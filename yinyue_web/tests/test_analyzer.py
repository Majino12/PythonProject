import json
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import lyric_analyzer
from lyric_analyzer import LocalLyricAnalyzer


class AnalyzerTests(unittest.TestCase):
    def setUp(self):
        self.analyzer = LocalLyricAnalyzer(model_engine=False)

    def test_zero_evidence_is_neutral(self):
        for lyrics in ('The train is at the station.', '', '[Chorus]\n...'):
            with self.subTest(lyrics=lyrics):
                result = self.analyzer.analyze_lyrics_comprehensive(lyrics)
                self.assertEqual(result['consensus_sentiment'], 'neutral')
                self.assertEqual(result['lexicon']['pos_count'], 0)
                self.assertEqual(result['lexicon']['neg_count'], 0)
                json.dumps(result, allow_nan=False)

    def test_punctuation_does_not_hide_words(self):
        result = self.analyzer.analyze_lyrics_comprehensive('Happy! Happy, happy? Sad.')
        self.assertEqual(result['lexicon']['pos_count'], 3)
        self.assertEqual(result['lexicon']['neg_count'], 1)
        self.assertEqual(result['lexical']['word_count'], 4)
        self.assertEqual(result['lexical']['top_words'][0], {'text': 'happy', 'value': 3})

    def test_negation_and_contractions(self):
        for text in ("I don't love you", 'I’m not happy', 'I am not very happy', 'I never feel happy'):
            with self.subTest(text=text):
                cleaned = self.analyzer.clean_lyrics(text)
                self.assertEqual(self.analyzer.analyze_sentiment_lexicon(cleaned)['sentiment'], 'negative')
        self.assertIn("don't", self.analyzer.clean_lyrics("Don't leave"))

    def test_negation_stops_at_punctuation_and_contrast(self):
        for text in ('not sad. happy', 'not sad, happy', 'not sad\nhappy', 'not sad but happy'):
            with self.subTest(text=text):
                result = self.analyzer.analyze_sentiment_lexicon(text)
                self.assertEqual(result['pos_count'], 2)
                self.assertEqual(result['neg_count'], 0)

    def test_opposing_evidence_tie_is_neutral(self):
        self.assertEqual(self.analyzer.get_consensus_sentiment(
            {'sentiment': 'positive', 'polarity': 0.3},
            {'sentiment': 'negative', 'score': -0.2}), 'neutral')

    def test_chinese_dictionary_and_negation(self):
        positive = self.analyzer.analyze_lyrics_comprehensive('我很快乐，心里充满希望。')
        negative = self.analyzer.analyze_lyrics_comprehensive('我不快乐。')
        self.assertEqual(positive['metadata']['language'], 'zh')
        self.assertEqual(positive['consensus_sentiment'], 'positive')
        self.assertEqual(negative['consensus_sentiment'], 'negative')
        self.assertGreater(positive['overall_polarity'], 0)
        self.assertLess(negative['overall_polarity'], 0)
        self.assertFalse(positive['textblob']['supported'])
        self.assertEqual(positive['metadata']['method'], 'lexicon')
        self.assertTrue(any('中文' in note for note in positive['metadata']['limitations']))
        self.assertGreater(self.analyzer.create_emotion_vector(positive)['polarity'], 0)

    def test_korean_dictionary_and_negation(self):
        positive = self.analyzer.analyze_lyrics_comprehensive('나는 행복해 사랑해')
        self.assertEqual(positive['metadata']['language'], 'ko')
        self.assertEqual(positive['consensus_sentiment'], 'positive')
        self.assertTrue(any('韩文' in note for note in positive['metadata']['limitations']))
        for lyrics in ('행복하지 않아', '안 행복해'):
            with self.subTest(lyrics=lyrics):
                self.assertEqual(self.analyzer.analyze_lyrics_comprehensive(lyrics)['consensus_sentiment'], 'negative')

    def test_mixed_scripts_without_spaces(self):
        result = self.analyzer.analyze_lyrics_comprehensive('我love你 사랑해')
        self.assertEqual(result['metadata']['language'], 'mixed')
        self.assertEqual(result['lexicon']['pos_count'], 2)
        self.assertGreater(result['lexical']['word_count'], 2)

    def test_unsupported_script_is_marked(self):
        for lyrics in ('Привет мир', '愛してる', '🎵🎶'):
            with self.subTest(lyrics=lyrics):
                result = self.analyzer.analyze_lyrics_comprehensive(lyrics)
                self.assertEqual(result['metadata']['language'], 'unknown')
                self.assertFalse(result['textblob']['supported'])
                self.assertTrue(any('未识别' in note for note in result['metadata']['limitations']))

    def test_line_trajectory_preserves_text_and_omits_section_headers(self):
        result = self.analyzer.analyze_lyrics_comprehensive('[Verse]\nI am happy!\n\nI am sad.\n[Chorus]')
        lines = result['line_analysis']
        self.assertEqual([line['text'] for line in lines], ['I am happy!', 'I am sad.'])
        self.assertEqual([line['sentiment'] for line in lines], ['positive', 'negative'])
        self.assertGreater(lines[0]['polarity'], 0)
        self.assertLess(lines[1]['polarity'], 0)

    def test_textblob_missing_has_explicit_fallback(self):
        with patch.object(lyric_analyzer, 'TextBlob', None):
            result = self.analyzer.analyze_lyrics_comprehensive('I am happy')
        self.assertFalse(result['textblob']['available'])
        self.assertEqual(result['metadata']['method'], 'lexicon')
        self.assertEqual(result['consensus_sentiment'], 'positive')
        self.assertTrue(any('不可用' in note for note in result['metadata']['limitations']))

    @unittest.skipIf(lyric_analyzer.TextBlob is None, 'Optional TextBlob is not installed')
    def test_real_textblob_english_negation(self):
        result = self.analyzer.analyze_lyrics_comprehensive('I am not happy.')
        self.assertTrue(result['textblob']['available'])
        self.assertEqual(result['metadata']['method'], 'textblob+lexicon')
        self.assertLess(result['textblob']['polarity'], 0)
        self.assertEqual(result['consensus_sentiment'], 'negative')


