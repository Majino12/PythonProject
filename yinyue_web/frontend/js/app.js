'use strict';

// All API data is inserted with textContent or DOM nodes, never parsed as markup.
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_LABELS = { analyze: '分析工作台', audio: '音频识词', search: '歌曲搜索', crawler: '歌词采集', library: '我的曲库', recommend: '相似发现' };
const SENTIMENT_LABELS = { positive: '积极', neutral: '中性', negative: '消极', uncertain: '倾向不明确', mixed: '混合情绪', unanalyzed: '待分析' };
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
    this.displayedSong = null;
    this.reanalyzingIds = new Set();
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
    $('dialog-reanalyze').addEventListener('click', () => this.reanalyzeSong(this.currentSong, 'dialog'));
    $('result-reanalyze').addEventListener('click', () => this.reanalyzeSong(this.displayedSong, 'result'));
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
    const view = Object.hasOwn(VIEW_LABELS, hash) && $(`view-${hash}`) ? hash : 'analyze';
    for (const key of Object.keys(VIEW_LABELS)) {
      const section = $(`view-${key}`);
      if (section) section.hidden = key !== view;
    }
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
      const health = await this.request('/health', { timeout: 10000 });
      if (sequence !== this.connectionSequence) return;
      $('connection-label').textContent = '本地服务已连接';
      $('connection-dot').classList.add('connected');
      $('connection-dot').setAttribute('title', '本地服务已连接');
      this.renderModelStatus(health.models);
    } catch (error) {
      if (sequence !== this.connectionSequence) return;
      $('connection-label').textContent = '服务连接异常';
      $('connection-dot').classList.add('offline');
      $('connection-dot').setAttribute('title', error.message);
      $('model-status').textContent = '暂时无法确认模型状态，请重新检查服务连接。';
      this.toast(error.message, true);
    }
  }

  renderModelStatus(models) {
    const container = $('model-status');
    container.replaceChildren();
    const labels = { ready: '专用模型已就绪', missing: '模型未安装 · 使用词典回退', disabled: '模型已停用 · 使用词典回退', error: '模型加载异常 · 使用词典回退' };
    if (!models || typeof models !== 'object') {
      container.textContent = '服务尚未提供专用模型状态；每次分析采用的方法会显示在结果中。';
      return;
    }
    for (const [language, title] of [['zh', '中文'], ['ko', '韩文']]) {
      const model = models[language];
      const row = element('span', `model-status-item ${model?.status === 'ready' ? 'ready' : 'fallback'}`);
      row.append(element('i', 'model-status-dot'), document.createTextNode(`${title}：${labels[model?.status] || '状态待确认'}`));
      if (model?.model) row.title = model.model;
      container.append(row);
    }
    const emotion = models.emotion;
    const emotionLabels = { ready: '十维模型已就绪', missing: '模型未安装', disabled: '模型已停用', error: '模型暂不可用' };
    const emotionRow = element('span', `model-status-item ${emotion?.status === 'ready' ? 'ready' : 'fallback'}`);
    emotionRow.append(element('i', 'model-status-dot'), document.createTextNode(`情绪画像：${emotionLabels[emotion?.status] || '状态待确认'}`));
    if (emotion?.model) emotionRow.title = emotion.model;
    container.append(emotionRow);
    container.append(element('span', 'model-status-note', '歌词在本机分析，首次运行可能稍慢。'));
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
      $('stat-other-emotions').textContent = `另有 ${number(distribution.uncertain).toLocaleString('zh-CN')} 首倾向不明确 · ${number(distribution.mixed).toLocaleString('zh-CN')} 首混合情绪。倾向不明确不等于中性。`;
    } catch (error) {
      if (sequence !== this.statsSequence) return;
      for (const id of ['stat-total', 'stat-positive', 'stat-neutral', 'stat-negative']) {
        $(id).textContent = '—';
        $(id).title = error.message;
      }
      $('stat-other-emotions').textContent = '';
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
      const data = await this.request('/add_song', { method: 'POST', body: JSON.stringify(payload), timeout: 120000 });
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
    this.displayedSong = song;
    $('result-reanalyze').hidden = song.id === undefined || song.id === null;
    this.setBusy('result-reanalyze', this.reanalyzingIds.has(String(song.id)));
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
    const method = { transformer: '专用神经网络情感模型', hybrid: '按语言组合模型与基础分析', 'textblob+lexicon': 'TextBlob 英文分析 + 基础情感词典', lexicon: '基础情感词典分析' }[analysis.metadata?.method] || '旧版 TextBlob 与词典分析';
    const limitations = Array.isArray(analysis.metadata?.limitations) ? analysis.metadata.limitations.join('；') : '';
    $('analysis-method').textContent = `${language} · ${method}${limitations ? `。${limitations}` : ''}`;
    this.renderModelAnalysis(analysis);
    this.renderEmotions(analysis.emotions);
    this.renderChart(analysis.line_analysis || []);
    this.renderWords(analysis.lexical?.top_words || []);
  }

  renderModelAnalysis(analysis) {
    const model = analysis.model_sentiment;
    const container = $('model-analysis');
    const sources = $('model-sources');
    container.replaceChildren();
    sources.replaceChildren();
    const models = Array.isArray(analysis.metadata?.models) ? [...analysis.metadata.models] : [];
    if (!models.length && model?.model) models.push({ model: model.model, revision: model.revision });
    for (const source of models) {
      if (!source || typeof source.model !== 'string') continue;
      const row = element('div', 'model-source');
      const language = { zh: '中文', ko: '韩文' }[source.language];
      row.append(element('span', '', language ? `${language}模型` : '模型来源'));
      // Model IDs are data, not arbitrary URLs. Only link valid Hugging Face repo IDs.
      if (/^[\w.-]+\/[\w.-]+$/.test(source.model)) {
        const link = element('a', '', source.model);
        link.href = `https://huggingface.co/${source.model}`;
        link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link);
      } else row.append(element('span', '', source.model));
      if (source.revision) row.append(element('small', '', `版本 ${String(source.revision).slice(0, 12)}`));
      sources.append(row);
    }
    if (model?.available && model.probabilities && Number.isFinite(Number(model.confidence))) {
      const heading = element('div', 'model-confidence-heading');
      heading.append(element('span', '', '模型预测置信度'), element('strong', '', percent(model.confidence)));
      const bar = element('div', 'model-probability-bar');
      const positive = element('span', 'positive');
      positive.style.width = percent(model.probabilities.positive);
      bar.append(positive);
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', `积极概率 ${percent(model.probabilities.positive)}，消极概率 ${percent(model.probabilities.negative)}`);
      const values = element('div', 'model-probability-values');
      values.append(element('span', '', `积极 ${percent(model.probabilities.positive)}`), element('span', '', `消极 ${percent(model.probabilities.negative)}`));
      container.append(heading, bar, values, element('p', 'field-help', '置信度是模型对本次预测的倾向，并非准确率。模型只区分积极与消极；“倾向不明确”表示证据不足，不代表中性。'));
      if (number(model.chunk_count) > 1) container.append(element('p', 'field-help', `长歌词已分为 ${number(model.chunk_count)} 段分析并汇总。`));
    } else if (analysis.metadata?.method === 'hybrid') {
      container.append(element('p', 'model-analysis-note', '本次按歌词语言分别分析并汇总，请展开分析依据查看使用的模型与限制。'));
    } else if (['zh', 'ko', 'mixed'].includes(analysis.metadata?.language)) {
      container.append(element('p', 'model-analysis-note', '这条记录使用了基础词典分析。专用模型就绪后，可点击“重新分析”更新结果。'));
    } else {
      container.append(element('p', 'model-analysis-note', '本次结果来自基础文本分析；专用神经网络模型用于中文和韩文歌词。'));
    }
  }

  renderEmotions(emotions) {
    const container = $('emotion-profile');
    if (!container) return;
    container.replaceChildren();
    const heading = element('div', 'chart-heading emotion-heading');
    const title = element('h4', '', '十维情绪画像');
    title.id = 'emotion-heading';
    heading.append(title, element('span', 'small-label', '语义匹配'));
    container.append(heading);
    const scores = Array.isArray(emotions?.scores) ? emotions.scores
      .filter((row) => row && typeof row.label === 'string' && Number.isFinite(Number(row.score)))
      .sort((left, right) => Number(number(right.evidence) >= 0.35) - Number(number(left.evidence) >= 0.35) || number(right.score) - number(left.score)) : [];
    if (!emotions?.available || !scores.length) {
      container.append(element('p', 'field-help', emotions
        ? '多维情绪模型当前不可用。上方情感倾向仍可使用；模型就绪后可重新分析。'
        : '这条记录尚未生成十维情绪画像。点击“重新分析”，使用当前模型补充结果。'));
      return;
    }
    container.append(element('p', 'emotion-intro', '情绪可以共存。下列分数是独立语义匹配度，不相加为 100%，也不是置信度或准确率。'));
    if (number(emotions.tokens_total) > 0 && number(emotions.tokens_total) < 24) {
      container.append(element('p', 'emotion-transfer-note', '这段文字较短，可用语义线索有限，主导情绪也可能不稳定。建议补充完整歌词后再分析。'));
    }
    const dominant = Array.isArray(emotions.dominant) ? emotions.dominant.filter((row) => row && typeof row.name_zh === 'string') : [];
    const tags = element('div', 'emotion-dominant');
    if (dominant.length) {
      tags.append(element('span', 'emotion-dominant-label', '主要表达'));
      for (const row of dominant.slice(0, 3)) tags.append(element('span', 'emotion-tag', row.name_zh));
    } else tags.append(element('p', 'emotion-uncertain', '主导情绪证据不足，请结合原文解读。'));
    container.append(tags);
    const labels = { joy: '喜悦', sadness: '悲伤', anger: '愤怒', fear: '恐惧', love: '爱恋', longing: '思念', hope: '希望', calm: '平静', loneliness: '孤独', nostalgia: '怀旧' };
    const grid = element('div', 'emotion-grid');
    for (const row of scores.slice(0, 10)) {
      const score = clamp(row.score, 0, 1);
      const supported = number(row.evidence) >= 0.35;
      const name = labels[row.label] || row.name_zh || row.label;
      const item = element('div', `emotion-item${supported ? '' : ' low-support'}`);
      const label = element('div', 'emotion-label');
      label.append(element('span', '', name), element('strong', '', supported ? percent(score) : '支持不足'));
      const bar = element('div', 'emotion-bar');
      const fill = element('span', '');
      fill.style.width = supported ? percent(score) : '0%';
      bar.append(fill);
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', supported ? `${name}语义匹配度 ${percent(score)}` : `${name}支持不足，未展示匹配度`);
      item.append(label, bar, element('small', 'emotion-support', supported ? '有语义支持' : '缺少蕴含证据'));
      grid.append(item);
    }
    container.append(grid);
    const coverage = clamp(emotions.coverage, 0, 1);
    const coverageNote = coverage >= 1
      ? `已分析全文 · ${number(emotions.chunk_count, 1)} 个片段`
      : `长文本片段采样 · 覆盖 ${percent(coverage)} 的词元 · ${number(emotions.chunk_count)} 个片段，未覆盖内容可能表达不同情绪`;
    container.append(element('p', 'emotion-coverage', coverageNote));
    const details = element('details', 'emotion-details');
    details.append(element('summary', '', '模型来源与解读提示'));
    const source = element('div', 'model-source');
    source.append(element('span', '', '多语 NLI 模型'));
    if (typeof emotions.model === 'string' && /^[\w.-]+\/[\w.-]+$/.test(emotions.model)) {
      const link = element('a', '', emotions.model);
      link.href = `https://huggingface.co/${emotions.model}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      source.append(link);
    }
    if (emotions.revision) source.append(element('small', '', `版本 ${String(emotions.revision).slice(0, 12)}`));
    details.append(source, element('p', 'field-help', '“支持不足”表示模型对该情绪的蕴含证据较弱，即使匹配度较高，也不宜据此判断歌词情绪。'));
    if (Array.isArray(emotions.warnings)) {
      for (const warning of emotions.warnings) if (typeof warning === 'string') details.append(element('p', 'field-help', warning));
    }
    container.append(details);
    if (['ko', 'mixed'].includes(emotions.language)) container.append(element('p', 'emotion-transfer-note', '韩文情绪画像使用跨语言迁移，尚未在韩文歌词情绪数据上验证。'));
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
      const label = point.sentiment ? ` · ${SENTIMENT_LABELS[sentimentKey(point.sentiment)]}` : '';
      circle.append(svgElement('title', {}, `第 ${index + 1} 句：${point.text || ''}（${number(point.polarity).toFixed(2)}${label}）`));
      chart.append(circle);
    });
    chart.append(svgElement('text', { x: left, y: height - 5 }, '第 1 句'));
    if (points.length > 1) chart.append(svgElement('text', { x: width - right, y: height - 5, 'text-anchor': 'end' }, `第 ${points.length} 句`));
    container.append(chart);
    const counts = {};
    for (const point of points) {
      const key = point.sentiment ? sentimentKey(point.sentiment) : number(point.polarity) > 0.05 ? 'positive' : number(point.polarity) < -0.05 ? 'negative' : 'neutral';
      counts[key] = (counts[key] || 0) + 1;
    }
    $('chart-summary').textContent = `${points.length} 句歌词中，${Object.entries(counts).map(([key, count]) => `${SENTIMENT_LABELS[key]} ${count} 句`).join('，')}。`;
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
      const data = await this.request('/professional/crawl', { method: 'POST', body: JSON.stringify(song), timeout: 120000 });
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
          const data = await this.request('/professional/crawl', { method: 'POST', body: JSON.stringify({ title: song.title, artist: song.artist }), timeout: 120000 });
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
      this.renderSongDialog(song);
      this.setStatus('dialog-analysis-status', this.reanalyzingIds.has(String(song.id)) ? '正在使用当前可用模型重新分析…' : '重新分析会更新本首歌曲的情感结果，保留歌词和歌曲信息。');
      if (!$('song-dialog').open) $('song-dialog').showModal();
      $('dialog-song-lyrics').scrollTop = 0;
    } catch (error) { if (sequence === this.detailSequence) this.toast(error.message, true); }
  }

  renderSongDialog(song) {
    $('dialog-song-title').textContent = song.title || '未命名歌曲';
    $('dialog-song-artist').textContent = song.artist || '未知创作者';
    $('dialog-song-lyrics').textContent = song.lyrics || '这条记录没有歌词。';
    setSentiment($('dialog-song-sentiment'), song.sentiment || song.analysis?.consensus_sentiment);
    const source = song.source || '手动导入';
    $('dialog-song-source').textContent = `来源：${source === 'manual' ? '手动导入' : source}`;
    $('dialog-analysis').textContent = song.analysis ? '查看完整分析 →' : '前往工作台分析 →';
    $('dialog-recommend').disabled = !song.analysis;
    this.setBusy('dialog-reanalyze', this.reanalyzingIds.has(String(song.id)));
    if (!song.lyrics) $('dialog-reanalyze').disabled = true;
  }

  async reanalyzeSong(song, origin) {
    if (song?.id === undefined || song?.id === null || this.reanalyzingIds.has(String(song.id))) return;
    const id = String(song.id);
    const stillCurrent = () => String((origin === 'dialog' ? this.currentSong : this.displayedSong)?.id) === id;
    const statusId = origin === 'dialog' ? 'dialog-analysis-status' : 'analysis-status';
    this.reanalyzingIds.add(id);
    if (String(this.currentSong?.id) === id) this.setBusy('dialog-reanalyze', true);
    if (String(this.displayedSong?.id) === id) this.setBusy('result-reanalyze', true);
    this.setStatus(statusId, '正在使用当前可用模型重新分析；首次加载可能需要稍等…', 'loading');
    try {
      const data = await this.request(`/songs/${encodeURIComponent(id)}/reanalyze`, { method: 'POST', timeout: 120000 });
      const updated = data.song || data;
      if (!updated.analysis) throw new Error('请求已提交，但没有收到分析结果。请刷新曲库查看。');
      if (String(this.currentSong?.id) === id) { this.currentSong = updated; this.renderSongDialog(updated); }
      if (String(this.displayedSong?.id) === id) this.displayAnalysis(updated);
      if (stillCurrent()) this.setStatus(statusId, '已用当前可用的分析方法更新结果，歌曲信息已保留。', 'success');
      this.toast(`《${updated.title || song.title}》已重新分析`);
      await this.refreshData();
      await this.checkConnection();
    } catch (error) {
      if (stillCurrent()) this.setStatus(statusId, error.message, 'error');
      else this.toast(error.message, true);
    } finally {
      this.reanalyzingIds.delete(id);
      if (String(this.currentSong?.id) === id) this.setBusy('dialog-reanalyze', false);
      if (String(this.displayedSong?.id) === id) this.setBusy('result-reanalyze', false);
    }
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
      this.displayedSong = null;
      $('analysis-placeholder').hidden = false;
      $('analysis-content').hidden = true;
      $('result-state-label').textContent = '等待输入';
    }
    this.setStatus('analysis-status', song.analysis ? '正在查看已保存的分析；点击结果中的“重新分析”使用当前可用模型，或修改歌词后提交。' : '歌曲已填入，点击“分析并保存到曲库”生成结果。');
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
