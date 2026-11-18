"""Music-CLAP contract tests; model weights and network are never required."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import music_mood
from music_mood import MUSIC_MOOD_MODEL, MusicMoodEngine, MusicMoodCancelled, MOOD_PROMPTS

setup_spec = importlib.util.spec_from_file_location("setup_music_mood_test", Path(__file__).resolve().parents[1] / "scripts" / "setup_music_mood.py")
setup_music_mood = importlib.util.module_from_spec(setup_spec)
setup_spec.loader.exec_module(setup_music_mood)


class MusicMoodTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.engine = MusicMoodEngine(self.directory)

    def fake_ready(self):
        return patch.object(self.engine, "status", return_value={"available": True})

    def fake_install(self):
        contents = b"test model file"
        checksum = hashlib.sha256(contents).hexdigest()
        patcher = patch.dict(MUSIC_MOOD_MODEL, {"weights_sha256": checksum})
        patcher.start()
        self.addCleanup(patcher.stop)
        files = {}
        for name in MUSIC_MOOD_MODEL["files"]:
            (self.directory / name).write_bytes(contents)
            files[name] = {"size": len(contents), "sha256": checksum}
        manifest = {"schema_version": 1, "model": MUSIC_MOOD_MODEL["model"], "revision": MUSIC_MOOD_MODEL["revision"], "files": files}
        (self.directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return manifest

    def test_status_is_lightweight_and_never_downloads_or_loads(self):
        self.assertEqual(self.engine.status()["status"], "missing")
        self.fake_install()
        with patch.object(self.engine, "_load", side_effect=AssertionError("must not load")), patch("music_mood.importlib.util.find_spec", return_value=object()):
            self.assertTrue(self.engine.status()["available"])
        self.assertIsNone(self.engine._runtime)

    def test_collapsed_or_empty_text_embeddings_are_rejected(self):
        for features in (np.ones((len(MOOD_PROMPTS), 16)) / 4, np.zeros((len(MOOD_PROMPTS), 16))):
            with self.subTest(features=features[0]), self.assertRaises(ValueError):
                self.engine._validate_text_features(features)
        self.engine._validate_text_features(np.eye(len(MOOD_PROMPTS)))

    def test_manifest_pin_and_upstream_weight_checksum_are_required(self):
        manifest = self.fake_install()
        manifest["revision"] = "wrong"
        (self.directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.assertEqual(self.engine.status()["status"], "error")
        manifest["revision"] = MUSIC_MOOD_MODEL["revision"]
        manifest["files"]["model.safetensors"]["sha256"] = "0" * 64
        (self.directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.assertEqual(self.engine.status()["status"], "error")

    def test_loader_rejects_modified_assets_before_importing_model(self):
        self.fake_install()
        (self.directory / "config.json").write_bytes(b"fake model file")
        with self.assertRaisesRegex(ValueError, "校验失败"):
            self.engine._load(None)

    def test_absent_model_short_silent_and_invalid_audio_have_no_scores(self):
        missing = self.engine.analyze(np.ones(16000 * 4, dtype=np.float32) * .1)
        self.assertFalse(missing["available"])
        self.assertEqual(missing["scores"], [])
        with self.fake_ready(), patch.object(self.engine, "_load", side_effect=AssertionError("insufficient input must not load")):
            for audio in (np.zeros(16000 * 4), np.ones(16000), np.array([np.nan]), np.zeros((2, 16000))):
                with self.subTest(shape=audio.shape):
                    result = self.engine.analyze(audio)
                    self.assertFalse(result["available"])
                    self.assertEqual(result["scores"], [])

    def test_deterministic_sampling_spans_full_duration_and_is_bounded(self):
        windows = self.engine._windows(16000 * 600, 16000)
        self.assertEqual(len(windows), 4)
        self.assertEqual(windows[0][0], 0)
        self.assertEqual(windows[-1][1], 16000 * 600)
        self.assertTrue(all(end - start == 16000 * 10 for start, end in windows))
        self.assertEqual(windows, self.engine._windows(16000 * 600, 16000))
        self.assertEqual(self.engine._coverage(windows, 16000, 16000 * 600)["analyzed_seconds"], 40)
        overlap = self.engine._windows(16000 * 12, 16000)
        self.assertEqual(self.engine._coverage(overlap, 16000, 16000 * 12)["analyzed_seconds"], 12)

    def test_resampling_raw_cosines_and_sampling_coverage(self):
        captured = []

        def predict(waveform, runtime):
            captured.append(waveform)
            return np.linspace(-.2, .5, len(MOOD_PROMPTS))

        with self.fake_ready(), patch.object(self.engine, "_load", return_value=object()), patch.object(self.engine, "_predict_window", side_effect=predict):
            result = self.engine.analyze(np.full(16000 * 55, .1, dtype=np.float32))
        self.assertTrue(result["available"])
        self.assertEqual([len(segment) for segment in captured], [480000] * 4)
        self.assertEqual(result["score_type"], "cosine_similarity")
        self.assertEqual(result["scores"][0]["score"], .5)
        self.assertEqual(result["scores"][-1]["score"], -.2)
        self.assertAlmostEqual(result["coverage"]["ratio"], 40 / 55)
        self.assertNotAlmostEqual(sum(score["score"] for score in result["scores"]), 1)
        self.assertTrue(any("最多4个" in warning for warning in result["warnings"]))
        json.dumps(result, allow_nan=False)

    def test_short_but_usable_audio_has_explicit_limitations(self):
        with self.fake_ready(), patch.object(self.engine, "_load", return_value=object()), patch.object(self.engine, "_predict_window", return_value=np.zeros(len(MOOD_PROMPTS))):
            result = self.engine.analyze(np.full(16000 * 4, .1, dtype=np.float32))
        self.assertTrue(result["available"])
        self.assertTrue(any("短于" in warning for warning in result["warnings"]))
        self.assertEqual(result["coverage"]["segment_count"], 1)

    def test_nan_or_inference_failure_downgrades_without_fake_scores(self):
        with self.fake_ready(), patch.object(self.engine, "_load", return_value=object()), patch.object(self.engine, "_predict_window", return_value=np.full(len(MOOD_PROMPTS), np.nan)):
            result = self.engine.analyze(np.full(16000 * 10, .1, dtype=np.float32))
        self.assertFalse(result["available"])
        self.assertEqual(result["scores"], [])
        self.assertEqual(result["coverage"]["ratio"], 0)
        self.assertEqual(self.engine.status()["status"], "error")

    def test_cancellation_before_and_between_segments_is_not_swallowed(self):
        event = threading.Event()
        event.set()
        with self.assertRaises(MusicMoodCancelled):
            self.engine.analyze(np.zeros(16000), cancel_event=event)
        event.clear()

        def predict(audio, runtime):
            event.set()
            return np.zeros(len(MOOD_PROMPTS))

        with self.fake_ready(), patch.object(self.engine, "_load", return_value=object()), patch.object(self.engine, "_predict_window", side_effect=predict):
            with self.assertRaises(MusicMoodCancelled):
                self.engine.analyze(np.full(16000 * 55, .1, dtype=np.float32), cancel_event=event)
        self.assertFalse(self.engine._lock.locked())
        self.assertIsNone(self.engine._error)

    def test_setup_pins_allowlist_and_validates_official_weight_hash(self):
        contents = b"test installed asset"
        checksum = hashlib.sha256(contents).hexdigest()

        def download(**kwargs):
            path = Path(kwargs["local_dir"]) / kwargs["filename"]
            path.write_bytes(contents)
            return str(path)

        downloader = Mock(side_effect=download)
        with patch.dict(sys.modules, {"huggingface_hub": SimpleNamespace(hf_hub_download=downloader)}), patch("builtins.print"):
            with self.assertRaisesRegex(ValueError, "SHA256"):
                setup_music_mood.install(self.directory)
            self.assertFalse((self.directory / "manifest.json").exists())
            with patch.dict(MUSIC_MOOD_MODEL, {"weights_sha256": checksum}):
                metadata = setup_music_mood.install(self.directory)
        self.assertEqual(set(metadata["files"]), set(MUSIC_MOOD_MODEL["files"]))
        for call in downloader.call_args_list:
            self.assertEqual(call.kwargs["revision"], MUSIC_MOOD_MODEL["revision"])
            self.assertFalse(call.kwargs["token"])
            self.assertNotIn(".bin", call.kwargs["filename"])


if __name__ == "__main__":
    unittest.main()
