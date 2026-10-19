"""Model routing and application semantics without model files or downloads."""

import json
import unittest

from backend.lyric_analyzer import LocalLyricAnalyzer


class FakeModelEngine:
    def __init__(self, *, scores=None, fail_languages=(), chunk_count=1):
        self.scores = scores or {'zh': 0.9, 'ko': -0.9}
        self.fail_languages = set(fail_languages)
        self.chunk_count = chunk_count
        self.calls = []

    def predict(self, texts, language):
        self.calls.append((list(texts), language))
        if language in self.fail_languages:
            raise RuntimeError('private /model/path contains secret details')
        results = []
        for text in texts:
            score = self.scores[language]
            positive = (score + 1) / 2
            confidence = max(positive, 1 - positive)
            results.append({
                'polarity': score,
                'sentiment': (
                    ('positive' if score > 0 else 'negative')
                    if confidence >= 0.65 else 'uncertain'),
                'confidence': confidence,
                'probabilities': {'positive': positive, 'negative': 1 - positive},
                'chunk_count': self.chunk_count,
                'model': f'fixture-model-{language}',
                'revision': f'fixture-revision-{language}',
            })
        return results

    def status(self):
        return {language: {'status': 'ready'} for language in ('zh', 'ko')}


class ModelIntegrationTests(unittest.TestCase):
    def test_specialized_prediction_replaces_opposing_dictionary_label(self):
        analyzer = LocalLyricAnalyzer(FakeModelEngine(scores={'zh': -0.9}))
        result = analyzer.analyze_lyrics_comprehensive('快乐 幸福 希望')
        self.assertEqual(result['lexicon']['sentiment'], 'positive')
        self.assertEqual(result['consensus_sentiment'], 'negative')
        self.assertEqual(result['overall_polarity'], -0.9)
        self.assertEqual(result['metadata']['method'], 'transformer')
        self.assertTrue(result['model_sentiment']['available'])
        self.assertEqual(result['metadata']['models'], [{
            'language': 'zh', 'model': 'fixture-model-zh',
            'revision': 'fixture-revision-zh',
        }])
        self.assertFalse(any('未使用中文专用' in item for item in result['metadata']['limitations']))

    def test_overall_model_polarity_reaches_recommendation_vector(self):
        analyzer = LocalLyricAnalyzer(FakeModelEngine(scores={'ko': -0.8}))
        result = analyzer.analyze_lyrics_comprehensive('행복해 사랑해')
        self.assertGreater(result['lexicon']['score'], 0)
        vector = analyzer.create_emotion_vector(result)
        self.assertEqual(vector['polarity'], -0.8)
        self.assertGreater(vector['lexicon_score'], 0)
        json.dumps(vector, allow_nan=False)

    def test_chinese_and_korean_route_to_their_own_models(self):
        for text, language in [('我们再次出发。', 'zh'), ('우리 다시 출발해.', 'ko')]:
            with self.subTest(language=language):
                engine = FakeModelEngine()
                result = LocalLyricAnalyzer(engine).analyze_lyrics_comprehensive(text)
                self.assertEqual([call[1] for call in engine.calls], [language])
                self.assertEqual(engine.calls[0][0], [text])
                self.assertEqual(result['metadata']['language'], language)
                self.assertEqual(result['line_analysis'][0]['method'], 'transformer')

    def test_english_japanese_unknown_and_empty_do_not_call_specialized_models(self):
        for text in ['I am happy.', '愛してる', 'Привет мир', '🎵', '', '[Chorus]\n...']:
            with self.subTest(text=text):
                engine = FakeModelEngine()
                result = LocalLyricAnalyzer(engine).analyze_lyrics_comprehensive(text)
                self.assertEqual(engine.calls, [])
                self.assertFalse(result['model_sentiment']['available'])
                self.assertNotEqual(result['metadata']['method'], 'transformer')

    def test_chinese_korean_separate_lines_are_routed_without_cross_language_text(self):
        engine = FakeModelEngine()
        result = LocalLyricAnalyzer(engine).analyze_lyrics_comprehensive('我们再次出发\n우리 다시 출발해')
        self.assertEqual(engine.calls, [(['我们再次出发'], 'zh'), (['우리 다시 출발해'], 'ko')])
        self.assertEqual(result['metadata']['method'], 'hybrid')
        self.assertEqual(result['consensus_sentiment'], 'mixed')
        self.assertEqual(result['metadata']['model_line_coverage'], {'modeled': 2, 'total': 2})
        self.assertFalse(result['model_sentiment']['partial'])
        self.assertEqual([line['sentiment'] for line in result['line_analysis']], ['positive', 'negative'])

    def test_same_line_chinese_and_korean_are_not_sent_to_either_model(self):
        engine = FakeModelEngine()
        result = LocalLyricAnalyzer(engine).analyze_lyrics_comprehensive('我们一起 사랑해')
        self.assertEqual(engine.calls, [])
        self.assertEqual(result['metadata']['language'], 'mixed')
        self.assertEqual(result['metadata']['method'], 'lexicon')
        self.assertFalse(result['model_sentiment']['available'])

    def test_english_only_line_is_not_folded_into_chinese_or_korean_model(self):
        for text, language in [('我们再次出发', 'zh'), ('우리 다시 출발해', 'ko')]:
            with self.subTest(language=language):
                engine = FakeModelEngine()
                result = LocalLyricAnalyzer(engine).analyze_lyrics_comprehensive(text + '\nI am happy.')
                self.assertEqual(engine.calls, [([text], language)])
                self.assertEqual(result['metadata']['method'], 'hybrid')
                self.assertTrue(result['model_sentiment']['partial'])
                self.assertEqual(result['metadata']['model_line_coverage'], {'modeled': 1, 'total': 2})
                self.assertNotEqual(result['line_analysis'][-1]['method'], 'transformer')

    def test_inline_english_does_not_split_a_chinese_or_korean_sentence(self):
        for text, language in [('我想对你说 thank you', 'zh'), ('너에게 말할게 thank you', 'ko')]:
            with self.subTest(language=language):
                engine = FakeModelEngine()
                result = LocalLyricAnalyzer(engine).analyze_lyrics_comprehensive(text)
                self.assertEqual(engine.calls, [([text], language)])
                self.assertEqual(result['metadata']['method'], 'transformer')

    def test_mixed_line_keeps_fallback_and_reports_partial_coverage(self):
        engine = FakeModelEngine()
        result = LocalLyricAnalyzer(engine).analyze_lyrics_comprehensive('我们出发\n우리 함께\n我们 사랑해')
        self.assertEqual(engine.calls, [(['我们出发'], 'zh'), (['우리 함께'], 'ko')])
        self.assertTrue(result['model_sentiment']['partial'])
        self.assertEqual(result['metadata']['model_line_coverage'], {'modeled': 2, 'total': 3})
        self.assertEqual(result['line_analysis'][-1]['method'], 'lexicon')

    def test_model_failure_is_explicit_and_returns_the_baseline_prediction(self):
        text = '我不快乐。'
        baseline = LocalLyricAnalyzer(model_engine=False).analyze_lyrics_comprehensive(text)
        engine = FakeModelEngine(fail_languages={'zh'})
        with self.assertLogs('backend.lyric_analyzer', level='WARNING'):
            result = LocalLyricAnalyzer(engine).analyze_lyrics_comprehensive(text)
        self.assertFalse(result['model_sentiment']['available'])
        self.assertEqual(result['consensus_sentiment'], baseline['consensus_sentiment'])
        self.assertEqual(result['overall_polarity'], baseline['overall_polarity'])
        self.assertEqual(result['metadata']['method'], 'lexicon')
        self.assertIn('zh', result['model_sentiment']['fallback_reasons'])
        self.assertTrue(any('回退' in item for item in result['metadata']['limitations']))
        self.assertNotIn('secret', json.dumps(result))
        self.assertNotIn('/model/path', json.dumps(result))

    def test_one_language_failure_keeps_other_model_and_exposes_fallback(self):
        engine = FakeModelEngine(fail_languages={'zh'})
        with self.assertLogs('backend.lyric_analyzer', level='WARNING'):
            result = LocalLyricAnalyzer(engine).analyze_lyrics_comprehensive('快乐\n우리 다시 출발해')
        self.assertTrue(result['model_sentiment']['available'])
        self.assertTrue(result['model_sentiment']['partial'])
        self.assertEqual(result['metadata']['method'], 'hybrid')
        self.assertEqual(result['metadata']['model_line_coverage'], {'modeled': 1, 'total': 2})
        self.assertIn('zh', result['metadata']['fallback_reasons'])
        self.assertEqual(result['line_analysis'][0]['method'], 'lexicon')
        self.assertEqual(result['line_analysis'][1]['method'], 'transformer')

    def test_response_count_mismatch_falls_back_without_partial_predictions(self):
        class EmptyEngine(FakeModelEngine):
            def predict(self, texts, language):
                return []

        with self.assertLogs('backend.lyric_analyzer', level='WARNING'):
            result = LocalLyricAnalyzer(EmptyEngine()).analyze_lyrics_comprehensive('快乐')
        self.assertFalse(result['model_sentiment']['available'])
        self.assertEqual(result['consensus_sentiment'], 'positive')
        self.assertEqual(result['metadata']['models'], [])

    def test_low_confidence_retains_uncertain_label_in_summary_and_lines(self):
        analyzer = LocalLyricAnalyzer(FakeModelEngine(scores={'zh': 0.12}))
        result = analyzer.analyze_lyrics_comprehensive('我们经过一座桥。')
        self.assertEqual(result['consensus_sentiment'], 'uncertain')
        self.assertEqual(result['model_sentiment']['sentiment'], 'uncertain')
        self.assertEqual(result['line_analysis'][0]['sentiment'], 'uncertain')
        self.assertNotEqual(result['consensus_sentiment'], 'neutral')
        self.assertAlmostEqual(result['model_sentiment']['confidence'], 0.56)
        self.assertEqual(analyzer.create_emotion_vector(result)['polarity'], 0.12)

    def test_full_long_text_and_last_line_are_preserved_for_model_inference(self):
        engine = FakeModelEngine(chunk_count=7)
        analyzer = LocalLyricAnalyzer(engine)
        first_line = '我们一路走过河流与山岗。' * 600
        last_line = '直到最后才知道你早已离开。'
        text = '[Verse]\n' + first_line + '\n' + last_line
        result = analyzer.analyze_lyrics_comprehensive(text)
        requested_texts = engine.calls[0][0]
        self.assertIn(first_line + '\n' + last_line, requested_texts)
        self.assertIn(last_line, requested_texts)
        self.assertGreater(len(requested_texts[0]), 512)
        self.assertEqual(result['line_analysis'][-1]['text'], last_line)
        self.assertEqual(result['model_sentiment']['chunk_count'], 7)
        self.assertEqual(result['metadata']['model_line_coverage'], {'modeled': 2, 'total': 2})
        json.dumps(result, allow_nan=False)

    def test_disabled_models_keep_stable_dictionary_baseline(self):
        analyzer = LocalLyricAnalyzer(model_engine=False)
        self.assertEqual(analyzer.model_status(), {'zh': {'status': 'disabled'}, 'ko': {'status': 'disabled'}})
        for text, expected in [('我很快乐。', 'positive'), ('我不快乐。', 'negative'),
                               ('나는 행복해', 'positive'), ('행복하지 않아', 'negative')]:
            with self.subTest(text=text):
                result = analyzer.analyze_lyrics_comprehensive(text)
                self.assertEqual(result['consensus_sentiment'], expected)
                self.assertEqual(result['metadata']['method'], 'lexicon')
                self.assertFalse(result['model_sentiment']['available'])


if __name__ == '__main__':
    unittest.main()
