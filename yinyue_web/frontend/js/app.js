'use strict';

// All API data is inserted with textContent or DOM nodes, never parsed as markup.
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_LABELS = { analyze: '分析工作台', crawler: '歌词采集', library: '我的曲库', recommend: '相似发现' };
const SENTIMENT_LABELS = { positive: '积极', neutral: '中性', negative: '消极', unanalyzed: '待分析' };
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const percent = (value) => `${Math.round(clamp(value, 0, 1) * 100)}%`;
const debounce = (fn, delay = 300) => {
  let timer;
  return (...args) => { window.clearTimeout(timer); timer = window.setTimeout(() => fn(...args), delay); };
};
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function svgElement(tag, attributes, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function actionButton(label, className, action) {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}
function sentimentKey(value) {
  const key = String(value || 'unanalyzed').toLowerCase();
  return Object.hasOwn(SENTIMENT_LABELS, key) ? key : 'unanalyzed';
}
function setSentiment(node, value) {
  const key = sentimentKey(value);
  node.className = `sentiment-badge ${key}`;
  node.textContent = SENTIMENT_LABELS[key];
}
function songPolarity(song) {
  const analysis = song.analysis || {};
  if (analysis.overall_polarity !== undefined) return number(analysis.overall_polarity);
  return number(analysis.textblob?.supported === false || analysis.textblob?.available === false ? analysis.lexicon?.score : analysis.textblob?.polarity);
}
function emptyState(title, description, symbol = 'music') {
  const node = element('div', 'empty-state');
  node.append(icon(symbol), element('h3', '', title), element('p', '', description));
  return node;
}

class LyricAnalyzerApp {
  constructor() {
    this.page = 1;
    this.perPage = 20;
    this.totalPages = 1;
    this.totalSongs = 0;
    this.librarySequence = 0;
    this.statsSequence = 0;
    this.connectionSequence = 0;
    this.pickerSequence = 0;
    this.detailSequence = 0;
    this.queue = [];
    this.queueRunning = false;
    this.stopRequested = false;
    this.currentSong = null;
    this.pendingDelete = null;
    this.recommendationSequence = 0;
    this.bindEvents();
    this.setView();
    this.updateCharacterCount();
    this.refreshData();
    this.checkConnection();
  }

  async request(path, options = {}) {
    const { timeout = 25000, ...fetchOptions } = options;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`/api${path}`, {
        ...fetchOptions,
        signal: controller.signal,
        headers: { Accept: 'application/json', ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}), ...fetchOptions.headers },
      });
      const type = response.headers.get('content-type') || '';
      if (!type.includes('application/json')) throw new Error('服务没有返回有效数据，请确认已通过项目启动器打开页面。');
      const data = await response.json();
      if (!response.ok || data.success === false || data.status === 'failed' || data.status === 'error') {
        const error = new Error(data.error || data.message || `请求未完成（HTTP ${response.status}）`);
        error.code = data.error_code;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请稍后刷新曲库确认结果，再决定是否重试。');
      if (error instanceof TypeError) throw new Error('无法连接服务，请检查网络或重新启动项目。');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  bindEvents() {
    window.addEventListener('hashchange', () => this.setView());
    $('start-analyze').addEventListener('click', () => {
      $('analysis-workspace').scrollIntoView({ behavior: this.scrollBehavior() });
      $('an-title').focus({ preventScroll: true });
    });
    $('fill-example').addEventListener('click', () => this.fillExample());
    $('an-lyrics').addEventListener('input', () => this.updateCharacterCount());
    $('analysis-form').addEventListener('submit', (event) => { event.preventDefault(); this.analyzeManual(); });
    $('crawler-form').addEventListener('submit', (event) => { event.preventDefault(); this.crawlSong(); });
    $('add-to-queue').addEventListener('click', () => this.addToQueue());
    $('start-queue').addEventListener('click', () => this.runQueue());
    $('stop-queue').addEventListener('click', () => this.stopQueue());
    $('clear-queue').addEventListener('click', () => { if (!this.queueRunning) { this.queue = []; this.renderQueue(); } });
    $('library-search').addEventListener('input', debounce(() => { this.page = 1; this.loadLibrary(); }));
    for (const id of ['library-sentiment', 'library-sort']) $(id).addEventListener('change', () => { this.page = 1; this.loadLibrary(); });
    $('previous-page').addEventListener('click', () => { if (this.page > 1) { this.page--; this.loadLibrary(); } });
    $('next-page').addEventListener('click', () => { if (this.page < this.totalPages) { this.page++; this.loadLibrary(); } });
    $('export-library').addEventListener('click', () => this.exportLibrary());
    $('refresh-connection').addEventListener('click', () => { this.checkConnection(); this.refreshData(); });
    $('recommend-search').addEventListener('input', debounce(() => this.loadSongPicker()));
    $('rec-target-song').addEventListener('change', () => {
      this.recommendationSequence++;
      this.setStatus('recommend-status', '');
      $('recommendation-results').replaceChildren(emptyState('参考歌曲已更新', '点击“发现相似歌曲”生成新的推荐。', 'discover'));
      this.setBusy('recommend-submit', false);
    });
    $('recommend-form').addEventListener('submit', (event) => { event.preventDefault(); this.getRecommendations(); });
    $('close-song-dialog').addEventListener('click', () => $('song-dialog').close());
    $('dialog-analysis').addEventListener('click', () => this.openCurrentAnalysis());
    $('dialog-recommend').addEventListener('click', () => this.recommendCurrentSong());
    $('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
    $('confirm-delete').addEventListener('click', () => this.deleteSong());
    for (const id of ['song-dialog', 'delete-dialog']) {
      $(id).addEventListener('click', (event) => {
        if (event.target === $(id)) {
          const bounds = $(id).getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
            if (id !== 'delete-dialog' || !$('confirm-delete').disabled) $(id).close();
          }
        }
      });
    }
    $('delete-dialog').addEventListener('cancel', (event) => { if ($('confirm-delete').disabled) event.preventDefault(); });
  }

  scrollBehavior() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'; }

  setView() {
    const hash = location.hash.slice(1);
    const view = Object.hasOwn(VIEW_LABELS, hash) ? hash : 'analyze';
    for (const key of Object.keys(VIEW_LABELS)) $(`view-${key}`).hidden = key !== view;
    document.querySelectorAll('.nav-item').forEach((item) => {
      const active = item.dataset.view === view;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    $('current-view-label').textContent = VIEW_LABELS[view];
    document.title = `${VIEW_LABELS[view]} · 音绪 YINYUE`;
    if (this.activeView && this.activeView !== view) window.scrollTo({ top: 0, behavior: 'instant' });
    this.activeView = view;
  }

  navigate(view) {
    if (location.hash === `#${view}`) this.setView(); else location.hash = view;
    window.requestAnimationFrame(() => $('main').focus({ preventScroll: true }));
  }

  setStatus(id, message, kind = '') {
    const node = $(id);
    node.textContent = message;
    node.classList.remove('error', 'success', 'loading');
    if (kind) node.classList.add(kind);
  }

  setBusy(id, busy) {
    const node = $(id);
    node.disabled = busy;
    node.classList.toggle('is-busy', busy);
    node.setAttribute('aria-busy', String(busy));
  }

  toast(message, error = false) {
    window.clearTimeout(this.toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    this.toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 4500);
  }

  async checkConnection() {
    const sequence = ++this.connectionSequence;
    $('connection-label').textContent = '正在连接服务';
    $('connection-dot').className = 'connection-dot';
    try {
      await this.request('/health', { timeout: 10000 });
      if (sequence !== this.connectionSequence) return;
      $('connection-label').textContent = '本地服务已连接';
      $('connection-dot').classList.add('connected');
      $('connection-dot').setAttribute('title', '本地服务已连接');
    } catch (error) {
      if (sequence !== this.connectionSequence) return;
      $('connection-label').textContent = '服务连接异常';
      $('connection-dot').classList.add('offline');
      $('connection-dot').setAttribute('title', error.message);
      this.toast(error.message, true);
    }
  }

  async refreshData() {
    await Promise.allSettled([this.loadLibrary(), this.loadStats(), this.loadSongPicker()]);
  }

  async loadStats() {
    const sequence = ++this.statsSequence;
    try {
      const data = await this.request('/stats');
      if (sequence !== this.statsSequence) return;
      const stats = data.stats || data;
      const distribution = stats.sentiment_distribution || stats.sentiments || {};
      for (const id of ['stat-total', 'stat-positive', 'stat-neutral', 'stat-negative']) $(id).removeAttribute('title');
      const total = number(stats.total_songs ?? stats.total, 0);
      $('stat-total').textContent = total.toLocaleString('zh-CN');
      $('nav-library-count').textContent = total.toLocaleString('zh-CN');
      for (const key of ['positive', 'neutral', 'negative']) $(`stat-${key}`).textContent = number(distribution[key], 0).toLocaleString('zh-CN');
    } catch (error) {
      if (sequence !== this.statsSequence) return;
      for (const id of ['stat-total', 'stat-positive', 'stat-neutral', 'stat-negative']) {
        $(id).textContent = '—';
        $(id).title = error.message;
      }
    }
  }

  updateCharacterCount() {
    $('lyrics-count').textContent = `${Array.from($('an-lyrics').value).length.toLocaleString('zh-CN')} 字`;
  }

  fillExample() {
    $('an-title').value = '清晨的回声';
    $('an-artist').value = '音绪 · 原创示例';
    $('an-lyrics').value = '昨夜的风带走一片忧伤\n孤独的路灯守着旧时光\n我把失落轻轻放在窗旁\n等待清晨照亮新的方向\n\n阳光落在你微笑的脸庞\n温暖与希望在心里生长\n我们带着勇气继续远航\n让快乐和爱成为新的篇章';
    this.updateCharacterCount();
    this.setStatus('analysis-status', '原创示例已填入，尚未保存。点击“分析并保存到曲库”开始体验。');
    $('analysis-workspace').scrollIntoView({ behavior: this.scrollBehavior() });
    $('an-title').focus({ preventScroll: true });
  }

  async analyzeManual() {
    if ($('analyze-submit').disabled || !$('analysis-form').reportValidity()) return;
    const payload = { title: $('an-title').value.trim(), artist: $('an-artist').value.trim(), lyrics: $('an-lyrics').value.trim() };
    if (!payload.title || !payload.artist || !payload.lyrics) {
      this.setStatus('analysis-status', '歌曲名称、创作者和歌词不能只包含空格。', 'error');
      return;
    }
    this.setBusy('analyze-submit', true);
    this.setStatus('analysis-status', '正在分析情感与词汇，并保存到曲库…', 'loading');
    document.querySelector('.result-panel').setAttribute('aria-busy', 'true');
    try {
      const data = await this.request('/add_song', { method: 'POST', body: JSON.stringify(payload), timeout: 45000 });
      const song = data.song || { ...payload, ...data, id: data.id ?? data.song_id };
      if (!song.analysis) throw new Error('歌曲已提交，但没有收到分析结果。请刷新曲库查看。');
      this.displayAnalysis(song);
      this.setStatus('analysis-status', `《${song.title}》已分析并保存到曲库。`, 'success');
      this.toast('分析完成，已保存到我的曲库');
      await this.refreshData();
    } catch (error) {
      this.setStatus('analysis-status', error.message, 'error');
    } finally {
      this.setBusy('analyze-submit', false);
      document.querySelector('.result-panel').setAttribute('aria-busy', 'false');
    }
  }

  displayAnalysis(song) {
    const analysis = song.analysis;
    if (!analysis) return;
    $('analysis-placeholder').hidden = true;
    $('analysis-content').hidden = false;
    $('result-state-label').textContent = '已完成分析';
    $('result-title').textContent = song.title || '未命名歌曲';
    $('result-artist').textContent = song.artist || '未知创作者';
    setSentiment($('result-sentiment'), song.sentiment || analysis.consensus_sentiment);
    $('res-polarity').textContent = songPolarity(song).toFixed(2);
    const subjectiveSupported = analysis.textblob?.supported !== false && analysis.textblob?.available !== false;
    $('res-subjectivity').textContent = subjectiveSupported ? number(analysis.textblob?.subjectivity).toFixed(2) : '不适用';
    $('res-subjectivity').style.fontSize = subjectiveSupported ? '' : '18px';
    $('res-diversity').textContent = percent(analysis.lexical?.lexical_diversity);
    $('res-word-count').textContent = `${number(analysis.lexical?.word_count)} 词 / ${number(analysis.lexical?.unique_words)} 种`;
    $('res-lexicon').textContent = number(analysis.lexicon?.score).toFixed(3);
    $('res-positive-ratio').textContent = percent(analysis.lexicon?.positive_ratio);
    $('res-negative-ratio').textContent = percent(analysis.lexicon?.negative_ratio);
    $('res-density').textContent = percent(analysis.emotion_intensity?.emotion_density);
    const language = { zh: '中文', en: '英文', ko: '韩文', mixed: '混合语言', unknown: '未识别语言' }[analysis.metadata?.language] || '旧版分析记录';
    const method = { 'textblob+lexicon': 'TextBlob 英文分析 + 基础情感词典', lexicon: '基础情感词典分析' }[analysis.metadata?.method] || 'TextBlob 与词典分析';
    const limitations = Array.isArray(analysis.metadata?.limitations) ? analysis.metadata.limitations.join('；') : '';
    $('analysis-method').textContent = `${language} · ${method}${limitations ? `。${limitations}` : ''}`;
    this.renderChart(analysis.line_analysis || []);
    this.renderWords(analysis.lexical?.top_words || []);
  }

  renderChart(lines) {
    const points = Array.isArray(lines) ? lines.filter((line) => Number.isFinite(Number(line.polarity))) : [];
    const container = $('sentiment-chart');
    container.replaceChildren();
    $('line-count').textContent = `${points.length} 句歌词`;
    if (!points.length) {
      container.append(element('p', 'chart-empty', '这条记录没有逐句数据，可在工作台重新分析。'));
      $('chart-summary').textContent = '无可用逐句情感数据。';
      return;
    }
    const width = 460, height = 150, left = 31, right = 12, top = 12, bottom = 28;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const x = (index) => left + (points.length === 1 ? plotWidth / 2 : index * plotWidth / (points.length - 1));
    const y = (value) => top + (1 - clamp(value, -1, 1)) * plotHeight / 2;
    const chart = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': 'chart-title chart-desc' });
    chart.append(svgElement('title', { id: 'chart-title' }, '逐句歌词情感轨迹'));
    chart.append(svgElement('desc', { id: 'chart-desc' }, `共 ${points.length} 句歌词，纵轴从负一到正一，数值越高表示文字越积极。`));
    const defs = svgElement('defs');
    const gradient = svgElement('linearGradient', { id: 'chart-fill', x1: '0', y1: '0', x2: '0', y2: '1' });
    gradient.append(svgElement('stop', { offset: '0%', 'stop-color': '#c6f36b', 'stop-opacity': '.17' }), svgElement('stop', { offset: '100%', 'stop-color': '#c6f36b', 'stop-opacity': '0' }));
    defs.append(gradient); chart.append(defs);
    for (const value of [1, 0, -1]) {
      chart.append(svgElement('line', { x1: left, y1: y(value), x2: width - right, y2: y(value), class: 'chart-grid' }));
      chart.append(svgElement('text', { x: left - 9, y: y(value) + 3, 'text-anchor': 'end' }, value > 0 ? '+1' : String(value)));
    }
    // Keep rendering bounded for long lyrics; retain the original line positions.
    const indexes = points.length <= 250 ? points.map((_, index) => index) : Array.from({ length: 250 }, (_, index) => Math.round(index * (points.length - 1) / 249));
    const path = indexes.map((index, position) => `${position ? 'L' : 'M'}${x(index).toFixed(2)},${y(points[index].polarity).toFixed(2)}`).join(' ');
    if (points.length > 1) {
      chart.append(svgElement('path', { d: `${path} L${x(points.length - 1)},${height - bottom} L${x(0)},${height - bottom} Z`, fill: 'url(#chart-fill)' }));
      chart.append(svgElement('path', { d: path, class: 'chart-line' }));
    }
    if (points.length <= 24) points.forEach((point, index) => {
      const circle = svgElement('circle', { cx: x(index), cy: y(point.polarity), r: points.length === 1 ? 4 : 2.5, class: 'chart-point' });
      circle.append(svgElement('title', {}, `第 ${index + 1} 句：${point.text || ''}（${number(point.polarity).toFixed(2)}）`));
      chart.append(circle);
    });
    chart.append(svgElement('text', { x: left, y: height - 5 }, '第 1 句'));
    if (points.length > 1) chart.append(svgElement('text', { x: width - right, y: height - 5, 'text-anchor': 'end' }, `第 ${points.length} 句`));
    container.append(chart);
    const positive = points.filter((point) => number(point.polarity) > 0.05).length;
    const negative = points.filter((point) => number(point.polarity) < -0.05).length;
    $('chart-summary').textContent = `${points.length} 句歌词中，积极 ${positive} 句，消极 ${negative} 句，中性 ${points.length - positive - negative} 句。`;
  }

  renderWords(words) {
    $('top-words').replaceChildren();
    if (!Array.isArray(words) || !words.length) {
      $('top-words').append(element('p', 'field-help', '没有可展示的高频词。'));
      return;
    }
    words.slice(0, 8).forEach((word) => {
      const tag = element('span', 'word-tag', word.text || word.word || '');
      tag.append(element('small', '', `×${number(word.value ?? word.count)}`));
      $('top-words').append(tag);
    });
  }

  getCrawlInput() {
    if (!$('crawler-form').reportValidity()) return null;
    const song = { artist: $('cr-artist').value.trim(), title: $('cr-title').value.trim() };
    if (!song.artist || !song.title) { this.setStatus('crawler-status', '歌手和歌曲名称不能只包含空格。', 'error'); return null; }
    return song;
  }

  async crawlSong() {
    if ($('crawl-submit').disabled) return;
    const song = this.getCrawlInput();
    if (!song) return;
    this.setBusy('crawl-submit', true);
    this.setStatus('crawler-status', '正在查询歌词来源，获取后将自动分析保存…', 'loading');
    try {
      const data = await this.request('/professional/crawl', { method: 'POST', body: JSON.stringify(song), timeout: 65000 });
      if (data.status !== 'success') throw new Error(data.error || '未能获取歌词，请尝试手动导入。');
      this.setStatus('crawler-status', `《${data.song?.title || data.title || song.title}》已采集、分析并保存。`, 'success');
      this.toast('歌词采集完成，已加入曲库');
      await this.refreshData();
    } catch (error) {
      this.setStatus('crawler-status', error.message, 'error');
    } finally {
      this.setBusy('crawl-submit', false);
    }
  }

  addToQueue() {
    if (this.queueRunning) return;
    const song = this.getCrawlInput();
    if (!song) return;
    if (this.queue.length >= 30) { this.setStatus('crawler-status', '队列最多 30 首，请先清空已完成的队列。', 'error'); return; }
    const normalize = (value) => value.trim().toLocaleLowerCase();
    if (this.queue.some((item) => normalize(item.artist) === normalize(song.artist) && normalize(item.title) === normalize(song.title))) {
      this.setStatus('crawler-status', '这首歌已经在队列中。', 'error'); return;
    }
    this.queue.push({ ...song, state: 'pending', error: '', songId: null });
    this.renderQueue();
    this.setStatus('crawler-status', `《${song.title}》已加入队列，尚未开始采集。`, 'success');
    $('cr-title').value = '';
    $('cr-title').focus();
  }

  renderQueue() {
    $('queue-count').textContent = String(this.queue.length);
    const succeeded = this.queue.filter((item) => item.state === 'success').length;
    const failed = this.queue.filter((item) => item.state === 'failed').length;
    const done = succeeded + failed;
    const pending = this.queue.filter((item) => item.state === 'pending').length;
    $('queue-progress').max = this.queue.length || 1;
    $('queue-progress').value = done;
    $('start-queue').disabled = this.queueRunning || !pending;
    $('clear-queue').disabled = this.queueRunning || !this.queue.length;
    $('add-to-queue').disabled = this.queueRunning;
    $('stop-queue').disabled = !this.queueRunning || this.stopRequested;
    const progress = `${done}/${this.queue.length} 完成 · ${succeeded} 成功 · ${failed} 失败`;
    $('queue-summary').textContent = !this.queue.length ? '尚未开始' : this.stopRequested && this.queueRunning ? '停止中，等待当前项完成…' : progress;
    const list = $('queue-list');
    list.replaceChildren();
    if (!this.queue.length) {
      const item = element('li'); item.append(emptyState('建立你的采集清单', '输入歌曲并添加到队列，每首歌将依次执行。', 'library')); list.append(item); return;
    }
    this.queue.forEach((song, index) => {
      const row = element('li', 'queue-item');
      row.append(element('span', 'queue-number', String(index + 1).padStart(2, '0')));
      const text = element('div', 'queue-text');
      text.append(element('strong', '', song.title), element('span', '', song.artist));
      if (song.error) text.append(element('span', 'queue-error', song.error));
      row.append(text);
      row.append(element('span', `queue-state ${song.state}`, { pending: '等待采集', running: '正在采集…', success: '已保存', failed: '采集失败' }[song.state]));
      if (song.state === 'failed' && !this.queueRunning) {
        row.append(actionButton('重试', 'text-button small', () => { song.state = 'pending'; song.error = ''; this.renderQueue(); }));
      }
      if (!this.queueRunning) {
        const remove = actionButton('', 'icon-button', () => { this.queue.splice(index, 1); this.renderQueue(); });
        remove.setAttribute('aria-label', `从队列移除 ${song.title}`); remove.title = '从队列移除'; remove.append(icon('close')); row.append(remove);
      }
      list.append(row);
    });
  }

  stopQueue() {
    if (!this.queueRunning) return;
    this.stopRequested = true;
    this.renderQueue();
  }

  async runQueue() {
    if (this.queueRunning || !this.queue.some((song) => song.state === 'pending')) return;
    this.queueRunning = true;
    this.stopRequested = false;
    this.renderQueue();
    try {
      for (const song of this.queue) {
        if (this.stopRequested) break;
        if (song.state !== 'pending') continue;
        song.state = 'running';
        this.renderQueue();
        try {
          const data = await this.request('/professional/crawl', { method: 'POST', body: JSON.stringify({ title: song.title, artist: song.artist }), timeout: 65000 });
          if (data.status !== 'success') throw new Error(data.error || '未能获取歌词');
          song.state = 'success';
          song.songId = data.song?.id ?? data.song_id ?? data.id;
        } catch (error) {
          song.state = 'failed';
          song.error = error.message;
        }
        this.renderQueue();
      }
    } finally {
      const stopped = this.stopRequested;
      this.queueRunning = false;
      this.stopRequested = false;
      this.renderQueue();
      if (stopped && this.queue.some((song) => song.state === 'pending')) {
        this.toast('已停止后续采集，待处理歌曲可以继续运行');
      } else {
        const failures = this.queue.filter((song) => song.state === 'failed').length;
        this.toast(failures ? `队列已结束，${failures} 首采集失败，请查看原因` : '队列已完成，所有歌曲已保存', failures > 0);
      }
      await this.refreshData();
    }
  }

  libraryMessage(text, error = false) {
    const row = element('tr', 'library-empty');
    const cell = element('td'); cell.colSpan = 5;
    const empty = emptyState(error ? '曲库暂时无法加载' : '还没有找到这段共鸣', text, 'library');
    if (error) empty.append(actionButton('重新加载', 'button secondary compact', () => this.loadLibrary()));
    else if (!$('library-search').value && !$('library-sentiment').value) empty.append(actionButton('添加第一首歌曲', 'button primary compact', () => this.navigate('analyze')));
    cell.append(empty); row.append(cell);
    $('library-table-body').replaceChildren(row);
  }

  async loadLibrary() {
    const sequence = ++this.librarySequence;
    const params = new URLSearchParams({ q: $('library-search').value.trim(), sentiment: $('library-sentiment').value, sort: $('library-sort').value, page: String(this.page), per_page: String(this.perPage) });
    $('previous-page').disabled = true; $('next-page').disabled = true;
    this.setStatus('library-status', '');
    const row = element('tr'); const cell = element('td', 'loading-row'); cell.colSpan = 5;
    cell.append(element('span', 'loading-indicator', '正在读取曲库…')); row.append(cell); $('library-table-body').replaceChildren(row);
    try {
      const data = await this.request(`/library?${params}`);
      if (sequence !== this.librarySequence) return;
      this.totalSongs = number(data.total, 0);
      this.totalPages = Math.max(1, number(data.total_pages, Math.ceil(this.totalSongs / this.perPage)));
      if (this.page > this.totalPages) { this.page = this.totalPages; return this.loadLibrary(); }
      const songs = Array.isArray(data.songs) ? data.songs : [];
      this.renderLibrary(songs);
      $('library-total').textContent = `共 ${this.totalSongs.toLocaleString('zh-CN')} 首${$('library-search').value || $('library-sentiment').value ? '匹配歌曲' : '歌曲'}`;
      $('page-label').textContent = `${this.page} / ${this.totalPages}`;
      $('previous-page').disabled = this.page <= 1;
      $('next-page').disabled = this.page >= this.totalPages;
      this.setStatus('library-status', songs.length ? `已载入第 ${(this.page - 1) * this.perPage + 1}–${(this.page - 1) * this.perPage + songs.length} 首歌曲。` : '');
    } catch (error) {
      if (sequence !== this.librarySequence) return;
      this.libraryMessage(error.message, true);
      $('library-total').textContent = '读取失败';
      this.setStatus('library-status', error.message, 'error');
    }
  }

  renderLibrary(songs) {
    $('library-table-body').replaceChildren();
    if (!songs.length) { this.libraryMessage($('library-search').value || $('library-sentiment').value ? '试试其他歌名、歌手或情绪筛选。' : '分析一首歌词，或者从在线来源采集歌曲，开启你的曲库。'); return; }
    const fragment = document.createDocumentFragment();
    songs.forEach((song, index) => {
      const row = element('tr');
      row.append(element('td', 'track-index', String((this.page - 1) * this.perPage + index + 1).padStart(2, '0')));
      const songCell = element('td');
      const content = element('div', 'song-cell');
      const art = element('span', `track-art tone-${index % 4}`); art.append(icon('music')); art.setAttribute('aria-hidden', 'true');
      const names = element('div');
      const title = actionButton(song.title || '未命名歌曲', 'song-title-button', () => this.viewSong(song.id));
      title.setAttribute('aria-label', `查看 ${song.title} 的详情`);
      names.append(title, element('p', '', song.artist || '未知创作者')); content.append(art, names); songCell.append(content); row.append(songCell);
      const emotion = element('td'); const badge = element('span'); setSentiment(badge, song.sentiment || song.analysis?.consensus_sentiment); emotion.append(badge); row.append(emotion);
      row.append(element('td', 'polarity-cell', song.analysis ? `${songPolarity(song) > 0 ? '+' : ''}${songPolarity(song).toFixed(2)}` : '—'));
      const actions = element('td', 'action-cell'); const buttons = element('div', 'row-actions');
      const view = actionButton('详情', 'text-button', () => this.viewSong(song.id)); view.setAttribute('aria-label', `查看 ${song.title} 的详情`);
      const remove = actionButton('', 'icon-button', () => this.askDelete(song)); remove.append(icon('trash')); remove.title = '删除歌曲'; remove.setAttribute('aria-label', `删除 ${song.title}`);
      buttons.append(view, remove); actions.append(buttons); row.append(actions); fragment.append(row);
    });
    $('library-table-body').append(fragment);
  }

  async viewSong(id) {
    if (id === undefined || id === null) { this.toast('这条记录缺少歌曲编号，请刷新曲库。', true); return; }
    const sequence = ++this.detailSequence;
    try {
      const data = await this.request(`/songs/${encodeURIComponent(id)}`);
      if (sequence !== this.detailSequence) return;
      this.currentSong = data.song || data;
      const song = this.currentSong;
      $('dialog-song-title').textContent = song.title || '未命名歌曲';
      $('dialog-song-artist').textContent = song.artist || '未知创作者';
      $('dialog-song-lyrics').textContent = song.lyrics || '这条记录没有歌词。';
      setSentiment($('dialog-song-sentiment'), song.sentiment || song.analysis?.consensus_sentiment);
      const source = song.source || '手动导入';
      $('dialog-song-source').textContent = `来源：${source === 'manual' ? '手动导入' : source}`;
      $('dialog-analysis').textContent = song.analysis ? '查看完整分析 →' : '前往工作台分析 →';
      $('dialog-recommend').disabled = !song.analysis;
      if (!$('song-dialog').open) $('song-dialog').showModal();
      $('dialog-song-lyrics').scrollTop = 0;
    } catch (error) { if (sequence === this.detailSequence) this.toast(error.message, true); }
  }

  openCurrentAnalysis() {
    const song = this.currentSong;
    if (!song) return;
    $('song-dialog').close();
    $('an-title').value = song.title || '';
    $('an-artist').value = song.artist || '';
    $('an-lyrics').value = song.lyrics || '';
    this.updateCharacterCount();
    if (song.analysis) this.displayAnalysis(song);
    else {
      $('analysis-placeholder').hidden = false;
      $('analysis-content').hidden = true;
      $('result-state-label').textContent = '等待输入';
    }
    this.setStatus('analysis-status', song.analysis ? '正在查看曲库中的已保存分析；修改歌词后可以重新分析。' : '歌曲已填入，点击“分析并保存到曲库”生成结果。');
    this.navigate('analyze');
    window.requestAnimationFrame(() => { $('analysis-workspace').scrollIntoView({ behavior: this.scrollBehavior() }); $('an-title').focus({ preventScroll: true }); });
  }

  recommendCurrentSong() {
    const song = this.currentSong;
    if (!song?.id) return;
    $('song-dialog').close();
    const select = $('rec-target-song');
    this.pickerSequence++;
    select.disabled = false;
    $('recommend-search').value = '';
    if (!Array.from(select.options).some((option) => option.value === String(song.id))) {
      const option = element('option', '', `${song.title} · ${song.artist}`); option.value = String(song.id); select.append(option);
    }
    select.value = String(song.id);
    this.recommendationSequence++;
    this.setBusy('recommend-submit', false);
    this.navigate('recommend');
    this.getRecommendations();
  }

  askDelete(song) {
    this.pendingDelete = song;
    $('delete-description').textContent = `确定删除《${song.title}》 · ${song.artist || '未知创作者'} 吗？`;
    this.setStatus('delete-status', '');
    $('delete-dialog').showModal();
    $('cancel-delete').focus();
  }

  async deleteSong() {
    const song = this.pendingDelete;
    if (!song || $('confirm-delete').disabled) return;
    this.setBusy('confirm-delete', true);
    $('cancel-delete').disabled = true;
    try {
      await this.request(`/songs/${encodeURIComponent(song.id)}`, { method: 'DELETE' });
      $('delete-dialog').close();
      this.pendingDelete = null;
      this.toast(`已从曲库删除《${song.title}》`);
      await this.refreshData();
    } catch (error) {
      this.setStatus('delete-status', error.message, 'error');
    } finally {
      this.setBusy('confirm-delete', false);
      $('cancel-delete').disabled = false;
    }
  }

  async exportLibrary() {
    if ($('export-library').disabled) return;
    this.setBusy('export-library', true);
    try {
      const data = await this.request('/export', { timeout: 45000 });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = element('a'); link.href = url;
      const now = new Date();
      link.download = `yinyue-library-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.json`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.toast('曲库 JSON 已导出');
    } catch (error) { this.toast(error.message, true); }
    finally { this.setBusy('export-library', false); }
  }

  async loadSongPicker() {
    const sequence = ++this.pickerSequence;
    const select = $('rec-target-song');
    const selectedId = select.value;
    const query = $('recommend-search').value.trim();
    const params = new URLSearchParams({ q: query, sort: 'recent', page: '1', per_page: '100' });
    select.disabled = true;
    try {
      const data = await this.request(`/library?${params}`);
      if (sequence !== this.pickerSequence) return;
      const entries = Array.isArray(data.songs) ? [...data.songs] : [];
      const pages = Math.max(1, number(data.total_pages, Math.ceil(number(data.total) / 100)));
      for (let page = 2; page <= pages; page++) {
        params.set('page', String(page));
        const next = await this.request(`/library?${params}`);
        if (sequence !== this.pickerSequence) return;
        if (Array.isArray(next.songs)) entries.push(...next.songs);
      }
      const songs = Array.from(new Map(entries.filter((song) => song.analysis).map((song) => [song.id, song])).values());
      select.replaceChildren();
      const placeholder = element('option', '', songs.length ? '选择一首参考歌曲' : query ? '没有找到已分析歌曲' : '曲库中还没有已分析歌曲'); placeholder.value = ''; select.append(placeholder);
      songs.forEach((song) => {
        const option = element('option', '', `${song.title} · ${song.artist || '未知创作者'}`); option.value = String(song.id); select.append(option);
      });
      if (songs.some((song) => String(song.id) === selectedId)) select.value = selectedId;
      else if (selectedId) {
        this.recommendationSequence++;
        this.setBusy('recommend-submit', false);
        this.setStatus('recommend-status', '请从当前结果中重新选择参考歌曲。');
        $('recommendation-results').replaceChildren(emptyState('等待新的参考歌曲', '选择一首歌曲，探索相似情绪的作品。', 'discover'));
      }
      $('recommend-picker-help').textContent = `找到 ${songs.length} 首已分析歌曲。可通过歌名或歌手搜索整个曲库。`;
    } catch (error) {
      if (sequence !== this.pickerSequence) return;
      this.recommendationSequence++;
      this.setBusy('recommend-submit', false);
      select.replaceChildren();
      const placeholder = element('option', '', '歌曲列表读取失败'); placeholder.value = ''; select.append(placeholder);
      this.setStatus('recommend-status', error.message, 'error');
      $('recommendation-results').replaceChildren(emptyState('歌曲列表暂时不可用', '重新搜索或检查服务连接后再试。', 'info'));
    } finally {
      if (sequence === this.pickerSequence) select.disabled = false;
    }
  }

  async getRecommendations() {
    if ($('recommend-submit').disabled) return;
    if ($('rec-target-song').disabled) { this.setStatus('recommend-status', '歌曲列表正在加载，请稍候。'); return; }
    const id = Number($('rec-target-song').value);
    if (!Number.isInteger(id) || id <= 0) { this.setStatus('recommend-status', '请先从曲库选择一首已分析歌曲。', 'error'); return; }
    const sequence = ++this.recommendationSequence;
    this.setBusy('recommend-submit', true);
    this.setStatus('recommend-status', '正在比较曲库中的歌词情绪特征…', 'loading');
    $('recommendation-results').replaceChildren(emptyState('正在寻找相似的情绪', '将比较情感极性、词汇多样性与情感词密度。', 'discover'));
    try {
      const data = await this.request('/recommend', { method: 'POST', body: JSON.stringify({ song_id: id, top_k: 5 }) });
      if (sequence !== this.recommendationSequence) return;
      const songs = Array.isArray(data.recommendations) ? data.recommendations : [];
      $('recommendation-results').replaceChildren();
      if (!songs.length) {
        $('recommendation-results').append(emptyState('还需要更多可以共鸣的歌曲', '曲库中暂时没有其他可推荐作品，先添加更多歌词吧。', 'discover'));
      } else {
        songs.forEach((song, index) => {
          const card = element('article', 'recommendation-item');
          const art = element('span', `track-art tone-${index % 4}`); art.append(icon('music')); art.setAttribute('aria-hidden', 'true');
          const copy = element('div', 'recommendation-copy'); copy.append(element('h3', '', song.title), element('p', '', song.artist || '未知创作者'));
          const score = element('div', 'match-score', percent(song.similarity)); score.append(element('small', '', '文本特征相似度'));
          const view = actionButton('', 'icon-button', () => this.viewSong(song.id)); view.setAttribute('aria-label', `查看 ${song.title} 的分析`); view.title = '查看分析'; view.append(icon('arrow'));
          card.append(art, copy, score, view); $('recommendation-results').append(card);
        });
      }
      this.setStatus('recommend-status', `已找到 ${songs.length} 首相似歌曲。`, 'success');
    } catch (error) {
      if (sequence !== this.recommendationSequence) return;
      this.setStatus('recommend-status', error.message, 'error');
      $('recommendation-results').replaceChildren(emptyState('这次发现暂时中断', '请根据左侧提示调整，或者稍后重试。', 'info'));
    } finally { if (sequence === this.recommendationSequence) this.setBusy('recommend-submit', false); }
  }
}

window.app = new LyricAnalyzerApp();
