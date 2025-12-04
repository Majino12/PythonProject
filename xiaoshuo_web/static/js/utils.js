// 工具函数库(支持多语言)
class Utils {
    // 格式化文件大小
    static formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // 格式化时间 (支持多语言)
    static formatTime(date) {
        if (!date) return '';

        // 如果存在全局翻译函数 t()，则使用它
        if (typeof t === 'function') {
            const d = new Date(date);
            const now = new Date();
            const diff = now - d;
            const minutes = Math.floor(diff / 60000);

            if (minutes < 1) return t('common.just_now');
            if (minutes < 60) return t('common.minutes_ago', {minutes: minutes});

            const hours = Math.floor(diff / 3600000);
            if (hours < 24) return t('common.hours_ago', {hours: hours});

            const days = Math.floor(diff / 86400000);
            if (days < 7) return t('common.days_ago', {days: days});

            return d.toLocaleDateString();
        }

        // 后备：直接返回本地字符串
        return new Date(date).toLocaleString();
    }

    // 防抖函数
    static debounce(func, wait, immediate) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                timeout = null;
                if (!immediate) func(...args);
            };
            const callNow = immediate && !timeout;
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
            if (callNow) func(...args);
        };
    }

    // 转义HTML
    static escapeHtml(unsafe) {
        if (!unsafe) return '';
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // 下载文件
    static downloadFile(data, filename, type = 'text/plain') {
        const file = new Blob([data], { type: type });
        const a = document.createElement('a');
        const url = URL.createObjectURL(file);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 0);
    }

    // 验证URL
    static isValidUrl(string) {
        try {
            new URL(string);
            return true;
        } catch (_) {
            return false;
        }
    }
}

// 全局工具函数
window.utils = Utils;