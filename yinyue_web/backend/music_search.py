"""Lyrics discovery and explicitly licensed audio from fixed public providers.

LRCLIB records are user-selected: a search result never silently replaces lyrics.
Commons audio is revalidated on download; caller URLs are never fetched. Remote
metadata is untrusted and all returned attribution strings are plain text.
"""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from urllib.parse import parse_qsl, quote, urlsplit

import requests


class MusicSearchError(Exception):
    def __init__(self, message, code='upstream_error', http_status=502, retry_after=None):
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.retry_after = retry_after


class _PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        if tag in {'br', 'p', 'div', 'li'}:
            self.parts.append(' ')


def _plain(value, limit=2000):
    if not isinstance(value, str):
        return ''
    parser = _PlainText()
    parser.feed(value[:20000])
    return ' '.join(''.join(parser.parts).split())[:limit]


class MusicSearchService:
    LYRICS_API = 'https://lrclib.net/api'
    COMMONS_API = 'https://commons.wikimedia.org/w/api.php'
    USER_AGENT = 'Yinyue/2.2 (https://github.com/Majino12/PythonProject)'
    MAX_AUDIO_BYTES = 30 * 1024 * 1024
    MAX_JSON_BYTES = 3 * 1024 * 1024
    AUDIO_MIMES = frozenset({
        'audio/ogg', 'application/ogg', 'audio/mpeg', 'audio/mp3',
        'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav',
        'audio/vnd.wave', 'audio/mp4', 'audio/webm', 'audio/opus',
    })

    def __init__(self, session=None):
        self.session = session or requests.Session()
        self._lock = threading.RLock()
        self._last_request = {}
        self._blocked_until = {}

    @staticmethod
    def _query(query):
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 200:
            raise MusicSearchError('请输入 1–200 个字符的歌名、歌手或关键词。', 'invalid_query', 400)
        if any(ord(char) < 32 for char in query):
            raise MusicSearchError('搜索词含有无效字符。', 'invalid_query', 400)
        return query.strip()

    @staticmethod
    def _lyrics_id(record_id):
        if isinstance(record_id, bool) or not re.fullmatch(r'[1-9][0-9]{0,15}', str(record_id)):
            raise MusicSearchError('歌词记录编号无效。', 'invalid_id', 400)
        return int(record_id)

    @staticmethod
    def _audio_id(record_id):
        if (not isinstance(record_id, str) or not record_id.startswith('File:')
                or not 6 <= len(record_id) <= 255 or '|' in record_id
                or any(ord(char) < 32 for char in record_id)
                or any(char in record_id for char in ['#', '<', '>', '[', ']', '{', '}'])):
            raise MusicSearchError('请选择搜索结果中的 Wikimedia Commons 音频。', 'invalid_id', 400)
        return record_id

    @staticmethod
    def _duration(value):
        try:
            result = float(value)
            return round(result, 3) if math.isfinite(result) and result >= 0 else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _retry_seconds(value):
        try:
            return max(1, min(86400, int(value)))
        except (TypeError, ValueError):
            try:
                target = parsedate_to_datetime(value)
                if target.tzinfo is None:
                    target = target.replace(tzinfo=timezone.utc)
                return max(1, min(86400, math.ceil((target - datetime.now(timezone.utc)).total_seconds())))
            except (TypeError, ValueError, OverflowError):
                return 60

    def _wait_for_provider(self, host):
        remaining = self._blocked_until.get(host, 0) - time.monotonic()
        if remaining > 0:
            raise MusicSearchError('来源服务请求过于频繁，请稍后重试。', 'rate_limited', 429,
                                   retry_after=math.ceil(remaining))
        delay = 0.25 - (time.monotonic() - self._last_request.get(host, 0))
        if delay > 0:
            time.sleep(delay)
        self._last_request[host] = time.monotonic()

    def _check_status(self, response, host):
        if response.status_code == 404:
            raise MusicSearchError('来源中已找不到这条记录，请重新搜索。', 'not_found', 404)
        if response.status_code == 429:
            seconds = self._retry_seconds(response.headers.get('Retry-After'))
            self._blocked_until[host] = time.monotonic() + seconds
            raise MusicSearchError('来源服务请求过于频繁，请稍后重试。', 'rate_limited', 429, seconds)
        if response.status_code != 200:
            raise MusicSearchError('来源服务暂时不可用，请稍后重试。', 'upstream_error', 502)

    def _json(self, url, params=None):
        host = urlsplit(url).hostname
        try:
            with self._lock:
                self._wait_for_provider(host)
                with self.session.get(url, params=params, timeout=(4, 12), stream=True,
                                      allow_redirects=False, headers={
                                          'User-Agent': self.USER_AGENT, 'Accept': 'application/json',
                                      }) as response:
                    self._check_status(response, host)
                    chunks, size, started = [], 0, time.monotonic()
                    for chunk in response.iter_content(chunk_size=16384):
                        size += len(chunk)
                        if size > self.MAX_JSON_BYTES:
                            raise MusicSearchError('来源返回的数据过大。', 'invalid_response', 502)
                        if time.monotonic() - started > 25:
                            raise MusicSearchError('来源服务响应超时，请稍后重试。', 'timeout', 504)
                        chunks.append(chunk)
                    return json.loads(b''.join(chunks))
        except requests.Timeout as exc:
            raise MusicSearchError('来源服务响应超时，请稍后重试。', 'timeout', 504) from exc
        except requests.RequestException as exc:
            raise MusicSearchError('无法连接来源服务，请检查网络后重试。', 'network_error', 502) from exc
        except (ValueError, UnicodeError) as exc:
            raise MusicSearchError('来源服务返回了无效数据。', 'invalid_response', 502) from exc

    def _lyrics_record(self, item):
        if not isinstance(item, dict):
            raise MusicSearchError('歌词来源返回了无效记录。', 'invalid_response', 502)
        try:
            record_id = self._lyrics_id(item.get('id'))
        except MusicSearchError as exc:
            raise MusicSearchError('歌词来源返回了无效记录编号。', 'invalid_response', 502) from exc
        fields = {}
        for source, destination in [('trackName', 'title'), ('artistName', 'artist'), ('albumName', 'album')]:
            value = item.get(source, '')
            if value is None:
                value = ''
            if not isinstance(value, str) or len(value) > 1000:
                raise MusicSearchError('歌词来源返回了无效曲目信息。', 'invalid_response', 502)
            fields[destination] = value.strip()
        for source, destination in [('plainLyrics', 'plain_lyrics'), ('syncedLyrics', 'synced_lyrics')]:
            value = item.get(source) or ''
            if not isinstance(value, str) or len(value) > 100000:
                raise MusicSearchError('歌词来源返回的歌词无效或过长。', 'invalid_response', 502)
            fields[destination] = value.replace('\r\n', '\n').strip()
        return dict(fields, id=record_id, duration=self._duration(item.get('duration')),
                    instrumental=item.get('instrumental') is True,
                    source='LRCLIB', source_url=f'{self.LYRICS_API}/get/{record_id}')

    def search_lyrics(self, query):
        payload = self._json(f'{self.LYRICS_API}/search', {'q': self._query(query)})
        if not isinstance(payload, list):
            raise MusicSearchError('歌词来源返回了无效搜索结果。', 'invalid_response', 502)
        return [self._lyrics_record(item) for item in payload[:20]]

    def get_lyrics(self, record_id):
        record_id = self._lyrics_id(record_id)
        result = self._lyrics_record(self._json(f'{self.LYRICS_API}/get/{record_id}'))
        if result['id'] != record_id:
            raise MusicSearchError('歌词来源返回的记录编号不匹配。', 'invalid_response', 502)
        return result

    @staticmethod
    def _commons_params():
        return {
            'action': 'query', 'format': 'json', 'formatversion': 2,
            'prop': 'imageinfo', 'iiprop': 'url|size|mime|mediatype|extmetadata',
            'iiextmetadatalanguage': 'en',
            'iiextmetadatafilter': 'Artist|Credit|Attribution|LicenseShortName|LicenseUrl|Copyrighted|Restrictions',
            'maxlag': 5,
        }

    @staticmethod
    def _commons_pages(payload):
        if not isinstance(payload, dict):
            raise MusicSearchError('音频来源返回了无效数据。', 'invalid_response', 502)
        if 'error' in payload:
            raise MusicSearchError('音频来源暂时无法完成搜索，请稍后重试。', 'upstream_error', 502)
        query = payload.get('query', {})
        pages = query.get('pages', []) if isinstance(query, dict) else None
        if not isinstance(pages, list):
            raise MusicSearchError('音频来源返回了无效记录。', 'invalid_response', 502)
        return pages

    @staticmethod
    def _audio_url(url):
        if not isinstance(url, str):
            return False
        try:
            parsed = urlsplit(url)
            return (parsed.scheme == 'https' and parsed.hostname == 'upload.wikimedia.org'
                    and parsed.port in (None, 443) and not parsed.username and not parsed.password
                    and parsed.path.startswith('/wikipedia/commons/')
                    and all(key in {'utm_source', 'utm_campaign', 'utm_content'}
                            for key, _ in parse_qsl(parsed.query, keep_blank_values=True))
                    and not parsed.fragment and '\\' not in url)
        except ValueError:
            return False

    @staticmethod
    def _license(metadata):
        def value(key):
            item = metadata.get(key, {})
            return _plain(item.get('value')) if isinstance(item, dict) else ''
        name, url = value('LicenseShortName'), value('LicenseUrl')
        normalized = name.upper().replace('‐', '-').replace('–', '-')
        if url.startswith('//'):
            url = 'https:' + url
        try:
            parsed = urlsplit(url)
        except ValueError:
            return None
        trusted = (parsed.hostname in {'creativecommons.org', 'www.creativecommons.org'}
                   and parsed.scheme in {'http', 'https'} and not parsed.username and not parsed.password)
        if normalized in {'CC0', 'CC0 1.0', 'CC ZERO'} and trusted and parsed.path.rstrip('/') == '/publicdomain/zero/1.0':
            return 'CC0 1.0', 'https://creativecommons.org/publicdomain/zero/1.0/'
        match = re.fullmatch(r'CC (BY(?:-SA)?) (1\.0|2\.0|2\.5|3\.0|4\.0)(?: [A-Z]{2})?', normalized)
        if match and trusted:
            expected = f'/licenses/{match[1].lower()}/{match[2]}'
            if re.fullmatch(re.escape(expected) + r'(?:/[a-z]{2})?/?', parsed.path):
                return name, 'https://creativecommons.org' + parsed.path.rstrip('/') + '/'
        if (normalized == 'PUBLIC DOMAIN' and value('Copyrighted').lower() == 'false'):
            return 'Public domain', 'https://commons.wikimedia.org/wiki/Commons:Public_domain'
        return None

    def _audio_record(self, page):
        if not isinstance(page, dict) or page.get('missing') is True or page.get('ns') != 6:
            return None
        title, infos = page.get('title'), page.get('imageinfo')
        try:
            self._audio_id(title)
        except MusicSearchError:
            return None
        if not isinstance(infos, list) or not infos or not isinstance(infos[0], dict):
            return None
        info = infos[0]
        mime, size = info.get('mime'), info.get('size')
        if (info.get('mediatype') != 'AUDIO' or mime not in self.AUDIO_MIMES
                or isinstance(size, bool) or not isinstance(size, int)
                or not 0 < size <= self.MAX_AUDIO_BYTES or not self._audio_url(info.get('url'))):
            return None
        metadata = info.get('extmetadata', {})
        if not isinstance(metadata, dict):
            return None
        license_data = self._license(metadata)
        if not license_data:
            return None
        def text_value(key):
            item = metadata.get(key, {})
            return _plain(item.get('value')) if isinstance(item, dict) else ''
        artist = text_value('Artist')
        if license_data[0].startswith('CC BY') and not artist:
            return None
        duration = self._duration(info.get('duration'))
        raw_metadata = info.get('metadata', [])
        if isinstance(raw_metadata, list):
            for entry in raw_metadata:
                if isinstance(entry, dict) and str(entry.get('name')).lower() in {'length', 'duration'}:
                    duration = self._duration(entry.get('value'))
                    break
        return {
            'id': title, 'title': title[5:], 'artist': artist or '作者信息见来源页',
            'license': license_data[0], 'license_url': license_data[1],
            'source': 'Wikimedia Commons',
            'source_url': 'https://commons.wikimedia.org/wiki/' + quote(title.replace(' ', '_'), safe=':'),
            'duration': duration, 'audio_url': info['url'].split('?', 1)[0], 'mime': mime, 'size': size,
            'credit': text_value('Credit'), 'attribution': text_value('Attribution'),
            'restrictions': text_value('Restrictions'),
        }

    def search_audio(self, query):
        # Quotes keep user input a keyword phrase rather than a search operator.
        query = self._query(query).replace('"', ' ')
        params = dict(self._commons_params(), generator='search',
                      gsrsearch=f'"{query}" filetype:audio', gsrnamespace=6, gsrlimit=12)
        pages = self._commons_pages(self._json(self.COMMONS_API, params))
        results = []
        for page in sorted(pages, key=lambda p: p.get('index', 0) if isinstance(p, dict) else 0):
            record = self._audio_record(page)
            if record:
                results.append(record)
        return results

    def resolve_audio(self, record_id):
        record_id = self._audio_id(record_id)
        pages = self._commons_pages(self._json(self.COMMONS_API, dict(self._commons_params(), titles=record_id)))
        # No redirects requested. MediaWiki may normalize underscores and spaces.
        for page in pages:
            record = self._audio_record(page)
            if record and record['id'].replace('_', ' ') == record_id.replace('_', ' '):
                return record
        raise MusicSearchError('此音频已不可用，或不符合开放许可、音频类型和 30 MB 大小要求。',
                               'audio_unavailable', 404)

    def download_audio(self, record_id, destination):
        """Download validated Commons audio to a caller-chosen local path atomically.

        Returns source/author/license metadata plus ``path``. The HTTP layer should
        offer an attribution sidecar or retain these fields alongside the file.
        """
        record = self.resolve_audio(record_id)
        destination = Path(destination)
        temporary = None
        try:
            with self._lock:
                self._wait_for_provider('upload.wikimedia.org')
                with self.session.get(record['audio_url'], timeout=(4, 15), stream=True,
                                      allow_redirects=False, headers={
                                          'User-Agent': self.USER_AGENT, 'Accept': 'audio/*,application/ogg',
                                      }) as response:
                    self._check_status(response, 'upload.wikimedia.org')
                    content_type = response.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
                    if content_type not in self.AUDIO_MIMES:
                        raise MusicSearchError('来源未返回有效音频文件。', 'invalid_audio', 502)
                    length = response.headers.get('Content-Length')
                    if length is not None:
                        try:
                            length = int(length)
                        except (TypeError, ValueError) as exc:
                            raise MusicSearchError('来源返回的文件大小无效。', 'invalid_audio', 502) from exc
                        if not 0 < length <= self.MAX_AUDIO_BYTES or length != record['size']:
                            raise MusicSearchError('音频大小已变化或超出 30 MB，请重新搜索。', 'invalid_audio', 502)
                    size, started = 0, time.monotonic()
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.audio-', delete=False) as handle:
                        temporary = handle.name
                        for chunk in response.iter_content(chunk_size=65536):
                            size += len(chunk)
                            if size > self.MAX_AUDIO_BYTES or size > record['size']:
                                raise MusicSearchError('音频大小超出限制。', 'audio_too_large', 502)
                            if time.monotonic() - started > 90:
                                raise MusicSearchError('音频下载超时，请稍后重试。', 'timeout', 504)
                            handle.write(chunk)
                    if size != record['size']:
                        raise MusicSearchError('音频下载不完整，请重试。', 'invalid_audio', 502)
                    os.replace(temporary, destination)
                    temporary = None
            return dict(record, path=str(destination))
        except requests.Timeout as exc:
            raise MusicSearchError('音频下载超时，请稍后重试。', 'timeout', 504) from exc
        except requests.RequestException as exc:
            raise MusicSearchError('音频下载中断，请检查网络后重试。', 'network_error', 502) from exc
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)
