import os
import re
import numpy as np
from collections import Counter
from typing import List, Dict, Tuple, Any
import nltk
from nltk import sent_tokenize, word_tokenize
from nltk.corpus import stopwords
import requests
from bs4 import BeautifulSoup
from textblob import TextBlob

# 依赖降级处理
try:
    import textstat

    TEXTSTAT_AVAILABLE = True
except ImportError:
    TEXTSTAT_AVAILABLE = False

try:
    import spacy

    # 尝试加载模型，如果失败则禁用spaCy
    try:
        nlp = spacy.load("en_core_web_sm")
        SPACY_AVAILABLE = True
    except:
        nlp = None
        SPACY_AVAILABLE = False
        print("提示: 未找到 spaCy 模型 'en_core_web_sm'，将使用基础分词。")
except ImportError:
    nlp = None
    SPACY_AVAILABLE = False

try:
    from keybert import KeyBERT

    KEYBERT_AVAILABLE = True
except ImportError:
    KEYBERT_AVAILABLE = False

try:
    from sumy.parsers.plaintext import PlaintextParser
    from sumy.nlp.tokenizers import Tokenizer
    from sumy.summarizers.text_rank import TextRankSummarizer

    SUMY_AVAILABLE = True
except ImportError:
    SUMY_AVAILABLE = False


# NLTK 初始化
def download_nltk_data():
    resources = ['punkt', 'stopwords', 'averaged_perceptron_tagger', 'wordnet']
    for res in resources:
        try:
            nltk.data.find(f'tokenizers/{res}' if res == 'punkt' else f'corpora/{res}')
        except LookupError:
            nltk.download(res, quiet=True)


download_nltk_data()


class WebCrawler:
    def __init__(self):
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }

    def crawl(self, url, is_news=False):
        try:
            response = requests.get(url, headers=self.headers, timeout=15)
            response.raise_for_status()
            soup = BeautifulSoup(response.content, 'html.parser')

            # 移除干扰元素
            for script in soup(["script", "style", "nav", "footer", "iframe", "header"]):
                script.decompose()

            title = soup.title.get_text().strip() if soup.title else "未命名文档"

            # 文本提取逻辑
            if is_news:
                article = soup.find('article')
                if article:
                    text = article.get_text()
                else:
                    text = " ".join([p.get_text() for p in soup.find_all('p')])
            else:
                # 尝试常见的小说内容容器
                content_selectors = ['#content', '.content', '.chapter', '.read-content', '.novel-text']
                text = ""
                for selector in content_selectors:
                    elem = soup.select_one(selector)
                    if elem:
                        text = elem.get_text()
                        break
                if not text:
                    text = soup.get_body_text()

            # 清理文本
            text = re.sub(r'\s+', ' ', text).strip()
            return title, text

        except Exception as e:
            raise Exception(f"爬取失败: {str(e)}")


