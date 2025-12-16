import requests
import json
import time
import logging
import hashlib
import os
from urllib.parse import quote
from fake_useragent import UserAgent
from config import Config

logger = logging.getLogger(__name__)


class UnifiedCrawler:
    def __init__(self):
        self.session = requests.Session()
        # 防止 fake_useragent 报错的保险措施
        try:
            self.ua = UserAgent()
        except:
            self.ua = None

        self.cache_dir = os.path.join(Config.CACHE_DIR, 'lyrics')
        os.makedirs(self.cache_dir, exist_ok=True)

    def _get_headers(self):
        # 如果 ua 加载失败，使用默认 header
        user_agent = self.ua.random if self.ua else 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        return {'User-Agent': user_agent}

    def _get_cache_key(self, artist, title):
        key = f"{artist}_{title}".lower().strip()
        return hashlib.md5(key.encode()).hexdigest()

    def _load_cache(self, key):
        path = os.path.join(self.cache_dir, f"{key}.json")
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    return data.get('lyrics')
            except:
                pass
        return None

    def _save_cache(self, key, lyrics):
        path = os.path.join(self.cache_dir, f"{key}.json")
        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump({'lyrics': lyrics, 'timestamp': time.time()}, f, ensure_ascii=False)
        except:
            pass

    def crawl_song(self, artist, title, use_cache=True):
        """统一爬取入口"""
        logger.info(f"Crawling: {artist} - {title}")
        key = self._get_cache_key(artist, title)

        # 1. 查缓存
        if use_cache:
            cached = self._load_cache(key)
            if cached:
                return {'title': title, 'artist': artist, 'lyrics': cached, 'status': 'success', 'source': 'cache'}

        # 2. 爬取 (优先 lyrics.ovh)
        lyrics = self._fetch_lyrics_ovh(artist, title)

        # 3. 结果处理
        if lyrics:
            if use_cache: self._save_cache(key, lyrics)
            return {'title': title, 'artist': artist, 'lyrics': lyrics, 'status': 'success', 'source': 'web'}

        return {'title': title, 'artist': artist, 'status': 'failed', 'error': 'Lyrics not found'}

    # --- 兼容性别名 (关键修复) ---
    def crawl_song_professional(self, artist, title, use_cache=True):
        """兼容旧代码调用的别名"""
        return self.crawl_song(artist, title, use_cache)

    def _fetch_lyrics_ovh(self, artist, title):
        try:
            # 处理特殊字符
            clean_artist = quote(artist)
            clean_title = quote(title)
            url = f"https://api.lyrics.ovh/v1/{clean_artist}/{clean_title}"

            resp = self.session.get(url, headers=self._get_headers(), timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                lyrics = data.get('lyrics', '')
                if lyrics: return lyrics
        except Exception as e:
            logger.error(f"Lyrics.ovh error: {e}")
        return None

    def crawl_multiple(self, songs):
        results = []
        for song in songs:
            res = self.crawl_song(song['artist'], song['title'])
            res['genre'] = song.get('genre', 'Unknown')
            results.append(res)
            time.sleep(0.5)
        return results


crawler = UnifiedCrawler()