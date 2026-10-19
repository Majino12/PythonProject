import contextlib
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from emotion_models import EMOTIONS, MODEL_SPEC, EmotionEngine


class FakeTensor:
    def __init__(self, values):
        self.values = values

    def to(self, _device):
        return self

    def cpu(self):
        return self

    def tolist(self):
        return self.values


class FakeTokenizer:
    model_max_length = 512

    def __init__(self, language="en"):
        self.hypotheses = EmotionEngine._hypotheses(language)
        self.seen_chunks = []

    def encode(self, value, **_kwargs):
        if value in self.hypotheses:
            return [1000 + self.hypotheses.index(value)]
        return list(range(len(value)))

    def num_special_tokens_to_add(self, pair):
        return 3 if pair else 2

    def prepare_for_model(self, chunk, pair_ids, **_kwargs):
        self.seen_chunks.append(list(chunk))
        return {"chunk": chunk, "label": pair_ids[0] - 1000}

    def pad(self, features, **_kwargs):
        return {"features": FakeTensor(features)}


class FakeModel:
    def __init__(self, logits=None):
        self.config = SimpleNamespace(max_position_embeddings=512,
                                     id2label={0: "entailment", 1: "neutral", 2: "contradiction"})
        self.logits = logits
        self.batch_sizes = []

    def __call__(self, features):
        self.batch_sizes.append(len(features.values))
        rows = [self.logits or ([4.0, 0.0, -2.0] if row["label"] == 0 else [-3.0, 1.0, 2.0])
                for row in features.values]
        return SimpleNamespace(logits=FakeTensor(rows))

    def to(self, _device):
        return self

    def eval(self):
        return self


class FakeTorch:
    float32 = "float32"

    @staticmethod
    def inference_mode():
        return contextlib.nullcontext()

    @staticmethod
    def get_num_threads():
        return 4

    @staticmethod
    def set_num_threads(_count):
        pass


def ready_engine(language="en", model=None):
    engine = EmotionEngine()
    tokenizer = FakeTokenizer(language)
    model = model or FakeModel()
    engine._loaded = (tokenizer, model, FakeTorch)
    engine.status = Mock(return_value={"available": True, "status": "ready"})
    return engine, tokenizer, model


class EmotionInferenceTests(unittest.TestCase):
    def test_independent_scores_and_dominant_label(self):
        engine, _, model = ready_engine()
        result = engine.analyze("A short happy original passage.", "en")
        self.assertTrue(result["available"])
        self.assertEqual(len(result["scores"]), 10)
        self.assertEqual(result["dominant"][0]["label"], "joy")
        self.assertEqual(result["coverage"], 1.0)
        self.assertEqual(result["chunk_count"], 1)
        self.assertEqual(result["coverage_mode"], "full")
        self.assertLessEqual(max(model.batch_sizes), engine.BATCH_SIZE)
        self.assertNotAlmostEqual(sum(row["score"] for row in result["scores"]), 1)

    def test_long_input_covers_start_middle_end_and_reports_sampling(self):
        engine, tokenizer, _ = ready_engine()
        result = engine.analyze("x" * 2000, "en")
        self.assertTrue(result["available"])
        self.assertEqual(result["chunk_count"], 4)
        self.assertEqual(result["total_chunk_count"], 11)
        self.assertEqual(result["tokens_analyzed"], 3 * 192 + 80)
        self.assertAlmostEqual(result["coverage"], (3 * 192 + 80) / 2000)
        self.assertEqual(tokenizer.seen_chunks[0][0], 0)
        self.assertEqual(tokenizer.seen_chunks[-1][-1], 1999)
        self.assertEqual(result["coverage_mode"], "uniform-token-windows")
        self.assertTrue(any("采样" in warning for warning in result["warnings"]))

    def test_unequal_chunks_are_weighted_by_content_tokens(self):
        engine, _, _ = ready_engine()
        # Two chunks, lengths 192 and 8; first chunk all scores 0.9, last 0.1.
        with patch.object(engine, "_score_logits", side_effect=[(0.9, 0.8)] * 10 + [(0.1, 0.05)] * 10):
            result = engine.analyze("a" * 200, "en")
        self.assertAlmostEqual(result["scores"][0]["score"], (192 * 0.9 + 8 * 0.1) / 200)
        self.assertEqual(result["coverage"], 1.0)

    def test_nli_neutral_is_not_presented_as_an_emotion(self):
        engine, _, _ = ready_engine(model=FakeModel(logits=[0.0, 15.0, -3.0]))
        result = engine.analyze("The table has a book on it.", "en")
        self.assertTrue(result["available"])
        self.assertGreater(result["scores"][0]["score"], 0.9)
        self.assertLess(result["scores"][0]["evidence"], 0.001)
        self.assertEqual(result["dominant"], [])
        self.assertNotIn("neutral", {row["label"] for row in result["scores"]})

    def test_korean_returns_transfer_limitation(self):
        engine, _, _ = ready_engine("ko")
        result = engine.analyze("정말 기쁘고 행복해.", "ko")
        self.assertTrue(result["available"])
        self.assertTrue(any("跨语言迁移" in warning for warning in result["warnings"]))

    def test_mixed_uses_multilingual_model_with_explicit_warning(self):
        engine, _, _ = ready_engine("mixed")
        result = engine.analyze("你好, I miss you. 보고 싶어.", "mixed")
        self.assertTrue(result["available"])
        self.assertEqual(result["language"], "mixed")
        self.assertTrue(any("韩文" in warning for warning in result["warnings"]))

    def test_invalid_logits_do_not_escape_as_fake_scores(self):
        engine, _, _ = ready_engine(model=FakeModel(logits=[float("nan"), 0, 0]))
        result = engine.analyze("Hello.", "en")
        self.assertFalse(result["available"])
        self.assertEqual(result["scores"], [])
        self.assertIn("invalid NLI logits", result["reason"])

    def test_empty_and_unsupported_do_not_load_model(self):
        engine = EmotionEngine()
        with patch.object(engine, "_load", side_effect=AssertionError("must not load")):
            self.assertFalse(engine.analyze(" ", "en")["available"])
            self.assertFalse(engine.analyze("こんにちは", "unknown")["available"])
        with self.assertRaises(ValueError):
            engine.analyze(None, "en")

    def test_stable_score_handles_extreme_logits(self):
        score, evidence = EmotionEngine._score_logits([1000, 999, -1000])
        self.assertEqual(score, 1)
        self.assertGreater(evidence, 0.7)
        with self.assertRaises(ValueError):
            EmotionEngine._score_logits([0, 1])


class EmotionAssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def make_manifest(self):
        files = {}
        for name in MODEL_SPEC["files"]:
            content = name.encode()
            (self.directory / name).write_bytes(content)
            files[name] = {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        metadata = {"schema_version": 1, "task": "emotion", "model": MODEL_SPEC["model"],
                    "revision": MODEL_SPEC["revision"], "files": files}
        (self.directory / "manifest.json").write_text(json.dumps(metadata), encoding="utf-8")
        return metadata

    def test_missing_assets_do_not_import_runtime_and_are_retryable(self):
        engine = EmotionEngine(self.directory)
        with patch("emotion_models.importlib.util.find_spec", side_effect=AssertionError("must not probe")):
            self.assertEqual(engine.status()["status"], "missing")
            self.assertFalse(engine.analyze("Hello.", "en")["available"])
        self.assertIsNone(engine._error)
        self.make_manifest()
        with patch("emotion_models.importlib.util.find_spec", return_value=object()):
            self.assertTrue(engine.status()["available"])

    def test_disabled_never_loads_or_claims_ready(self):
        self.make_manifest()
        engine = EmotionEngine(self.directory, enabled=False)
        self.assertEqual(engine.status()["status"], "disabled")
        self.assertFalse(engine.analyze("Hello.", "en")["available"])

    def test_revision_mismatch_is_rejected(self):
        metadata = self.make_manifest()
        metadata["revision"] = "different-revision"
        (self.directory / "manifest.json").write_text(json.dumps(metadata), encoding="utf-8")
        self.assertEqual(EmotionEngine(self.directory).status()["status"], "error")

    def test_hash_mismatch_detects_same_size_corruption(self):
        self.make_manifest()
        asset = self.directory / "model.safetensors"
        asset.write_bytes(b"x" * asset.stat().st_size)
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            EmotionEngine(self.directory)._verify_hashes()

    def test_load_uses_only_local_safetensors_and_verifies_label_order(self):
        engine = EmotionEngine(self.directory)
        tokenizer = FakeTokenizer()
        model = FakeModel()
        tokenizer_factory = SimpleNamespace(from_pretrained=Mock(return_value=tokenizer))
        model_factory = SimpleNamespace(from_pretrained=Mock(return_value=model))
        fake_transformers = SimpleNamespace(AutoTokenizer=tokenizer_factory,
                                            AutoModelForSequenceClassification=model_factory)
        with patch.object(engine, "status", return_value={"available": True}), \
                patch.object(engine, "_verify_hashes"), \
                patch.dict(sys.modules, {"torch": FakeTorch, "transformers": fake_transformers}):
            engine._load()
            self.assertTrue(model_factory.from_pretrained.call_args.kwargs["local_files_only"])
            self.assertTrue(model_factory.from_pretrained.call_args.kwargs["use_safetensors"])
            self.assertFalse(model_factory.from_pretrained.call_args.kwargs["trust_remote_code"])
            engine._loaded = None
            model.config.id2label = {0: "contradiction", 1: "neutral", 2: "entailment"}
            with self.assertRaisesRegex(ValueError, "mapping changed"):
                engine._load()

    def test_frozen_fixture_is_original_and_has_all_ten_emotions_per_language(self):
        path = Path(__file__).parent / "fixtures" / "emotion_examples.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertIn("not song lyrics", data["purpose"])
        for language in ("zh", "ko", "en"):
            labels = {label for sample in data["examples"] if sample["language"] == language
                      for label in sample["expected"]}
            self.assertEqual(labels, {row[0] for row in EMOTIONS})


if __name__ == "__main__":
    unittest.main()
