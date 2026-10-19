"""Optional local multilingual NLI analysis of ten lyrical emotion themes.

This is zero-shot semantic matching, not a classifier trained on emotion labels
or a validated lyrics benchmark. Korean uses cross-lingual transfer: it is not
among this checkpoint's XNLI fine-tuning/evaluation languages. Runtime inference
never downloads assets or uploads text. Install explicitly with setup_emotion_model.
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


MODEL_SPEC = {
    "model": "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli",
    "revision": "8adb042d524ecd5c26d3e3ba0e3fbcf7e2d0864c",
    "license": "MIT",
    "files": ("config.json", "tokenizer.json", "tokenizer_config.json",
              "special_tokens_map.json", "added_tokens.json", "model.safetensors"),
    "source": "https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-mnli-xnli",
}

# Fix hypotheses before evaluating: changes alter the task, not only presentation.
EMOTIONS = (
    ("joy", "喜悦", "joy and happiness", "喜悦和开心", "기쁨과 행복"),
    ("sadness", "悲伤", "sadness and grief", "悲伤和伤痛", "슬픔과 비애"),
    ("anger", "愤怒", "anger and resentment", "愤怒和怨恨", "분노와 원망"),
    ("fear", "恐惧", "fear and anxiety", "恐惧和不安", "두려움과 불안"),
    ("love", "爱恋", "love and affection", "爱恋和深情", "사랑과 애정"),
    ("longing", "思念", "longing and missing someone", "思念和牵挂", "그리움과 보고 싶은 마음"),
    ("hope", "希望", "hope and optimism for the future", "希望和对未来的乐观", "희망과 미래에 대한 낙관"),
    ("calm", "平静", "calm and inner peace", "平静和内心安宁", "평온함과 마음의 평화"),
    ("loneliness", "孤独", "loneliness and isolation", "孤独和寂寞", "외로움과 고독"),
    ("nostalgia", "怀旧", "nostalgia and memories of the past", "怀旧和对往昔的回忆", "향수와 지난날의 추억"),
)


def default_emotion_model_dir():
    return Path(os.environ.get("YINYUE_EMOTION_MODEL_DIR") or Path(Config.MODEL_DIR) / "emotion")


class EmotionEngine:
    """Bounded CPU inference with honest coverage for very long texts.

    Up to four uniformly spaced, disjoint windows are evaluated. Per-emotion
    E/(E+C) scores are averaged by window token count, as in independent NLI
    zero-shot labels. ``evidence`` retains three-class entailment probability so
    neutral NLI judgments do not become confident dominant emotion labels.
    """

    MAX_CHUNKS = 4
    CONTENT_TOKENS = 192
    BATCH_SIZE = 8
    _torch_setup_lock = threading.Lock()

    def __init__(self, model_dir=None, enabled=None):
        self.model_dir = Path(model_dir) if model_dir is not None else default_emotion_model_dir()
        self.enabled = (os.environ.get("YINYUE_EMOTIONS_ENABLED", "true").lower()
                        not in {"0", "false", "no"}) if enabled is None else bool(enabled)
        self._loaded = None
        self._error = None
        self._lock = threading.RLock()

    def _file_status(self):
        info = {key: MODEL_SPEC[key] for key in ("model", "revision", "license", "source")}
        info.update(method="zero-shot-nli", languages=["zh", "ko", "en", "mixed"])
        if not self.enabled:
            return dict(info, status="disabled", reason="Rich emotion inference is disabled.")
        if self._error:
            return dict(info, status="error", reason=self._error)
        manifest = self.model_dir / "manifest.json"
        if not manifest.is_file():
            return dict(info, status="missing", reason="Emotion model assets have not been installed.")
        try:
            metadata = json.loads(manifest.read_text(encoding="utf-8"))
            if (metadata.get("schema_version") != 1 or metadata.get("task") != "emotion"
                    or any(metadata.get(key) != MODEL_SPEC[key] for key in ("model", "revision"))):
                raise ValueError("Emotion manifest does not match the pinned checkpoint.")
            for filename in MODEL_SPEC["files"]:
                path = self.model_dir / filename
                if not path.is_file():
                    return dict(info, status="missing", reason=f"Emotion model asset is missing: {filename}")
                entry = metadata.get("files", {}).get(filename, {})
                digest = entry.get("sha256", "")
                if (not isinstance(digest, str) or len(digest) != 64
                        or any(c not in "0123456789abcdef" for c in digest)
                        or not isinstance(entry.get("size"), int) or entry["size"] <= 0
                        or path.stat().st_size != entry["size"]):
                    raise ValueError(f"Invalid emotion asset manifest or size: {filename}")
        except (OSError, ValueError, TypeError, AttributeError) as error:
            return dict(info, status="error", reason=str(error))
        return dict(info, status="ready", reason=None)

    def status(self):
        """Fast readiness inspection; it does not import PyTorch or load weights."""
        with self._lock:
            result = self._file_status()
            if result["status"] == "ready":
                missing = [name for name in ("torch", "transformers") if importlib.util.find_spec(name) is None]
                if missing:
                    result.update(status="missing", reason="Missing optional dependencies: " + ", ".join(missing))
            result["available"] = result["status"] == "ready"
            return result

    def _verify_hashes(self):
        metadata = json.loads((self.model_dir / "manifest.json").read_text(encoding="utf-8"))
        for filename in MODEL_SPEC["files"]:
            digest = hashlib.sha256()
            with (self.model_dir / filename).open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != metadata["files"][filename]["sha256"]:
                raise ValueError(f"Emotion asset checksum mismatch: {filename}")

    def _load(self):
        if self._loaded is not None:
            return self._loaded
        state = self.status()
        if not state["available"]:
            raise RuntimeError(state["reason"])
        self._verify_hashes()
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        with self._torch_setup_lock:
            torch.set_num_threads(min(4, torch.get_num_threads()))
        tokenizer = AutoTokenizer.from_pretrained(
            str(self.model_dir), local_files_only=True, trust_remote_code=False, use_fast=True,
        )
        model = AutoModelForSequenceClassification.from_pretrained(
            str(self.model_dir), local_files_only=True, trust_remote_code=False,
            use_safetensors=True, dtype=torch.float32,
        )
        mapping = {int(key): str(value).lower() for key, value in model.config.id2label.items()}
        if mapping != {0: "entailment", 1: "neutral", 2: "contradiction"}:
            raise ValueError("The pinned NLI model's entailment/neutral/contradiction mapping changed.")
        model.to("cpu")
        model.eval()
        self._loaded = tokenizer, model, torch
        return self._loaded

    @staticmethod
    def _hypotheses(language):
        if language == "zh":
            return [f"这段文字表达了{row[3]}。" for row in EMOTIONS]
        if language == "ko":
            # Korean object particles depend on the final syllable's coda.
            return [f"이 글은 {row[4]}{'을' if (ord(row[4][-1]) - 0xAC00) % 28 else '를'} 표현한다."
                    for row in EMOTIONS]
        return [f"This text expresses {row[2]}." for row in EMOTIONS]

    @classmethod
    def _select_chunks(cls, token_ids, capacity):
        if capacity < 1:
            raise ValueError("No content-token capacity remains for emotion analysis.")
        all_chunks = [token_ids[offset:offset + capacity] for offset in range(0, len(token_ids), capacity)]
        count = len(all_chunks)
        if count <= cls.MAX_CHUNKS:
            return all_chunks, count
        indices = [round(index * (count - 1) / (cls.MAX_CHUNKS - 1)) for index in range(cls.MAX_CHUNKS)]
        return [all_chunks[index] for index in indices], count

    @staticmethod
    def _score_logits(row):
        if len(row) != 3 or any(not math.isfinite(value) for value in row):
            raise ValueError("Emotion model returned invalid NLI logits.")
        # Stable softmax; the neutral NLI label is not a neutral emotion.
        pair_max = max(row[0], row[2])
        pair = [math.exp(row[index] - pair_max) for index in (0, 2)]
        all_max = max(row)
        full = [math.exp(value - all_max) for value in row]
        return pair[0] / sum(pair), full[0] / sum(full)

    def analyze(self, text, language):
        """Return ten independent semantic matches, or explicit unavailability."""
        if not isinstance(text, str):
            raise ValueError("Emotion text must be a string.")
        base = {"method": "zero-shot-nli", "model": MODEL_SPEC["model"],
                "revision": MODEL_SPEC["revision"], "language": language,
                "score_kind": "independent-entailment-vs-contradiction",
                "scores": [], "dominant": [], "chunk_count": 0,
                "warnings": []}
        if language not in {"zh", "ko", "en", "mixed"} or not text.strip():
            return dict(base, available=False, reason="No supported non-empty text was provided.")
        warnings = ["这些分数是情绪语义匹配度，彼此独立，不代表准确率、情绪强度或临床判断。",
                    "该模型没有用歌词情绪标签微调，隐喻、反讽和复杂叙事可能误判。"]
        if language in {"ko", "mixed"}:
            warnings.append("韩文使用跨语言迁移；模型没有在韩文 XNLI 或歌词情绪数据上微调验证。")
        with self._lock:
            state = self.status()
            if not state["available"]:
                return dict(base, available=False, reason=state["reason"], warnings=warnings)
            try:
                tokenizer, model, torch = self._load()
                hypotheses = self._hypotheses(language)
                hypothesis_ids = [tokenizer.encode(value, add_special_tokens=False, truncation=False)
                                  for value in hypotheses]
                limits = [512]
                for limit in (getattr(tokenizer, "model_max_length", None),
                              getattr(model.config, "max_position_embeddings", None)):
                    if isinstance(limit, int) and 0 < limit < 1_000_000:
                        limits.append(limit)
                capacity = min(self.CONTENT_TOKENS, min(limits)
                               - tokenizer.num_special_tokens_to_add(pair=True)
                               - max(len(ids) for ids in hypothesis_ids))
                ids = tokenizer.encode(text, add_special_tokens=False, truncation=False)
                chunks, total_chunks = self._select_chunks(ids, capacity)
                if not chunks:
                    return dict(base, available=False, reason="No content tokens were found.")
                pairs = [(chunk, label_index, hypothesis) for chunk in chunks
                         for label_index, hypothesis in enumerate(hypothesis_ids)]
                sums = [[0.0, 0.0] for _ in EMOTIONS]
                for start in range(0, len(pairs), self.BATCH_SIZE):
                    current = pairs[start:start + self.BATCH_SIZE]
                    features = [tokenizer.prepare_for_model(chunk, pair_ids=hypothesis,
                                add_special_tokens=True, truncation=False, return_attention_mask=True)
                                for chunk, _, hypothesis in current]
                    inputs = tokenizer.pad(features, padding=True, return_tensors="pt")
                    inputs = {key: value.to("cpu") for key, value in inputs.items()}
                    with torch.inference_mode():
                        logits = model(**inputs).logits.cpu().tolist()
                    if len(logits) != len(current):
                        raise ValueError("Emotion model returned an unexpected batch size.")
                    for (chunk, label_index, _), row in zip(current, logits):
                        score, evidence = self._score_logits(row)
                        sums[label_index][0] += score * len(chunk)
                        sums[label_index][1] += evidence * len(chunk)
                analyzed = sum(len(chunk) for chunk in chunks)
                scores = [{"label": row[0], "name_zh": row[1], "score": sums[index][0] / analyzed,
                           "evidence": sums[index][1] / analyzed} for index, row in enumerate(EMOTIONS)]
                scores.sort(key=lambda row: row["score"], reverse=True)
                dominant = [dict(row) for row in scores if row["score"] >= 0.5 and row["evidence"] >= 0.35][:3]
                if total_chunks > len(chunks):
                    warnings.append("长文本采用均匀分布的片段采样；未分析的片段可能包含不同情绪。")
                if not dominant:
                    warnings.append("没有足够明确的主导情绪，建议结合原文解读。")
                return dict(base, available=True, scores=scores, dominant=dominant,
                            chunk_count=len(chunks), total_chunk_count=total_chunks,
                            tokens_analyzed=analyzed, tokens_total=len(ids), coverage=analyzed / len(ids),
                            coverage_mode="full" if len(chunks) == total_chunks else "uniform-token-windows",
                            warnings=warnings)
            except Exception as error:
                self._error = f"Local emotion model could not run: {error}"
                return dict(base, available=False, reason=self._error, warnings=warnings)
