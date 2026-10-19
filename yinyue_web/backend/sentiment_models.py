"""Pinned, optional local transformer models for Chinese and Korean lyrics.

Importing this module neither imports PyTorch nor accesses the network. Download
models explicitly with ``scripts/setup_models.py`` before enabling inference.
"""

import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import threading

try:
    from .config import Config
except ImportError:
    from config import Config


MODEL_SPECS = {
    "zh": {
        "model": "IDEA-CCNL/Erlangshen-Roberta-110M-Sentiment",
        # Hugging Face's SFconvertbot safetensors conversion in upstream PR #3.
        "revision": "6845a34e9284761a0f17e062e2a810dde992a214",
        "files": ("config.json", "vocab.txt", "model.safetensors"),
        "license": "Apache-2.0",
    },
    "ko": {
        "model": "Copycats/koelectra-base-v3-generalized-sentiment-analysis",
        "revision": "370f325ce11aabd837b89bfb3ffdc26fde354689",
        "files": ("config.json", "tokenizer_config.json", "vocab.txt", "model.safetensors"),
        "license": "Apache-2.0",
    },
}


def default_model_dir():
    return Path(os.environ.get("YINYUE_MODEL_DIR") or Path(Config.DATA_DIR) / "models")


class ModelUnavailable(RuntimeError):
    """The optional local model cannot run; callers can expose a fallback."""

    def __init__(self, reason):
        self.reason = str(reason)
        super().__init__(self.reason)


