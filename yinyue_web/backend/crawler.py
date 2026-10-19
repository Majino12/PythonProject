"""Bounded lyrics.ovh client with expiring, atomic local caching."""
import hashlib
import json
import logging
import os
from pathlib import Path
import tempfile
import time
from urllib.parse import quote

import requests

try:
    from .config import Config
except ImportError:
    from config import Config

logger = logging.getLogger(__name__)


class UnifiedCrawler:
    def __init__(self, cache_dir=None, session=None, cache_ttl=86400):
        self.cache_dir = Path(cache_dir or Path(Config.CACHE_DIR) / 'lyrics')
        self.session = session or requests.Session()
        self.cache_ttl = cache_ttl

    @staticmethod
    def _get_cache_key(artist, title):
        parts = [' '.join(value.casefold().split()) for value in (artist, title)]
        return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()

    def _load_cache(self, key):
        try:
            data = json.loads((self.cache_dir / f'{key}.json').read_text(encoding='utf-8'))
            age = time.time() - float(data['timestamp'])
            lyrics = data['lyrics']
            if 0 <= age < self.cache_ttl and isinstance(lyrics, str) and 0 < len(lyrics.strip()) <= 50000:
                return lyrics
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    def _save_cache(self, key, lyrics):
        temporary = None
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.cache_dir,
                                             prefix='.lyrics-', delete=False) as handle:
                temporary = handle.name
                json.dump({'lyrics': lyrics, 'timestamp': time.time()}, handle, ensure_ascii=False)
            os.replace(temporary, self.cache_dir / f'{key}.json')
        except OSError:
            logger.warning('Lyrics cache could not be written')
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def crawl_song(self, artist, title, use_cache=True):
        if not all(isinstance(v, str) and 0 < len(v.strip()) <= 200 for v in (artist, title)):
            return self._failure('歌曲和歌手必须为 1–200 个字符。', 'invalid_song', 400)
        artist, title = artist.strip(), title.strip()
        base = {'artist': artist, 'title': title}
        key = self._get_cache_key(artist, title)
        if use_cache:
            cached = self._load_cache(key)
            if cached:
                return dict(base, status='success', lyrics=cached, source='cache')

        url = f'https://api.lyrics.ovh/v1/{quote(artist, safe="")}/{quote(title, safe="")}'
        try:
            # Requests stay on the explicitly configured public provider.
            with self.session.get(url, timeout=(4, 12), allow_redirects=False, stream=True,
                                  headers={'User-Agent': 'Yinyue/2.0', 'Accept': 'application/json'}) as response:
                if response.status_code == 404:
                    return dict(base, **self._failure('未找到歌词，请检查歌名、歌手，或手动粘贴歌词。', 'not_found', 404))
                if response.status_code == 429:
                    return dict(base, **self._failure('歌词服务请求过于频繁，请稍后重试。', 'rate_limited', 429))
                if response.status_code != 200:
                    return dict(base, **self._failure('歌词服务暂时不可用，请稍后重试。', 'upstream_error', 502))
                chunks, size, started = [], 0, time.monotonic()
                for chunk in response.iter_content(chunk_size=8192):
                    size += len(chunk)
                    if size > 512000:
                        return dict(base, **self._failure('歌词服务返回的数据过大。', 'invalid_response', 502))
                    if time.monotonic() - started > 20:
                        return dict(base, **self._failure('歌词服务响应超时，请稍后重试。', 'timeout', 504))
                    chunks.append(chunk)
                payload = json.loads(b''.join(chunks))
            lyrics = payload.get('lyrics') if isinstance(payload, dict) else None
            if not isinstance(lyrics, str) or not lyrics.strip() or len(lyrics) > 50000:
                return dict(base, **self._failure('歌词服务未返回有效歌词，请手动输入。', 'invalid_response', 502))
            lyrics = lyrics.strip().replace('\r\n', '\n')
            if use_cache:
                self._save_cache(key, lyrics)
            return dict(base, status='success', lyrics=lyrics, source='lyrics.ovh')
        except requests.Timeout:
            return dict(base, **self._failure('歌词服务响应超时，请稍后重试。', 'timeout', 504))
        except requests.RequestException:
            return dict(base, **self._failure('无法连接歌词服务，请检查网络或手动输入。', 'network_error', 502))
        except (ValueError, UnicodeError):
            return dict(base, **self._failure('歌词服务返回了无效数据。', 'invalid_response', 502))

    @staticmethod
    def _failure(message, code, status):
        return {'status': 'failed', 'error': message, 'error_code': code, 'http_status': status}

    def crawl_song_professional(self, artist, title, use_cache=True):
        return self.crawl_song(artist, title, use_cache)

    def crawl_multiple(self, songs):
        return [self.crawl_song(song.get('artist'), song.get('title')) for song in songs[:10]]


crawler = UnifiedCrawler()
