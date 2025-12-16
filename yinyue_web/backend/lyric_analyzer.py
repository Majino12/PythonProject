import numpy as np
import re
import logging
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.preprocessing import StandardScaler
from collections import Counter
from textblob import TextBlob
from database import db

logger = logging.getLogger(__name__)


class LocalLyricAnalyzer:
    """
    高级歌词分析器
    特性: TextBlob + 词典混合分析, 词汇特征提取, 多维相似度向量
    """

    def __init__(self):
        # 1. 初始化自定义情感词典
        self.positive_words = set([
            'love', 'happy', 'beautiful', 'amazing', 'wonderful', 'fantastic',
            'great', 'good', 'perfect', 'nice', 'sweet', 'better', 'best',
            'joy', 'smile', 'laugh', 'peace', 'hope', 'dream', 'free',
            'bright', 'light', 'sun', 'heaven', 'angel', 'paradise', 'trust',
            'passionate', 'glory', 'victory', 'alive', 'fun', 'enjoy'
        ])

        self.negative_words = set([
            'hate', 'sad', 'bad', 'wrong', 'hurt', 'pain', 'cry', 'tears',
            'broken', 'lost', 'alone', 'dark', 'death', 'kill', 'hell',
            'sorry', 'regret', 'miss', 'gone', 'fear', 'shadow',
            'end', 'fall', 'die', 'cold', 'night', 'void', 'withdrawals',
            'lonely', 'empty', 'sorrow', 'grief', 'fail'
        ])

        logger.info("Advanced Lyric Analyzer initialized")

    def clean_lyrics(self, lyrics):
        """清洗歌词"""
        if not lyrics: return ""
        # 移除括号内容 [Chorus] 等
        text = re.sub(r'\[.*?\]', '', lyrics)
        # 移除特殊字符，保留标点用于分句
        text = re.sub(r'[^\w\s\.\!\?,;]', '', text)
        # 合并空格
        text = re.sub(r'\s+', ' ', text)
        return text.lower().strip()

    def analyze_sentiment_textblob(self, text):
        """TextBlob 情感分析"""
        blob = TextBlob(text)
        polarity = blob.sentiment.polarity  # -1 (负) 到 1 (正)
        subjectivity = blob.sentiment.subjectivity  # 0 (客观) 到 1 (主观)

        if polarity > 0.1:
            sentiment = "positive"
        elif polarity < -0.1:
            sentiment = "negative"
        else:
            sentiment = "neutral"

        return {
            'sentiment': sentiment,
            'polarity': polarity,
            'subjectivity': subjectivity
        }

    def analyze_sentiment_lexicon(self, text):
        """词典匹配分析"""
        words = text.split()
        word_count = len(words)
        if word_count == 0:
            return {'sentiment': 'neutral', 'score': 0, 'positive_ratio': 0, 'negative_ratio': 0}

        pos_count = sum(1 for word in words if word in self.positive_words)
        neg_count = sum(1 for word in words if word in self.negative_words)

        pos_ratio = pos_count / word_count
        neg_ratio = neg_count / word_count
        score = pos_ratio - neg_ratio

        if score > 0.05:
            sentiment = "positive"
        elif score < -0.05:
            sentiment = "negative"
        else:
            sentiment = "neutral"

        return {
            'sentiment': sentiment,
            'score': score,
            'positive_ratio': pos_ratio,
            'negative_ratio': neg_ratio,
            'pos_count': pos_count,
            'neg_count': neg_count
        }

    def analyze_lexical_features(self, text):
        """语言学特征分析"""
        words = text.split()
        word_count = len(words)
        unique_words = len(set(words))
        # 词汇多样性 (TTR: Type-Token Ratio)
        lexical_diversity = unique_words / word_count if word_count > 0 else 0

        # 平均句长
        sentences = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]
        avg_sentence_length = np.mean([len(s.split()) for s in sentences]) if sentences else 0

        # 高频词 (用于词云或统计)
        word_freq = Counter(words).most_common(10)
        # 转换格式以适应 JSON
        top_words = [{"text": w, "value": c} for w, c in word_freq if len(w) > 2]

        return {
            'word_count': word_count,
            'unique_words': unique_words,
            'lexical_diversity': lexical_diversity,
            'avg_sentence_length': avg_sentence_length,
            'top_words': top_words
        }

    def analyze_emotion_intensity(self, text):
        """情感强度分析"""
        words = text.split()
        pos = sum(1 for w in words if w in self.positive_words)
        neg = sum(1 for w in words if w in self.negative_words)
        density = (pos + neg) / len(words) if words else 0
        return {
            'positive_intensity': pos,
            'negative_intensity': neg,
            'emotion_density': density
        }

    def get_consensus_sentiment(self, textblob, lexicon):
        """计算共识情感 (加权投票)"""
        scores = {'positive': 0, 'negative': 0, 'neutral': 0}

        # TextBlob 权重 1
        scores[textblob['sentiment']] += abs(textblob['polarity'])

        # Lexicon 权重 1.5 (词典匹配通常更准)
        scores[lexicon['sentiment']] += abs(lexicon['score']) * 1.5

        return max(scores, key=scores.get)

    def create_emotion_vector(self, analysis):
        """
        创建多维特征向量 (用于推荐系统)
        包含: 极性, 主观性, 词典分, 多样性, 情感密度, 句长
        """
        return {
            'polarity': analysis['textblob']['polarity'],
            'subjectivity': analysis['textblob']['subjectivity'],
            'lexicon_score': analysis['lexicon']['score'],
            'lexical_diversity': analysis['lexical']['lexical_diversity'],
            'emotion_density': analysis['emotion_intensity']['emotion_density'],
            # 句长归一化 (假设平均句长20为最大值)
            'sentence_complexity': min(analysis['lexical']['avg_sentence_length'] / 20, 1.0)
        }

    def analyze_lyrics_comprehensive(self, lyrics):
        """综合分析入口"""
        cleaned = self.clean_lyrics(lyrics)

        tb_res = self.analyze_sentiment_textblob(cleaned)
        lex_res = self.analyze_sentiment_lexicon(cleaned)
        lex_feat = self.analyze_lexical_features(cleaned)
        intensity = self.analyze_emotion_intensity(cleaned)

        consensus = self.get_consensus_sentiment(tb_res, lex_res)

        return {
            'textblob': tb_res,
            'lexicon': lex_res,
            'lexical': lex_feat,
            'emotion_intensity': intensity,
            'consensus_sentiment': consensus
        }

    def analyze_song_library(self):
        """从数据库加载所有已分析的歌曲"""
        try:
            songs = db.get_all_songs_with_analysis(limit=5000)
            library = {}
            for s in songs:
                if 'analysis' in s and 'emotion_vector' in s:
                    library[s['title']] = {
                        'artist': s['artist'],
                        'genre': s['genre'],
                        'analysis': s['analysis'],
                        'emotion_vector': s['emotion_vector']
                    }
            return library
        except Exception as e:
            logger.error(f"Library load error: {e}")
            return {}

    def find_similar_songs(self, target_title, database, top_k=5):
        """查找相似歌曲 (基于 Cosine Similarity)"""
        if target_title not in database: return []

        titles = list(database.keys())
        vectors = []

        # 提取并对齐向量
        for t in titles:
            v = database[t]['emotion_vector']
            vectors.append([
                v.get('polarity', 0),
                v.get('subjectivity', 0),
                v.get('lexicon_score', 0),
                v.get('lexical_diversity', 0),
                v.get('emotion_density', 0),
                v.get('sentence_complexity', 0)
            ])

        if not vectors: return []

        try:
            # 标准化数据 (对于混合特征很重要)
            scaler = StandardScaler()
            norm_vectors = scaler.fit_transform(vectors)

            target_idx = titles.index(target_title)
            target_vec = norm_vectors[target_idx].reshape(1, -1)

            # 计算余弦相似度
            sims = cosine_similarity(target_vec, norm_vectors)[0]

            results = []
            for i, score in enumerate(sims):
                if i != target_idx:
                    t = titles[i]
                    results.append((
                        t,
                        float(score),
                        database[t]['genre'],
                        database[t]['artist']
                    ))

            results.sort(key=lambda x: x[1], reverse=True)
            return results[:top_k]

        except Exception as e:
            logger.error(f"Recommendation error: {e}")
            return []


analyzer = LocalLyricAnalyzer()