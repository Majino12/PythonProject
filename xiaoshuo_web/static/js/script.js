// 主JavaScript功能
function analyzeContent(analysisType, formData) {
    const loadingElement = document.getElementById('loading');
    const resultsElement = document.getElementById('results');

    // 显示加载指示器
    loadingElement.classList.remove('d-none');
    resultsElement.classList.add('d-none');

    // 添加分析类型到表单数据
    formData.append('analysis_type', analysisType);

    // 显示进度指示
    let dots = 0;
    const progressText = loadingElement.querySelector('p');
    const originalText = progressText.textContent;
    const progressInterval = setInterval(() => {
        dots = (dots + 1) % 4;
        progressText.textContent = originalText + '.'.repeat(dots);
    }, 500);

    // 发送分析请求
    fetch('/analyze', {
        method: 'POST',
        body: formData
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        return response.json();
    })
    .then(data => {
        clearInterval(progressInterval);
        loadingElement.classList.add('d-none');

        if (data.error) {
            showError(data.error);
            return;
        }

        if (data.success) {
            // 重定向到结果页面
            window.location.href = `/result/${data.result_id}`;
        } else {
            showError('分析失败，请重试');
        }
    })
    .catch(error => {
        clearInterval(progressInterval);
        loadingElement.classList.add('d-none');
        console.error('Error:', error);
        showError('网络错误，请检查连接后重试');
    });
}

function showError(message) {
    // 创建错误提示
    const errorAlert = document.createElement('div');
    errorAlert.className = 'alert alert-danger alert-dismissible fade show';
    errorAlert.innerHTML = `
        <strong>错误:</strong> ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;

    // 插入到页面顶部
    const container = document.querySelector('.container');
    container.insertBefore(errorAlert, container.firstChild);

    // 自动移除
    setTimeout(() => {
        if (errorAlert.parentNode) {
            errorAlert.remove();
        }
    }, 5000);
}

function showSuccess(message) {
    // 创建成功提示
    const successAlert = document.createElement('div');
    successAlert.className = 'alert alert-success alert-dismissible fade show';
    successAlert.innerHTML = `
        <strong>成功:</strong> ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;

    // 插入到页面顶部
    const container = document.querySelector('.container');
    container.insertBefore(successAlert, container.firstChild);

    // 自动移除
    setTimeout(() => {
        if (successAlert.parentNode) {
            successAlert.remove();
        }
    }, 3000);
}

// 示例文本加载
function loadExampleText() {
    const textArea = document.querySelector('textarea[name="text_content"]');
    const titleInput = document.querySelector('input[name="title"]');

    if (textArea && titleInput) {
        titleInput.value = "1984 - 示例文本";
        textArea.value = `CHAPTER 1
It was a bright cold day in April, and the clocks were striking thirteen.
Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind,
slipped quickly through the glass doors of Victory Mansions, though not quickly enough
to prevent a swirl of gritty dust from entering along with him.

The hallway smelt of boiled cabbage and old rag mats. At one end of it a coloured poster,
too large for indoor display, had been tacked to the wall. It depicted simply an enormous face,
more than a metre wide: the face of a man of about forty-five, with a heavy black moustache
and ruggedly handsome features.

CHAPTER 2
Winston made for the stairs. It was no use trying the lift. Even at the best of times
it was seldom working, and at present the electric current was cut off during daylight hours.
It was part of the economy drive in preparation for Hate Week. The flat was seven flights up,
and Winston, who was thirty-nine and had a varicose ulcer above his right ankle, went slowly,
resting several times on the way.

On each landing, opposite the lift-shaft, the poster with the enormous face gazed from the wall.
It was one of those pictures which are so contrived that the eyes follow you about when you move.
BIG BROTHER IS WATCHING YOU, the caption beneath it ran.`;

        showSuccess('已加载示例文本，您可以修改或直接进行分析');
    }
}

