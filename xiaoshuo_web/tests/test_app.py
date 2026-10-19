import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid

from app import create_app
from jobs import JobStore


class FakeModels:
    configured = False

    def describe(self):
        return {"configured": self.configured, "provider": "disabled", "models": {}}

    def check_health(self):
        return {**self.describe(), "availability_checked": True, "available": False}


class BlockingAnalyzer:
    def __init__(self, fail=False):
        self.started = threading.Event()
        self.release = threading.Event()
        self.fail = fail
        self.received = None
        self.metadata = None
        self.message = "正在核对正文。"

    def analyze_novel_text(self, content, title, progress_callback=None, mode="auto"):
        self.received = (content, title, mode)
        progress_callback({"stage": "map", "progress": 25, "completed_units": 1, "total_units": 4,
                           "message": self.message})
        self.started.set()
        if not self.release.wait(timeout=10):
            raise RuntimeError("Test did not release analyzer")
        if self.fail:
            raise ValueError("provider unavailable; analysis stopped")
        result = {"novel_info": {"title": title, "total_chapters": 4}, "received_characters": len(content)}
        if self.metadata is not None:
            result["analysis_metadata"] = self.metadata
        return result

    def fetch_content_from_url(self, url, analysis_type):
        return "Fetched page", "Fetched page contents. " * 8


