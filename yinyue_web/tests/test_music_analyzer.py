"""Contract tests run without optional DSP dependencies; synthesis tests opt in."""

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import music_analyzer as module
from backend.music_analyzer import MusicAnalyzer, MusicAnalysisUnavailable
from backend.audio_transcriber import AudioCancelled, AudioValidationError

HAS_NUMPY = importlib.util.find_spec('numpy') is not None
HAS_AV = importlib.util.find_spec('av') is not None
if HAS_NUMPY:
    import numpy as np


def mock_report():
    return dict(summary='measured', features=[], timeline=[], pitch={'available': False},
                emotions=[], warnings=[], insufficient_evidence=False, mood_evidence=True)


class MusicContractTests(unittest.TestCase):
    def test_status_does_not_import_numeric_packages_or_download(self):
        with patch.object(module.importlib.util, 'find_spec', return_value=None):
            status = MusicAnalyzer().status()
        self.assertFalse(status['ready'])
        self.assertTrue(status['offline'])
        self.assertEqual(status['max_duration_seconds'], 600)
        self.assertEqual(status['max_audio_bytes'], 30 * 1024 * 1024)
        self.assertEqual(status['dependencies'], {'numpy': False, 'av': False})

    def test_missing_dependencies_fail_before_decode(self):
        with patch.object(MusicAnalyzer, 'status', return_value={'ready': False}), patch.object(module, 'decode_audio') as decode:
            with self.assertRaises(MusicAnalysisUnavailable) as error:
                MusicAnalyzer().analyze('missing.wav')
        self.assertEqual(error.exception.http_status, 503)
        decode.assert_not_called()

    def test_unknown_goal_rejected_before_work(self):
        for goal in ('happy', '', None, [], 2):
            with self.subTest(goal=goal), patch.object(module, 'decode_audio') as decode:
                with self.assertRaises(AudioValidationError):
                    MusicAnalyzer().analyze('anything.wav', goal=goal)
                decode.assert_not_called()

    def test_cancel_is_not_a_successful_analysis(self):
        event = threading.Event()
        event.set()
        with patch.object(module, 'decode_audio') as decode:
            with self.assertRaises(AudioCancelled):
                MusicAnalyzer().analyze('anything.wav', cancel_event=event)
        decode.assert_not_called()

    def test_mocked_analysis_contract_without_numpy(self):
        events = []
        with patch.object(MusicAnalyzer, 'status', return_value={'ready': True}), \
             patch.object(module, 'decode_audio', return_value=[0] * (module.SAMPLE_RATE * 4)), \
             patch.object(MusicAnalyzer, '_extract', return_value=mock_report()):
            report = MusicAnalyzer().analyze('not-read.wav', goal='calmer',
                                            progress=lambda value, text: events.append((value, text)))
        self.assertEqual(report['duration'], 4)
        self.assertEqual(report['goal'], 'calmer')
        self.assertTrue(report['available'])
        self.assertEqual(report['suggestions'], {'arrangement': [], 'melody': []})
        self.assertFalse(report['mood_model']['available'])
        self.assertNotIn('insufficient_evidence', report)
        self.assertEqual(events[-1][0], 1)
        self.assertTrue(all(0 <= value <= 1 for value, _ in events))
        json.dumps(report, allow_nan=False)

    def test_model_score_is_not_rewritten_as_probability(self):
        payload = {'available': True, 'method': 'CLAP cosine',
                   'scores': [{'label': 'dark', 'name_zh': '暗沉', 'score': -0.12}],
                   'coverage': {'ratio': 0.25}, 'warnings': []}
        class Mood:
            def analyze(self, audio, sample_rate, cancel_event, progress):
                progress('模型测量中')
                return copy.deepcopy(payload)
        calls = []
        with patch.object(MusicAnalyzer, 'status', return_value={'ready': True}), \
             patch.object(module, 'decode_audio', return_value=[0] * (module.SAMPLE_RATE * 4)), \
             patch.object(MusicAnalyzer, '_extract', return_value=mock_report()):
            report = MusicAnalyzer(audio_mood_engine=Mood()).analyze('unused', progress=lambda *args: calls.append(args))
        self.assertEqual(report['mood_model'], payload)
        self.assertTrue(any(message == '模型测量中' for _, message in calls))

    def test_model_failure_retains_measurements_and_cancellation_propagates(self):
        for failure in (RuntimeError('model unavailable'), AudioCancelled()):
            mood = Mock()
            mood.analyze.side_effect = failure
            with self.subTest(failure=failure), patch.object(MusicAnalyzer, 'status', return_value={'ready': True}), \
                 patch.object(module, 'decode_audio', return_value=[0] * (module.SAMPLE_RATE * 4)), \
                 patch.object(MusicAnalyzer, '_extract', side_effect=lambda *_: mock_report()):
                if isinstance(failure, AudioCancelled):
                    with self.assertRaises(AudioCancelled):
                        MusicAnalyzer(mood).analyze('unused')
                else:
                    report = MusicAnalyzer(mood).analyze('unused')
                    self.assertTrue(report['available'])
                    self.assertFalse(report['mood_model']['available'])
                    self.assertIn('不可用', report['mood_model']['warnings'][0])

    def test_decoded_duration_is_bounded_even_with_custom_decoder(self):
        class TooLong:
            def __len__(self):
                return 600 * module.SAMPLE_RATE + 1
        with patch.object(MusicAnalyzer, 'status', return_value={'ready': True}), \
             patch.object(module, 'decode_audio', return_value=TooLong()), \
             patch.object(MusicAnalyzer, '_extract') as extract:
            with self.assertRaises(AudioValidationError):
                MusicAnalyzer().analyze('unused')
        extract.assert_not_called()


