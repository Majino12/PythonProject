// 多语言支持
class LanguageManager {
    constructor() {
        this.currentLang = localStorage.getItem('preferred-language') || 'zh';
        this.translations = {};
        this.init();
    }

    async init() {
        await this.loadTranslations();
        this.applyLanguage(this.currentLang);
        this.setupEventListeners();
    }

    async loadTranslations() {
        try {
            const response = await fetch(`/static/locales/${this.currentLang}.json`);
            this.translations = await response.json();
        } catch (error) {
            console.error('Failed to load translations:', error);
            // 加载默认中文翻译
            this.translations = await this.getDefaultTranslations();
        }
    }

    async getDefaultTranslations() {
        // 默认中文翻译
        return {
            "nav.home": "首页",
            "nav.about": "关于",
            "title.main": "小说分析系统",
            "title.subtitle": "使用AI技术深度分析小说内容，提取人物关系、情节结构、主题等关键信息",
            "analysis.choose_method": "选择分析方式",
            "analysis.text": "文本分析",
            "analysis.file": "文件上传",
            "analysis.news": "新闻爬取",
            "analysis.novel": "小说爬取",
            "analysis.analyzing": "正在分析内容，这可能需要几分钟时间...",
            "form.title": "标题",
            "form.content": "小说内容",
            "form.analyze": "开始分析",
            "form.example": "查看示例",
            "form.select_file": "选择文件",
            "form.file_support": "支持.txt, .doc, .docx格式文件，最大16MB",
            "form.upload_analyze": "上传并分析",
            "form.news_url": "新闻网站URL",
            "form.news_tip": "请输入新闻网站的URL，系统将自动爬取并分析文章内容",
            "form.novel_url": "小说网站URL",
            "form.novel_tip": "请输入小说阅读网站的URL",
            "form.crawl_analyze": "爬取并分析",
            "about.intro": "系统简介",
            "about.description": "小说分析系统是一个基于人工智能技术的文本分析工具，专门用于深度分析小说内容。系统能够自动提取小说的关键信息，包括人物关系、情节结构、主题分析等。",
            "about.features": "主要功能",
            "about.character_analysis": "人物分析",
            "about.character_desc": "自动识别主要人物，分析人物关系和出现频率",
            "about.plot_analysis": "情节分析",
            "about.plot_desc": "分析情节发展，识别高潮和转折点",
            "about.theme_extraction": "主题提取",
            "about.theme_desc": "自动提取小说的主要主题和关键词",
            "about.text_stats": "文本统计",
            "about.stats_desc": "提供详细的文本统计和可读性分析",
            "about.tech_stack": "技术架构",
            "about.tech_desc": "系统基于以下技术构建：",
            "about.backend": "后端框架",
            "about.nlp": "自然语言处理",
            "about.ml": "机器学习",
            "about.summarization": "文本摘要",
            "about.crawler": "网络爬虫",
            "about.frontend": "前端技术",
            "about.usage": "使用方法",
            "about.step1": "选择分析方式：文本输入、文件上传或网页爬取",
            "about.step2": "提交内容进行分析",
            "about.step3": "查看详细的分析报告",
            "about.step4": "下载或分享分析结果",
            "about.tips": "使用提示",
            "about.tip1": "系统目前主要支持英文文本分析",
            "about.tip2": "对于长篇小说，分析可能需要几分钟时间",
            "about.tip3": "网页爬取功能依赖于目标网站的结构",
            "about.tip4": "确保上传的文件编码为UTF-8",
            "results.novel_info": "基本信息",
            "results.title": "标题",
            "results.total_chapters": "总章节数",
            "results.total_length": "总长度",
            "results.avg_chapter_length": "平均章节长度",
            "results.overall_summary": "整体摘要",
            "results.main_themes": "主要主题",
            "results.character_analysis": "人物分析",
            "results.main_characters": "主要人物",
            "results.character": "人物",
            "results.mentions": "提及次数",
            "results.first_appearance": "首次出现",
            "results.character_relationships": "人物关系",
            "results.character1": "人物1",
            "results.character2": "人物2",
            "results.co_occurrence": "共同出现次数",
            "results.relationship_strength": "关系强度",
            "results.plot_structure": "情节结构",
            "results.exposition": "开端",
            "results.rising_action": "发展",
            "results.climax": "高潮",
            "results.resolution": "结尾",
            "results.text_statistics": "文本统计",
            "results.total_words": "总词数",
            "results.total_sentences": "总句数",
            "results.avg_sentence_length": "平均句长",
            "results.unique_words": "独特词汇",
            "results.lexical_diversity": "词汇多样性",
            "results.readability_scores": "可读性分数",
            "results.flesch_reading_ease": "Flesch阅读难度",
            "results.flesch_kincaid_grade": "Flesch-Kincaid等级",
            "results.smog_index": "SMOG指数",
            "results.source": "来源"
        };
    }

    setupEventListeners() {
        // 语言切换事件
        document.querySelectorAll('.language-option').forEach(option => {
            option.addEventListener('click', (e) => {
                e.preventDefault();
                const lang = e.target.getAttribute('data-lang');
                this.switchLanguage(lang);
            });
        });
    }

    async switchLanguage(lang) {
        this.currentLang = lang;
        localStorage.setItem('preferred-language', lang);
        await this.loadTranslations();
        this.applyLanguage(lang);

        // 更新页面标题
        document.title = this.translate('title.main');
    }

    applyLanguage(lang) {
        // 更新所有带有data-i18n属性的元素
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const translation = this.translate(key);
            if (translation) {
                if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                    if (element.hasAttribute('placeholder')) {
                        element.setAttribute('placeholder', translation);
                    } else if (element.type !== 'hidden') {
                        element.value = translation;
                    }
                } else {
                    element.textContent = translation;
                }
            }
        });

        // 更新页面语言属性
        document.documentElement.lang = lang;
    }

    translate(key) {
        return this.translations[key] || key;
    }

    // 动态翻译函数，供其他脚本使用
    t(key) {
        return this.translate(key);
    }
}

// 初始化语言管理器
const languageManager = new LanguageManager();

// 全局翻译函数
function t(key) {
    return languageManager.t(key);
}