'use strict';
class Dashboard {
    constructor() {
        document.getElementById('refreshDashboard')?.addEventListener('click', () => this.load());
        this.load();
    }
    text(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
    async load() {
        const refresh = document.getElementById('refreshDashboard');
        if (refresh) refresh.disabled = true;
        const [historyResult, statsResult] = await Promise.allSettled([
            fetchJSON('/api/history'), fetchJSON('/api/stats')
        ]);
        if (historyResult.status === 'fulfilled' && Array.isArray(historyResult.value)) {
            const history = historyResult.value;
            this.renderHistory(history);
            this.text('totalAnalyses', history.length);
            this.text('successAnalyses', history.filter(item => item.analysis_status === 'complete').length);
            this.text('todayAnalyses', history.filter(item => new Date(item.timestamp).toDateString() === new Date().toDateString()).length);
            const durations = history.map(item => item.duration == null ? NaN : parseFloat(item.duration)).filter(Number.isFinite);
            this.text('avgTime', durations.length ? `${(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)}s` : '未记录');
            this.text('dashboardMessage', `显示最近 ${history.length} 条保存记录。统计仅基于当前列表；缺少处理状态的历史报告不计入完整处理记录。`);
        } else {
            this.text('dashboardMessage', '分析记录加载失败，请刷新重试。');
            for (const id of ['totalAnalyses', 'successAnalyses', 'todayAnalyses', 'avgTime']) this.text(id, '—');
        }
        const system = statsResult.status === 'fulfilled' ? statsResult.value.system : null;
        this.text('cpuUsage', typeof system?.cpu?.percent === 'number' ? `${system.cpu.percent}%` : '未提供');
        for (const [kind, id] of [['memory', 'memoryUsage'], ['disk', 'storageUsage']]) {
            const item = system?.[kind];
            this.text(id, typeof item?.used === 'number' && typeof item?.total === 'number' ? `${item.used.toFixed(1)} / ${item.total.toFixed(1)} GB` : '未提供');
        }
        if (refresh) refresh.disabled = false;
    }
    renderHistory(history) {
        const container = document.getElementById('recentAnalyses');
        container.replaceChildren();
        if (!history.length) {
            const empty = document.createElement('p');
            empty.className = 'p-4 text-muted mb-0';
            empty.textContent = '暂无分析记录。上传小说后，可在这里查看报告。';
            container.appendChild(empty);
            return;
        }
        const modes = {model: '模型分析', baseline: '基础统计'};
        const statuses = {queued: '排队中', processing: '处理中', completed: '任务已完成', failed: '失败'};
        for (const item of history) {
            const row = document.createElement('article');
            row.className = 'list-group-item p-4';
            const title = document.createElement('h3');
            title.className = 'h6 text-break';
            title.textContent = item.title || '未命名文档';
            const subtitle = document.createElement('p');
            subtitle.className = 'small text-muted';
            const date = new Date(item.timestamp);
            const status = item.error ? '失败' : item.analysis_status === 'partial' ? '部分完成' : item.analysis_status === 'complete' ? '处理完整' : statuses[item.status] || '已保存 · 完整性未记录';
            subtitle.textContent = [status, modes[item.mode] || '模式未记录', `${item.chapters ?? '—'} 章`, Number.isNaN(date.valueOf()) ? '时间未记录' : date.toLocaleString()].join(' · ');
            const actions = document.createElement('div');
            actions.className = 'd-flex gap-2';
            const view = document.createElement('a');
            view.className = 'btn btn-sm btn-outline-primary';
            view.href = `/result/${encodeURIComponent(item.id)}`;
            view.textContent = '查看报告';
            const download = document.createElement('a');
            download.className = 'btn btn-sm btn-outline-secondary';
            download.href = `/export/${encodeURIComponent(item.id)}?format=json`;
            download.textContent = '下载 JSON';
            if (['queued', 'processing'].includes(item.status)) {
                const resume = document.createElement('a');
                resume.className = 'btn btn-sm btn-outline-primary';
                resume.href = '/';
                resume.textContent = '查看进度';
                resume.addEventListener('click', () => rememberTask(item.id));
                actions.appendChild(resume);
            } else if (item.status !== 'failed') actions.append(view, download);
            else {
                const error = document.createElement('p');
                error.className = 'small text-danger mb-0';
                error.textContent = item.error || '任务失败，未生成报告。';
                actions.appendChild(error);
            }
            row.append(title, subtitle, actions);
            container.appendChild(row);
        }
    }
}
document.addEventListener('DOMContentLoaded', () => { window.dashboard = new Dashboard(); });