class ModelSentimentEngine:
    """Lazy, CPU-only inference without downloads, including on first use.

    Both checkpoints are binary classifiers. ``uncertain`` means their
    aggregated maximum probability is below 0.65; it is not a neutral class.
    Full token sequences are split into disjoint model-sized chunks and their
    probabilities are averaged by the number of content tokens in each chunk.
    """

    BATCH_SIZE = 8
    CONFIDENCE_THRESHOLD = 0.65
    _torch_setup_lock = threading.Lock()

    def __init__(self, model_dir=None, enabled=None):
        self.model_dir = Path(model_dir) if model_dir is not None else default_model_dir()
        self.enabled = Config.MODELS_ENABLED if enabled is None else bool(enabled)
        self._loaded = {}
        self._errors = {}
        self._lock = threading.RLock()

    def _file_status(self, language):
        spec = MODEL_SPECS[language]
        result = {"model": spec["model"], "revision": spec["revision"]}
        if not self.enabled:
            return dict(result, status="disabled", reason="Local model inference is disabled.")
        if language in self._errors:
            return dict(result, status="error", reason=self._errors[language])
        directory = self.model_dir / language
        manifest_file = directory / "manifest.json"
        if not manifest_file.is_file():
            return dict(result, status="missing", reason="Model assets have not been installed.")
        try:
            metadata = json.loads(manifest_file.read_text(encoding="utf-8"))
            if (
                metadata.get("schema_version") != 1
                or metadata.get("language") != language
                or metadata.get("model") != spec["model"]
                or metadata.get("revision") != spec["revision"]
            ):
                raise ValueError("Model manifest does not match the pinned checkpoint.")
            recorded = metadata.get("files", {})
            for name in spec["files"]:
                filename = directory / name
                if not filename.is_file():
                    return dict(result, status="missing", reason=f"Model asset is missing: {name}")
                entry = recorded.get(name, {})
                digest = entry.get("sha256", "")
                if (
                    not isinstance(digest, str)
                    or len(digest) != 64
                    or any(character not in "0123456789abcdef" for character in digest)
                    or not isinstance(entry.get("size"), int)
                    or entry["size"] <= 0
                    or entry["size"] != filename.stat().st_size
                ):
                    raise ValueError(f"Model manifest or asset size is invalid: {name}")
        except (OSError, ValueError, TypeError, AttributeError) as error:
            return dict(result, status="error", reason=str(error))
        return dict(result, status="ready", reason=None)

    def status(self):
        """Return per-language readiness without importing or loading models."""
        with self._lock:
            states = {language: self._file_status(language) for language in MODEL_SPECS}
            if any(state["status"] == "ready" for state in states.values()):
                missing = [name for name in ("torch", "transformers") if importlib.util.find_spec(name) is None]
                if missing:
                    for state in states.values():
                        if state["status"] == "ready":
                            state.update(status="missing", reason="Optional dependencies are missing: " + ", ".join(missing))
            return states

    def _verify_hashes(self, language):
        directory = self.model_dir / language
        metadata = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        for name in MODEL_SPECS[language]["files"]:
            digest = hashlib.sha256()
            with (directory / name).open("rb") as asset:
                for block in iter(lambda: asset.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != metadata["files"][name]["sha256"]:
                raise ValueError(f"Model asset checksum mismatch: {name}")

    def _load(self, language):
        if language not in MODEL_SPECS:
            raise ModelUnavailable(f"No local sentiment model is configured for {language}.")
        state = self.status()[language]
        if state["status"] != "ready":
            raise ModelUnavailable(state["reason"])
        if language in self._loaded:
            return self._loaded[language]
        try:
            self._verify_hashes(language)
            # Optional imports occur only after the complete local checkpoint
            # has been verified. from_pretrained may not fetch missing files.
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            with self._torch_setup_lock:
                torch.set_num_threads(min(4, torch.get_num_threads()))
            directory = str(self.model_dir / language)
            tokenizer = AutoTokenizer.from_pretrained(
                directory, local_files_only=True, trust_remote_code=False,
            )
            model = AutoModelForSequenceClassification.from_pretrained(
                directory, local_files_only=True, trust_remote_code=False,
                use_safetensors=True,
            )
            if model.config.num_labels != 2:
                raise ValueError("The pinned sentiment model must have exactly two labels.")
            labels = {int(key): str(value).lower() for key, value in model.config.id2label.items()}
            if labels.get(0) not in {"negative", "0", "label_0"} or labels.get(1) not in {"positive", "1", "label_1"}:
                raise ValueError("Model label mapping differs from its documented negative/positive order.")
            model.to("cpu")
            model.eval()
            self._loaded[language] = (tokenizer, model, torch)
            return self._loaded[language]
        except Exception as error:
            reason = f"Local model could not be loaded: {error}"
            self._errors[language] = reason
            raise ModelUnavailable(reason) from error

    @staticmethod
    def _content_capacity(tokenizer, model):
        limits = [512]
        for limit in (getattr(tokenizer, "model_max_length", None), getattr(model.config, "max_position_embeddings", None)):
            if isinstance(limit, int) and 0 < limit < 1_000_000:
                limits.append(limit)
        capacity = min(limits) - tokenizer.num_special_tokens_to_add(pair=False)
        if capacity < 1:
            raise ValueError("The model has no room for content tokens.")
        return capacity

    def predict(self, texts, language):
        """Analyze every input fully and return JSON-compatible binary scores."""
        if isinstance(texts, str) or not isinstance(texts, (list, tuple)):
            raise ValueError("texts must be a list or tuple of strings.")
        if any(not isinstance(text, str) for text in texts):
            raise ValueError("Each input text must be a string.")
        if not texts:
            return []
        with self._lock:
            tokenizer, model, torch = self._load(language)
            try:
                capacity = self._content_capacity(tokenizer, model)
                chunks = []
                counts = [0] * len(texts)
                totals = [[0.0, 0.0, 0] for _ in texts]
                for index, text in enumerate(texts):
                    token_ids = tokenizer.encode(text, add_special_tokens=False, truncation=False)
                    for offset in range(0, len(token_ids), capacity):
                        ids = token_ids[offset:offset + capacity]
                        chunks.append((index, ids))
                        counts[index] += 1
                for start in range(0, len(chunks), self.BATCH_SIZE):
                    current = chunks[start:start + self.BATCH_SIZE]
                    features = [tokenizer.prepare_for_model(ids, add_special_tokens=True, truncation=False, return_attention_mask=True)
                                for _, ids in current]
                    inputs = tokenizer.pad(features, padding=True, return_tensors="pt")
                    inputs = {key: value.to("cpu") for key, value in inputs.items()}
                    with torch.inference_mode():
                        probabilities = torch.softmax(model(**inputs).logits, dim=-1).cpu().tolist()
                    if len(probabilities) != len(current):
                        raise ValueError("Model returned an unexpected batch size.")
                    for (index, ids), row in zip(current, probabilities):
                        if len(row) != 2 or any(not math.isfinite(value) or not 0 <= value <= 1 for value in row):
                            raise ValueError("Model returned invalid binary probabilities.")
                        weight = len(ids)
                        totals[index][0] += float(row[0]) * weight
                        totals[index][1] += float(row[1]) * weight
                        totals[index][2] += weight
                spec = MODEL_SPECS[language]
                results = []
                for index, (negative_sum, positive_sum, weight) in enumerate(totals):
                    negative, positive = (negative_sum / weight, positive_sum / weight) if weight else (0.5, 0.5)
                    confidence = max(negative, positive)
                    sentiment = ("positive" if positive > negative else "negative") if confidence >= self.CONFIDENCE_THRESHOLD else "uncertain"
                    results.append({
                        "polarity": positive - negative,
                        "sentiment": sentiment,
                        "confidence": confidence,
                        "probabilities": {"positive": positive, "negative": negative},
                        "chunk_count": counts[index],
                        "model": spec["model"],
                        "revision": spec["revision"],
                    })
                return results
            except Exception as error:
                reason = f"Local model inference failed: {error}"
                self._errors[language] = reason
                raise ModelUnavailable(reason) from error