// 文件类型验证
function validateFile(input) {
    const file = input.files[0];
    if (file) {
        const fileName = file.name.toLowerCase();
        const validExtensions = ['.txt', '.docx', '.pdf'];
        const maxSize = 16 * 1024 * 1024; // 16MB

        if (!validExtensions.some(ext => fileName.endsWith(ext))) {
            showError('只支持 .txt, .docx, .pdf 格式文件');
            input.value = '';
            return false;
        }

        if (file.size > maxSize) {
            showError('文件大小超过16MB限制');
            input.value = '';
            return false;
        }

        showSuccess(`已选择文件: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
        return true;
    }
    return false;
}

// URL验证
function validateURL(input) {
    const url = input.value.trim();
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
        showError('URL必须以 http:// 或 https:// 开头');
        input.focus();
        return false;
    }
    return true;
}

// 文本长度统计
function updateTextCounter() {
    const textArea = document.querySelector('textarea[name="text_content"]');
    const counter = document.getElementById('textCounter');

    if (textArea && counter) {
        const length = textArea.value.length;
        counter.textContent = `${length} 字符`;

        if (length < 100) {
            counter.className = 'form-text text-end text-danger';
        } else if (length < 500) {
            counter.className = 'form-text text-end text-warning';
        } else {
            counter.className = 'form-text text-end text-success';
        }
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    console.log('小说分析系统已加载');

    // 添加文本计数器
    const textArea = document.querySelector('textarea[name="text_content"]');
    if (textArea) {
        const counter = document.createElement('div');
        counter.id = 'textCounter';
        counter.className = 'form-text text-end';
        counter.textContent = '0 字符';
        textArea.parentNode.appendChild(counter);

        textArea.addEventListener('input', updateTextCounter);
        updateTextCounter();
    }

    // 示例加载按钮
    const loadExampleBtn = document.getElementById('loadExample');
    if (loadExampleBtn) {
        loadExampleBtn.addEventListener('click', loadExampleText);
    }

    // 文件验证
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
        fileInput.addEventListener('change', function() {
            validateFile(this);
        });
    }

    // URL验证
    const urlInputs = document.querySelectorAll('input[type="url"]');
    urlInputs.forEach(input => {
        input.addEventListener('blur', function() {
            validateURL(this);
        });
    });

    // 表单验证
    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
        form.addEventListener('submit', function(e) {
            if (!form.checkValidity()) {
                e.preventDefault();
                e.stopPropagation();

                // 找到第一个无效字段
                const invalidField = form.querySelector(':invalid');
                if (invalidField) {
                    invalidField.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    invalidField.focus();
                }
            }
            form.classList.add('was-validated');
        });
    });

    // 平滑滚动
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({ behavior: 'smooth' });
            }
        });
    });
});

// 控制台功能
function loadDashboardData() {
    // 加载分析历史
    const history = JSON.parse(localStorage.getItem('analysisHistory') || '[]');
    displayRecentAnalyses(history);

    // 更新统计信息
    updateStatistics(history);
}

function displayRecentAnalyses(history) {
    const container = document.getElementById('recentAnalyses');

    if (history.length === 0) {
        container.innerHTML = `
            <div class="text-center py-4 text-muted">
                <i class="fas fa-inbox fa-3x mb-3"></i>
                <p>暂无分析记录</p>
            </div>
        `;
        return;
    }

    container.innerHTML = history.slice(0, 10).map(item => `
        <div class="list-group-item">
            <div class="d-flex w-100 justify-content-between">
                <h6 class="mb-1">${item.title || '未命名分析'}</h6>
                <small class="text-muted">${formatTime(item.timestamp)}</small>
            </div>
            <p class="mb-1">${item.type || '文本分析'} • ${item.chapters || 0} 章节</p>
            <div class="d-flex justify-content-between align-items-center">
                <small class="text-muted">${item.duration || 'N/A'}</small>
                <div>
                    <button class="btn btn-sm btn-outline-primary" onclick="viewAnalysis('${item.id}')">
                        <i class="fas fa-eye me-1"></i>查看
                    </button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteAnalysis('${item.id}')">
                        <i class="fas fa-trash me-1"></i>删除
                    </button>
                </div>
            </div>
        </div>
    `).join('');
}

function updateStatistics(history) {
    const totalEl = document.getElementById('totalAnalyses');
    const todayEl = document.getElementById('todayAnalyses');
    const successEl = document.getElementById('successAnalyses');
    const avgTimeEl = document.getElementById('avgTime');

    if (totalEl) totalEl.textContent = history.length;

    const today = new Date().toDateString();
    const todayCount = history.filter(item =>
        new Date(item.timestamp).toDateString() === today
    ).length;
    if (todayEl) todayEl.textContent = todayCount;

    const successCount = history.filter(item => !item.error).length;
    if (successEl) successEl.textContent = successCount;

    const totalTime = history.reduce((sum, item) => sum + (parseFloat(item.duration) || 0), 0);
    const avgTime = history.length > 0 ? (totalTime / history.length).toFixed(1) : 0;
    if (avgTimeEl) avgTimeEl.textContent = avgTime + 's';
}

function updateSystemStatus() {
    // 模拟系统状态更新
    const cpu = Math.floor(Math.random() * 30) + 10;
    const memory = Math.floor(Math.random() * 200) + 100;
    const storage = Math.floor(Math.random() * 500) + 200;

    const cpuUsageEl = document.getElementById('cpuUsage');
    const cpuProgressEl = document.getElementById('cpuProgress');
    const memoryUsageEl = document.getElementById('memoryUsage');
    const memoryProgressEl = document.getElementById('memoryProgress');
    const storageUsageEl = document.getElementById('storageUsage');
    const storageProgressEl = document.getElementById('storageProgress');

    if (cpuUsageEl) cpuUsageEl.textContent = cpu + '%';
    if (cpuProgressEl) cpuProgressEl.style.width = cpu + '%';

    if (memoryUsageEl) memoryUsageEl.textContent = memory + ' MB';
    if (memoryProgressEl) memoryProgressEl.style.width = Math.min(cpu + 20, 100) + '%';

    if (storageUsageEl) storageUsageEl.textContent = storage + ' MB';
    if (storageProgressEl) storageProgressEl.style.width = Math.min(storage / 10, 100) + '%';
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN');
}

function clearHistory() {
    if (confirm('确定要清空所有分析记录吗？此操作不可恢复。')) {
        localStorage.removeItem('analysisHistory');
        loadDashboardData();
    }
}

function viewAnalysis(id) {
    window.location.href = `/result/${id}`;
}

function deleteAnalysis(id) {
    if (confirm('确定要删除此分析记录吗？')) {
        let history = JSON.parse(localStorage.getItem('analysisHistory') || '[]');
        history = history.filter(item => item.id !== id);
        localStorage.setItem('analysisHistory', JSON.stringify(history));
        loadDashboardData();
    }
}

function loadSampleData() {
    // 加载示例数据进行分析
    fetch('/example')
        .then(response => response.json())
        .then(data => {
            // 模拟分析过程
            const analysisId = 'sample_' + Date.now();
            const analysisItem = {
                id: analysisId,
                title: data.novel_info.title,
                type: '示例分析',
                chapters: data.novel_info.total_chapters,
                timestamp: new Date().toISOString(),
                duration: '2.5s'
            };

            // 保存到历史
            let history = JSON.parse(localStorage.getItem('analysisHistory') || '[]');
            history.unshift(analysisItem);
            localStorage.setItem('analysisHistory', JSON.stringify(history));

            // 跳转到结果页面
            window.location.href = `/result/${analysisId}`;
        })
        .catch(error => {
            console.error('Error loading sample data:', error);
            showError('加载示例数据失败');
        });
}

function saveSettings() {
    const form = document.getElementById('settingsForm');
    const formData = new FormData(form);
    const settings = Object.fromEntries(formData.entries());

    localStorage.setItem('analysisSettings', JSON.stringify(settings));

    // 显示成功消息
    showSuccess('设置已保存！');

    // 关闭模态框
    const modal = bootstrap.Modal.getInstance(document.getElementById('settingsModal'));
    if (modal) {
        modal.hide();
    }
}

function startBatchAnalysis() {
    const batchProgress = document.getElementById('batchProgress');
    if (batchProgress) {
        batchProgress.classList.remove('d-none');
    }

    let progress = 0;
    const interval = setInterval(() => {
        progress += 10;
        const progressBar = document.querySelector('#batchProgress .progress-bar');
        if (progressBar) {
            progressBar.style.width = progress + '%';
        }

        if (progress >= 100) {
            clearInterval(interval);
            setTimeout(() => {
                showSuccess('批量分析完成！');
                const modal = bootstrap.Modal.getInstance(document.getElementById('batchModal'));
                if (modal) {
                    modal.hide();
                }
                if (batchProgress) {
                    batchProgress.classList.add('d-none');
                }
            }, 500);
        }
    }, 200);
}

function exportResults() {
    showSuccess('导出功能正在准备中...');
    const modal = bootstrap.Modal.getInstance(document.getElementById('exportModal'));
    if (modal) {
        modal.hide();
    }
}

// 初始化控制台
if (window.location.pathname === '/dashboard') {
    document.addEventListener('DOMContentLoaded', function() {
        loadDashboardData();
        setInterval(updateSystemStatus, 5000);
    });
}