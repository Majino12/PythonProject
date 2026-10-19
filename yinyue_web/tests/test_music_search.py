import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import requests

from backend.music_search import MusicSearchError, MusicSearchService


def lyrics_record(**overrides):
    return dict({
        'id': 42, 'trackName': '自创测试歌', 'artistName': '테스트', 'albumName': 'Examples',
        'duration': 12.5, 'plainLyrics': '晨光落在窗台\r\n오늘도 웃어요',
        'syncedLyrics': '[00:01.00]晨光落在窗台', 'instrumental': False,
    }, **overrides)


def commons_page(**overrides):
    page = {
        'ns': 6, 'title': 'File:Original song.ogg', 'index': 1,
        'imageinfo': [{
            'size': 8, 'duration': 12.25, 'mime': 'application/ogg', 'mediatype': 'AUDIO',
            'url': 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Original_song.ogg',
            'extmetadata': {
                'Artist': {'value': '<a href="https://example.com">Original &amp; Artist</a>'},
                'LicenseShortName': {'value': 'CC BY 4.0'},
                'LicenseUrl': {'value': 'https://creativecommons.org/licenses/by/4.0/'},
                'Credit': {'value': '<p>Own work</p>'},
                'Copyrighted': {'value': 'True'},
                'Restrictions': {'value': ''},
            },
        }],
    }
    page.update(overrides)
    return page


