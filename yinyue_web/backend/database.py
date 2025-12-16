import sqlite3
import json
import logging
from datetime import datetime
from contextlib import contextmanager
from config import Config

logger = logging.getLogger(__name__)


class DatabaseManager:
    def __init__(self, db_path=None):
        self.db_path = db_path or Config.DATABASE_PATH
        self.init_database()

    @contextmanager
    def get_connection(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.close()

    def init_database(self):
        try:
            with self.get_connection() as conn:
                # 歌曲表
                conn.execute('''
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
                ''')
                # 分析结果表
                conn.execute('''
                    CREATE TABLE IF NOT EXISTS song_analysis (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        song_id INTEGER NOT NULL,
                        analysis_json TEXT NOT NULL,
                        emotion_vector TEXT NOT NULL,
                        analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE,
                        UNIQUE(song_id)
                    )
                ''')
                # 统计表
                conn.execute('''
                    CREATE TABLE IF NOT EXISTS analysis_stats (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        total_songs INTEGER DEFAULT 0,
                        total_analyses INTEGER DEFAULT 0,
                        avg_polarity REAL DEFAULT 0,
                        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                ''')
                logger.info("Database initialized successfully")
        except Exception as e:
            logger.error(f"Error initializing database: {e}")

    def add_song(self, title, artist, lyrics, genre="Unknown", year=None, source="manual"):
        """添加或更新歌曲"""
        try:
            with self.get_connection() as conn:
                existing = conn.execute('SELECT id FROM songs WHERE title = ? AND artist = ?',
                                        (title, artist)).fetchone()

                if existing:
                    song_id = existing['id']
                    conn.execute('''
                        UPDATE songs SET lyrics=?, genre=?, year=?, source=?, updated_at=? WHERE id=?
                    ''', (lyrics, genre, year, source, datetime.now(), song_id))
                    logger.info(f"Updated song: {title} (ID: {song_id})")
                else:
                    cursor = conn.execute('''
                        INSERT INTO songs (title, artist, genre, year, lyrics, source, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    ''', (title, artist, genre, year, lyrics, source, datetime.now()))
                    song_id = cursor.lastrowid
                    logger.info(f"Added song: {title} (ID: {song_id})")
                return song_id
        except Exception as e:
            logger.error(f"Add song error: {e}")
            raise

    def save_analysis(self, song_id, analysis_json, emotion_vector):
        """保存情感分析结果"""
        try:
            analysis_str = json.dumps(analysis_json, ensure_ascii=False)
            vector_str = json.dumps(emotion_vector, ensure_ascii=False)
            with self.get_connection() as conn:
                conn.execute('''
                    INSERT OR REPLACE INTO song_analysis (song_id, analysis_json, emotion_vector)
                    VALUES (?, ?, ?)
                ''', (song_id, analysis_str, vector_str))
            return True
        except Exception as e:
            logger.error(f"Save analysis error: {e}")
            return False

    def store_crawled_song_with_analysis(self, song_data, analysis_result, emotion_vector):
        """【核心】原子操作：保存爬取数据 + 分析结果"""
        try:
            song_id = self.add_song(
                title=song_data.get('title'),
                artist=song_data.get('artist'),
                lyrics=song_data.get('lyrics'),
                genre=song_data.get('genre', 'Pop'),
                year=song_data.get('year'),
                source='crawler'
            )
            if song_id:
                self.save_analysis(song_id, analysis_result, emotion_vector)
                self.update_analysis_stats()
                return song_id
            return None
        except Exception as e:
            logger.error(f"Store crawled data error: {e}")
            return None

    def update_analysis_stats(self):
        try:
            with self.get_connection() as conn:
                total_songs = conn.execute('SELECT COUNT(*) as count FROM songs').fetchone()['count']
                total_analyses = conn.execute('SELECT COUNT(*) as count FROM song_analysis').fetchone()['count']
                conn.execute('''
                    INSERT OR REPLACE INTO analysis_stats (id, total_songs, total_analyses, last_updated)
                    VALUES (1, ?, ?, ?)
                ''', (total_songs, total_analyses, datetime.now()))
        except Exception:
            pass

    # --- 查询方法 (简化版，保留核心功能) ---
    def get_all_songs_with_analysis(self, limit=1000):
        with self.get_connection() as conn:
            results = conn.execute('''
                SELECT s.*, sa.analysis_json, sa.emotion_vector 
                FROM songs s LEFT JOIN song_analysis sa ON s.id = sa.song_id 
                ORDER BY s.created_at DESC LIMIT ?
            ''', (limit,)).fetchall()

            songs = []
            for r in results:
                d = dict(r)
                if d['analysis_json']:
                    d['analysis'] = json.loads(d['analysis_json'])
                    d['emotion_vector'] = json.loads(d['emotion_vector'])
                songs.append(d)
            return songs

    def get_analysis_stats(self):
        with self.get_connection() as conn:
            res = conn.execute('SELECT * FROM analysis_stats WHERE id=1').fetchone()
            return dict(res) if res else {'total_songs': 0}

    def get_recent_songs(self, limit=5):
        return self.get_all_songs_with_analysis(limit)

    def get_sentiment_distribution(self):
        # 简化的实现
        return {}

    def get_genre_distribution(self):
        return {}

    def get_song_count_by_source(self):
        return {}

    def search_songs(self, query, limit=50):
        with self.get_connection() as conn:
            term = f"%{query}%"
            rows = conn.execute('SELECT * FROM songs WHERE title LIKE ? OR artist LIKE ? LIMIT ?',
                                (term, term, limit)).fetchall()
            return [dict(r) for r in rows]


db = DatabaseManager()