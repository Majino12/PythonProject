"""Independent failure, cancellation and retention checks for audio workers."""
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from backend.audio_jobs import AudioJobs
from backend.audio_transcriber import AudioModelUnavailable


class JobBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.jobs = None
        self.addCleanup(self.close)

    def close(self):
        if self.jobs is not None:
            self.jobs.close()

    def file(self, name):
        path = Path(self.directory.name) / name
        path.write_bytes(b'local temporary audio')
        return path

    def terminal(self, job_id):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            job = self.jobs.get(job_id)
            if job['status'] in {'completed', 'failed', 'cancelled'}:
                return job
            time.sleep(.002)
        self.fail('worker did not finish')

    def test_model_removed_between_acceptance_and_worker_reports_failure(self):
        class Engine:
            def transcribe(self, *args, **kwargs):
                raise AudioModelUnavailable('音频模型校验失败，请重新安装模型。')
        self.jobs = AudioJobs(Engine())
        path = self.file('changed-model.wav')
        job = self.terminal(self.jobs.submit(path))
        self.close()
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(job['error_code'], 'audio_model_unavailable')
        self.assertIn('校验失败', job['error'])
        self.assertIsNone(job['result'])
        self.assertFalse(path.exists())

    def test_unexpected_runtime_error_does_not_expose_internal_details(self):
        class Engine:
            def transcribe(self, *args, **kwargs):
                raise RuntimeError('/private/local/path secret internal stack')
        self.jobs = AudioJobs(Engine())
        path = self.file('internal-error.wav')
        job = self.terminal(self.jobs.submit(path))
        self.close()
        self.assertNotIn('secret', job['error'])
        self.assertEqual(job['error_code'], 'transcription_failed')
        self.assertFalse(path.exists())

    def test_queued_cancellation_skips_model_and_cleans_both_uploads(self):
        started = threading.Event()
        release = threading.Event()
        calls = []
        class Engine:
            def transcribe(self, path, **kwargs):
                calls.append(path)
                started.set()
                release.wait(2)
                return {'text': 'draft'}
        self.jobs = AudioJobs(Engine())
        first, second = self.file('first.wav'), self.file('second.wav')
        first_id = self.jobs.submit(first)
        self.assertTrue(started.wait(1))
        second_id = self.jobs.submit(second)
        self.jobs.cancel(second_id)
        release.set()
        self.assertEqual(self.terminal(first_id)['status'], 'completed')
        self.assertEqual(self.terminal(second_id)['status'], 'cancelled')
        self.close()
        self.assertEqual(calls, [first])
        self.assertFalse(first.exists())
        self.assertFalse(second.exists())

    def test_acknowledged_cancel_wins_over_pending_completion(self):
        class Engine:
            def transcribe(self, *args, **kwargs):
                return {'text': 'must not survive cancellation'}
        self.jobs = AudioJobs(Engine())
        about_to_publish = threading.Event()
        release_publication = threading.Event()
        original_update = self.jobs._update

        def gated_update(job_id, **fields):
            if fields.get('status') == 'completed':
                about_to_publish.set()
                release_publication.wait(2)
            return original_update(job_id, **fields)

        self.jobs._update = gated_update
        path = self.file('cancel-race.wav')
        job_id = self.jobs.submit(path)
        self.assertTrue(about_to_publish.wait(1))
        acknowledged = self.jobs.cancel(job_id)
        self.assertEqual(acknowledged['status'], 'cancelling')
        release_publication.set()
        completed = self.terminal(job_id)
        self.close()
        self.assertEqual(completed['status'], 'cancelled')
        self.assertIsNone(completed['result'])
        self.assertIsNone(completed['error'])
        self.assertFalse(path.exists())

    def test_completed_draft_remains_retrievable_until_ttl(self):
        class Engine:
            def transcribe(self, *args, **kwargs):
                return {'text': '校对用草稿'}
        self.jobs = AudioJobs(Engine(), ttl=60)
        job_id = self.jobs.submit(self.file('completed.wav'))
        self.terminal(job_id)
        self.close()
        self.assertEqual(self.jobs.get(job_id)['result']['text'], '校对用草稿')
        with patch('backend.audio_jobs.time.monotonic', return_value=time.monotonic() + 61):
            self.assertIsNone(self.jobs.get(job_id))


if __name__ == '__main__':
    unittest.main()
