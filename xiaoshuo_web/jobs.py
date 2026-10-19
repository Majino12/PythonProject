"""Bounded background jobs with atomic, private on-disk state.

Run the web service in one process. Interrupted jobs explicitly fail after a
restart. The original novel is held only for the job's lifetime.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import uuid


ID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def valid_id(value):
    return isinstance(value, str) and bool(ID_PATTERN.fullmatch(value))


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class QueueFullError(Exception):
    pass


class JobStore:
    def __init__(self, data_dir, workers=1, queue_size=2):
        if workers < 1 or queue_size < 0:
            raise ValueError("JOB_WORKERS 必须大于 0，JOB_QUEUE_SIZE 不能小于 0")
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.jobs_dir = self.data_dir / "jobs"
        self.results_dir = self.data_dir / "results"
        for directory in (self.data_dir, self.jobs_dir, self.results_dir):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
        self._lock = threading.RLock()
        self._slots = threading.BoundedSemaphore(workers + queue_size)
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="novel-analysis")
        self._recover_interrupted()

    def _write(self, path, data):
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".pending-", suffix=".json")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @staticmethod
    def _read(path):
        try:
            with path.open(encoding="utf-8") as stream:
                value = json.load(stream)
            return value if isinstance(value, dict) else None
        except (FileNotFoundError, OSError, ValueError):
            return None

    def get_job(self, task_id):
        if not valid_id(task_id):
            return None
        with self._lock:
            return self._read(self.jobs_dir / f"{task_id}.json")

    def get_result(self, result_id):
        if not valid_id(result_id):
            return None
        with self._lock:
            return self._read(self.results_dir / f"{result_id}.json")

    def list_jobs(self):
        with self._lock:
            jobs = [self._read(path) for path in self.jobs_dir.glob("*.json") if valid_id(path.stem)]
        return sorted((job for job in jobs if job), key=lambda job: job.get("created_at", ""), reverse=True)

    def _recover_interrupted(self):
        for job in self.list_jobs():
            if job.get("status") in {"queued", "processing"}:
                if self.get_result(job["task_id"]):
                    self._update(job["task_id"], status="completed", stage="completed", progress=100,
                                 result_id=job["task_id"], finished_at=utc_now())
                else:
                    self._update(job["task_id"], status="failed", stage="interrupted",
                                 error="服务重启中断了此任务，请重新提交原文。", finished_at=utc_now())

    def _update(self, task_id, **updates):
        with self._lock:
            job = self.get_job(task_id)
            if job is None:
                raise RuntimeError("分析任务状态文件丢失")
            job.update(updates)
            job["updated_at"] = utc_now()
            self._write(self.jobs_dir / f"{task_id}.json", job)

    def submit(self, analyze, title, source, analysis_type, mode):
        if not self._slots.acquire(blocking=False):
            raise QueueFullError("分析队列已满，请等待当前任务结束后再提交。")
        task_id = str(uuid.uuid4())
        now = utc_now()
        job = {"task_id": task_id, "result_id": task_id, "title": title, "source": source,
               "type": analysis_type, "mode": mode, "status": "queued", "stage": "queued",
               "progress": 0, "completed_units": 0, "total_units": 0, "error": None,
               "message": "",
               "created_at": now, "updated_at": now, "started_at": None, "finished_at": None,
               "duration_seconds": None}
        try:
            with self._lock:
                self._write(self.jobs_dir / f"{task_id}.json", job)
            self._executor.submit(self._run, task_id, analyze)
        except Exception:
            self._slots.release()
            if self.get_job(task_id):
                self._update(task_id, status="failed", stage="failed", error="无法启动分析任务。")
            raise
        return task_id

    def _run(self, task_id, analyze):
        started = time.monotonic()
        try:
            self._update(task_id, status="processing", stage="preparing", started_at=utc_now())

            def progress(update):
                if not isinstance(update, dict):
                    return
                updates = {key: update[key] for key in ("stage", "completed_units", "total_units") if key in update}
                if isinstance(update.get("message"), str):
                    updates["message"] = update["message"][:500]
                if "progress" in update:
                    updates["progress"] = max(0, min(99, float(update["progress"])))
                self._update(task_id, **updates)

            result = analyze(progress)
            if not isinstance(result, dict):
                raise ValueError("分析器没有返回有效结果")
            if result.get("error"):
                raise ValueError(result["error"])
            job = self.get_job(task_id)
            duration = round(time.monotonic() - started, 3)
            result.update(result_id=task_id, timestamp=utc_now(), source=job["source"],
                          duration=f"{duration}s", duration_seconds=duration, type=job["type"])
            with self._lock:
                self._write(self.results_dir / f"{task_id}.json", result)
            self._update(task_id, status="completed", stage="completed", progress=100,
                         finished_at=utc_now(), duration_seconds=duration,
                         completed_units=job["total_units"] or job["completed_units"])
        except Exception as exc:
            self._update(task_id, status="failed", stage="failed", error=str(exc) or type(exc).__name__,
                         finished_at=utc_now(), duration_seconds=round(time.monotonic() - started, 3))
        finally:
            self._slots.release()

    def shutdown(self, wait=True):
        self._executor.shutdown(wait=wait)
