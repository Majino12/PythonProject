"""Lyric features and stable recommendations without numeric dependencies.

English combines TextBlob with a lexicon. Chinese and Korean use deliberately
limited dictionaries; every analysis exposes the corresponding limitations.
"""

import logging
import math
import re
import unicodedata
from collections import Counter

try:
    from textblob import TextBlob
except ImportError:
    TextBlob = None

logger = logging.getLogger(__name__)


class LocalLyricAnalyzer:
    VERSION = "2.0"
    TOKEN_RE = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)*", re.UNICODE)
    BOUNDARY_RE = re.compile(r"[.!?,;:。！？、；：\n]")
    VECTOR_WEIGHTS = {
        'polarity': 3.0, 'subjectivity': 1.0, 'lexicon_score': 3.0,
        'lexical_diversity': 1.0, 'emotion_density': 2.0,
        'sentence_complexity': 0.5,
    }

    def __init__(self):
        self.positive_words = set(
            'love loved loving happy happiness beautiful amazing wonderful fantastic '
            'great good perfect nice sweet better best joy joyful smile smiling laugh '
            'peace hope hopeful dream free bright heaven angel paradise trust '
            'passionate glory victory alive fun enjoy'.split()
        )
        self.negative_words = set(
            'hate hated sad sadness bad wrong hurt pain painful cry crying tears '
            'broken lost alone death hell sorry regret miss fear lonely empty '
            'sorrow grief fail hopeless miserable heartbreak'.split()
        )
        self.zh_positive = set('爱 喜欢 快乐 开心 幸福 美好 美丽 希望 温柔 微笑 欢笑 感谢 自由 甜蜜 勇敢 温暖 喜悦'.split())
        self.zh_negative = set('恨 讨厌 悲伤 难过 痛苦 孤独 寂寞 绝望 眼泪 心碎 伤心 失去 害怕 遗憾 悲哀 哭泣 伤痛'.split())
        self.ko_positive = set('사랑 행복 기쁨 기뻐 아름다 웃음 희망 평화 좋아 즐거 따뜻 감사 설레'.split())
        self.ko_negative = set('슬픔 슬퍼 슬프 외로 눈물 아픔 아파 아프 미워 싫어 싫다 절망 이별 괴로 고통 두려'.split())
        self.negators = set(
            "not no never neither nor without hardly scarcely cannot can't don't "
            "doesn't didn't isn't aren't wasn't weren't won't wouldn't shouldn't "
            "couldn't haven't hasn't hadn't".split()
        ) | {'不', '没', '没有', '别', '无', '并非', '不是', '不再', '未', '안', '못'}
        self.stop_words = set(
            "the a an and or but i me my you your we our they their he she it its "
            "this that to of in on at for with is are was were be been am do does "
            "did have has had oh yeah la na i'm you're we're it's".split()
        ) | set('的 了 是 我 你 他 她 它 我们 你们 在 和 与 就 都 也 很 一个 这 那'.split())
        self._zh_terms = sorted(self.zh_positive | self.zh_negative | self.negators,
                                key=lambda word: (-len(word), word))

    def clean_lyrics(self, lyrics):
        """Remove section labels, retaining contractions and line boundaries."""
        text = unicodedata.normalize('NFKC', str(lyrics or ''))
        text = text.replace('’', "'").replace('‘', "'").replace('\r\n', '\n').replace('\r', '\n')
        text = re.sub(r'\[[^\]\n]*\]', '', text)
        text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
        return '\n'.join(re.sub(r'[^\S\n]+', ' ', line).strip()
                         for line in text.lower().splitlines()).strip()

    @staticmethod
    def detect_language(text):
        languages = []
        if re.search(r'[a-zA-Z]', text):
            languages.append('en')
        if re.search(r'[\u4e00-\u9fff]', text):
            languages.append('zh')
        if re.search(r'[\uac00-\ud7af]', text):
            languages.append('ko')
        # Kana means the Han characters may be Japanese, not Chinese.
        if re.search(r'[\u3040-\u30ff]', text):
            return 'unknown'
        if len(languages) > 1:
            return 'mixed'
        return languages[0] if languages else 'unknown'

    def _tokens(self, text):
        """Yield (token, start, end); Chinese uses greedy dictionary matching."""
        for match in self.TOKEN_RE.finditer(text):
            token = match.group()
            # Mixed lyrics may omit spaces between scripts (for example 我love你).
            for part in re.finditer(r'[\u4e00-\u9fff]+|[\uac00-\ud7af]+|[^\u4e00-\u9fff\uac00-\ud7af]+', token):
                value, start = part.group(), match.start() + part.start()
                if re.fullmatch(r'[\u4e00-\u9fff]+', value):
                    offset = 0
                    while offset < len(value):
                        term = next((word for word in self._zh_terms
                                     if value.startswith(word, offset)), value[offset])
                        yield term, start + offset, start + offset + len(term)
                        offset += len(term)
                else:
                    yield value, start, start + len(value)

    def _word_score(self, word):
        if word in self.positive_words or word in self.zh_positive:
            return 1
        if word in self.negative_words or word in self.zh_negative:
            return -1
        if re.fullmatch(r'[\uac00-\ud7af]+', word):
            if any(word.startswith(stem) for stem in self.ko_positive):
                return 1
            if any(word.startswith(stem) for stem in self.ko_negative):
                return -1
        return 0

    def _lexicon_counts(self, text):
        tokens = list(self._tokens(text))
        positive = negative = 0
        for index, (word, start, end) in enumerate(tokens):
            score = self._word_score(word)
            if not score:
                continue
            negations = 0
            for previous in range(index - 1, max(-1, index - 4), -1):
                prior_word, _, prior_end = tokens[previous]
                if self.BOUNDARY_RE.search(text[prior_end:start]) or prior_word in {'but', 'however', '하지만', '但是', '但'}:
                    break
                negations += prior_word in self.negators
            # A common Korean negation follows the adjective: 행복하지 않아.
            if re.fullmatch(r'[\uac00-\ud7af]+', word):
                for next_word, next_start, _ in tokens[index + 1:index + 3]:
                    if self.BOUNDARY_RE.search(text[end:next_start]):
                        break
                    if next_word.startswith('않'):
                        negations += 1
                        break
            if negations % 2:
                score *= -1
            positive += score > 0
            negative += score < 0
        return len(tokens), positive, negative

    @staticmethod
    def _label(score, threshold=0.05):
        return 'positive' if score > threshold else 'negative' if score < -threshold else 'neutral'

    def analyze_sentiment_textblob(self, text):
        supported = self.detect_language(text) in {'en', 'mixed'} and bool(re.search(r'[a-z]', text, re.I))
        result = {'sentiment': 'neutral', 'polarity': 0.0, 'subjectivity': 0.0,
                  'supported': supported, 'available': TextBlob is not None}
        if supported and TextBlob is not None:
            try:
                # TextBlob is English-only; its score does not cover other scripts.
                english = re.sub(r'[^a-zA-Z\s\x27.,!?;:\-]', ' ', text)
                sentiment = TextBlob(english).sentiment
                result.update(polarity=float(sentiment.polarity), subjectivity=float(sentiment.subjectivity))
                result['sentiment'] = self._label(result['polarity'], 0.1)
            except Exception:
                logger.warning('TextBlob unavailable for this analysis; using lexicon', exc_info=True)
                result['available'] = False
        return result

    def analyze_sentiment_lexicon(self, text):
        count, positive, negative = self._lexicon_counts(text)
        positive_ratio = positive / count if count else 0.0
        negative_ratio = negative / count if count else 0.0
        score = positive_ratio - negative_ratio
        return {'sentiment': self._label(score), 'score': score,
                'positive_ratio': positive_ratio, 'negative_ratio': negative_ratio,
                'pos_count': positive, 'neg_count': negative}

    def analyze_lexical_features(self, text):
        words = [word for word, _, _ in self._tokens(text)]
        word_count, unique_words = len(words), len(set(words))
        sentence_lengths = [len(list(self._tokens(sentence)))
                            for sentence in re.split(r'[.!?。！？\n]+', text)]
        sentence_lengths = [length for length in sentence_lengths if length]
        frequencies = Counter(word for word in words if word not in self.stop_words
                              and (len(word) > 1 or self._word_score(word)))
        return {
            'word_count': word_count, 'unique_words': unique_words,
            'lexical_diversity': unique_words / word_count if word_count else 0.0,
            'avg_sentence_length': sum(sentence_lengths) / len(sentence_lengths) if sentence_lengths else 0.0,
            'top_words': [{'text': word, 'value': count} for word, count in frequencies.most_common(10)],
        }

    def analyze_emotion_intensity(self, text):
        count, positive, negative = self._lexicon_counts(text)
        return {'positive_intensity': positive, 'negative_intensity': negative,
                'emotion_density': (positive + negative) / count if count else 0.0}

    @staticmethod
    def _consensus_score(textblob, lexicon):
        if not textblob.get('supported', True) or not textblob.get('available', True):
            return float(lexicon['score'])
        return (textblob['polarity'] + 1.5 * lexicon['score']) / 2.5

    def get_consensus_sentiment(self, textblob, lexicon):
        # Zero evidence and equal opposing evidence both produce neutral results.
        return self._label(self._consensus_score(textblob, lexicon))

    @staticmethod
    def _bounded(value, minimum=0.0, maximum=1.0):
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return 0.0
        return max(minimum, min(maximum, number)) if math.isfinite(number) else 0.0

    def create_emotion_vector(self, analysis):
        tb, lex = analysis['textblob'], analysis['lexicon']
        return {
            'polarity': self._bounded(tb['polarity'] if tb.get('supported', True) and tb.get('available', True)
                                      else lex['score'], -1.0, 1.0),
            'subjectivity': self._bounded(tb['subjectivity']),
            'lexicon_score': self._bounded(lex['score'], -1.0, 1.0),
            'lexical_diversity': self._bounded(analysis['lexical']['lexical_diversity']),
            'emotion_density': self._bounded(analysis['emotion_intensity']['emotion_density']),
            'sentence_complexity': self._bounded(analysis['lexical']['avg_sentence_length'] / 20),
        }

    def analyze_lyrics_comprehensive(self, lyrics):
        cleaned = self.clean_lyrics(lyrics)
        language = self.detect_language(cleaned)
        tb = self.analyze_sentiment_textblob(cleaned)
        lexicon = self.analyze_sentiment_lexicon(cleaned)
        limitations = ['情感结果为启发式估计，不能可靠识别讽刺、隐喻或完整语境。']
        if re.search(r'[\u4e00-\u9fff]', cleaned):
            limitations.append('中文使用基础词典和简单切分，未使用中文专用语言模型；词数仅供参考。')
        if re.search(r'[\uac00-\ud7af]', cleaned):
            limitations.append('韩文使用基础词干词典和简单否定规则，未使用韩语专用语言模型。')
        if language == 'mixed':
            limitations.append('混合语言按字形识别；TextBlob 仅分析英文部分，跨语言表达可能被误读。')
        if language == 'unknown':
            limitations.append('未识别到支持的语言；零分表示缺少情感证据，不代表文本客观中立。')
        if not tb['available']:
            limitations.append('TextBlob 当前不可用，本次仅使用基础情感词典。')
        lines = []
        for original in str(lyrics or '').splitlines():
            line = self.clean_lyrics(original)
            if not list(self._tokens(line)):
                continue
            line_tb = self.analyze_sentiment_textblob(line)
            line_lex = self.analyze_sentiment_lexicon(line)
            polarity = self._consensus_score(line_tb, line_lex)
            lines.append({'text': original.strip(), 'polarity': round(polarity, 6),
                          'sentiment': self._label(polarity)})
        return {
            'textblob': tb, 'lexicon': lexicon,
            'lexical': self.analyze_lexical_features(cleaned),
            'emotion_intensity': self.analyze_emotion_intensity(cleaned),
            'consensus_sentiment': self.get_consensus_sentiment(tb, lexicon),
            'overall_polarity': round(self._consensus_score(tb, lexicon), 6),
            'metadata': {'language': language,
                         'method': 'textblob+lexicon' if tb['supported'] and tb['available'] else 'lexicon',
                         'limitations': limitations, 'analyzer_version': self.VERSION,
                         'tokenization': 'Unicode words; Chinese dictionary matching with character fallback'},
            'line_analysis': lines,
        }

    def analyze_song_library(self, database=None):
        """Compatibility helper; IDs keep songs with equal titles distinct."""
        if database is None:
            try:
                from .database import DatabaseManager
            except ImportError:
                from database import DatabaseManager
            database = DatabaseManager()
        songs = database.get_all_songs_with_analysis(limit=5000)
        return {song['id']: song for song in songs
                if song.get('analysis') and song.get('emotion_vector')}

    def _normalized_vector(self, song):
        vector = song.get('emotion_vector')
        # Earlier exports sometimes stored the same six features as an array.
        if isinstance(vector, (list, tuple)) and len(vector) == len(self.VECTOR_WEIGHTS):
            vector = dict(zip(self.VECTOR_WEIGHTS, vector))
        if not isinstance(vector, dict) or not vector:
            return None
        normalized = {}
        for key in self.VECTOR_WEIGHTS:
            try:
                value = float(vector.get(key, 0))
            except (ValueError, TypeError, OverflowError):
                return None
            if not math.isfinite(value):
                return None
            if key in {'polarity', 'lexicon_score'}:
                normalized[key] = (self._bounded(value, -1, 1) + 1) / 2
            else:
                normalized[key] = self._bounded(value)
        return normalized

    def recommend_songs(self, target_id, songs, top_k=5):
        """Fixed feature ranges make existing scores independent of other songs."""
        if not isinstance(top_k, int) or top_k <= 0:
            return []
        songs = list(songs.values()) if isinstance(songs, dict) else list(songs)
        target = next((song for song in songs if str(song.get('id')) == str(target_id)), None)
        target_vector = self._normalized_vector(target) if target else None
        if target_vector is None:
            return []
        results, seen = [], {str(target_id)}
        weight_total = sum(self.VECTOR_WEIGHTS.values())
        for song in songs:
            song_id = song.get('id')
            if song_id is None or str(song_id) in seen:
                continue
            vector = self._normalized_vector(song)
            if vector is None:
                continue
            distance = math.sqrt(sum(weight * (target_vector[key] - vector[key]) ** 2
                                     for key, weight in self.VECTOR_WEIGHTS.items()) / weight_total)
            results.append({'id': song_id, 'title': song.get('title', ''),
                            'artist': song.get('artist', ''), 'genre': song.get('genre', 'Unknown'),
                            'similarity': round(max(0.0, min(1.0, 1.0 - distance)), 6)})
            seen.add(str(song_id))
        results.sort(key=lambda result: (-result['similarity'], str(result['id'])))
        return results[:top_k]

    def find_similar_songs(self, target_title, database, top_k=5):
        """Legacy tuple adapter; new callers should use recommend_songs with IDs."""
        songs = []
        target_id = None
        for key, value in database.items():
            song = dict(value, id=value.get('id', key), title=value.get('title', str(key)))
            songs.append(song)
            if str(key) == str(target_title) or song['title'] == target_title:
                target_id = song['id']
        if target_id is None:
            return []
        return [(item['title'], item['similarity'], item['genre'], item['artist'])
                for item in self.recommend_songs(target_id, songs, top_k)]


analyzer = LocalLyricAnalyzer()
