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

# 初始化 spaCy (用于更好的人名识别)
nlp = None
SPACY_AVAILABLE = False
try:
    import spacy

    try:
        # 尝试加载英文小模型
        nlp = spacy.load("en_core_web_sm")
        SPACY_AVAILABLE = True
    except OSError:
        print("提示: 未找到 spaCy 模型 'en_core_web_sm'。将使用基础正则进行人物分析。")
        print("建议运行: python -m spacy download en_core_web_sm")
except ImportError:
    print("提示: 未安装 spaCy 库。将使用基础正则进行人物分析。")

# 其他可选库
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
    resources = ['punkt', 'stopwords', 'averaged_perceptron_tagger', 'wordnet', 'omw-1.4']
    for res in resources:
        try:
            nltk.data.find(f'tokenizers/{res}' if res == 'punkt' else f'corpora/{res}')
        except LookupError:
            print(f"正在下载 NLTK 资源: {res}...")
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
            for script in soup(["script", "style", "nav", "footer", "iframe", "header", "aside", "form"]):
                script.decompose()

            title = soup.title.get_text().strip() if soup.title else "未命名文档"

            # 文本提取逻辑
            if is_news:
                article = soup.find('article')
                if article:
                    text = article.get_text()
                else:
                    # 寻找最长的文本块
                    paragraphs = [p.get_text() for p in soup.find_all('p')]
                    text = "\n".join(paragraphs)
            else:
                # 尝试常见的小说内容容器
                content_selectors = ['#content', '.content', '.chapter-content', '.read-content', '.novel-text',
                                     'div[itemprop="articleBody"]']
                text = ""
                for selector in content_selectors:
                    elem = soup.select_one(selector)
                    if elem:
                        text = elem.get_text()
                        break
                if not text or len(text) < 500:
                    # 如果没找到或内容太少，尝试获取所有主体文本
                    text = soup.get_body_text()

            # 清理文本
            text = re.sub(r'\n+', '\n', text)  # 保留段落结构用于分析
            text = re.sub(r'\s+', ' ', text).strip()  # 最终清理

            if len(text) < 100:
                raise Exception("未能提取到有效内容，该网站可能无法爬取。")

            return title, text

        except requests.exceptions.RequestException as e:
            raise Exception(f"网络请求失败: {str(e)}")
        except Exception as e:
            raise Exception(f"爬取失败: {str(e)}")


