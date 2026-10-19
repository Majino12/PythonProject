"""Bounded in-process transcription jobs; uploaded audio is always temporary."""
from concurrent.futures import ThreadPoolExecutor
import logging
from pathlib import Path
import threading
import time
from uuid import uuid4

logger = logging.getLogger(__name__)


class QueueFull(RuntimeError):
    pass


class AudioJobs:
    def __init__(self, transcriber, *, capacity=2, ttl=3600):
        self.transcriber = transcriber
        self.capacity, self.ttl = capacity, ttl
        self._jobs = {}
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='lyrics-transcription')

    def _prune(self):
        now = time.monotonic()
        for job_id, job in list(self._jobs.items()):
            if job['status'] in {'completed', 'failed', 'cancelled'} and now - job['_updated'] > self.ttl:
                del self._jobs[job_id]

    def submit(self, path, language=None):
        path = Path(path)
        with self._lock:
            self._prune()
            if sum(job['status'] in {'queued', 'running', 'cancelling'} for job in self._jobs.values()) >= self.capacity:
                raise QueueFull('当前转写任务已满，请等待正在处理的音频完成。')
            job_id = uuid4().hex
            self._jobs[job_id] = {'id': job_id, 'status': 'queued', 'progress': 0.0,
                                  'message': '等待转写', 'result': None, 'error': None,
                                  '_cancel': threading.Event(), '_updated': time.monotonic()}
            self._executor.submit(self._run, job_id, path, language)
            return job_id

    def _update(self, job_id, **fields):
        with self._lock:
            job = self._jobs[job_id]
            # Cancellation and terminal publication must be atomic. A cancel
            # accepted just before completion must never expose a completed result.
            if job['_cancel'].is_set():
                if fields.get('status') in {'completed', 'failed', 'cancelled'}:
                    fields.update(status='cancelled', message='已取消', result=None, error=None)
                else:
                    fields.update(status='cancelling', message='正在取消，等待当前片段结束')
            job.update(fields, _updated=time.monotonic())

    def _run(self, job_id, path, language):
        event = self._jobs[job_id]['_cancel']
        try:
            if event.is_set():
                self._update(job_id, status='cancelled', message='已取消')
                return
            self._update(job_id, status='running', message='正在加载模型并解码音频')

            def progress(value, message='正在识别歌词'):
                self._update(job_id, progress=max(0, min(0.99, float(value))),
                             message='正在取消，等待当前片段结束' if event.is_set() else str(message))

            result = self.transcriber.transcribe(path, language=language, progress=progress, cancel_event=event)
            if event.is_set():
                self._update(job_id, status='cancelled', message='已取消')
            else:
                self._update(job_id, status='completed', progress=1.0, message='转写完成，请校对歌词', result=result)
        except Exception as error:
            if event.is_set():
                self._update(job_id, status='cancelled', message='已取消')
            else:
                logger.warning('Audio transcription failed: %s', type(error).__name__)
                message = getattr(error, 'message', None) or '音频转写失败，请检查文件及模型状态后重试。'
                code = getattr(error, 'code', 'transcription_failed')
                self._update(job_id, status='failed', message=message, error=message, error_code=code)
        finally:
            path.unlink(missing_ok=True)

    def get(self, job_id):
        with self._lock:
            self._prune()
            job = self._jobs.get(job_id)
            return {key: value for key, value in job.items() if not key.startswith('_')} if job else None

    def cancel(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job['status'] in {'queued', 'running', 'cancelling'}:
                job['_cancel'].set()
                job.update(status='cancelling', message='正在取消，等待当前片段结束')
            return self.get(job_id)

    def close(self):
        with self._lock:
            for job in self._jobs.values():
                job['_cancel'].set()
        self._executor.shutdown(wait=True)
