"""Contract and failure tests; no real model, network or optional ML dependencies."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from sentiment_models import MODEL_SPECS, ModelSentimentEngine, ModelUnavailable

setup_spec = importlib.util.spec_from_file_location(
    "setup_models_for_test", Path(__file__).resolve().parents[1] / "scripts" / "setup_models.py"
)
setup_models = importlib.util.module_from_spec(setup_spec)
setup_spec.loader.exec_module(setup_models)


class Tensor:
    def __init__(self, values):
        self.values = values

    def to(self, device):
        assert device == "cpu"
        return self

    def cpu(self):
        return self

    def tolist(self):
        return self.values


class Tokenizer:
    model_max_length = 5

    def __init__(self):
        self.batch_sizes = []
        self.seen_ids = []

    def num_special_tokens_to_add(self, pair=False):
        return 2

    def encode(self, text, **kwargs):
        assert kwargs == {"add_special_tokens": False, "truncation": False}
        return [{"p": 1, "n": 2, "u": 3}[word] for word in text.split()]

    def prepare_for_model(self, ids, **kwargs):
        assert kwargs["truncation"] is False
        assert len(ids) <= 3
        self.seen_ids.extend(ids)
        return {"input_ids": [101] + ids + [102], "attention_mask": [1] * (len(ids) + 2)}

    def pad(self, features, **kwargs):
        self.batch_sizes.append(len(features))
        return {key: Tensor([feature[key] for feature in features]) for key in features[0]}


class Model:
    config = SimpleNamespace(num_labels=2, max_position_embeddings=5, id2label={0: "Negative", 1: "Positive"})

    def to(self, device):
        assert device == "cpu"
        return self

    def eval(self):
        return self

    def __call__(self, **inputs):
        rows = []
        for ids in inputs["input_ids"].values:
            content = ids[1:-1]
            positive = sum({1: 0.9, 2: 0.1, 3: 0.5}[token] for token in content) / len(content)
            rows.append([1 - positive, positive])
        return SimpleNamespace(logits=Tensor(rows))


def fake_torch():
    return SimpleNamespace(
        inference_mode=nullcontext,
        softmax=lambda logits, dim: logits,
        get_num_threads=lambda: 12,
        set_num_threads=Mock(),
    )


class ModelEngineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.engine = ModelSentimentEngine(self.directory)

    def install_manifest(self, language="zh"):
        spec = MODEL_SPECS[language]
        directory = self.directory / language
        directory.mkdir()
        files = {}
        for name in spec["files"]:
            contents = b"test checkpoint"
            (directory / name).write_bytes(contents)
            files[name] = {"size": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}
        manifest = {"schema_version": 1, "language": language, "model": spec["model"], "revision": spec["revision"], "files": files}
        (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return manifest

    def runtime(self):
        tokenizer = Tokenizer()
        runtime = tokenizer, Model(), fake_torch()
        return tokenizer, patch.object(self.engine, "_load", return_value=runtime)

    def test_missing_disabled_and_unsupported_are_explicit(self):
        self.assertEqual(self.engine.status()["zh"]["status"], "missing")
        with self.assertRaises(ModelUnavailable):
            self.engine.predict(["p"], "zh")
        self.engine.enabled = False
        self.assertEqual(self.engine.status()["ko"]["status"], "disabled")
        with self.assertRaisesRegex(ModelUnavailable, "disabled"):
            self.engine.predict(["p"], "ko")
        with self.assertRaisesRegex(ModelUnavailable, "configured"):
            self.engine.predict(["p"], "en")

    def test_status_never_loads_models(self):
        self.install_manifest()
        with patch("sentiment_models.importlib.util.find_spec", return_value=object()), patch.object(self.engine, "_load", side_effect=AssertionError("status loaded a model")):
            state = self.engine.status()["zh"]
        self.assertEqual(state["status"], "ready")
        self.assertEqual(state["revision"], MODEL_SPECS["zh"]["revision"])
        self.assertEqual(self.engine._loaded, {})

    def test_optional_dependencies_missing(self):
        self.install_manifest()
        with patch("sentiment_models.importlib.util.find_spec", return_value=None):
            state = self.engine.status()["zh"]
        self.assertEqual(state["status"], "missing")
        self.assertIn("dependencies", state["reason"])

    def test_manifest_revision_and_partial_download_are_rejected(self):
        manifest = self.install_manifest()
        manifest["revision"] = "not-the-pinned-revision"
        (self.directory / "zh" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.assertEqual(self.engine.status()["zh"]["status"], "error")
        manifest["revision"] = MODEL_SPECS["zh"]["revision"]
        (self.directory / "zh" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (self.directory / "zh" / "model.safetensors").unlink()
        self.assertEqual(self.engine.status()["zh"]["status"], "missing")

    def test_tampered_weight_is_rejected_before_model_loading(self):
        self.install_manifest()
        (self.directory / "zh" / "model.safetensors").write_bytes(b"fake checkpoint")
        with patch("sentiment_models.importlib.util.find_spec", return_value=object()):
            with self.assertRaisesRegex(ModelUnavailable, "checksum mismatch"):
                self.engine.predict(["p"], "zh")
        self.assertEqual(self.engine.status()["zh"]["status"], "error")

    def test_loader_is_local_only_cpu_safe_and_cached(self):
        self.install_manifest()
        tokenizer, model, torch = Tokenizer(), Model(), fake_torch()
        tokenizer_loader = Mock(return_value=tokenizer)
        model_loader = Mock(return_value=model)
        transformers = SimpleNamespace(
            AutoTokenizer=SimpleNamespace(from_pretrained=tokenizer_loader),
            AutoModelForSequenceClassification=SimpleNamespace(from_pretrained=model_loader),
        )
        with patch("sentiment_models.importlib.util.find_spec", return_value=object()), patch.dict(sys.modules, {"torch": torch, "transformers": transformers}):
            first = self.engine.predict(["p"], "zh")
            self.engine.predict(["n"], "zh")
        self.assertEqual(first[0]["sentiment"], "positive")
        self.assertEqual(tokenizer_loader.call_count, 1)
        self.assertEqual(model_loader.call_count, 1)
        for loader in (tokenizer_loader, model_loader):
            self.assertTrue(loader.call_args.kwargs["local_files_only"])
            self.assertFalse(loader.call_args.kwargs["trust_remote_code"])
        self.assertTrue(model_loader.call_args.kwargs["use_safetensors"])
        torch.set_num_threads.assert_called_once_with(4)

    def test_long_text_covers_tail_and_weights_content_tokens(self):
        tokenizer, runtime = self.runtime()
        with runtime:
            result = self.engine.predict(["p p p n"], "zh")[0]
        self.assertEqual(tokenizer.seen_ids, [1, 1, 1, 2])
        self.assertEqual(result["chunk_count"], 2)
        self.assertAlmostEqual(result["probabilities"]["positive"], 0.7)
        self.assertAlmostEqual(result["polarity"], 0.4)
        self.assertEqual(result["sentiment"], "positive")
        self.assertEqual(result["revision"], MODEL_SPECS["zh"]["revision"])
        json.dumps(result, allow_nan=False)

    def test_batches_are_bounded_and_input_order_is_preserved(self):
        tokenizer, runtime = self.runtime()
        texts = ["p", "n", "u"] * 7
        with runtime:
            results = self.engine.predict(texts, "ko")
        self.assertEqual([result["sentiment"] for result in results], ["positive", "negative", "uncertain"] * 7)
        self.assertEqual(tokenizer.batch_sizes, [8, 8, 5])

    def test_ambiguity_and_empty_text_never_invent_a_neutral_class(self):
        _, runtime = self.runtime()
        with runtime:
            results = self.engine.predict(["p n", "u", ""], "zh")
        for result in results:
            self.assertEqual(result["sentiment"], "uncertain")
            self.assertAlmostEqual(result["confidence"], 0.5)
            self.assertEqual(set(result["probabilities"]), {"positive", "negative"})
        self.assertEqual(results[-1]["chunk_count"], 0)

    def test_invalid_input_and_empty_batch(self):
        self.assertEqual(self.engine.predict([], "zh"), [])
        for invalid in ("not-a-list", [1], None):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.engine.predict(invalid, "zh")

    def test_non_finite_model_scores_fail_without_nan_outputs(self):
        tokenizer, model, torch = Tokenizer(), Model(), fake_torch()
        torch.softmax = lambda logits, dim: Tensor([[float("nan"), 0.5]])
        with patch.object(self.engine, "_load", return_value=(tokenizer, model, torch)):
            with self.assertRaisesRegex(ModelUnavailable, "invalid binary probabilities"):
                self.engine.predict(["p"], "zh")

    def test_concurrent_requests_preserve_results(self):
        _, runtime = self.runtime()
        with runtime, ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda text: self.engine.predict([text], "zh")[0]["sentiment"], ["p", "n"] * 8))
        self.assertEqual(results, ["positive", "negative"] * 8)

    def test_setup_downloads_only_allowlisted_files_at_pinned_revision(self):
        def download(**kwargs):
            filename = Path(kwargs["local_dir"]) / kwargs["filename"]
            filename.write_bytes(b"downloaded asset")
            return str(filename)

        downloader = Mock(side_effect=download)
        with patch.dict(sys.modules, {"huggingface_hub": SimpleNamespace(hf_hub_download=downloader)}), patch("builtins.print"):
            metadata = setup_models.download_model("ko", self.directory)
        spec = MODEL_SPECS["ko"]
        self.assertEqual(set(metadata["files"]), set(spec["files"]))
        self.assertTrue((self.directory / "ko" / "manifest.json").is_file())
        for call in downloader.call_args_list:
            self.assertEqual(call.kwargs["repo_id"], spec["model"])
            self.assertEqual(call.kwargs["revision"], spec["revision"])
            self.assertNotIn(".bin", call.kwargs["filename"])
        with patch("sentiment_models.importlib.util.find_spec", return_value=object()):
            self.assertEqual(self.engine.status()["ko"]["status"], "ready")
        self.engine._verify_hashes("ko")

    def test_interrupted_setup_cannot_leave_old_completion_manifest(self):
        self.install_manifest("ko")
        downloader = Mock(side_effect=OSError("download interrupted"))
        with patch.dict(sys.modules, {"huggingface_hub": SimpleNamespace(hf_hub_download=downloader)}), patch("builtins.print"):
            with self.assertRaisesRegex(OSError, "download interrupted"):
                setup_models.download_model("ko", self.directory)
        self.assertFalse((self.directory / "ko" / "manifest.json").exists())
        self.assertEqual(self.engine.status()["ko"]["status"], "missing")


if __name__ == "__main__":
    unittest.main()