class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.analyzer = BlockingAnalyzer()
        self.app = create_app({"TESTING": True, "DATA_DIR": self.temporary.name,
                               "JOB_WORKERS": 1, "JOB_QUEUE_SIZE": 0},
                              analyzer=self.analyzer, model_client=FakeModels())
        self.client = self.app.test_client()
        self.jobs = self.app.extensions["novel_jobs"]

    def tearDown(self):
        self.analyzer.release.set()
        self.jobs.shutdown()
        self.temporary.cleanup()

    def submit(self, **extra):
        payload = {"analysis_type": "text", "text_content": "第一章 完整正文。" * 15, "title": "Test book"}
        payload.update(extra)
        return self.client.post("/analyze", data=payload)

    def await_finished(self, task_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = self.client.get(f"/analysis/status/{task_id}").get_json()
            if job["status"] in {"completed", "failed"}:
                return job
            time.sleep(0.01)
        self.fail("Background analysis did not finish")

    def test_real_async_progress_result_and_history(self):
        self.analyzer.message = "正在核对正文。" + "x" * 600
        response = self.submit(analysis_mode="baseline")
        self.assertEqual(response.status_code, 202)
        task_id = response.get_json()["task_id"]
        self.assertTrue(self.analyzer.started.wait(timeout=2))
        status = self.client.get(f"/analysis/status/{task_id}").get_json()
        self.assertEqual(status["status"], "processing")
        self.assertEqual(status["stage"], "map")
        self.assertEqual(status["progress"], 25)
        self.assertEqual(status["completed_units"], 1)
        self.assertEqual(status["total_units"], 4)
        self.assertEqual(status["message"], self.analyzer.message[:500])
        self.assertEqual(self.client.get(f"/export/{task_id}").status_code, 404)
        self.assertIsNone(self.client.get("/api/history").get_json()[0]["duration"])
        stats = self.client.get("/api/stats").get_json()["application"]
        self.assertEqual(stats["active_tasks"], 1)
        self.analyzer.release.set()
        finished = self.await_finished(task_id)
        self.assertEqual(finished["status"], "completed")
        self.assertEqual(finished["progress"], 100)
        result = self.client.get(f"/export/{task_id}").get_json()
        self.assertEqual(result["received_characters"], len("第一章 完整正文。" * 15))
        self.assertEqual(self.analyzer.received[2], "baseline")
        self.assertGreaterEqual(result["duration_seconds"], 0)
        history = self.client.get("/api/history").get_json()
        self.assertEqual(history[0]["status"], "completed")
        self.assertEqual(history[0]["duration_seconds"], result["duration_seconds"])
        self.assertEqual((Path(self.temporary.name) / "results" / f"{task_id}.json").stat().st_mode & 0o777, 0o600)

    def test_unknown_and_unsafe_ids_are_not_fake_processing(self):
        for task_id in (str(uuid.uuid4()), "missing", "..%2F..%2Fconfig"):
            self.assertEqual(self.client.get(f"/analysis/status/{task_id}").status_code, 404)
            self.assertEqual(self.client.get(f"/export/{task_id}").status_code, 404)
        self.assertEqual(self.client.get("/static/uploads/old-book.txt").status_code, 404)
        self.assertEqual(self.client.get("/static/results/old-result.json").status_code, 404)

    def test_bounded_queue_rejects_overload(self):
        first = self.submit()
        self.assertEqual(first.status_code, 202)
        self.assertTrue(self.analyzer.started.wait(timeout=2))
        second = self.submit()
        self.assertEqual(second.status_code, 429)
        self.assertIn("Retry-After", second.headers)
        self.assertEqual(len(self.jobs.list_jobs()), 1)

    def test_failures_are_persisted_without_success_report(self):
        self.analyzer.fail = True
        response = self.submit()
        self.analyzer.release.set()
        task_id = response.get_json()["task_id"]
        status = self.await_finished(task_id)
        self.assertEqual(status["status"], "failed")
        self.assertIn("provider unavailable", status["error"])
        self.assertLess(status["progress"], 100)
        self.assertIsNone(self.jobs.get_result(task_id))
        self.assertEqual(self.client.get("/api/history").get_json()[0]["status"], "failed")

    def test_history_distinguishes_partial_report_from_completed_job(self):
        self.analyzer.metadata = {"status": "partial", "mode": "model", "coverage_ratio": 0.75}
        response = self.submit()
        task_id = response.get_json()["task_id"]
        pending = self.client.get("/api/history").get_json()[0]
        self.assertIsNone(pending["coverage_ratio"])
        self.assertIsNone(pending["analysis_status"])
        self.analyzer.release.set()
        self.await_finished(task_id)
        history = self.client.get("/api/history").get_json()[0]
        self.assertEqual(history["status"], "completed")
        self.assertEqual(history["analysis_status"], "partial")
        self.assertEqual(history["mode"], "model")
        self.assertEqual(history["coverage_ratio"], 0.75)

    def test_text_below_analyzer_minimum_is_rejected_before_queue(self):
        response = self.submit(text_content="x" * 99)
        self.assertEqual(response.status_code, 400)
        self.assertIn("100", response.get_json()["error"])
        self.assertFalse(self.jobs.list_jobs())

    def test_invalid_modes_and_unconfigured_model_fail_before_submit(self):
        self.assertEqual(self.submit(analysis_mode="invented").status_code, 400)
        response = self.submit(analysis_mode="model")
        self.assertEqual(response.status_code, 400)
        self.assertIn("尚未配置", response.get_json()["error"])
        self.assertFalse(self.jobs.list_jobs())

    def test_entire_input_is_rejected_never_truncated(self):
        self.app.config["MAX_ANALYSIS_TEXT_LENGTH"] = 100
        response = self.submit(text_content="x" * 101)
        self.assertEqual(response.status_code, 400)
        self.assertIn("不会截断", response.get_json()["error"])
        self.assertFalse(self.jobs.list_jobs())

    def test_malformed_file_and_unsupported_extension(self):
        for filename in ("novel.docx", "novel.pdf", "novel.exe"):
            response = self.client.post("/analyze", data={"analysis_type": "file", "file": (io.BytesIO(b"broken file"), filename)})
            self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
        self.assertFalse(self.jobs.list_jobs())

    def test_gb18030_file_has_no_public_copy(self):
        content = "第一章\n我们在河边找到了整本失传的书。" * 20
        response = self.client.post("/analyze", data={"analysis_type": "file", "file": (io.BytesIO(content.encode("gb18030")), "../../novel.txt")})
        self.assertEqual(response.status_code, 202)
        self.assertTrue(self.analyzer.started.wait(timeout=2))
        self.assertEqual(self.analyzer.received[:2], (content, "novel.txt"))
        self.assertFalse((Path(self.temporary.name) / "novel.txt").exists())

    def test_maximum_request_size_returns_json_413(self):
        self.app.config["MAX_CONTENT_LENGTH"] = 200
        response = self.submit(text_content="x" * 500)
        self.assertEqual(response.status_code, 413)
        self.assertIn("error", response.get_json())

    def test_url_runs_in_background_and_unsafe_scheme_rejected(self):
        response = self.client.post("/analyze", data={"analysis_type": "url_novel", "url": "file:///etc/passwd"})
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/analyze", data={"analysis_type": "url_novel", "url": "https://example.com/chapter"})
        self.assertEqual(response.status_code, 202)
        self.assertTrue(self.analyzer.started.wait(timeout=2))
        self.assertEqual(self.analyzer.received[1], "Fetched page")

    def test_example_contains_real_input_and_no_fabricated_report(self):
        sample = self.client.get("/example").get_json()
        self.assertGreater(len(sample["text_content"]), 50)
        self.assertNotIn("novel_info", sample)
        self.assertEqual(self.client.get("/api/history").get_json(), [])

    def test_health_probe_is_explicit(self):
        normal = self.client.get("/api/models").get_json()
        self.assertNotIn("availability_checked", normal)
        live = self.client.get("/api/models?check=1").get_json()
        self.assertTrue(live["availability_checked"])
        self.assertFalse(live["available"])


class RecoveryTests(unittest.TestCase):
    def test_restart_marks_interrupted_job_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            jobs_path = Path(directory) / "jobs"
            jobs_path.mkdir()
            task_id = str(uuid.uuid4())
            (jobs_path / f"{task_id}.json").write_text(json.dumps({"task_id": task_id, "status": "processing", "progress": 30}), encoding="utf-8")
            store = JobStore(directory)
            try:
                job = store.get_job(task_id)
                self.assertEqual(job["status"], "failed")
                self.assertEqual(job["stage"], "interrupted")
                self.assertIn("重启", job["error"])
                self.assertEqual(job["progress"], 30)
                self.assertIsNone(store.get_result(task_id))
            finally:
                store.shutdown()


if __name__ == "__main__":
    unittest.main()