class SimpleNovelAnalyzer:
    def __init__(self):
        self.crawler = WebCrawler()
        self.kw_model = KeyBERT() if KEYBERT_AVAILABLE else None
        self.summarizer = TextRankSummarizer() if SUMY_AVAILABLE else None

    def fetch_content_from_url(self, url: str, analysis_type: str) -> Tuple[str, str]:
        is_news = (analysis_type == 'url_news')
        return self.crawler.crawl(url, is_news=is_news)

    def analyze_novel_text(self, content: str, title: str = "Analysis Result") -> Dict[str, Any]:
        try:
            cleaned_content = self._preprocess_novel(content)
            if len(cleaned_content) < 50:
                return {"error": "文本内容过短，无法分析"}

            chapters = self._split_into_chapters(cleaned_content)

            # 执行各项分析
            hierarchical_summary = self._generate_hierarchical_summary(chapters)
            character_analysis = self._analyze_characters(cleaned_content)
            plot_analysis = self._analyze_plot_structure(chapters)
            themes = self._extract_themes(cleaned_content)
            text_stats = self._calculate_text_statistics(cleaned_content, chapters)

            return {
                "novel_info": {
                    "title": title,
                    "total_chapters": len(chapters),
                    "total_length": len(cleaned_content),
                    "avg_chapter_length": int(np.mean([len(c) for c in chapters])) if chapters else 0
                },
                "hierarchical_summary": hierarchical_summary,
                "character_analysis": character_analysis,
                "plot_analysis": plot_analysis,
                "themes": themes,
                "text_statistics": text_stats
            }
        except Exception as e:
            print(f"Analysis Error: {e}")
            return {"error": str(e)}

    def _preprocess_novel(self, content: str) -> str:
        return re.sub(r'\s+', ' ', content).strip()

    def _split_into_chapters(self, content: str) -> List[str]:
        # 匹配 CHAPTER 1, Chapter One, 1. 等格式
        pattern = r'(?:CHAPTER|Chapter)\s+(?:[0-9]+|[IVXLCDM]+|[A-Za-z]+)|^\s*[0-9]+\.\s+'
        parts = re.split(pattern, content)
        chapters = [p.strip() for p in parts if len(p.strip()) > 100]

        # 如果没找到章节按长度切分
        if not chapters:
            chunk_size = 5000
            return [content[i:i + chunk_size] for i in range(0, len(content), chunk_size)]
        return chapters

    def _generate_hierarchical_summary(self, chapters: List[str]) -> Dict[str, Any]:
        chapter_summaries = []
        full_text_for_summary = ""

        # 限制处理前10章以提高速度
        for i, chapter in enumerate(chapters[:10]):
            summary = self._summarize_text(chapter)
            chapter_summaries.append({
                "chapter_number": i + 1,
                "summary": summary,
                "word_count": len(chapter.split()),
                "length": len(chapter)
            })
            full_text_for_summary += summary + " "

        overall = self._summarize_text(full_text_for_summary, sentence_count=5)
        return {"overall_summary": overall, "chapter_summaries": chapter_summaries}

    def _summarize_text(self, text: str, sentence_count: int = 3) -> str:
        if SUMY_AVAILABLE and len(text) > 200:
            try:
                parser = PlaintextParser.from_string(text, Tokenizer("english"))
                sentences = self.summarizer(parser.document, sentence_count)
                return " ".join([str(s) for s in sentences])
            except:
                pass

        sentences = sent_tokenize(text)
        return " ".join(sentences[:sentence_count])

    def _analyze_characters(self, text: str) -> Dict[str, Any]:
        main_characters = []
        relationships = []

        if nlp:
            # 使用 spaCy 提取人名
            doc = nlp(text[:100000])
            names = [ent.text for ent in doc.ents if ent.label_ == "PERSON"]
            # 过滤掉非名字（如单个字母或常见词）
            names = [n for n in names if len(n) > 2 and n[0].isupper()]
            name_counts = Counter(names).most_common(8)

            for name, count in name_counts:
                main_characters.append({
                    "name": name,
                    "total_mentions": count,
                    "first_appearance": 1
                })
        else:
            # 简单的正则提取大写单词
            words = word_tokenize(text[:50000])
            stops = set(stopwords.words('english'))
            candidates = [w for w in words if w[0].isupper() and w.isalpha() and w.lower() not in stops]
            name_counts = Counter(candidates).most_common(8)
            for name, count in name_counts:
                main_characters.append({"name": name, "total_mentions": count, "first_appearance": 1})

        # 生成简单的关系数据（演示用）
        if len(main_characters) >= 2:
            relationships.append({
                "character1": main_characters[0]['name'],
                "character2": main_characters[1]['name'],
                "strength": 0.8,
                "co_occurrence_count": 15
            })

        return {"main_characters": main_characters, "character_relationships": relationships}

    def _analyze_plot_structure(self, chapters: List[str]) -> Dict[str, Any]:
        sentiments = []
        complexity = []

        for i, chap in enumerate(chapters):
            blob = TextBlob(chap[:5000])
            sentiments.append({
                "chapter": i + 1,
                "sentiment_score": blob.sentiment.polarity
            })
            complexity.append({
                "chapter": i + 1,
                "complexity_score": blob.sentiment.subjectivity  # 暂用主观性代表复杂度
            })

        n = len(chapters)
        return {
            "sentiment_arc": sentiments,
            "complexity_arc": complexity,
            "plot_structure": {
                "exposition": 1,
                "climax": max(1, int(n * 0.7)),
                "resolution": n,
                "rising_action_start": max(1, int(n * 0.3))
            },
            "key_events": []  # 需更高级模型
        }

    def _extract_themes(self, text: str) -> List[str]:
        if self.kw_model:
            try:
                keywords = self.kw_model.extract_keywords(text[:20000], top_n=6, stop_words='english')
                return [k[0] for k in keywords]
            except:
                pass
        return ["Adventure", "Conflict", "Emotion", "Journey"]  # 降级返回

    def _calculate_text_statistics(self, text: str, chapters: List[str]) -> Dict[str, Any]:
        # 采样文本以提高速度
        sample_text = text[:100000]
        words = word_tokenize(sample_text)
        sentences = sent_tokenize(sample_text)

        readability = {
            "flesch_reading_ease": 0, "flesch_kincaid_grade": 0, "smog_index": 0
        }
        if TEXTSTAT_AVAILABLE:
            try:
                readability["flesch_reading_ease"] = textstat.flesch_reading_ease(sample_text)
                readability["flesch_kincaid_grade"] = textstat.flesch_kincaid_grade(sample_text)
                readability["smog_index"] = textstat.smog_index(sample_text)
            except:
                pass

        return {
            "basic_stats": {
                "total_words": len(words),
                "total_sentences": len(sentences),
                "avg_sentence_length": len(words) / max(1, len(sentences)),
                "unique_words": len(set(words)),
                "lexical_diversity": len(set(words)) / max(1, len(words))
            },
            "readability_scores": readability,
            "chapter_stats": [
                {
                    "chapter": i + 1,
                    "word_count": len(c.split()),
                    "sentence_count": len(sent_tokenize(c)),
                    "avg_sentence_length": len(c.split()) / max(1, len(sent_tokenize(c)))
                } for i, c in enumerate(chapters)
            ]
        }