"""Music-only jobs must not require lyrics; optional ASR cannot erase analysis."""
from io import BytesIO
from pathlib import Path
import tempfile
import threading
import time
import unittest

from backend.app import create_app
from backend.audio_pipeline import AudioPipeline
from backend.audio_transcriber import AudioCancelled


class Transcriber:
    def __init__(self, ready=True, failure=False):
        self.ready, self.failure = ready, failure
        self.calls = 0

    def status(self):
        return {'status': 'ready' if self.ready else 'missing'}

    def transcribe(self, path, **kwargs):
        self.calls += 1
        if self.failure:
            raise RuntimeError('private implementation detail')
        if kwargs.get('progress'):
            for value in [.7, .3, float('nan'), .95]:
                kwargs['progress'](value, '识词进度')
        return {'text': 'original lyric', 'duration': 12, 'segments': [], 'language': 'en', 'warnings': []}


class Analyzer:
    def __init__(self, ready=True):
        self.ready, self.calls = ready, []

    def status(self):
        return {'ready': self.ready, 'available': self.ready}

    def analyze(self, path, goal='preserve', progress=None, cancel_event=None):
        self.calls.append((Path(path), goal))
        progress(.7, '分析音乐')
        return {'available': True, 'duration': 12, 'goal': goal, 'features': [], 'warnings': [],
                'suggestions': {'arrangement': [{'title': 'test evidence'}], 'melody': []}}


class MusicPipelineTests(unittest.TestCase):
    def test_music_only_never_calls_transcriber(self):
        transcriber, analyzer = Transcriber(ready=False), Analyzer()
        result = AudioPipeline(transcriber, analyzer).process('test.wav', mode='music', goal='calmer')
        self.assertEqual(transcriber.calls, 0)
        self.assertEqual(result['music_analysis']['goal'], 'calmer')
        self.assertEqual(result['transcription_status']['status'], 'skipped')
        self.assertEqual(result['text'], '')

    def test_combined_missing_asr_keeps_music(self):
        transcriber = Transcriber(ready=False)
        result = AudioPipeline(transcriber, Analyzer()).process('test.wav', mode='combined')
        self.assertTrue(result['music_analysis']['available'])
        self.assertEqual(result['transcription_status']['status'], 'unavailable')
        self.assertEqual(transcriber.calls, 0)

    def test_combined_failed_asr_keeps_music_and_hides_internal_error(self):
        result = AudioPipeline(Transcriber(failure=True), Analyzer()).process('test.wav', mode='combined')
        self.assertEqual(result['transcription_status']['status'], 'failed')
        self.assertNotIn('private', str(result))
        self.assertTrue(result['music_analysis']['available'])

    def test_status_failure_also_preserves_completed_music(self):
        class BrokenStatus(Transcriber):
            def status(self):
                raise OSError('private file error')
        result = AudioPipeline(BrokenStatus(), Analyzer()).process('test.wav', mode='combined')
        self.assertEqual(result['transcription_status']['status'], 'failed')
        self.assertTrue(result['music_analysis']['available'])
        self.assertNotIn('private', str(result))

    def test_transcription_only_progress_never_regresses_or_returns_nan(self):
        values = []
        AudioPipeline(Transcriber(), Analyzer()).process(
            'test.wav', mode='transcribe', progress=lambda value, message: values.append(value))
        self.assertEqual(values, [.7, .7, .95])

    def test_combined_success_retains_both_results_and_monotonic_progress(self):
        values = []
        result = AudioPipeline(Transcriber(), Analyzer()).process(
            'test.wav', mode='combined', progress=lambda value, message: values.append(value))
        self.assertEqual(result['text'], 'original lyric')
        self.assertIn('music_analysis', result)
        self.assertEqual(result['transcription_status']['status'], 'completed')
        self.assertEqual(values, sorted(values))

    def test_cancel_between_music_and_asr_does_not_publish_partial_result(self):
        event = threading.Event()
        class CancellingAnalyzer(Analyzer):
            def analyze(self, *args, **kwargs):
                result = super().analyze(*args, **kwargs)
                event.set()
                return result
        transcriber = Transcriber()
        with self.assertRaises(AudioCancelled):
            AudioPipeline(transcriber, CancellingAnalyzer()).process('test.wav', mode='combined', cancel_event=event)
        self.assertEqual(transcriber.calls, 0)


class MusicAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.transcriber, self.analyzer = Transcriber(ready=False), Analyzer()
        self.app = create_app({'TESTING': True, 'DATABASE_PATH': str(root/'songs.db'),
            'UPLOAD_DIR': str(root/'uploads'), 'MODEL_DIR': str(root/'models'), 'CACHE_DIR': str(root/'cache')},
            audio_transcriber=self.transcriber, music_analyzer=self.analyzer)
        self.client = self.app.test_client()
        self.jobs = self.app.extensions['audio_jobs']

    def tearDown(self):
        self.jobs.close()
        self.app.extensions['database'].close()
        self.temp.cleanup()

    def upload(self, **options):
        return self.client.post('/api/audio/jobs', data={'file': (BytesIO(b'audio'), 'demo.wav'), **options})

    def finish(self, job_id):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            result = self.jobs.get(job_id)
            if result['status'] in {'completed', 'failed', 'cancelled'}:
                return result
            time.sleep(.003)
        self.fail('Audio job did not finish')

    def test_music_job_without_whisper_cleans_upload_and_does_not_write_lyrics(self):
        response = self.upload(mode='music', goal='uplifting')
        self.assertEqual(response.status_code, 202)
        job = self.finish(response.get_json()['job']['id'])
        self.jobs.close()
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(job['result']['music_analysis']['goal'], 'uplifting')
        self.assertEqual(job['mode'], 'music')
        self.assertFalse(self.analyzer.calls[0][0].exists())
        self.assertEqual(self.app.extensions['database'].get_analysis_stats()['total_songs'], 0)

    def test_modes_validate_and_legacy_transcription_still_requires_model(self):
        self.assertEqual(self.upload().status_code, 503)
        self.assertEqual(self.upload(mode='anything').status_code, 400)
        self.assertEqual(self.upload(mode='music', goal='anything').status_code, 400)
        self.assertEqual(self.analyzer.calls, [])
        self.analyzer.ready = False
        self.assertEqual(self.upload(mode='music').status_code, 503)
        self.transcriber.ready = True
        self.assertEqual(self.upload(mode='transcribe').status_code, 202)

    def test_status_separates_music_and_whisper_readiness(self):
        status = self.client.get('/api/audio/status').get_json()
        self.assertEqual(status['status'], 'missing')
        self.assertEqual(status['music']['status'], 'ready')
        self.assertTrue(self.client.get('/api/health').get_json()['music']['ready'])


if __name__ == '__main__':
    unittest.main()