@unittest.skipUnless(HAS_NUMPY, 'Optional NumPy DSP dependency is not installed')
class MusicDSPTests(unittest.TestCase):
    sr = 16000

    def tone(self, frequency=440, seconds=12, amplitude=0.25):
        return (amplitude * np.sin(2 * np.pi * frequency * np.arange(int(seconds * self.sr)) / self.sr)).astype(np.float32)

    def clicks(self, bpm=120, seconds=16):
        output = np.zeros(int(seconds * self.sr), dtype=np.float32)
        click = np.random.default_rng(5).normal(size=400) * np.exp(-np.arange(400) / 70) * 0.35
        for time in np.arange(0.5, seconds - 0.1, 60 / bpm):
            start = int(time * self.sr)
            output[start:start + len(click)] += click
        return output

    def run_audio(self, audio, goal='preserve', **kwargs):
        analyzer = kwargs.pop('analyzer', None) or MusicAnalyzer()
        with patch.object(MusicAnalyzer, 'status', return_value={'ready': True}), \
             patch.object(module, 'decode_audio', return_value=audio):
            result = analyzer.analyze('synthetic.wav', goal=goal, **kwargs)
        json.dumps(result, allow_nan=False)
        return result

    @staticmethod
    def values(report):
        return {feature['key']: feature['value'] for feature in report['features']}

    def test_silence_does_not_invent_mood_tempo_pitch_or_edits(self):
        mood = Mock()
        result = self.run_audio(np.zeros(self.sr * 6), analyzer=MusicAnalyzer(mood))
        self.assertEqual(result['emotions'], [])
        self.assertIsNone(self.values(result)['tempo'])
        self.assertFalse(result['pitch']['available'])
        self.assertIsNone(result['pitch']['key'])
        self.assertIsNone(result['pitch']['mode'])
        self.assertEqual(result['suggestions'], {'arrangement': [], 'melody': []})
        mood.analyze.assert_not_called()

    def test_short_sound_keeps_measurements_but_withholds_inference(self):
        result = self.run_audio(self.tone(seconds=0.5))
        self.assertIsNotNone(self.values(result)['rms_dbfs'])
        self.assertIsNone(self.values(result)['tempo'])
        self.assertEqual(result['emotions'], [])
        self.assertFalse(result['pitch']['available'])
        self.assertEqual(result['suggestions']['melody'], [])

    def test_sine_pitch_is_a4_without_fabricated_beat_or_emotion(self):
        result = self.run_audio(self.tone())
        self.assertEqual(result['pitch']['dominant_note'], 'A4')
        self.assertLess(result['pitch']['range_semitones'], 0.3)
        self.assertGreater(result['pitch']['coverage'], 0.95)
        self.assertIsNone(self.values(result)['tempo'])
        self.assertEqual(result['emotions'], [])
        self.assertIn('不是', result['pitch']['note'])

    def test_stationary_noise_does_not_become_a_tune_or_mood(self):
        audio = np.random.default_rng(2).normal(0, 0.1, self.sr * 12).astype(np.float32)
        result = self.run_audio(audio)
        self.assertFalse(result['pitch']['available'])
        self.assertIsNone(self.values(result)['tempo'])
        self.assertEqual(result['emotions'], [])

    def test_click_tempos_and_reliability(self):
        for bpm in (80, 120, 160):
            with self.subTest(bpm=bpm):
                result = self.run_audio(self.clicks(bpm))
                value = self.values(result)['tempo']
                self.assertIsNotNone(value)
                self.assertLess(abs(value - bpm), 3)
                feature = next(item for item in result['features'] if item['key'] == 'tempo')
                self.assertGreater(feature['reliability'], 0.4)

    def test_brightness_and_bass_follow_frequency_relationships(self):
        bass = self.values(self.run_audio(self.tone(100)))
        treble = self.values(self.run_audio(self.tone(2200)))
        self.assertGreater(treble['spectral_centroid_hz'], bass['spectral_centroid_hz'] * 10)
        self.assertGreater(bass['low_frequency_ratio'], 0.95)
        self.assertLess(treble['low_frequency_ratio'], 0.05)

    def test_gain_affects_rms_but_not_pitch(self):
        loud = self.run_audio(self.tone(amplitude=0.5))
        quiet = self.run_audio(self.tone(amplitude=0.05))
        self.assertAlmostEqual(self.values(loud)['rms_dbfs'] - self.values(quiet)['rms_dbfs'], 20, delta=0.01)
        self.assertEqual(loud['pitch']['dominant_note'], quiet['pitch']['dominant_note'])

    def test_moving_tone_contour_and_timeline_are_bounded(self):
        audio = np.concatenate([self.tone(hz, seconds=4) for hz in (330, 440, 660)])
        report = self.run_audio(audio)
        self.assertGreater(report['pitch']['range_semitones'], 10)
        self.assertLessEqual(len(report['pitch']['contour']), 240)
        self.assertLessEqual(len(report['timeline']), 60)
        self.assertEqual(report['timeline'][0]['start'], 0)
        self.assertEqual(report['timeline'][-1]['end'], 12)
        for item in report['timeline']:
            self.assertTrue(0 <= item['energy'] <= 1)
            self.assertTrue(0 <= item['start'] < item['end'] <= 12)

    def test_advice_changes_with_goal_and_measured_evidence(self):
        audio = self.clicks(120) + self.tone(100, seconds=16, amplitude=0.05)
        calm = self.run_audio(audio, goal='calmer')
        bright = self.run_audio(audio, goal='uplifting')
        self.assertNotEqual(calm['suggestions'], bright['suggestions'])
        for report in (calm, bright):
            self.assertTrue(report['suggestions']['arrangement'])
            for group in report['suggestions'].values():
                for suggestion in group:
                    self.assertEqual(set(suggestion), {'title', 'evidence', 'action', 'expected_effect'})
                    self.assertIn('秒', suggestion['evidence'])
        percussion = self.run_audio(self.clicks())
        self.assertEqual(percussion['suggestions']['melody'], [])

    def test_cancel_during_dsp_never_emits_completion(self):
        event, messages = threading.Event(), []
        def progress(value, message):
            messages.append(value)
            if value >= 0.6:
                event.set()
        with self.assertRaises(AudioCancelled):
            self.run_audio(self.tone(seconds=18), cancel_event=event, progress=progress)
        self.assertNotIn(1.0, messages)

    @unittest.skipUnless(HAS_AV, 'Optional PyAV decoder is not installed')
    def test_real_wav_decoding_and_no_lyric_model_required(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tone.wav'
            with wave.open(str(path), 'wb') as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(self.sr)
                output.writeframes((self.tone(seconds=4) * 32767).astype('<i2').tobytes())
            result = MusicAnalyzer().analyze(path)
        self.assertAlmostEqual(result['duration'], 4, places=2)
        self.assertEqual(result['pitch']['dominant_note'], 'A4')


if __name__ == '__main__':
    unittest.main()
