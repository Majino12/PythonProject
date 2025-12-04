// 国际化
class I18n {
    constructor() {
        this.currentLang = 'en'; // 默认防抖
        this.translations = {};
        this.isReady = false;

        // 语言名称
        this.langNames = {
            'cn': '中文',
            'en': 'English',
            'kr': '한국어'
        };

        this.init();
    }

    async init() {
        // 语言
        const savedLang = localStorage.getItem('preferredLanguage');
        if (savedLang && this.langNames[savedLang]) {
            this.currentLang = savedLang;
        } else {
            // 浏览器语言检测
            const browserLang = navigator.language.toLowerCase();
            if (browserLang.startsWith('zh')) this.currentLang = 'cn';
            else if (browserLang.startsWith('ko')) this.currentLang = 'kr';
            else this.currentLang = 'en';
        }

        // 加载翻译并更新页面
        await this.loadTranslations(this.currentLang);
        this.updatePage();
        this.setupEventListeners();

        // 标记
        this.isReady = true;
        document.dispatchEvent(new CustomEvent('i18nReady'));
    }

    async loadTranslations(lang) {
        try {
            const response = await fetch(`/static/locales/${lang}.json`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            this.translations = await response.json();
            localStorage.setItem('preferredLanguage', lang);
            this.currentLang = lang;
        } catch (error) {
            console.error('Failed to load translations:', error);
            if (lang !== 'en') await this.loadTranslations('en');
        }
    }

    t(key) {
        if (!this.translations) return key;
        const keys = key.split('.');
        let value = this.translations;

        for (const k of keys) {
            if (value && value[k] !== undefined) {
                value = value[k];
            } else {
                return key;
            }
        }
        return value;
    }

    translate(key, params = {}) {
        let translation = this.t(key);
        if (typeof translation !== 'string') return translation;

        Object.keys(params).forEach(param => {
            const regex = new RegExp(`{${param}}`, 'g');
            translation = translation.replace(regex, params[param]);
        });
        return translation;
    }

    updatePage() {
        // data-i18n 元素
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const translation = this.t(key);
            if (translation !== key) {
                if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                    element.placeholder = translation;
                } else {
                    element.textContent = translation;
                }
            }
        });

        // 占位符
        document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
            const key = element.getAttribute('data-i18n-placeholder');
            element.placeholder = this.t(key);
        });

        // 顶部导航栏当前语言显示
        const currentLangElement = document.getElementById('current-language');
        if (currentLangElement) {
            // 从字典中获取对应的显示名称
            currentLangElement.textContent = this.langNames[this.currentLang] || 'Language';
        }

        // HTML lang
        document.documentElement.lang = this.currentLang;

        // 更新动态内容
        document.dispatchEvent(new CustomEvent('i18nPageUpdated'));
    }

    setupEventListeners() {
        // 绑定语言切换点击事件
        document.querySelectorAll('.language-option').forEach(option => {
            option.addEventListener('click', (e) => {
                e.preventDefault();
                // 使用 currentTarget 确保获取到的是 a 标签上的 data-lang
                const lang = e.currentTarget.getAttribute('data-lang');

                if (lang && lang !== this.currentLang) {
                    this.loadTranslations(lang).then(() => {
                        this.updatePage();
                        // 触发重绘事件 (用于图表等)
                        document.dispatchEvent(new CustomEvent('i18nReady'));
                    });
                }
            });
        });
    }
}

// 创建全局实例
const i18n = new I18n();

// 全局翻译函数简写
function t(key, params = {}) {
    return i18n.translate(key, params);
}