class MusicSearchTests(unittest.TestCase):
    def setUp(self):
        self.session = Mock()
        self.service = MusicSearchService(session=self.session)
        self.sleep = patch('backend.music_search.time.sleep').start()
        self.addCleanup(patch.stopall)
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)

    @staticmethod
    def response(body=None, status=200, headers=None):
        response = Mock(status_code=status, headers=headers or {})
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        response.iter_content.return_value = [raw]
        return response

    def serve_pages(self, pages):
        self.session.get.return_value = self.response({'query': {'pages': pages}})

    def test_lyrics_search_preserves_selected_record_and_languages(self):
        self.session.get.return_value = self.response([lyrics_record(), lyrics_record(id=43, instrumental=True,
                                                                                       plainLyrics=None, syncedLyrics=None)])
        results = self.service.search_lyrics('中文 한국어')
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['id'], 42)
        self.assertEqual(results[0]['plain_lyrics'], '晨光落在窗台\n오늘도 웃어요')
        self.assertEqual(results[0]['synced_lyrics'], '[00:01.00]晨光落在窗台')
        self.assertEqual(results[1]['plain_lyrics'], '')
        self.assertTrue(results[1]['instrumental'])
        args, kwargs = self.session.get.call_args
        self.assertEqual(args[0], 'https://lrclib.net/api/search')
        self.assertEqual(kwargs['params'], {'q': '中文 한국어'})
        self.assertFalse(kwargs['allow_redirects'])
        self.assertIn('github.com/Majino12/PythonProject', kwargs['headers']['User-Agent'])

    def test_get_lyrics_checks_record_id(self):
        self.session.get.return_value = self.response(lyrics_record())
        self.assertEqual(self.service.get_lyrics('42')['source_url'], 'https://lrclib.net/api/get/42')
        with self.assertRaises(MusicSearchError) as raised:
            self.service.get_lyrics(43)
        self.assertEqual(raised.exception.code, 'invalid_response')

    def test_no_search_results_is_valid(self):
        self.session.get.return_value = self.response([])
        self.assertEqual(self.service.search_lyrics('missing'), [])
        self.session.get.return_value = self.response({'batchcomplete': True})
        self.assertEqual(self.service.search_audio('missing'), [])

    def test_input_validation_never_fetches_arbitrary_urls(self):
        for value in ('', ' ', 'x' * 201, None, [], 'a\nb'):
            for method in (self.service.search_lyrics, self.service.search_audio):
                with self.subTest(value=value, method=method.__name__), self.assertRaises(MusicSearchError) as raised:
                    method(value)
                self.assertEqual(raised.exception.http_status, 400)
        for value in ('https://127.0.0.1/', '../42', 0, -1, True, '42/../43'):
            with self.subTest(value=value), self.assertRaises(MusicSearchError):
                self.service.get_lyrics(value)
        for value in ('https://upload.wikimedia.org/a.ogg', 'File:a|File:b', 'File:bad\n', None):
            with self.subTest(value=value), self.assertRaises(MusicSearchError):
                self.service.resolve_audio(value)
        self.session.get.assert_not_called()

    def test_upstream_failures_are_not_empty_successes(self):
        for status, code in ((404, 'not_found'), (301, 'upstream_error'), (503, 'upstream_error')):
            self.session.get.return_value = self.response({}, status=status)
            with self.subTest(status=status), self.assertRaises(MusicSearchError) as raised:
                self.service.search_lyrics('song')
            self.assertEqual(raised.exception.code, code)
        for error, code in ((requests.Timeout(), 'timeout'), (requests.ConnectionError(), 'network_error')):
            self.session.get.side_effect = error
            with self.subTest(error=error), self.assertRaises(MusicSearchError) as raised:
                self.service.search_audio('song')
            self.assertEqual(raised.exception.code, code)

    def test_rate_limit_honors_retry_after_without_repeated_requests(self):
        self.session.get.return_value = self.response({}, status=429, headers={'Retry-After': '90'})
        with self.assertRaises(MusicSearchError) as raised:
            self.service.search_lyrics('song')
        self.assertEqual(raised.exception.retry_after, 90)
        with self.assertRaises(MusicSearchError) as repeated:
            self.service.get_lyrics(42)
        self.assertEqual(repeated.exception.code, 'rate_limited')
        self.assertEqual(self.session.get.call_count, 1)

    def test_invalid_json_and_oversized_response_fail(self):
        for raw in (b'broken-json', b'{}', b'x' * (self.service.MAX_JSON_BYTES + 1)):
            self.session.get.return_value = self.response(raw)
            with self.subTest(length=len(raw)), self.assertRaises(MusicSearchError) as raised:
                self.service.search_lyrics('song')
            self.assertEqual(raised.exception.code, 'invalid_response')
        self.session.get.return_value = self.response([lyrics_record(plainLyrics=17)])
        with self.assertRaises(MusicSearchError):
            self.service.search_lyrics('song')

    def test_audio_metadata_is_plain_text_and_keeps_attribution(self):
        page = commons_page()
        page['imageinfo'][0]['extmetadata']['Attribution'] = {'value': 'Credit the <b>performer</b>.'}
        page['imageinfo'][0]['url'] += '?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original'
        self.serve_pages([page])
        result = self.service.search_audio('Arirang')[0]
        self.assertEqual(result['id'], 'File:Original song.ogg')
        self.assertEqual(result['artist'], 'Original & Artist')
        self.assertEqual(result['license'], 'CC BY 4.0')
        self.assertEqual(result['credit'], 'Own work')
        self.assertEqual(result['attribution'], 'Credit the performer.')
        self.assertNotIn('?', result['audio_url'])
        self.assertEqual(result['duration'], 12.25)
        self.assertEqual(result['source_url'], 'https://commons.wikimedia.org/wiki/File:Original_song.ogg')

    def test_public_domain_and_cc0_are_allowed(self):
        for name, url, copyrighted in (
            ('Public domain', '', 'False'),
            ('CC0', 'https://creativecommons.org/publicdomain/zero/1.0/', 'False'),
            ('CC BY-SA 3.0', '//creativecommons.org/licenses/by-sa/3.0/', 'True'),
        ):
            page = commons_page()
            meta = page['imageinfo'][0]['extmetadata']
            meta['LicenseShortName']['value'] = name
            meta['LicenseUrl']['value'] = url
            meta['Copyrighted']['value'] = copyrighted
            self.serve_pages([page])
            with self.subTest(license=name):
                self.assertEqual(len(self.service.search_audio('song')), 1)

    def test_license_is_checked_not_assumed_from_provider(self):
        for name, url, copyrighted in (
            ('CC BY-NC 4.0', 'https://creativecommons.org/licenses/by-nc/4.0/', 'True'),
            ('CC BY-ND 4.0', 'https://creativecommons.org/licenses/by-nd/4.0/', 'True'),
            ('All rights reserved', '', 'True'),
            ('Public domain', '', 'True'),
            ('CC BY 4.0', 'https://evil.test/licenses/by/4.0/', 'True'),
            ('CC BY 4.0', 'https://creativecommons.org/licenses/by-nc/4.0/', 'True'),
            ('CC0', '', 'False'),
        ):
            page = commons_page()
            meta = page['imageinfo'][0]['extmetadata']
            meta['LicenseShortName']['value'] = name
            meta['LicenseUrl']['value'] = url
            meta['Copyrighted']['value'] = copyrighted
            self.serve_pages([page])
            with self.subTest(license=name, url=url):
                self.assertEqual(self.service.search_audio('song'), [])

    def test_audio_results_require_author_mime_size_and_trusted_host(self):
        variants = []
        for key, value in (
            ('size', 0), ('size', self.service.MAX_AUDIO_BYTES + 1), ('size', True),
            ('mime', 'image/png'), ('mediatype', 'VIDEO'),
            ('url', 'https://evil.test/a.ogg'),
            ('url', 'http://upload.wikimedia.org/wikipedia/commons/a.ogg'),
            ('url', 'https://upload.wikimedia.org.evil.test/wikipedia/commons/a.ogg'),
            ('url', 'https://user@upload.wikimedia.org/wikipedia/commons/a.ogg'),
            ('url', 'https://upload.wikimedia.org:8080/wikipedia/commons/a.ogg'),
            ('url', 'https://upload.wikimedia.org/wikipedia/en/a.ogg'),
            ('url', 'https://upload.wikimedia.org/wikipedia/commons/a.ogg?redirect=evil'),
        ):
            page = commons_page()
            page['imageinfo'][0][key] = value
            variants.append(page)
        no_author = commons_page()
        no_author['imageinfo'][0]['extmetadata'].pop('Artist')
        variants.append(no_author)
        self.serve_pages(variants)
        self.assertEqual(self.service.search_audio('song'), [])

    def test_audio_resolve_does_not_select_other_record(self):
        self.serve_pages([commons_page()])
        self.assertEqual(self.service.resolve_audio('File:Original_song.ogg')['id'], 'File:Original song.ogg')
        with self.assertRaises(MusicSearchError) as raised:
            self.service.resolve_audio('File:Other song.ogg')
        self.assertEqual(raised.exception.code, 'audio_unavailable')

    def test_download_revalidates_metadata_and_writes_only_complete_file(self):
        self.session.get.side_effect = [
            self.response({'query': {'pages': [commons_page()]}}),
            self.response(b'OggS1234', headers={'Content-Type': 'application/ogg', 'Content-Length': '8'}),
        ]
        destination = Path(self.folder.name) / 'song.ogg'
        result = self.service.download_audio('File:Original song.ogg', destination)
        self.assertEqual(destination.read_bytes(), b'OggS1234')
        self.assertEqual(result['path'], str(destination))
        self.assertEqual(result['license'], 'CC BY 4.0')
        self.assertEqual(len(list(destination.parent.iterdir())), 1)
        self.assertFalse(self.session.get.call_args.kwargs['allow_redirects'])

    def test_download_refuses_changed_license_before_fetching_bytes(self):
        page = commons_page()
        page['imageinfo'][0]['extmetadata']['LicenseShortName']['value'] = 'All rights reserved'
        self.serve_pages([page])
        with self.assertRaises(MusicSearchError):
            self.service.download_audio('File:Original song.ogg', Path(self.folder.name) / 'song.ogg')
        self.assertEqual(self.session.get.call_count, 1)
        self.assertEqual(list(Path(self.folder.name).iterdir()), [])

    def test_failed_download_leaves_existing_file_and_no_partial_file(self):
        destination = Path(self.folder.name) / 'song.ogg'
        destination.write_bytes(b'old-file')
        for raw, status, headers, expected_code in (
            (b'123', 200, {'Content-Type': 'application/ogg'}, 'invalid_audio'),
            (b'123456789', 200, {'Content-Type': 'application/ogg'}, 'audio_too_large'),
            (b'HTML', 200, {'Content-Type': 'text/html'}, 'invalid_audio'),
            (b'OggS1234', 200, {'Content-Type': 'audio/ogg', 'Content-Length': '100000000'}, 'invalid_audio'),
            (b'OggS1234', 302, {'Location': 'http://127.0.0.1/private'}, 'upstream_error'),
        ):
            self.session.get.side_effect = [
                self.response({'query': {'pages': [commons_page()]}}),
                self.response(raw, status=status, headers=headers),
            ]
            with self.subTest(status=status, length=len(raw)), self.assertRaises(MusicSearchError) as raised:
                self.service.download_audio('File:Original song.ogg', destination)
            self.assertEqual(raised.exception.code, expected_code)
            self.assertEqual(destination.read_bytes(), b'old-file')
            self.assertEqual(list(destination.parent.iterdir()), [destination])

    def test_interrupted_download_cleans_temporary_file(self):
        response = self.response(b'', headers={'Content-Type': 'application/ogg'})
        def interrupted(**kwargs):
            yield b'OggS'
            raise requests.ConnectionError('connection dropped')
        response.iter_content.side_effect = interrupted
        self.session.get.side_effect = [self.response({'query': {'pages': [commons_page()]}}), response]
        with self.assertRaises(MusicSearchError) as raised:
            self.service.download_audio('File:Original song.ogg', Path(self.folder.name) / 'song.ogg')
        self.assertEqual(raised.exception.code, 'network_error')
        self.assertEqual(list(Path(self.folder.name).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
