'use strict';

// Server progress is the only source of completion. Text from files/models uses textContent.
let activeTaskId = null;
let polling = false;
let currentModal = null;
const taskStorageKey = 'novelAnalysisActiveTask';

function showMessage(message, kind = 'danger') {
    const container = document.getElementById('pageMessages') || document.querySelector('main');
    if (!container) return;
    const alert = document.createElement('div');
    alert.className = `alert alert-${kind} alert-dismissible fade show`;
    alert.setAttribute('role', 'alert');
    alert.appendChild(document.createTextNode(String(message)));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-close';
    close.setAttribute('data-bs-dismiss', 'alert');
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => alert.remove());
    alert.appendChild(close);
    container.prepend(alert);
}
function showError(message) { showMessage(message); }
function showSuccess(message) { showMessage(message, 'success'); }

async function fetchJSON(url, options = {}) {
    const response = await fetch(url, options);
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error(`服务器未返回有效数据（HTTP ${response.status}），请重试。`); }
    if (!response.ok) {
        const error = new Error(data.error || `请求失败（HTTP ${response.status}）。`);
        error.status = response.status;
        throw error;
    }
    return data;
}

function rememberTask(id) {
    try { if (id) sessionStorage.setItem(taskStorageKey, id); else sessionStorage.removeItem(taskStorageKey); }
    catch (_) { /* Storage can be unavailable in privacy mode. */ }
}
function setBusy(busy) {
    document.getElementById('activeTaskNotice')?.classList.toggle('d-none', !busy);
    document.querySelectorAll('form[data-analysis-type] button[type="submit"]').forEach(button => {
        button.disabled = busy || (button.id === 'fileSubmit' && !document.getElementById('fileInput')?.files.length);
    });
    const mode = document.getElementById('analysisMode');
    if (mode) mode.disabled = busy;
}
function showProgress() {
    const element = document.getElementById('progressModal');
    if (element && typeof bootstrap !== 'undefined') {
        currentModal = bootstrap.Modal.getOrCreateInstance(element);
        currentModal.show();
    }
}
function progressError(message, reconnect) {
    const error = document.getElementById('progressError');
    if (error) { error.textContent = message; error.classList.remove('d-none'); }
    else showError(message);
    document.getElementById('retryStatus')?.classList.toggle('d-none', !reconnect);
    document.getElementById('analysisProgress')?.classList.remove('progress-bar-animated');
}
function updateProgress(status) {
    const bar = document.getElementById('analysisProgress');
    const progress = Number(status.progress);
    if (bar && Number.isFinite(progress)) {
        const value = Math.max(0, Math.min(status.status === 'completed' ? 100 : 99, progress));
        bar.style.width = `${value}%`;
        bar.setAttribute('aria-valuenow', String(value));
    }
    const text = document.getElementById('progressText');
    const stages = {queued: '已排队，等待处理', prepare: '准备全文', extract: '分段阅读', fetching: '获取网页正文', loading: '正在读取正文', preparing: '准备全文', map: '分段阅读', verify: '核对引用与结论', baseline: '基础统计与摘录', chapter_summary: '整理章节摘要', book_summary: '汇总全书', complete: '处理完成'};
    if (text) text.textContent = status.message || stages[status.stage] || status.stage || (status.status === 'queued' ? '已排队，等待处理…' : '正在处理全文…');
    const units = document.getElementById('progressUnits');
    if (units) units.textContent = Number(status.total_units) > 0 ? `当前阶段已处理 ${status.completed_units || 0} / ${status.total_units} 个单元` : '等待服务器报告处理单元数';
}
async function pollAnalysis(taskId) {
    if (polling) return;
    polling = true;
    document.getElementById('progressError')?.classList.add('d-none');
    document.getElementById('retryStatus')?.classList.add('d-none');
    document.getElementById('analysisProgress')?.classList.add('progress-bar-animated');
    try {
        while (activeTaskId === taskId) {
            const status = await fetchJSON(`/analysis/status/${encodeURIComponent(taskId)}`);
            updateProgress(status);
            if (status.status === 'completed') {
                if (!status.result_id) throw new Error('服务器报告已完成，但缺少结果编号。请重新连接进度。');
                rememberTask(null);
                window.location.assign(`/result/${encodeURIComponent(status.result_id)}`);
                return;
            }
            if (status.status === 'failed') {
                activeTaskId = null;
                rememberTask(null);
                setBusy(false);
                progressError(status.error || '分析未完成，请检查配置后重试。', false);
                return;
            }
            if (!['queued', 'processing'].includes(status.status)) throw new Error('服务器返回了未知任务状态，请重新连接进度。');
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    } catch (error) {
        if (error.status === 404) {
            activeTaskId = null;
            rememberTask(null);
            setBusy(false);
            progressError(`${error.message} 请返回首页重新提交。`, false);
        } else progressError(`${error.message} 任务可能仍在服务器运行，可重新连接查看。`, true);
    } finally { polling = false; }
}
async function startAnalysis(type, formData) {
    if (activeTaskId) { showProgress(); return; }
    formData.set('analysis_type', type);
    formData.set('analysis_mode', document.getElementById('analysisMode')?.value || 'auto');
    setBusy(true);
    showProgress();
    document.getElementById('progressError')?.classList.add('d-none');
    document.getElementById('retryStatus')?.classList.add('d-none');
    updateProgress({progress: 0, stage: '正在提交内容…'});
    try {
        const data = await fetchJSON('/analyze', {method: 'POST', body: formData});
        if (!data.success || !data.task_id) throw new Error(data.error || '服务器未创建分析任务。');
        activeTaskId = data.task_id;
        rememberTask(activeTaskId);
        await pollAnalysis(activeTaskId);
    } catch (error) {
        setBusy(false);
        progressError(error.message, false);
    }
}
// Retain the public entry point for old links/integrations.
function analyzeContent(type, data) { return startAnalysis(type, data); }

function updateTextCounter() {
    const input = document.querySelector('textarea[name="text_content"]');
    const counter = document.getElementById('textCounter');
    if (input && counter) counter.textContent = `${Array.from(input.value).length.toLocaleString()} 字符`;
}
function loadExampleText() {
    const input = document.querySelector('textarea[name="text_content"]');
    const title = document.querySelector('input[name="title"]');
    if (!input || !title) return;
    title.value = '灯塔来信（三章原创示例）';
    input.value = '第一章 来信\n林舟在旧灯塔里发现一封未寄出的信。信上写着姐姐林遥的名字，她已经离开海岛十年。守塔人陈伯说，林遥离开前曾把一本航海日志交给他。林舟决定找出姐姐离开的原因。\n\n第二章 日志\n陈伯把日志交给林舟。日志记录了十年前的风暴：林遥冒险出海，救下了一名迷路的孩子。林舟读到最后一页才知道，姐姐受伤后去了城里治疗，没有人把后续的信送到岛上。陈伯承认自己一直没有勇气告诉林舟。\n\n第三章 重逢\n林舟带着那封旧信来到城里的修船厂，找到了林遥。林遥解释自己曾多次寄信，却始终没有收到回音。两人决定一起回岛，查清信件失踪的缘由。黄昏时，兄妹重新点亮灯塔，把日志留在窗边。';
    document.getElementById('text-tab')?.click();
    updateTextCounter();
}
function validateFile(input) {
    const file = input.files[0];
    if (!file) return false;
    const maxBytes = Number(input.dataset.maxBytes) || 64 * 1024 * 1024;
    if (!/\.(txt|docx|pdf)$/i.test(file.name) || file.size >= maxBytes) {
        showError(`请选择小于 ${Math.round(maxBytes / 1024 / 1024)} MB 的 TXT、DOCX 或带文字层的 PDF 文件。`);
        input.value = '';
        return false;
    }
    return true;
}
async function loadModelStatus() {
    const status = document.getElementById('modelStatus');
    const details = document.getElementById('modelDetails');
    if (!status) return;
    try {
        const data = await fetchJSON('/api/models');
        status.textContent = data.configured ? '已配置模型，分析时将连接模型服务。' : '尚未配置模型，自动模式将提供基础统计与原文摘录。';
        status.className = data.configured ? 'mb-1 small text-success' : 'mb-1 small text-warning-emphasis';
        const labels = {map: '分段阅读', reduce: '全书汇总', verify: '引用复核'};
        if (details) {
            details.replaceChildren();
            for (const role of ['map', 'reduce', 'verify']) {
                const row = document.createElement('p');
                row.className = 'mb-1';
                const stage = data.stages?.[role];
                row.textContent = `${labels[role]}：${stage?.model || data.models?.[role] || '未配置'}${stage?.provider ? `（${stage.provider}）` : ''}`;
                details.appendChild(row);
            }
            for (const warning of data.warnings || []) {
                const row = document.createElement('p');
                row.className = 'mb-1';
                row.textContent = warning;
                details.appendChild(row);
            }
        }
    } catch (error) {
        status.textContent = '暂时无法读取模型状态。提交时将由服务器检查配置。';
        if (details) details.textContent = error.message;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('form[data-analysis-type]').forEach(form => {
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (form.reportValidity()) startAnalysis(form.dataset.analysisType, new FormData(form));
        });
    });
    document.querySelector('textarea[name="text_content"]')?.addEventListener('input', updateTextCounter);
    document.getElementById('loadExample')?.addEventListener('click', loadExampleText);
    document.getElementById('clearText')?.addEventListener('click', () => {
        const input = document.querySelector('textarea[name="text_content"]');
        if (input) input.value = '';
        updateTextCounter();
    });
    document.getElementById('fileInput')?.addEventListener('change', event => {
        const input = event.target;
        const valid = validateFile(input);
        document.getElementById('fileSubmit').disabled = !valid || Boolean(activeTaskId);
        document.getElementById('fileInfo').textContent = valid ? `${input.files[0].name} · ${(input.files[0].size / 1024 / 1024).toFixed(2)} MB` : '';
    });
    document.getElementById('checkModels')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        const status = document.getElementById('modelHealth');
        button.disabled = true;
        status.textContent = '正在检查已配置的模型连接…';
        try {
            const data = await fetchJSON('/api/models?check=1');
            status.textContent = data.available ? '配置的模型可连接。实际分析时仍可能受服务容量影响。' : '有模型尚不可用，请检查模型服务是否启动、模型是否已下载及配置是否正确。';
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
    });
    document.getElementById('reopenProgress')?.addEventListener('click', showProgress);
    document.getElementById('retryStatus')?.addEventListener('click', () => { if (activeTaskId) pollAnalysis(activeTaskId); });
    updateTextCounter();
    loadModelStatus();
    if (document.getElementById('progressModal')) {
        try { activeTaskId = sessionStorage.getItem(taskStorageKey); } catch (_) { /* Optional state. */ }
        if (activeTaskId) { setBusy(true); showProgress(); pollAnalysis(activeTaskId); }
    }
});
