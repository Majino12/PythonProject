"""Offline contracts and bounded decoding; no audio model/download is required."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import audio_transcriber as audio


class AudioTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.engine = audio.AudioTranscriber(self.directory)

    def install(self):
        files = {}
        for name in audio.AUDIO_MODEL["files"]:
            data = name.encode()
            (self.directory / name).write_bytes(data)
            files[name] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        files["model.bin"]["sha256"] = audio.AUDIO_MODEL["weights_sha256"]
        manifest = {"model": audio.AUDIO_MODEL["model"], "revision": audio.AUDIO_MODEL["revision"], "files": files}
        (self.directory / "manifest.json").write_text(json.dumps(manifest))
        return manifest

    def predict(self, segments, silence=False, event=None):
        model = Mock()
        model.transcribe.return_value = (iter(segments), SimpleNamespace(language="ko", language_probability=0.95))
        progress = Mock()
        with patch.object(self.engine, "_manifest"), patch.object(self.engine, "_load_model", return_value=model), patch.object(audio, "decode_audio", return_value=[0] * 160000), patch.object(audio, "_is_silent", return_value=silence):
            result = self.engine.transcribe("test.wav", language="auto", progress=progress, cancel_event=event)
        return result, model, progress

    @staticmethod
    def segment(text="다시 함께 웃어요", start=0, end=3, logprob=-0.2, no_speech=0.01):
        return SimpleNamespace(text=text, start=start, end=end, avg_logprob=logprob, no_speech_prob=no_speech)

    def test_missing_model_never_decodes_or_downloads(self):
        with patch.object(audio, "decode_audio") as decoder:
            self.assertEqual(self.engine.status()["status"], "missing")
            with self.assertRaises(audio.AudioModelUnavailable) as context:
                self.engine.transcribe("test.wav")
            self.assertEqual(context.exception.http_status, 503)
            decoder.assert_not_called()

    def test_ready_requires_pinned_revision_and_complete_files(self):
        manifest = self.install()
        with patch.object(audio.importlib.util, "find_spec", return_value=object()):
            self.assertTrue(self.engine.status()["ready"])
            manifest["revision"] = "main"
            (self.directory / "manifest.json").write_text(json.dumps(manifest))
            self.assertFalse(self.engine.status()["ready"])

    def test_weights_are_verified_before_loading(self):
        self.install()
        with self.assertRaises(audio.AudioModelUnavailable):
            self.engine._load_model()

    def test_local_only_cpu_int8_model_loading(self):
        manifest = self.install()
        factory = Mock()
        def digest(path):
            return manifest["files"][path.name]["sha256"]
        with patch.object(audio, "_sha256", side_effect=digest), patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=factory)}):
            self.engine._load_model()
            self.engine._load_model()
        factory.assert_called_once()
        kwargs = factory.call_args.kwargs
        self.assertTrue(kwargs["local_files_only"])
        self.assertEqual(kwargs["device"], "cpu")
        self.assertEqual(kwargs["compute_type"], "int8")
        self.assertLessEqual(kwargs["cpu_threads"], 4)

    def test_preserves_timestamps_and_sung_repetitions(self):
        result, model, progress = self.predict([self.segment(), self.segment(start=3, end=7)])
        self.assertEqual(len(result["segments"]), 2)
        self.assertEqual(result["language"], "ko")
        self.assertEqual(result["duration"], 10)
        self.assertEqual(result["text"].count("다시 함께 웃어요"), 2)
        options = model.transcribe.call_args.kwargs
        self.assertEqual(options["beam_size"], 5)
        self.assertFalse(options["condition_on_previous_text"])
        self.assertFalse(options["vad_filter"])
        self.assertEqual(options["task"], "transcribe")
        self.assertEqual(progress.call_args.args[0], 1.0)
        self.assertTrue(all(0 <= call.args[0] <= 1 for call in progress.call_args_list))

    def test_discards_only_overlapping_duplicate(self):
        result, _, _ = self.predict([self.segment(), self.segment(start=1, end=4)])
        self.assertEqual(len(result["segments"]), 1)

    def test_silence_returns_no_lyrics_and_skips_model_inference(self):
        result, model, _ = self.predict([], silence=True)
        self.assertTrue(result["no_speech"])
        self.assertEqual(result["text"], "")
        model.transcribe.assert_not_called()

    def test_no_speech_and_poor_probability_not_turned_into_lyrics(self):
        result, _, _ = self.predict([self.segment(text="幻觉", logprob=-2, no_speech=0.9)])
        self.assertTrue(result["no_speech"])
        self.assertEqual(result["segments"], [])

    def test_low_confidence_is_flagged_but_not_destroyed(self):
        result, _, _ = self.predict([self.segment(logprob=-1.2)])
        self.assertEqual(len(result["segments"]), 1)
        self.assertTrue(any("把握较低" in message for message in result["warnings"]))

    def test_nan_segment_is_rejected(self):
        result, _, _ = self.predict([self.segment(start=float("nan"))])
        self.assertEqual(result["segments"], [])

    def test_cancellation_before_decode(self):
        event = threading.Event()
        event.set()
        with self.assertRaises(audio.AudioCancelled) as context:
            self.engine.transcribe("test.wav", cancel_event=event)
        self.assertEqual(context.exception.code, "cancelled")

    def test_cancellation_while_iterating_releases_lock(self):
        event = threading.Event()
        def segments():
            yield self.segment()
            event.set()
            yield self.segment(start=4, end=6)
        with self.assertRaises(audio.AudioCancelled):
            self.predict(segments(), event=event)
        self.assertFalse(self.engine._lock.locked())

    def test_invalid_language(self):
        with self.assertRaises(audio.AudioValidationError):
            self.engine.transcribe("test.wav", language="../../")


class Array:
    def __init__(self, values):
        self.values = list(values)
        self.size = len(self.values)

    def __setitem__(self, key, value):
        self.values[key] = value.values

    def __getitem__(self, key):
        return Array(self.values[key])

    def reshape(self, *_):
        return self


class DecodeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "clip.wav"
        self.path.write_bytes(b"RIFF-test")
        self.stream = SimpleNamespace(duration=None, time_base=None, codec_context=SimpleNamespace())
        self.container = Mock()
        self.container.__enter__ = Mock(return_value=self.container)
        self.container.__exit__ = Mock(return_value=False)
        self.container.streams = SimpleNamespace(audio=[self.stream])
        self.frame = SimpleNamespace(sample_rate=16000, layout=SimpleNamespace(channels=[1]), pts=0)
        self.container.decode.return_value = iter([self.frame])
        self.converted = SimpleNamespace(to_ndarray=lambda: Array([0.1] * 5000))
        self.av = SimpleNamespace(open=Mock(return_value=self.container), AudioResampler=Mock(return_value=SimpleNamespace(resample=lambda frame: [self.converted] if frame else [])))
        self.numpy = SimpleNamespace(float32="float32", empty=lambda *a, **kw: Array([]), isfinite=lambda _: SimpleNamespace(all=lambda: True))

    def decode(self):
        with patch.dict(sys.modules, {"av": self.av, "numpy": self.numpy}):
            return audio.decode_audio(self.path)

    def test_decodes_only_local_file_in_fixed_format(self):
        result = self.decode()
        self.assertEqual(result.size, 5000)
        self.assertEqual(self.av.open.call_args.kwargs["format"], "wav")
        self.assertEqual(self.av.open.call_args.kwargs["options"], {"protocol_whitelist": "pipe"})
        self.assertFalse(isinstance(self.av.open.call_args.args[0], str))
        self.assertEqual(self.frame.pts, None)

    def test_rejects_duration_metadata_over_ten_minutes(self):
        self.stream.duration = 601
        self.stream.time_base = 1
        with self.assertRaises(audio.AudioValidationError):
            self.decode()

    def test_enforces_decoded_duration_when_metadata_lies(self):
        with patch.object(audio, "MAX_DURATION_SECONDS", 0.25):
            with self.assertRaises(audio.AudioValidationError):
                self.decode()

    def test_rejects_decoder_time_budget_overrun(self):
        with patch.object(audio.time, "monotonic", side_effect=[0.0, 46.0]):
            with self.assertRaises(audio.AudioValidationError):
                self.decode()

    def test_rejects_excessive_channels(self):
        self.frame.layout.channels = list(range(9))
        with self.assertRaises(audio.AudioValidationError):
            self.decode()

    def test_rejects_non_audio_format(self):
        self.path = self.path.with_suffix(".m3u")
        self.path.write_text("https://example.com/track.mp3")
        with self.assertRaises(audio.AudioValidationError):
            self.decode()
        self.av.open.assert_not_called()

    def test_corrupt_audio_is_reported(self):
        self.av.open.side_effect = RuntimeError("invalid")
        with self.assertRaises(audio.AudioValidationError) as context:
            self.decode()
        self.assertEqual(context.exception.http_status, 400)


if __name__ == "__main__":
    unittest.main()
