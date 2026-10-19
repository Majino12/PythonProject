"""API contract and failure tests without external network requests."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.app import create_app
from backend.database import DatabaseManager


class FakeAnalyzer:
    def analyze_lyrics_comprehensive(self, lyrics):
        if lyrics == "ANALYSIS_ERROR":
            raise RuntimeError("private file path and secret stack")
        sentiment = "negative" if "sad" in lyrics else "positive"
        return {"consensus_sentiment": sentiment, "textblob": {"polarity": -0.5 if sentiment == "negative" else 0.5}}

    def create_emotion_vector(self, analysis):
        return {"polarity": analysis["textblob"]["polarity"]}

    def recommend_songs(self, target_id, songs, top_k=5):
        return [{"id": song["id"], "title": song["title"], "artist": song["artist"], "similarity": 0.8}
                for song in songs if song["id"] != target_id][:top_k]


class FakeCrawler:
    def __init__(self):
        self.calls = []

    def crawl_song(self, artist, title, use_cache=True):
        self.calls.append((artist, title, use_cache))
        if title == "Missing":
            return {"status": "failed", "error": "No lyrics found", "error_code": "not_found", "http_status": 404}
        return {"status": "success", "artist": artist, "title": title,
                "lyrics": "ANALYSIS_ERROR" if title == "Broken" else "love and hope"}


class APITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = DatabaseManager(Path(self.temp.name) / "songs.db")
        self.crawler = FakeCrawler()
        self.analyzer = FakeAnalyzer()
        self.app = create_app({"TESTING": True}, database=self.db,
                              lyric_analyzer=self.analyzer, song_crawler=self.crawler)
        self.client = self.app.test_client()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def add(self, title="Morning", artist="Artist", lyrics="love and hope"):
        response = self.client.post("/api/add_song", json={"title": title, "artist": artist, "lyrics": lyrics})
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def test_add_detail_delete_and_actual_stats(self):
        payload = self.add()
        self.assertTrue(payload["db_saved"])
        song_id = payload["song_id"]
        detail = self.client.get(f"/api/songs/{song_id}").get_json()["song"]
        self.assertEqual(detail["sentiment"], "positive")
        self.assertEqual(detail["source"], "manual")
        stats = self.client.get("/api/stats").get_json()
        self.assertEqual(stats["total_songs"], 1)
        self.assertEqual(stats["sentiment_distribution"]["positive"], 1)
        self.assertEqual(self.client.delete(f"/api/songs/{song_id}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/songs/{song_id}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/songs/{song_id}").status_code, 404)
        self.assertEqual(self.client.get("/api/stats").get_json()["total_songs"], 0)

    def test_duplicate_song_updates_same_id(self):
        old = self.add()
        updated = self.add(lyrics="sad and alone")
        self.assertEqual(old["song_id"], updated["song_id"])
        self.assertEqual(updated["sentiment"], "negative")
        self.assertEqual(self.client.get("/api/library").get_json()["total"], 1)

    def test_manual_reanalysis_and_recrawl_preserve_legacy_metadata(self):
        song_id = self.db.store_crawled_song_with_analysis(
            {"title": "Legacy", "artist": "Artist", "lyrics": "old text",
             "genre": "Alternative Pop", "year": 2019, "source": "crawler"},
            {"consensus_sentiment": "neutral", "textblob": {"polarity": 0}},
            {"polarity": 0})
        manual = self.add("Legacy", "Artist", "sad")
        self.assertEqual(manual["id"], song_id)
        self.assertEqual((manual["genre"], manual["year"]), ("Alternative Pop", 2019))
        self.assertEqual(manual["source"], "manual")
        crawled = self.client.post("/api/professional/crawl", json={"title": "Legacy", "artist": "Artist"})
        self.assertEqual(crawled.status_code, 200)
        saved = crawled.get_json()
        self.assertEqual(saved["id"], song_id)
        self.assertEqual((saved["genre"], saved["year"]), ("Alternative Pop", 2019))
        self.assertEqual(saved["source"], "crawler")
        self.assertEqual(self.add("New manual")["genre"], "Manual")
        fresh = self.client.post("/api/professional/crawl", json={"title": "New remote", "artist": "Artist"})
        self.assertEqual(fresh.get_json()["genre"], "Unknown")

    def test_json_types_missing_fields_and_limits_rejected(self):
        invalid_bodies = [None, [], "text", {}, {"title": "Title", "artist": 2, "lyrics": "love"},
                          {"title": " ", "artist": "Singer", "lyrics": "love"},
                          {"title": "x" * 201, "artist": "Singer", "lyrics": "love"},
                          {"title": "Title", "artist": "Singer", "lyrics": "x" * 50001}]
        for value in invalid_bodies:
            with self.subTest(value=str(value)[:50]):
                response = self.client.post("/api/add_song", json=value)
                self.assertIn(response.status_code, (400, 415))
                self.assertFalse(response.get_json()["success"])
        malformed = self.client.post("/api/add_song", data="{", content_type="application/json")
        self.assertEqual(malformed.status_code, 400)
        wrong_type = self.client.post("/api/add_song", data="plain")
        self.assertEqual(wrong_type.status_code, 415)
        self.assertEqual(self.db.get_all_songs_with_analysis(), [])

    def test_request_size_limit_returns_json(self):
        self.app.config["MAX_CONTENT_LENGTH"] = 32
        response = self.client.post("/api/add_song", data="x" * 100, content_type="application/json")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.get_json()["error_code"], "http_413")

    def test_library_filter_sort_and_total_are_independent_of_page(self):
        self.add("Zulu", "Duo")
        self.add("Alpha", "Duo")
        self.add("Beta", "Duo", "sad")
        self.add("Other", "Solo")
        response = self.client.get("/api/library?q=duo&sort=title&per_page=1&page=2")
        result = response.get_json()
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["total_pages"], 3)
        self.assertEqual(result["songs"][0]["title"], "Beta")
        positive = self.client.get("/api/library?q=duo&sentiment=positive").get_json()
        self.assertEqual(positive["total"], 2)
        for query in ("page=0", "per_page=101", "page=no", "sort=sql", "sentiment=bad"):
            self.assertEqual(self.client.get("/api/library?" + query).status_code, 400)

    def test_crawl_reports_real_saved_song_and_failure_status(self):
        response = self.client.post("/api/professional/crawl", json={"artist": "Artist", "title": "Remote", "use_cache": False})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["db_saved"])
        self.assertEqual(response.get_json()["song"]["source"], "crawler")
        self.assertEqual(self.crawler.calls[-1], ("Artist", "Remote", False))
        failure = self.client.post("/api/professional/crawl", json={"artist": "Artist", "title": "Missing"})
        self.assertEqual(failure.status_code, 404)
        self.assertFalse(failure.get_json()["db_saved"])
        self.assertEqual(self.db.get_analysis_stats()["total_songs"], 1)

    def test_analysis_failure_never_claims_success_or_leaks_details(self):
        with self.assertLogs("backend.app", level="ERROR"):
            response = self.client.post("/api/add_song", json={"title": "Song", "artist": "Artist", "lyrics": "ANALYSIS_ERROR"})
        self.assertEqual(response.status_code, 500)
        self.assertFalse(response.get_json()["success"])
        self.assertNotIn("secret", response.get_data(as_text=True))
        self.assertEqual(self.db.get_all_songs_with_analysis(), [])

    def test_storage_failure_never_claims_success(self):
        with patch.object(self.db, "store_crawled_song_with_analysis", side_effect=RuntimeError("disk failure")):
            with self.assertLogs("backend.app", level="ERROR"):
                response = self.client.post("/api/professional/crawl", json={"title": "Remote", "artist": "Artist"})
        self.assertEqual(response.status_code, 500)
        self.assertFalse(response.get_json()["success"])
        self.assertEqual(self.db.get_all_songs_with_analysis(), [])

    def test_batch_continues_after_independent_song_failures(self):
        with self.assertLogs("backend.app", level="ERROR"):
            response = self.client.post("/api/professional/crawl_batch", json={
                "songs": [{"artist": "Artist", "title": title} for title in ("Good", "Missing", "Broken", "Last")]})
        result = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(result["summary"], {"total": 4, "succeeded": 2, "failed": 2})
        self.assertEqual(len(result["crawled_songs"]), 4)
        self.assertFalse(result["crawled_songs"][2]["db_saved"])
        self.assertEqual(self.db.get_analysis_stats()["total_songs"], 2)

    def test_batch_validates_every_item_before_network(self):
        for songs in ([], [{"artist": "Artist", "title": "Good"}, {}],
                      [{"artist": "Artist", "title": "Good"}] * 11, "bad", [False]):
            response = self.client.post("/api/professional/crawl_batch", json={"songs": songs})
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.crawler.calls, [])

    def test_recommendation_uses_ids_and_rejects_ambiguous_title(self):
        first = self.add("Same", "First")
        second = self.add("Same", "Second")
        response = self.client.post("/api/recommend", json={"song_id": first["id"], "top_k": 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["recommendations"][0]["id"], second["id"])
        ambiguous = self.client.post("/api/recommend", json={"target_song": "Same"})
        self.assertEqual(ambiguous.status_code, 400)
        self.assertEqual(ambiguous.get_json()["error_code"], "ambiguous_song")
        self.assertEqual(self.client.post("/api/recommend", json={"song_id": True}).status_code, 400)
        self.assertEqual(self.client.post("/api/recommend", json={"song_id": first["id"], "top_k": 0}).status_code, 400)
        self.assertEqual(self.client.post("/api/recommend", json={"song_id": 999}).status_code, 404)

    def test_unanalyzed_song_is_not_recommended_as_target(self):
        song_id = self.db.add_song("Old", "Artist", "text")
        response = self.client.post("/api/recommend", json={"song_id": song_id})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error_code"], "analysis_unavailable")

    def test_export_contains_full_data_and_download_header(self):
        self.add()
        result = self.client.get("/api/export")
        self.assertEqual(result.status_code, 200)
        self.assertIn("attachment", result.headers["Content-Disposition"])
        self.assertEqual(result.get_json()["total"], 1)
        self.assertEqual(result.get_json()["songs"][0]["lyrics"], "love and hope")
        self.assertIn("analysis", result.get_json()["songs"][0])

    def test_health_static_and_missing_api(self):
        health = self.client.get("/api/health")
        self.assertEqual(health.get_json()["status"], "ok")
        self.assertEqual(health.get_json()["service"], "yinyue-web")
        index = self.client.get("/")
        self.assertEqual(index.status_code, 200)
        index.close()
        unknown = self.client.get("/api/not-here")
        self.assertEqual(unknown.status_code, 404)
        self.assertTrue(unknown.is_json)
        self.assertEqual(health.headers["Cache-Control"], "no-store")
        self.assertNotIn("Access-Control-Allow-Origin", health.headers)


if __name__ == "__main__":
    unittest.main()
