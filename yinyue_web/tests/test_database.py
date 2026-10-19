"""Regression tests for persistence, legacy compatibility, and real rollback."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from backend.database import DatabaseManager


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "nested" / "songs.db"
        self.db = DatabaseManager(self.path)
        self.song = {"title": "Morning", "artist": "Artist", "lyrics": "love and hope",
                     "source": "manual"}
        self.analysis = {"consensus_sentiment": "positive", "textblob": {"polarity": 0.5}}
        self.vector = {"polarity": 0.5}

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def save(self, song=None):
        return self.db.store_crawled_song_with_analysis(song or self.song, self.analysis, self.vector)

    def test_updating_song_preserves_id_and_existing_favorites(self):
        song_id = self.save()
        with self.db.get_connection() as conn:
            conn.execute("CREATE TABLE user_favorites (song_id INTEGER REFERENCES songs(id))")
            conn.execute("INSERT INTO user_favorites VALUES (?)", (song_id,))
        self.assertEqual(self.save({**self.song, "lyrics": "updated"}), song_id)
        saved = self.db.get_song(song_id)
        self.assertEqual(saved["lyrics"], "updated")
        self.assertEqual(saved["source"], "manual")
        self.assertEqual(self.db.get_analysis_stats()["total_songs"], 1)
        with self.db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT song_id FROM user_favorites").fetchone()[0], song_id)

    def test_analysis_failure_rolls_back_new_song(self):
        with self.db.get_connection() as conn:
            conn.execute("""CREATE TRIGGER fail_analysis BEFORE INSERT ON song_analysis
                            BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.save()
        self.assertEqual(self.db.get_all_songs_with_analysis(), [])
        self.assertEqual(self.db.get_analysis_stats()["total_songs"], 0)

    def test_updates_preserve_metadata_until_explicitly_supplied(self):
        song_id = self.save({**self.song, "genre": "Alternative Pop", "year": 2019})
        self.save({**self.song, "lyrics": "new analysis text"})
        saved = self.db.get_song(song_id)
        self.assertEqual((saved["genre"], saved["year"]), ("Alternative Pop", 2019))
        self.db.add_song(self.song["title"], self.song["artist"], "edited text")
        saved = self.db.get_song(song_id)
        self.assertEqual((saved["genre"], saved["year"]), ("Alternative Pop", 2019))
        self.save({**self.song, "genre": "Synth-pop", "year": None})
        saved = self.db.get_song(song_id)
        self.assertEqual((saved["genre"], saved["year"]), ("Synth-pop", None))

    def test_analysis_failure_rolls_back_existing_lyrics(self):
        song_id = self.save()
        with self.db.get_connection() as conn:
            conn.execute("""CREATE TRIGGER fail_analysis BEFORE UPDATE ON song_analysis
                            BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.save({**self.song, "lyrics": "must not persist"})
        self.assertEqual(self.db.get_song(song_id)["lyrics"], self.song["lyrics"])
        self.assertEqual(self.db.get_song(song_id)["analysis"], self.analysis)

    def test_invalid_json_and_missing_fk_never_report_success(self):
        with self.assertRaises(ValueError):
            self.db.store_crawled_song_with_analysis(self.song, self.analysis, {"x": float("nan")})
        self.assertEqual(self.db.get_all_songs_with_analysis(), [])
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.save_analysis(12345, self.analysis, self.vector)
        with self.db.get_connection() as conn:
            self.assertEqual(conn.execute("PRAGMA foreign_keys").fetchone()[0], 1)

    def test_legacy_delete_removes_dependents_without_cascade(self):
        song_id = self.save()
        with self.db.get_connection() as conn:
            conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
            conn.execute("INSERT INTO users VALUES (1, 'existing-user')")
            conn.execute("""CREATE TABLE user_favorites (
                user_id INTEGER REFERENCES users(id),
                song_id INTEGER REFERENCES songs(id))""")
            conn.execute("INSERT INTO user_favorites VALUES (1, ?)", (song_id,))
        self.assertTrue(self.db.delete_song(song_id))
        self.assertFalse(self.db.delete_song(song_id))
        with self.db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM song_analysis").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM user_favorites").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)

    def test_reopening_preserves_legacy_rows_and_extra_tables(self):
        song_id = self.save()
        with self.db.get_connection() as conn:
            conn.execute("CREATE TABLE legacy_notes (body TEXT)")
            conn.execute("INSERT INTO legacy_notes VALUES ('preserve me')")
        reopened = DatabaseManager(self.path)
        self.assertEqual(reopened.get_song(song_id)["lyrics"], self.song["lyrics"])
        with reopened.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT body FROM legacy_notes").fetchone()[0], "preserve me")

    def test_stats_are_computed_from_data_not_stale_cache(self):
        self.save()
        self.db.add_song("Unanalyzed", "Artist", "plain text")
        with self.db.get_connection() as conn:
            conn.execute("UPDATE analysis_stats SET total_songs=999, total_analyses=0")
        stats = self.db.get_analysis_stats()
        self.assertEqual(stats["total_songs"], 2)
        self.assertEqual(stats["total_analyses"], 1)
        self.assertEqual(stats["avg_polarity"], 0.5)
        self.assertEqual(stats["sentiment_distribution"]["positive"], 1)
        self.assertEqual(stats["sentiment_distribution"]["unanalyzed"], 1)

    def test_legacy_corrupt_analysis_keeps_song_readable(self):
        song_id = self.save()
        with self.db.get_connection() as conn:
            conn.execute("UPDATE song_analysis SET analysis_json='broken json' WHERE song_id=?", (song_id,))
        with self.assertLogs("backend.database", level="WARNING"):
            saved = self.db.get_song(song_id)
        self.assertEqual(saved["id"], song_id)
        self.assertEqual(saved["lyrics"], self.song["lyrics"])
        self.assertIsNone(saved["analysis"])
        self.assertEqual(saved["sentiment"], "unanalyzed")

    def test_multilingual_polarity_and_malformed_legacy_fields(self):
        self.db.store_crawled_song_with_analysis(
            self.song,
            {"consensus_sentiment": "positive", "overall_polarity": 0.8,
             "textblob": {"polarity": 0}}, self.vector)
        self.db.store_crawled_song_with_analysis(
            {**self.song, "title": "Legacy"},
            {"consensus_sentiment": ["invalid"], "textblob": None}, self.vector)
        stats = self.db.get_analysis_stats()
        self.assertEqual(stats["avg_polarity"], 0.8)
        self.assertEqual(stats["sentiment_distribution"]["unanalyzed"], 1)

    def test_library_has_no_hidden_thousand_song_limit(self):
        with self.db.get_connection() as conn:
            conn.executemany("INSERT INTO songs (title,artist,lyrics) VALUES (?, 'artist','text')",
                             [(str(i),) for i in range(1005)])
        self.assertEqual(len(self.db.get_all_songs_with_analysis()), 1005)
        self.assertEqual(self.db.get_analysis_stats()["total_songs"], 1005)

    def test_memory_database_survives_multiple_connections(self):
        memory = DatabaseManager(":memory:")
        try:
            song_id = memory.store_crawled_song_with_analysis(self.song, self.analysis, self.vector)
            self.assertEqual(memory.get_song(song_id)["title"], self.song["title"])
        finally:
            memory.close()


if __name__ == "__main__":
    unittest.main()
