// static/js/dashboard.js

class Dashboard {
    constructor() {
        this.currentPage = 1;
        this.itemsPerPage = 10;
        this.filterType = 'all';
        this.init();
    }

    async init() {
        await this.loadDashboardData();
        this.setupEventListeners();
        this.startBackgroundTasks();

        // 监听语言就绪和更新事件
        document.addEventListener('i18nReady', () => this.updateUI());
        document.addEventListener('i18nPageUpdated', () => this.updateStatisticsUIOnly());
    }

    async loadDashboardData() {
        try {
            const [history, stats] = await Promise.all([
                this.loadAnalysisHistory(),
                this.loadSystemStats()
            ]);

            // 保存数据到实例，以便语言切换时重新渲染
            this.currentHistory = history;
            this.currentStats = stats;

            this.displayRecentAnalyses(history);
            this.updateStatistics(history);
            this.updateSystemStatus(stats);
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }

    async loadAnalysisHistory() {
        try {
            const response = await fetch('/api/history');
            if (response.ok) return await response.json();
            return [];
        } catch { return []; }
    }

    async loadSystemStats() {
        try {
            const response = await fetch('/api/stats');
            return response.ok ? await response.json() : null;
        } catch { return null; }
    }

    displayRecentAnalyses(history) {
        const container = document.getElementById('recentAnalyses');
        if (!container) return;

        if (!history || history.length === 0) {
            container.innerHTML = this.getEmptyStateHTML();
            return;
        }

        const sorted = history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const pageItems = sorted.slice(startIndex, startIndex + this.itemsPerPage);

        container.innerHTML = pageItems.map(item => this.getAnalysisItemHTML(item)).join('');
    }

    getEmptyStateHTML() {
        return `
            <div class="text-center py-5 text-muted">
                <i class="fas fa-inbox fa-4x mb-3 opacity-50"></i>
                <h5 data-i18n="dashboard.no_analyses">No analysis records</h5>
                <a href="/" class="btn btn-primary mt-2">
                    <i class="fas fa-plus me-2"></i><span data-i18n="dashboard.new_analysis">New Analysis</span>
                </a>
            </div>
        `;
    }

    getAnalysisItemHTML(item) {
        // 安全处理翻译，防止 t() 未加载时报错
        const translate = (typeof t === 'function') ? t : (k) => k;

        const statusText = item.error ? translate('common.failed') : translate('common.success');
        const statusClass = item.error ? 'text-danger' : 'text-success';
        const statusIcon = item.error ? 'fa-exclamation-circle' : 'fa-check-circle';
        const timeString = this.formatTime(item.timestamp);
        const chaptersText = `${item.chapters || 0} ${translate('common.chapters')}`;
        const viewText = translate('common.view');
        const downloadText = translate('common.download');
        const deleteText = translate('common.delete');

        return `
            <div class="list-group-item analysis-item p-3 border-bottom">
                <div class="d-flex justify-content-between align-items-start">
                    <div class="flex-grow-1">
                        <div class="d-flex justify-content-between mb-1">
                            <h6 class="mb-0 fw-bold text-dark">${this.escapeHtml(item.title || 'Untitled')}</h6>
                            <small class="text-muted">${timeString}</small>
                        </div>
                        <div class="d-flex align-items-center gap-2 mt-2">
                            <span class="badge bg-light text-dark border">${item.type || 'Text'}</span>
                            <span class="badge bg-info bg-opacity-10 text-info border border-info">${chaptersText}</span>
                            <span class="badge bg-light ${statusClass} border">
                                <i class="fas ${statusIcon} me-1"></i>${statusText}
                            </span>
                        </div>
                    </div>
                </div>
                <div class="d-flex justify-content-end mt-3 gap-2">
                    <button class="btn btn-sm btn-outline-primary" onclick="dashboard.viewAnalysis('${item.id}')">
                        <i class="fas fa-eye me-1"></i> ${viewText}
                    </button>
                    <button class="btn btn-sm btn-outline-success" onclick="dashboard.downloadAnalysis('${item.id}')">
                        <i class="fas fa-download me-1"></i> ${downloadText}
                    </button>
                    <button class="btn btn-sm btn-outline-danger" onclick="dashboard.deleteAnalysis('${item.id}')">
                        <i class="fas fa-trash me-1"></i> ${deleteText}
                    </button>
                </div>
            </div>
        `;
    }

    formatTime(timestamp) {
        if (!timestamp) return '';
        if (typeof t !== 'function') return timestamp;

        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        // 修复：确保参数传递给翻译函数
        if (minutes < 1) return t('common.just_now');
        if (minutes < 60) return t('common.minutes_ago', {minutes: minutes});
        if (hours < 24) return t('common.hours_ago', {hours: hours});
        if (days < 7) return t('common.days_ago', {days: days});

        return date.toLocaleDateString();
    }

    updateStatistics(history) {
        if (!history) return;

        const total = history.length;
        const successCount = history.filter(item => !item.error).length;
        const todayCount = history.filter(item => new Date(item.timestamp).toDateString() === new Date().toDateString()).length;

        // Avg Time 计算
        let avgTimeStr = "0.0s";
        if (total > 0) {
            const totalTime = history.reduce((sum, item) => {
                // 移除 's' 后缀并转浮点
                const val = parseFloat((item.duration || "0").toString().replace('s', ''));
                return sum + (isNaN(val) ? 0 : val);
            }, 0);
            avgTimeStr = (totalTime / total).toFixed(1) + "s";
        }

        // Success Rate 计算
        const successRate = total > 0 ? Math.round((successCount / total) * 100) : 0;

        // 更新 DOM
        this.updateElement('totalAnalyses', total);
        this.updateElement('successAnalyses', successCount);
        this.updateElement('todayAnalyses', todayCount);
        this.updateElement('avgTime', avgTimeStr);

        // 更新成功率标签 (处理 "Success Rate: 0%" 的多语言显示)
        // 我们需要保留 Label (翻译后)，只更新数值
        const successRateEl = document.getElementById('successRate'); // 这是 subtitle
        if (successRateEl) {
            const label = (typeof t === 'function') ? t('dashboard.success_rate') : 'Success Rate';
            successRateEl.textContent = `${label}: ${successRate}%`;
        }
    }

    // 仅在语言切换时调用，避免闪烁
    updateStatisticsUIOnly() {
        if (this.currentHistory) {
            this.updateStatistics(this.currentHistory);
            this.displayRecentAnalyses(this.currentHistory);
        }
    }

    updateSystemStatus(stats) {
        if (!stats || !stats.system) return;
        const { cpu, memory, disk } = stats.system;

        this.updateProgress('cpuProgress', cpu.percent);
        this.updateText('cpuUsage', `${cpu.percent}%`);

        this.updateProgress('memoryProgress', memory.percent);
        this.updateText('memoryUsage', `${memory.used.toFixed(1)} GB / ${memory.total.toFixed(1)} GB`);

        this.updateProgress('storageProgress', disk.percent);
        this.updateText('storageUsage', `${disk.used.toFixed(1)} GB / ${disk.total.toFixed(1)} GB`);
    }

    updateElement(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    updateText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    updateProgress(id, percent) {
        const el = document.getElementById(id);
        if (el) el.style.width = `${percent}%`;
    }

    showLoadingState() {
        const container = document.getElementById('recentAnalyses');
        if(container && typeof t === 'function') {
            container.innerHTML = `<div class="text-center py-4 text-muted">${t('common.loading')}</div>`;
        }
    }

    viewAnalysis(id) { window.location.href = `/result/${id}`; }

    async downloadAnalysis(id) { window.open(`/export/${id}?format=json`, '_blank'); }

    async deleteAnalysis(id) {
        if (!confirm(typeof t === 'function' ? t('common.confirm') : 'Confirm?')) return;

        // 更新本地缓存（如果使用了本地模式）
        let history = JSON.parse(localStorage.getItem('analysisHistory') || '[]');
        history = history.filter(h => h.id !== id);
        localStorage.setItem('analysisHistory', JSON.stringify(history));

        // 重新加载数据
        this.loadDashboardData();
    }

    updateUI() {
        this.loadDashboardData();
    }

    escapeHtml(text) {
        if (!text) return text;
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    startBackgroundTasks() {
        setInterval(() => this.loadSystemStats().then(s => this.updateSystemStatus(s)), 5000);
    }

    setupEventListeners() {
        document.getElementById('refreshDashboard')?.addEventListener('click', () => this.loadDashboardData());
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new Dashboard();
});