class RecommendationTests(unittest.TestCase):
    def setUp(self):
        self.analyzer = LocalLyricAnalyzer(model_engine=False)

    def song(self, song_id, lyrics='I am happy!', title='Same title'):
        result = self.analyzer.analyze_lyrics_comprehensive(lyrics)
        return {'id': song_id, 'title': title, 'artist': 'Artist ' + str(song_id),
                'genre': 'Pop', 'analysis': result,
                'emotion_vector': self.analyzer.create_emotion_vector(result)}

    def test_same_titles_are_distinct_and_target_is_excluded(self):
        songs = [self.song(1), self.song(2), self.song(3, 'I am sad.')]
        result = self.analyzer.recommend_songs('1', songs)
        self.assertEqual([item['id'] for item in result], [2, 3])
        self.assertEqual(result[0]['similarity'], 1.0)
        self.assertEqual(result[0]['artist'], 'Artist 2')
        self.assertEqual(set(result[0]), {'id', 'title', 'artist', 'genre', 'similarity'})

    def test_fixed_normalization_is_independent_of_library(self):
        target, other = self.song(1), self.song(2, 'I am sad.')
        before = self.analyzer.recommend_songs(1, [target, other])[0]['similarity']
        after = {song['id']: song['similarity'] for song in self.analyzer.recommend_songs(
            1, [self.song(3, 'Love beautiful wonderful'), other, target])}[2]
        self.assertEqual(before, after)
        self.assertGreaterEqual(before, 0)
        self.assertLessEqual(before, 1)

    def test_identical_neutral_vectors_have_full_similarity(self):
        result = self.analyzer.recommend_songs(1, [self.song(1, ''), self.song(2, '')])
        self.assertEqual(result[0]['similarity'], 1.0)

    def test_limits_unknown_target_and_missing_vectors(self):
        songs = [self.song(1), self.song(2), {'id': 3, 'emotion_vector': None}]
        self.assertEqual(self.analyzer.recommend_songs(999, songs), [])
        self.assertEqual(self.analyzer.recommend_songs(1, songs, 0), [])
        self.assertEqual(self.analyzer.recommend_songs(1, [songs[0]]), [])
        self.assertEqual(len(self.analyzer.recommend_songs(1, songs, 1)), 1)

    def test_corrupt_non_finite_vector_is_ignored(self):
        bad = self.song(3)
        bad['emotion_vector']['polarity'] = math.nan
        result = self.analyzer.recommend_songs(1, [self.song(1), self.song(2), bad])
        self.assertEqual([item['id'] for item in result], [2])
        json.dumps(result, allow_nan=False)

    def test_legacy_array_vector_is_supported(self):
        target, legacy, malformed = self.song(1), self.song(2), self.song(3)
        legacy['emotion_vector'] = list(legacy['emotion_vector'].values())
        malformed['emotion_vector'] = [0.5, 0.5]
        result = self.analyzer.recommend_songs(1, [target, legacy, malformed])
        self.assertEqual([item['id'] for item in result], [2])
        self.assertEqual(result[0]['similarity'], 1.0)

    def test_library_uses_ids_and_injected_database(self):
        class Database:
            def get_all_songs_with_analysis(inner_self, limit):
                return [self.song(1), self.song(2)]

        library = self.analyzer.analyze_song_library(Database())
        self.assertEqual(set(library), {1, 2})
        self.assertEqual(library[1]['title'], library[2]['title'])


if __name__ == '__main__':
    unittest.main()
