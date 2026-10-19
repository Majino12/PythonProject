"""Audio uploads, cancellable jobs, and licensed-download API contracts."""
from io import BytesIO
from pathlib import Path
import tempfile
import threading
import time
import unittest

from backend.app import create_app
from backend.audio_transcriber import AudioTranscriptionError
from backend.music_search import MusicSearchError


class FakeTranscriber:
    def __init__(self):
        self.ready = True
        self.calls = []
        self.block = False
        self.started = threading.Event()

    def status(self):
        return {'status': 'ready' if self.ready else 'missing'}

    def transcribe(self, path, language=None, progress=None, cancel_event=None):
        self.calls.append((Path(path), language, Path(path).read_bytes()))
        self.started.set()
        if self.block:
            cancel_event.wait(3)
        if Path(path).read_bytes() == b'broken':
            raise AudioTranscriptionError('音频损坏。', 'invalid_audio', 400)
        progress(0.75, '已识别一段歌词')
        return {'text': '你把光留在我心里', 'language': language or 'zh',
                'duration': 3, 'segments': [{'start': 0, 'end': 3, 'text': '你把光留在我心里'}], 'warnings': []}


class FakeMusic:
    def search_lyrics(self, query):
        if query == 'failure':
            raise MusicSearchError('来源暂不可用', 'upstream_error', 502)
        return [self.get_lyrics(1)]

    def get_lyrics(self, record_id):
        if record_id == 99:
            raise MusicSearchError('未找到歌词', 'not_found', 404)
        return {'id': record_id, 'title': '原创歌', 'artist': '测试作者', 'plain_lyrics': '一行歌词',
                'synced_lyrics': '[00:01.00]一行歌词', 'instrumental': False}

    def search_audio(self, query):
        return [{'id': 'File:Example.ogg', 'title': 'Example', 'license': 'CC BY 4.0',
                 'source_url': 'https://commons.wikimedia.org/wiki/File:Example.ogg'}]

    def download_audio(self, record_id, destination):
        if record_id != 'File:Example.ogg':
            raise MusicSearchError('无效的音频记录', 'invalid_id', 400)
        Path(destination).write_bytes(b'OggS audio example')
        return {'mime': 'audio/ogg', 'license': 'CC BY 4.0'}


class MediaAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.transcriber = FakeTranscriber()
        self.music = FakeMusic()
        self.app = create_app({'TESTING': True, 'DATABASE_PATH': str(root/'songs.db'),
                               'UPLOAD_DIR': str(root/'uploads'), 'DOWNLOAD_DIR': str(root/'downloads'),
                               'MODEL_DIR': str(root/'models'), 'CACHE_DIR': str(root/'cache')},
                              audio_transcriber=self.transcriber, music_service=self.music)
        self.client = self.app.test_client()
        self.jobs = self.app.extensions['audio_jobs']

    def tearDown(self):
        self.jobs.close()
        self.app.extensions['database'].close()
        self.temp.cleanup()

    def upload(self, content=b'audio', filename='example.wav', **kwargs):
        return self.client.post('/api/audio/jobs', data={'file': (BytesIO(content), filename), 'language': 'ko'}, **kwargs)

    def finish(self, job_id):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            job = self.client.get('/api/audio/jobs/'+job_id).get_json()['job']
            if job['status'] in {'completed', 'failed', 'cancelled'}:
                return job
            time.sleep(0.005)
        self.fail('Job did not reach a terminal state')

    def test_upload_job_progress_result_and_original_file_cleanup(self):
        result = self.upload(filename='../../outside.wav')
        self.assertEqual(result.status_code, 202)
        job = self.finish(result.get_json()['job']['id'])
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(job['result']['language'], 'ko')
        self.assertEqual(job['progress'], 1)
        path, language, content = self.transcriber.calls[0]
        self.assertEqual(path.parent, Path(self.temp.name)/'uploads')
        self.assertFalse(path.exists())
        self.assertEqual(self.app.extensions['database'].get_analysis_stats()['total_songs'], 0)

    def test_validation_missing_model_invalid_file_empty_size_language(self):
        self.transcriber.ready = False
        self.assertEqual(self.upload().status_code, 503)
        self.transcriber.ready = True
        self.assertEqual(self.upload(filename='script.py').status_code, 400)
        self.assertEqual(self.upload(content=b'').status_code, 400)
        self.assertEqual(self.client.post('/api/audio/jobs', data={'language': 'ja'}).status_code, 400)
        self.app.config['MAX_AUDIO_BYTES'] = 2
        self.assertEqual(self.upload().status_code, 413)
        self.assertEqual(list((Path(self.temp.name)/'uploads').glob('*')), [])
        self.assertEqual(self.transcriber.calls, [])

    def test_corrupt_audio_failure_does_not_save_or_leave_file(self):
        job = self.finish(self.upload(content=b'broken').get_json()['job']['id'])
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(job['error_code'], 'invalid_audio')
        self.assertIsNone(job['result'])
        self.assertFalse(self.transcriber.calls[0][0].exists())

    def test_cancel_running_and_queued_jobs_releases_all_uploads(self):
        self.transcriber.block = True
        first = self.upload().get_json()['job']['id']
        self.assertTrue(self.transcriber.started.wait(1))
        second = self.upload().get_json()['job']['id']
        self.assertEqual(self.upload().status_code, 429)
        self.assertEqual(self.client.delete('/api/audio/jobs/'+second).status_code, 200)
        self.assertEqual(self.client.delete('/api/audio/jobs/'+first).status_code, 200)
        self.assertEqual(self.finish(first)['status'], 'cancelled')
        self.assertEqual(self.finish(second)['status'], 'cancelled')
        self.jobs.close()
        self.assertEqual(list((Path(self.temp.name)/'uploads').glob('*')), [])

    def test_cross_site_upload_and_missing_jobs_rejected(self):
        self.assertEqual(self.upload(headers={'Origin': 'https://unrelated.example'}).status_code, 403)
        self.assertEqual(self.upload(headers={'Sec-Fetch-Site': 'cross-site'}).status_code, 403)
        self.assertEqual(self.client.get('/api/audio/jobs/missing').status_code, 404)
        self.assertEqual(self.client.delete('/api/audio/jobs/missing').status_code, 404)
        self.assertEqual(self.transcriber.calls, [])

    def test_search_does_not_save_and_provider_errors_remain_explicit(self):
        result = self.client.get('/api/search/lyrics?q=歌曲').get_json()
        self.assertEqual(result['results'][0]['artist'], '测试作者')
        self.assertEqual(self.client.get('/api/search/lyrics?q=').status_code, 400)
        self.assertEqual(self.client.get('/api/search/lyrics?q=failure').status_code, 502)
        self.assertEqual(self.client.get('/api/search/lyrics/99').status_code, 404)
        self.assertEqual(self.client.get('/api/search/audio?q=folk').status_code, 200)
        self.assertEqual(self.app.extensions['database'].get_analysis_stats()['total_songs'], 0)

    def test_lyrics_and_audio_downloads_cleanup_and_attachment(self):
        response = self.client.get('/api/search/lyrics/1/download?format=lrc')
        self.assertEqual(response.status_code, 200)
        self.assertIn('attachment', response.headers['Content-Disposition'])
        self.assertIn('[00:01.00]', response.get_data(as_text=True))
        audio = self.client.get('/api/search/audio/download', query_string={'id': 'File:Example.ogg'})
        self.assertEqual(audio.status_code, 200)
        self.assertEqual(audio.data, b'OggS audio example')
        self.assertEqual(audio.headers['X-Audio-License'], 'CC BY 4.0')
        self.assertEqual(list((Path(self.temp.name)/'downloads').glob('*')), [])
        bad = self.client.get('/api/search/audio/download', query_string={'id': 'https://127.0.0.1/secret'})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(list((Path(self.temp.name)/'downloads').glob('*')), [])

    def test_large_json_retains_smaller_text_limit(self):
        response = self.client.post('/api/add_song', data='x'*(2*1024*1024+1), content_type='application/json')
        self.assertEqual(response.status_code, 413)
        self.assertTrue(response.is_json)


if __name__ == '__main__':
    unittest.main()
