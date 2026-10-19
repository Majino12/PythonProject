import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock

import requests
from backend.crawler import UnifiedCrawler


class CrawlerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.session = Mock()
        self.crawler = UnifiedCrawler(self.folder.name, session=self.session)

    def response(self, status=200, body=None):
        response = Mock(status_code=status)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        raw = body if isinstance(body, bytes) else json.dumps(body or {'lyrics': 'My original happy song.'}).encode()
        response.iter_content.return_value = [raw]
        self.session.get.return_value = response
        return response

    def test_fetch_is_cached_and_cache_expires(self):
        self.response()
        first = self.crawler.crawl_song('Artist', 'Song')
        self.assertEqual(first['source'], 'lyrics.ovh')
        self.assertEqual(self.crawler.crawl_song('Artist', 'Song')['source'], 'cache')
        self.assertEqual(self.session.get.call_count, 1)
        key = self.crawler._get_cache_key('Artist', 'Song')
        path = Path(self.folder.name) / f'{key}.json'
        path.write_text(json.dumps({'lyrics': 'stale', 'timestamp': time.time() - 90000}))
        self.crawler.crawl_song('Artist', 'Song')
        self.assertEqual(self.session.get.call_count, 2)

    def test_cache_keys_cannot_collide_at_separator(self):
        self.assertNotEqual(self.crawler._get_cache_key('a_b', 'c'), self.crawler._get_cache_key('a', 'b_c'))
        self.assertEqual(self.crawler._get_cache_key(' ARTIST ', 'Song'), self.crawler._get_cache_key('artist', 'song'))

    def test_path_segments_are_escaped_and_redirects_disabled(self):
        self.response()
        self.crawler.crawl_song('AC/DC', 'A?B#C')
        args, kwargs = self.session.get.call_args
        self.assertIn('AC%2FDC/A%3FB%23C', args[0])
        self.assertFalse(kwargs['allow_redirects'])
        self.assertEqual(kwargs['timeout'], (4, 12))

    def test_failure_modes_are_distinct(self):
        for status, code in ((404, 'not_found'), (429, 'rate_limited'), (503, 'upstream_error')):
            with self.subTest(status=status):
                self.response(status)
                result = self.crawler.crawl_song('Artist', 'Song', use_cache=False)
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['error_code'], code)
        self.session.get.side_effect = requests.Timeout()
        self.assertEqual(self.crawler.crawl_song('Artist', 'Song')['error_code'], 'timeout')
        self.session.get.side_effect = requests.ConnectionError()
        self.assertEqual(self.crawler.crawl_song('Artist', 'Song')['error_code'], 'network_error')

    def test_invalid_payloads_and_large_response(self):
        for body in (b'not-json', b'[]', b'{"lyrics":17}', b'{"lyrics":"   "}', b'x' * 512001):
            with self.subTest(body_length=len(body)):
                self.response(body=body)
                result = self.crawler.crawl_song('Artist', 'Song', use_cache=False)
                self.assertEqual(result['error_code'], 'invalid_response')

    def test_invalid_input_does_not_make_request(self):
        for value in (' ', None, {}, 'x' * 201):
            self.assertEqual(self.crawler.crawl_song(value, 'Song')['http_status'], 400)
        self.session.get.assert_not_called()

    def test_corrupt_cache_is_ignored(self):
        key = self.crawler._get_cache_key('Artist', 'Song')
        (Path(self.folder.name) / f'{key}.json').write_text('{bad')
        self.response()
        self.assertEqual(self.crawler.crawl_song('Artist', 'Song')['source'], 'lyrics.ovh')


if __name__ == '__main__':
    unittest.main()