class SimpleNovelAnalyzer:
    def __init__(self):
        self.crawler = WebCrawler()
        self.kw_model = KeyBERT() if KEYBERT_AVAILABLE else None
        self.summarizer = TextRankSummarizer() if SUMY_AVAILABLE else None
        self.stop_words = set(stopwords.words('english'))
        # 添加一些小说中常见的非人物噪音词
        self.stop_words.update(
            ['said', 'asked', 'replied', 'thought', 'looked', 'mr', 'mrs', 'miss', 'lord', 'lady', 'chapter', 'one',
             'two'])

    def fetch_content_from_url(self, url: str, analysis_type: str) -> Tuple[str, str]:
        is_news = (analysis_type == 'url_news')
        return self.crawler.crawl(url, is_news=is_news)

    def analyze_novel_text(self, content: str, title: str = "Analysis Result") -> Dict[str, Any]:
        try:
            if not content or len(content) < 100:
                return {"error": "文本内容过短，无法进行有效分析（至少需要100个字符）。"}

            # 预处理与章节分割
            cleaned_content = self._preprocess_novel(content)
            chapters = self._split_into_chapters(cleaned_content)

            if not chapters:
                return {"error": "无法识别章节结构，请确保文本有清晰的章节标记。"}

            # 执行各项分析
            # 限制用于耗时分析的文本长度
            analysis_text_limit = 300000
            text_for_analysis = cleaned_content[:analysis_text_limit]

            hierarchical_summary = self._generate_hierarchical_summary(chapters)
            # 这里传入了完整的 chapters 列表用于发展分析
            character_analysis = self._analyze_characters(text_for_analysis, chapters)
            plot_analysis = self._analyze_plot_structure(chapters)
            themes = self._extract_themes(text_for_analysis)
            text_stats = self._calculate_text_statistics(text_for_analysis, chapters)

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
            import traceback
            traceback.print_exc()
            return {"error": f"分析过程中发生错误: {str(e)}"}

    def _preprocess_novel(self, content: str) -> str:
        # 标准化空白字符，但保留句子结构
        return re.sub(r'\s+', ' ', content).strip()

    def _split_into_chapters(self, content: str) -> List[str]:
        # 更健壮的章节分割正则
        # 匹配:
        # 行首的 "Chapter X" 或 "CHAPTER X" (X可以是数字或罗马数字或英文单词)
        # 行首的纯数字加点 "1. "
        pattern = r'(?:^|\n)\s*(?:CHAPTER|Chapter)\s+(?:[0-9]+|[IVXLCDM]+|[A-Za-z]+).*?(?=\n)|(?:^|\n)\s*[0-9]+\.\s+.*?(?=\n)'

        parts = re.split(pattern, content)
        # 过滤掉过短的片段（可能是目录或标题）
        chapters = [p.strip() for p in parts if len(p.strip()) > 200]

        # 降级策略：如果没找到章节，按固定长度切分
        if not chapters or len(chapters) < 2:
            chunk_size = 10000
            chapters = [content[i:i + chunk_size] for i in range(0, len(content), chunk_size)]

        return chapters

    def _generate_hierarchical_summary(self, chapters: List[str]) -> Dict[str, Any]:
        chapter_summaries = []
        full_text_for_summary = ""

        # 限制处理前15章以提高速度，且每章只取开头部分进行摘要
        process_chapters = chapters[:15]
        for i, chapter in enumerate(process_chapters):
            # 每章只取前3000字进行摘要计算
            summary_input = chapter[:3000]
            summary = self._summarize_text(summary_input, sentence_count=2)

            word_count = len(chapter.split())
            chapter_summaries.append({
                "chapter_number": i + 1,
                "summary": summary,
                "word_count": word_count,
                "length": len(chapter),
                # 提取关键句（简单地取最长的句子作为备选）
                "key_sentences": sorted(sent_tokenize(summary_input), key=len, reverse=True)[:2]
            })
            full_text_for_summary += summary + " "

        # 生成整体摘要
        overall = self._summarize_text(full_text_for_summary, sentence_count=4)
        return {"overall_summary": overall, "chapter_summaries": chapter_summaries}

    def _summarize_text(self, text: str, sentence_count: int = 3) -> str:
        if not text or len(text) < 100: return text

        if SUMY_AVAILABLE:
            try:
                parser = PlaintextParser.from_string(text, Tokenizer("english"))
                # 如果文本太短，TextRank可能会失败，降级到LSA
                if len(parser.document.sentences) < sentence_count * 2:
                    from sumy.summarizers.lsa import LsaSummarizer
                    summarizer = LsaSummarizer()
                else:
                    summarizer = self.summarizer

                sentences = summarizer(parser.document, sentence_count)
                return " ".join([str(s) for s in sentences])
            except Exception:
                pass

        # 降级方法：取开头和结尾的句子
        sentences = sent_tokenize(text)
        if len(sentences) <= sentence_count:
            return text
        return " ".join(sentences[:sentence_count])

    def _analyze_characters(self, full_text: str, chapters: List[str]) -> Dict[str, Any]:
        main_characters = []
        relationships = []
        character_development = {}

        names = []
        if SPACY_AVAILABLE and nlp:
            # 使用 spaCy 进行更准确的 NER
            # 处理前 150k 字符以平衡速度和准确性
            doc = nlp(full_text[:150000])
            for ent in doc.ents:
                if ent.label_ == "PERSON":
                    name = ent.text.strip()
                    # 过滤规则：长度大于2，首字母大写，不是停用词，不包含数字
                    if len(name) > 2 and name[0].isupper() and name.lower() not in self.stop_words and not any(
                            char.isdigit() for char in name):
                        names.append(name)
        else:
            # 降级：使用正则和NLTK提取连续的大写单词
            tokens = word_tokenize(full_text[:100000])
            tagged = nltk.pos_tag(tokens)

            current_name = []
            for word, tag in tagged:
                if tag == 'NNP' and len(word) > 2 and word.lower() not in self.stop_words:
                    current_name.append(word)
                else:
                    if current_name:
                        names.append(" ".join(current_name))
                    current_name = []
            # 处理最后一个可能的名字
            if current_name: names.append(" ".join(current_name))

        # 统计Top N人物
        name_counts = Counter(names).most_common(10)
        top_names = [name for name, count in name_counts]

        # 初始化数据结构
        for name in top_names:
            character_development[name] = []

        # 遍历每一章进行统计
        for i, chapter_content in enumerate(chapters):
            # 只在每章前5000字内搜索
            chapter_sample = chapter_content[:5000].lower()
            for name in top_names:
                # 简单统计名字（转小写）在章节样本中出现的次数
                count = chapter_sample.count(name.lower())
                character_development[name].append(count)

        # 构建主要人物详细信息
        for name, count in name_counts:
            # 查找首次出现的章节
            first_appearance = 1
            for i, chap in enumerate(chapters):
                if name.lower() in chap[:5000].lower():
                    first_appearance = i + 1
                    break

            main_characters.append({
                "name": name,
                "total_mentions": count,
                "first_appearance": first_appearance
            })

        # 生成简单的人物关系
        if len(top_names) >= 2:
            # 简单假设前两个人物有关系
            c1 = top_names[0]
            c2 = top_names[1]
            # 计算简单的共现强度
            strength = 0
            co_occurrence = 0
            window_size = 500
            text_lower = full_text[:100000].lower()
            for i in range(0, len(text_lower) - window_size, window_size):
                window = text_lower[i:i + window_size]
                if c1.lower() in window and c2.lower() in window:
                    co_occurrence += 1

            if co_occurrence > 0:
                strength = min(0.95, co_occurrence / 20)

                relationships.append({
                    "character1": c1,
                    "character2": c2,
                    "strength": strength,
                    "co_occurrence_count": co_occurrence
                })

        return {
            "main_characters": main_characters,
            "character_relationships": relationships,
            "character_development": character_development
        }

    def _analyze_plot_structure(self, chapters: List[str]) -> Dict[str, Any]:
        sentiments = []
        complexity = []

        # 限制处理章节数
        num_chapters = len(chapters)
        # 最多取约30个点绘制曲线
        step = max(1, num_chapters // 30)

        sampled_chapters = []
        for i in range(0, num_chapters, step):
            sampled_chapters.append((i + 1, chapters[i]))

        for chapter_num, chap_content in sampled_chapters:
            # 取每章中间部分进行情感分析，更能代表主要情节
            mid = len(chap_content) // 2
            sample = chap_content[max(0, mid - 1500):min(len(chap_content), mid + 1500)]

            blob = TextBlob(sample)
            sentiments.append({
                "chapter": chapter_num,
                "sentiment_score": round(blob.sentiment.polarity, 3)
            })
            # 使用主观性作为复杂度的简单代理
            complexity.append({
                "chapter": chapter_num,
                "complexity_score": round(blob.sentiment.subjectivity, 3)
            })

        n = num_chapters
        return {
            "sentiment_arc": sentiments,
            "complexity_arc": complexity,
            # 基于章节位置的简单结构估算
            "plot_structure": {
                "exposition": 1,
                "rising_action_start": max(2, int(n * 0.2)),
                "climax": max(3, int(n * 0.65)),
                "resolution": n
            },
            "key_events": []
        }

    def _extract_themes(self, text: str) -> List[str]:
        # 使用 KeyBERT 提取主题词
        if self.kw_model:
            try:
                # 增加多样性参数
                keywords = self.kw_model.extract_keywords(
                    text[:100000],
                    keyphrase_ngram_range=(1, 2),
                    stop_words='english',
                    use_maxsum=True, nr_candidates=20, top_n=8  # 使用 MaxSum 算法提高多样性
                )
                # 过滤掉包含人名或其他噪音的关键词（简单过滤）
                filtered_keywords = []
                for k, score in keywords:
                    word = k.lower()
                    if word not in self.stop_words and len(word) > 3 and not word[0].isdigit():
                        # 将首字母大写用于展示
                        filtered_keywords.append(word.title())

                return list(set(filtered_keywords))[:6]  # 去重并取前6个
            except Exception as e:
                print(f"KeyBERT error: {e}")
                pass

        # 降级：使用 NLTK 提取高频名词短语
        try:
            tokens = word_tokenize(text[:50000].lower())
            filtered_tokens = [w for w in tokens if w.isalpha() and w not in self.stop_words and len(w) > 3]
            fdist = Counter(filtered_tokens)
            common = [w.title() for w, c in fdist.most_common(15)]
            # 简单过滤掉可能的人名（基于之前识别的）- 这里暂不实现复杂过滤
            return common[:6]
        except:
            return ["Adventure", "Conflict", "Mystery", "Journey"]  # 最后的静态后备

    def _calculate_text_statistics(self, text: str, chapters: List[str]) -> Dict[str, Any]:
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

        # 计算章节统计，限制前20章以提高速度
        chapter_stats = []
        for i, c in enumerate(chapters[:20]):
            c_words = word_tokenize(c[:5000])
            c_sents = sent_tokenize(c[:5000])
            chapter_stats.append({
                "chapter": i + 1,
                "word_count": len(c.split()),
                "sentence_count": len(c_sents),
                "avg_sentence_length": len(c_words) / max(1, len(c_sents))
            })

        return {
            "basic_stats": {
                "total_words": len(word_tokenize(text)),
                "total_sentences": len(sent_tokenize(text)),
                "avg_sentence_length": len(words) / max(1, len(sentences)),
                "unique_words": len(set(words)),
                "lexical_diversity": len(set(words)) / max(1, len(words))
            },
            "readability_scores": readability,
            "chapter_stats": chapter_stats
        }