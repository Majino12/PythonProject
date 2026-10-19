"""SQLite persistence with stable song IDs and atomic song/analysis writes."""

from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import logging
import math
from pathlib import Path
import sqlite3
from uuid import uuid4

try:
    from .config import Config
except ImportError:  # Support python backend/database.py.
    from config import Config

logger = logging.getLogger(__name__)
_UNSET = object()


class DatabaseManager:
    def __init__(self, db_path=None):
        self.db_path = str(db_path if db_path is not None else Config.DATABASE_PATH)
        self._anchor = None
        self._uri = self.db_path == ":memory:"
        if self._uri:
            self._connection_path = f"file:yinyue-{uuid4().hex}?mode=memory&cache=shared"
            self._anchor = sqlite3.connect(self._connection_path, uri=True)
        else:
            Path(self.db_path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
            self._connection_path = str(Path(self.db_path).expanduser())
        self.init_database()

    def close(self):
        if self._anchor is not None:
            self._anchor.close()
            self._anchor = None

    @contextmanager
    def get_connection(self):
        conn = sqlite3.connect(self._connection_path, timeout=15, uri=self._uri)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_database(self):
        # Existing tables and unrelated legacy tables are deliberately preserved.
        with self.get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS songs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    artist TEXT NOT NULL,
                    genre TEXT DEFAULT 'Unknown',
                    year INTEGER,
                    lyrics TEXT NOT NULL,
                    source TEXT DEFAULT 'manual',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(title, artist)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS song_analysis (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    song_id INTEGER NOT NULL UNIQUE,
                    analysis_json TEXT NOT NULL,
                    emotion_vector TEXT NOT NULL,
                    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS analysis_stats (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    total_songs INTEGER DEFAULT 0,
                    total_analyses INTEGER DEFAULT 0,
                    avg_polarity REAL DEFAULT 0,
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_created ON songs(created_at DESC)")

    @staticmethod
    def _now():
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    def _upsert_song(self, conn, song):
        source = song.get("source", "manual")
        default_genre = "Manual" if source == "manual" else "Unknown"
        conn.execute("""
            INSERT INTO songs (title, artist, lyrics, genre, year, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(title, artist) DO UPDATE SET
                lyrics=excluded.lyrics,
                genre=CASE WHEN ? THEN excluded.genre ELSE songs.genre END,
                year=CASE WHEN ? THEN excluded.year ELSE songs.year END,
                source=excluded.source, updated_at=excluded.updated_at
        """, (song["title"], song["artist"], song["lyrics"], song.get("genre", default_genre),
              song.get("year"), source, self._now(), "genre" in song, "year" in song))
        return conn.execute("SELECT id FROM songs WHERE title=? AND artist=?",
                            (song["title"], song["artist"])).fetchone()["id"]

    def _save_analysis(self, conn, song_id, analysis_json, emotion_vector):
        if not isinstance(analysis_json, dict) or not isinstance(emotion_vector, (dict, list)):
            raise ValueError("Analysis must be an object and vector must be an object or list")
        analysis_str = json.dumps(analysis_json, ensure_ascii=False, allow_nan=False)
        vector_str = json.dumps(emotion_vector, ensure_ascii=False, allow_nan=False)
        conn.execute("""
            INSERT INTO song_analysis (song_id, analysis_json, emotion_vector, analyzed_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(song_id) DO UPDATE SET
                analysis_json=excluded.analysis_json,
                emotion_vector=excluded.emotion_vector, analyzed_at=excluded.analyzed_at
        """, (song_id, analysis_str, vector_str, self._now()))

    def _update_stats(self, conn):
        conn.execute("""
            INSERT INTO analysis_stats (id, total_songs, total_analyses, last_updated)
            VALUES (1, (SELECT COUNT(*) FROM songs),
                    (SELECT COUNT(*) FROM song_analysis), ?)
            ON CONFLICT(id) DO UPDATE SET total_songs=excluded.total_songs,
                total_analyses=excluded.total_analyses, last_updated=excluded.last_updated
        """, (self._now(),))

    def add_song(self, title, artist, lyrics, genre=_UNSET, year=_UNSET, source="manual"):
        song = dict(title=title, artist=artist, lyrics=lyrics, source=source)
        if genre is not _UNSET:
            song["genre"] = genre
        if year is not _UNSET:
            song["year"] = year
        with self.get_connection() as conn:
            song_id = self._upsert_song(conn, song)
            # Direct lyric edits must not retain an analysis of the previous text.
            conn.execute("DELETE FROM song_analysis WHERE song_id=?", (song_id,))
            self._update_stats(conn)
            return song_id

    def save_analysis(self, song_id, analysis_json, emotion_vector):
        with self.get_connection() as conn:
            self._save_analysis(conn, song_id, analysis_json, emotion_vector)
            self._update_stats(conn)
        return True

    def store_crawled_song_with_analysis(self, song_data, analysis_result, emotion_vector):
        """Commit the song and analysis together, or leave both unchanged on failure."""
        with self.get_connection() as conn:
            song_id = self._upsert_song(conn, song_data)
            self._save_analysis(conn, song_id, analysis_result, emotion_vector)
            self._update_stats(conn)
            return song_id

    def update_analysis_stats(self):
        with self.get_connection() as conn:
            self._update_stats(conn)

    @staticmethod
    def _decode_json(value, expected_type):
        try:
            decoded = json.loads(value, parse_constant=lambda _value: None) if value else None
            return decoded if isinstance(decoded, expected_type) else None
        except (TypeError, ValueError):
            logger.warning("A legacy analysis JSON value could not be decoded")
            return None

    def _song_from_row(self, row):
        song = dict(row)
        song["analysis"] = self._decode_json(song.pop("analysis_json", None), dict)
        song["emotion_vector"] = self._decode_json(song.get("emotion_vector"), (dict, list))
        sentiment = (song["analysis"] or {}).get("consensus_sentiment", "unanalyzed")
        song["sentiment"] = sentiment if isinstance(sentiment, str) and sentiment in {
            "positive", "neutral", "negative"
        } else "unanalyzed"
        return song

    def get_all_songs_with_analysis(self, limit=None):
        sql = """SELECT s.*, sa.analysis_json, sa.emotion_vector
                 FROM songs s LEFT JOIN song_analysis sa ON s.id = sa.song_id
                 ORDER BY s.created_at DESC, s.id DESC"""
        args = ()
        if limit is not None:
            sql += " LIMIT ?"
            args = (max(0, int(limit)),)
        with self.get_connection() as conn:
            return [self._song_from_row(row) for row in conn.execute(sql, args).fetchall()]

    def get_song(self, song_id):
        with self.get_connection() as conn:
            row = conn.execute("""SELECT s.*, sa.analysis_json, sa.emotion_vector
                                  FROM songs s LEFT JOIN song_analysis sa ON s.id=sa.song_id
                                  WHERE s.id=?""", (song_id,)).fetchone()
            return self._song_from_row(row) if row else None

    def delete_song(self, song_id):
        with self.get_connection() as conn:
            # Older databases may declare these foreign keys without CASCADE.
            # Remove their dependent rows in this same transaction before the song.
            conn.execute("DELETE FROM song_analysis WHERE song_id=?", (song_id,))
            has_favorites = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_favorites'"
            ).fetchone()
            if has_favorites:
                conn.execute("DELETE FROM user_favorites WHERE song_id=?", (song_id,))
            deleted = conn.execute("DELETE FROM songs WHERE id=?", (song_id,)).rowcount > 0
            self._update_stats(conn)
            return deleted

    def get_analysis_stats(self):
        songs = self.get_all_songs_with_analysis()
        analyses = [song["analysis"] for song in songs if song["analysis"]]
        polarities = []
        for analysis in analyses:
            value = analysis.get("overall_polarity")
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                textblob = analysis.get("textblob")
                value = textblob.get("polarity") if isinstance(textblob, dict) else None
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                polarities.append(value)
        distribution = dict.fromkeys(("positive", "neutral", "negative", "unanalyzed"), 0)
        distribution.update(Counter(song["sentiment"] for song in songs))
        return {
            "total_songs": len(songs),
            "total_analyses": len(analyses),
            "avg_polarity": sum(polarities) / len(polarities) if polarities else 0,
            "sentiment_distribution": distribution,
            "genre_distribution": dict(Counter(song["genre"] or "Unknown" for song in songs)),
            "source_distribution": dict(Counter(song["source"] or "unknown" for song in songs)),
            "last_updated": max((song["updated_at"] or "" for song in songs), default=None),
        }

    def get_recent_songs(self, limit=5):
        return self.get_all_songs_with_analysis(limit)

    def get_sentiment_distribution(self):
        return self.get_analysis_stats()["sentiment_distribution"]

    def get_genre_distribution(self):
        return self.get_analysis_stats()["genre_distribution"]

    def get_song_count_by_source(self):
        return self.get_analysis_stats()["source_distribution"]

    def search_songs(self, query, limit=50):
        term = query.casefold()
        return [song for song in self.get_all_songs_with_analysis()
                if term in song["title"].casefold() or term in song["artist"].casefold()][:limit]


if __name__ == "__main__":
    DatabaseManager()
