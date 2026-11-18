'use strict';

// Uploads stay local. Search results are rendered as text and trusted links only.
(() => {
  const byId = (id) => document.getElementById(id);
  const languages = { zh: '中文', ko: '韩文', en: '英文', unknown: '未确定' };
  const goals = { preserve: '保持原有风格', uplifting: '更明亮、振奋', calmer: '更平静、舒缓', darker: '更暗沉、紧张' };
  const modes = { music: '音乐分析', combined: '音乐分析 + 歌词识别', transcribe: '歌词识别' };
  const measured = (value) => typeof value === 'number' && Number.isFinite(value);
  const jobKey = 'yinyue-audio-job';
  const fileLimit = 30 * 1024 * 1024;
  const allowedExtensions = /\.(mp3|wav|m4a|flac|ogg|oga|aiff|aif|aac|opus|webm)$/i;
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  };
  const button = (text, action, className = 'button secondary compact') => {
    const result = node('button', className, text);
    result.type = 'button';
    result.addEventListener('click', action);
    return result;
  };
  const filename = (title) => String(title || 'lyrics').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'lyrics';
  const formatTime = (seconds) => {
    if (!Number.isFinite(Number(seconds)) || seconds === null) return '时长未知';
    const total = Math.max(0, Math.floor(Number(seconds)));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  const save = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const link = node('a');
    link.href = url;
    link.download = filename(name);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const trustedLink = (value, kind) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
      const hosts = {
        lyrics: ['lrclib.net'],
        source: ['commons.wikimedia.org'],
        license: ['commons.wikimedia.org', 'creativecommons.org'],
        audio: ['upload.wikimedia.org'],
      };
      if (!hosts[kind]?.includes(url.hostname)) return null;
      if (kind === 'audio' && !url.pathname.startsWith('/wikipedia/commons/')) return null;
      return url.href;
    } catch { return null; }
  };
  const externalLink = (text, href, kind) => {
    const valid = trustedLink(href, kind);
    const result = node(valid ? 'a' : 'span', 'media-source-link', text);
    if (valid) {
      result.href = valid;
      result.target = '_blank';
      result.rel = 'noopener noreferrer';
    }
    return result;
  };
  const status = (id, message, error = false) => {
    const target = byId(id);
    target.textContent = message;
    target.classList.toggle('error', error);
  };
  const stored = (value) => {
    try {
      if (value === undefined) return sessionStorage.getItem(jobKey);
      if (value === null) sessionStorage.removeItem(jobKey); else sessionStorage.setItem(jobKey, value);
    } catch { /* The app still works when browser storage is disabled. */ }
    return null;
  };

  async function api(path, options = {}) {
    const { timeout = 30000, ...rest } = options;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`/api${path}`, { ...rest, signal: controller.signal, headers: { Accept: 'application/json', ...rest.headers } });
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('服务返回了无法读取的数据，请检查本地服务。');
      const data = await response.json();
      if (!response.ok || data.success === false) {
        const error = new Error(data.error || '请求失败，请稍后重试。');
        error.code = data.error_code;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时。可以检查任务状态或稍后重试。');
      if (error instanceof TypeError) throw new Error('无法连接服务，请检查网络或本地服务。');
      throw error;
    } finally { window.clearTimeout(timer); }
  }

  async function download(path, name, trigger, statusId) {
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    status(statusId, '正在准备下载…');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 125000);
    try {
      const response = await fetch(`/api${path}`, { signal: controller.signal });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '下载失败，请稍后重试。');
      }
      save(await response.blob(), name);
      status(statusId, '已交给浏览器下载。音频的作者、许可与出处可另存为署名信息。');
    } catch (error) {
      status(statusId, error.name === 'AbortError' ? '下载超时，请稍后重试。' : error.message, true);
    } finally {
      window.clearTimeout(timer);
      trigger.disabled = false;
      trigger.removeAttribute('aria-busy');
    }
  }

  function importLyrics(title, artist, text, statusId) {
    if (!text.trim()) { status(statusId, '没有可导入的歌词。', true); return; }
    if (text.length > 50000) { status(statusId, '歌词超过 50,000 字，请缩短后再导入。', true); return; }
    byId('an-title').value = String(title || '').slice(0, 200);
    byId('an-artist').value = String(artist || '').slice(0, 200);
    byId('an-lyrics').value = text;
    window.app.updateCharacterCount();
    window.app.navigate('analyze');
    window.app.setStatus('analysis-status', '歌词已导入。请确认歌名、歌手和正文，再点击“分析并保存到曲库”。');
    window.requestAnimationFrame(() => {
      byId('analysis-workspace').scrollIntoView({ behavior: window.app.scrollBehavior() });
      byId('an-lyrics').focus({ preventScroll: true });
    });
  }

  class AudioWorkspace {
    constructor() {
      this.file = null;
      this.objectURL = null;
      this.previewReadyMessage = '';
      this.result = null;
      this.expectedFile = null;
      this.restoredResult = false;
      this.jobId = null;
      this.active = false;
      this.submitting = false;
      this.sequence = 0;
      this.modelSequence = 0;
      const localPlayer = byId('audio-local-player');
      localPlayer.addEventListener('error', () => {
        if (!this.objectURL || (localPlayer.currentSrc && localPlayer.currentSrc !== this.objectURL)) return;
        status('audio-file-status', '浏览器无法试听此格式，可用本机播放器试听；音频分析仍可继续。', true);
      });
      localPlayer.addEventListener('loadedmetadata', () => {
        if (!this.objectURL || localPlayer.currentSrc !== this.objectURL) return;
        status('audio-file-status', this.previewReadyMessage || '音频已就绪，可以试听并继续分析。');
      });
      byId('audio-file').addEventListener('change', (event) => this.selectFile(event.target.files[0]));
      byId('audio-upload-form').addEventListener('submit', (event) => { event.preventDefault(); this.submit(); });
      byId('audio-cancel').addEventListener('click', () => this.cancel());
      byId('audio-retry-status').addEventListener('click', () => this.poll());
      byId('audio-refresh-model').addEventListener('click', () => this.checkModel());
      byId('audio-mode').addEventListener('change', () => this.updateMode());
      byId('music-save-report').addEventListener('click', () => this.saveReport());
      byId('audio-search-lyrics').addEventListener('click', () => {
        const title = byId('audio-title').value.trim() || byId('audio-input-title').value.trim();
        const artist = byId('audio-artist').value.trim() || byId('audio-input-artist').value.trim();
        if (!title) { status('audio-review-status', '请填写歌名，再搜索已发布歌词来核对识别结果。', true); return; }
        window.musicSearchWorkspace.searchFor([title, artist].filter(Boolean).join(' '));
      });
      byId('audio-review-form').addEventListener('submit', (event) => {
        event.preventDefault();
        if (!byId('audio-reviewed').checked) { status('audio-review-status', '请先校对识别歌词并勾选确认。', true); return; }
        importLyrics(byId('audio-title').value, byId('audio-artist').value, byId('audio-transcript').value, 'audio-review-status');
      });
      byId('audio-transcript').addEventListener('input', () => {
        byId('audio-reviewed').checked = false;
        this.updateDownloads();
        this.saveDraft();
      });
      for (const id of ['audio-title', 'audio-artist']) byId(id).addEventListener('input', () => this.saveDraft());
      byId('audio-save-txt').addEventListener('click', () => save(new Blob(['\ufeff', byId('audio-transcript').value], { type: 'text/plain;charset=utf-8' }), `${filename(byId('audio-title').value)}.txt`));
      byId('audio-save-lrc').addEventListener('click', () => this.saveLRC());
      const drop = byId('audio-drop-zone');
      for (const eventName of ['dragenter', 'dragover']) drop.addEventListener(eventName, (event) => {
        event.preventDefault();
        if (!this.active && !this.submitting) drop.classList.add('drag-over');
      });
      for (const eventName of ['dragleave', 'drop']) drop.addEventListener(eventName, (event) => {
        event.preventDefault();
        drop.classList.remove('drag-over');
      });
      drop.addEventListener('drop', (event) => {
        if (!this.active && !this.submitting) this.selectFile(event.dataTransfer.files[0]);
      });
      window.addEventListener('pagehide', () => {
        this.saveDraft();
        if (this.objectURL) URL.revokeObjectURL(this.objectURL);
        window.clearTimeout(this.pollTimer);
      });
      this.updateMode();
      this.checkModel();
      const previous = stored();
      if (previous && /^[a-f0-9]{32}$/.test(previous)) {
        this.jobId = previous;
        this.active = true;
        this.restoredResult = true;
        try {
          const metadata = JSON.parse(sessionStorage.getItem('yinyue-audio-metadata') || '{}');
          if (metadata.id === previous) {
            byId('audio-title').value = String(metadata.title || '').slice(0, 200);
            byId('audio-artist').value = String(metadata.artist || '').slice(0, 200);
            byId('audio-input-title').value = byId('audio-title').value;
            byId('audio-input-artist').value = byId('audio-artist').value;
            if (Object.hasOwn(modes, metadata.mode)) byId('audio-mode').value = metadata.mode;
            if (Object.hasOwn(goals, metadata.goal)) byId('audio-goal').value = metadata.goal;
            if (typeof metadata.filename === 'string' && Number.isFinite(metadata.size)
                && Number.isFinite(metadata.lastModified)) {
              this.expectedFile = { name: metadata.filename, size: metadata.size, lastModified: metadata.lastModified };
            }
          }
        } catch { /* Metadata is optional when restoring a job. */ }
        this.updateMode();
        this.setBusy();
        status('audio-job-status', '正在恢复上次音频任务…');
        this.poll();
      }
    }

    async checkModel() {
      const sequence = ++this.modelSequence;
      byId('audio-refresh-model').disabled = true;
      status('audio-music-status', '正在检查本机音乐分析服务…');
      try {
        const state = await api('/audio/status');
        if (sequence !== this.modelSequence) return;
        status('audio-music-status', state.music?.status === 'ready'
          ? '音乐分析已就绪 · 直接分析音频，无需歌词识别模型'
          : state.music?.message || '音乐分析组件尚未就绪，请检查本机安装状态。', state.music?.status !== 'ready');
        status('audio-model-status', state.status === 'ready'
          ? `可选歌词识别：${state.name || 'Whisper'} 已就绪 · 中文 / 韩文 / 英文`
          : `可选歌词识别未就绪；音乐分析仍可单独使用。${state.message || ''}`);
      } catch (error) { if (sequence === this.modelSequence) status('audio-music-status', error.message, true); }
      finally { if (sequence === this.modelSequence) byId('audio-refresh-model').disabled = false; }
    }

    updateMode() {
      const mode = byId('audio-mode').value;
      byId('audio-language-field').hidden = mode === 'music';
      byId('audio-goal-field').hidden = mode === 'transcribe';
      byId('audio-submit-label').textContent = { music: '开始音乐分析', combined: '分析音乐并尝试识词', transcribe: '开始识别歌词' }[mode];
      byId('audio-mode-help').textContent = {
        music: '直接分析音频，适合纯音乐和歌曲；无需安装歌词识别模型。',
        combined: '先分析音乐，再尝试识别歌词。识词不可用或失败时，音乐结果仍会保留。',
        transcribe: '仅生成待校对歌词，需要本机歌词识别模型。纯音乐可能没有可靠文字。',
      }[mode];
      if (!this.result) {
        byId('music-analysis-panel').hidden = mode === 'transcribe';
        byId('audio-review-panel').hidden = mode === 'music';
      }
      this.setBusy();
    }

    selectFile(file) {
      if (!file || this.active || this.submitting) return;
      if (!allowedExtensions.test(file.name)) { this.rejectFile('请选择 MP3、WAV、M4A、FLAC、OGG 等音频文件。'); return; }
      if (!file.size || file.size > fileLimit) { this.rejectFile('请选择大小在 0–30 MB 之间的非空音频文件。'); return; }
      const restorePreview = this.result && this.restoredResult && this.expectedFile
        && file.name === this.expectedFile.name && file.size === this.expectedFile.size
        && file.lastModified === this.expectedFile.lastModified;
      this.file = file;
      if (this.objectURL) URL.revokeObjectURL(this.objectURL);
      this.objectURL = URL.createObjectURL(file);
      this.previewReadyMessage = restorePreview
        ? '已重新连接原音频，可继续逐段试听；分析结果和校对文字已保留。'
        : '已选择音频。可以先试听，再开始分析。';
      status('audio-file-status', this.previewReadyMessage);
      byId('audio-local-player').src = this.objectURL;
      byId('audio-local-preview').hidden = false;
      byId('audio-file-name').textContent = file.name;
      byId('audio-file-size').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
      if (restorePreview) {
        byId('audio-segments').querySelectorAll('.segment-time').forEach((time) => { time.disabled = false; });
        status('audio-file-status', this.previewReadyMessage);
        this.setBusy();
        return;
      }
      byId('audio-title').value = file.name.replace(/\.[^.]+$/, '').slice(0, 200);
      byId('audio-input-title').value = byId('audio-title').value;
      byId('audio-artist').value = '';
      byId('audio-input-artist').value = '';
      status('audio-file-status', this.previewReadyMessage);
      this.result = null;
      this.expectedFile = null;
      this.restoredResult = false;
      this.clearDraft();
      byId('audio-review-content').hidden = true;
      byId('audio-review-empty').hidden = false;
      byId('audio-reviewed').checked = false;
      byId('audio-transcript-empty-title').textContent = '听清歌词，再分析文字';
      byId('audio-transcript-empty-description').textContent = '选择包含歌词识别的模式后，识别结果会显示在这里。纯音乐和不清晰的人声可能没有可靠文字。';
      byId('audio-progress').value = 0;
      byId('audio-progress-label').textContent = '0%';
      byId('music-analysis-content').hidden = true;
      byId('music-analysis-empty').hidden = false;
      status('audio-transcription-status', '');
      status('audio-job-status', '选择分析内容和创作目标后开始。最长支持 10 分钟。');
      this.jobId = null;
      stored(null);
      byId('audio-retry-status').hidden = true;
      this.updateMode();
    }

    rejectFile(message) {
      this.file = null;
      byId('audio-file').value = '';
      if (this.objectURL) URL.revokeObjectURL(this.objectURL);
      this.objectURL = null;
      this.previewReadyMessage = '';
      byId('audio-local-player').removeAttribute('src');
      byId('audio-local-preview').hidden = true;
      this.setBusy();
      status('audio-file-status', message, true);
      byId('audio-segments').querySelectorAll('.segment-time').forEach((time) => { time.disabled = true; });
    }

    setBusy() {
      const busy = this.active || this.submitting;
      byId('audio-file').disabled = busy;
      byId('audio-language').disabled = busy;
      byId('audio-mode').disabled = busy;
      byId('audio-goal').disabled = busy;
      byId('audio-input-title').disabled = busy;
      byId('audio-input-artist').disabled = busy;
      byId('audio-submit').disabled = busy || !this.file;
      byId('audio-submit').classList.toggle('is-busy', busy);
      byId('audio-submit').setAttribute('aria-busy', String(busy));
      byId('audio-cancel').hidden = !this.active;
    }

    async submit() {
      if (!this.file || this.active || this.submitting) return;
      this.submitting = true;
      this.setBusy();
      const form = new FormData();
      form.append('file', this.file);
      form.append('language', byId('audio-language').value);
      form.append('mode', byId('audio-mode').value);
      form.append('goal', byId('audio-goal').value);
      status('audio-job-status', '正在上传到本机并建立音频任务…');
      try {
        const data = await api('/audio/jobs', { method: 'POST', body: form, timeout: 60000 });
        this.jobId = data.job.id;
        stored(this.jobId);
        this.clearDraft();
        this.result = null;
        this.restoredResult = false;
        this.expectedFile = { name: this.file.name, size: this.file.size, lastModified: this.file.lastModified };
        byId('audio-review-content').hidden = true;
        byId('audio-review-empty').hidden = false;
        byId('music-analysis-content').hidden = true;
        byId('music-analysis-empty').hidden = false;
        byId('audio-progress').value = 0;
        this.updateMode();
        byId('audio-title').value = byId('audio-input-title').value;
        byId('audio-artist').value = byId('audio-input-artist').value;
        try {
          sessionStorage.setItem('yinyue-audio-metadata', JSON.stringify({ id: this.jobId,
            title: byId('audio-title').value, artist: byId('audio-artist').value,
            filename: this.file.name, size: this.file.size, lastModified: this.file.lastModified,
            mode: byId('audio-mode').value, goal: byId('audio-goal').value }));
        } catch { /* A job can run without browser storage. */ }
        this.active = true;
        this.sequence++;
        this.renderJob(data.job);
        this.poll();
      } catch (error) { status('audio-job-status', error.message, true); }
      finally { this.submitting = false; this.setBusy(); }
    }

    async poll() {
      if (!this.jobId) return;
      const sequence = ++this.sequence;
      const id = this.jobId;
      window.clearTimeout(this.pollTimer);
      byId('audio-retry-status').hidden = true;
      try {
        const data = await api(`/audio/jobs/${encodeURIComponent(id)}`);
        if (sequence !== this.sequence || id !== this.jobId) return;
        this.renderJob(data.job);
        if (this.active) this.pollTimer = window.setTimeout(() => this.poll(), 1800);
      } catch (error) {
        if (sequence !== this.sequence) return;
        status('audio-job-status', error.message, true);
        if (error.code === 'job_not_found') {
          this.active = false;
          this.jobId = null;
          stored(null);
          this.setBusy();
        } else {
          byId('audio-retry-status').hidden = false;
          byId('audio-retry-status').textContent = '重新检查任务';
        }
      }
    }

    renderJob(job) {
      this.active = ['queued', 'running', 'cancelling'].includes(job.status);
      if (Object.hasOwn(modes, job.mode)) byId('audio-mode').value = job.mode;
      if (Object.hasOwn(goals, job.goal)) byId('audio-goal').value = job.goal;
      this.updateMode();
      byId('audio-progress').value = Math.max(0, Math.min(1, Number(job.progress) || 0));
      byId('audio-progress-label').textContent = `${Math.round(byId('audio-progress').value * 100)}%`;
      status('audio-job-status', job.error || job.message || '正在处理音频', job.status === 'failed');
      byId('audio-cancel').disabled = job.status === 'cancelling';
      this.setBusy();
      if (job.status === 'completed' && job.result) this.renderResult(job.result);
      if (job.status === 'cancelled' || job.status === 'failed') {
        stored(null);
        byId('audio-retry-status').hidden = true;
      }
    }

    async cancel() {
      if (!this.jobId) return;
      byId('audio-cancel').disabled = true;
      try {
        const data = await api(`/audio/jobs/${encodeURIComponent(this.jobId)}`, { method: 'DELETE' });
        this.renderJob(data.job);
        if (this.active) this.poll();
      } catch (error) {
        status('audio-job-status', error.message, true);
        byId('audio-cancel').disabled = false;
      }
    }

    renderMusic(analysis) {
      byId('music-analysis-panel').hidden = false;
      byId('music-analysis-empty').hidden = true;
      byId('music-analysis-content').hidden = false;
      byId('music-report-title').textContent = byId('audio-title').value || byId('audio-input-title').value || '这段音乐的声音画像';
      byId('music-report-meta').textContent = `${formatTime(analysis.duration)} · ${goals[analysis.goal] || '音乐分析'}`;
      byId('music-report-summary').textContent = analysis.summary || '分析已完成，请结合实测特征与试听判断。';
      byId('music-goal-label').textContent = goals[analysis.goal] || '基于音频证据';
      byId('music-method').textContent = analysis.method === 'offline-dsp-heuristic-v1'
        ? '在本机测量音频的节奏、音色、能量与音高，再用可解释规则生成听感线索。方法标识：offline-dsp-heuristic-v1。'
        : analysis.method || '根据音频实测特征推导可解释线索。';
      const warnings = Array.isArray(analysis.warnings) ? analysis.warnings : [];
      byId('music-analysis-warnings').replaceChildren(...warnings.map((message) => node('li', '', message)));
      byId('music-analysis-warnings').hidden = !warnings.length;

      const emotions = Array.isArray(analysis.emotions) ? analysis.emotions : [];
      const emotionList = byId('music-emotions');
      const modelSummary = byId('music-model-summary');
      emotionList.replaceChildren();
      modelSummary.hidden = !analysis.mood_model?.available || !analysis.mood_model.summary;
      modelSummary.textContent = analysis.mood_model?.summary || '';
      modelSummary.style.gridColumn = '1 / -1';
      emotionList.append(modelSummary);
      for (const emotion of emotions) {
        const item = node('article', 'music-emotion-card');
        const heading = node('div', 'music-emotion-heading');
        heading.append(node('h4', '', emotion.label));
        if (measured(emotion.score)) {
          heading.append(node('span', 'small-label', `规则倾向 ${emotion.score.toFixed(2)} / 1`));
          const meter = node('div', 'music-emotion-meter');
          meter.setAttribute('aria-hidden', 'true');
          const fill = node('span'); fill.style.width = `${Math.max(0, Math.min(1, emotion.score)) * 100}%`; meter.append(fill);
          item.append(heading, meter);
        } else item.append(heading);
        const evidence = Array.isArray(emotion.evidence) ? emotion.evidence.join('；') : emotion.evidence;
        if (evidence) item.append(node('p', '', evidence));
        emotionList.append(item);
      }
      if (!emotions.length) emotionList.append(node('p', 'music-insufficient', '当前片段缺少足够的声学规则依据，不生成规则情绪判断。'));

      const features = byId('music-features');
      features.replaceChildren();
      for (const feature of Array.isArray(analysis.features) ? analysis.features : []) {
        const card = node('article', 'music-feature');
        card.append(node('h4', '', feature.label || feature.key));
        const isProportion = ['low_frequency_ratio', 'pitch_coverage'].includes(feature.key);
        let displayValue = '证据不足';
        let displayUnit = feature.unit || '';
        if (measured(feature.value)) {
          if (isProportion) {
            displayValue = `${Math.round(feature.value * 100)}%`;
            displayUnit = '实测占比';
          } else {
            displayValue = feature.value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
            if (feature.key === 'pulse_clarity') displayUnit = '/ 1';
            else if (feature.unit === 'ratio') displayUnit = '（0–1）';
          }
        }
        const value = node('strong', measured(feature.value) ? '' : 'insufficient-value', displayValue);
        if (measured(feature.value) && displayUnit) value.append(node('small', '', displayUnit));
        card.append(value);
        if (feature.note) card.append(node('p', '', feature.note));
        features.append(card);
      }
      if (!features.childElementCount) features.append(node('p', 'music-insufficient', '没有可展示的音乐特征。'));

      const pitch = analysis.pitch || {};
      byId('music-pitch-note').textContent = pitch.note || (pitch.available ? '这是混音中的音高线索，不等同于分离后的主旋律。' : '未检测到足够稳定的音高，暂不推断旋律走向。');
      const pitchFacts = byId('music-pitch-facts'); pitchFacts.replaceChildren();
      if (pitch.available) {
        if (pitch.dominant_note) pitchFacts.append(node('span', '', `常见音高 ${pitch.dominant_note}`));
        if (measured(pitch.range_semitones)) pitchFacts.append(node('span', '', `检测跨度 ${pitch.range_semitones.toFixed(1)} 半音`));
        if (measured(pitch.coverage)) pitchFacts.append(node('span', '', `有效音高覆盖 ${(pitch.coverage * 100).toFixed(0)}%`));
      }
      this.renderEnergy(analysis.timeline);
      this.renderAdvice('music-arrangement-advice', analysis.suggestions?.arrangement);
      this.renderAdvice('music-melody-advice', analysis.suggestions?.melody);
      this.renderMoodModel(analysis.mood_model);
      status('music-report-status', analysis.available === false ? '当前音频证据不足，报告保留可用信息与限制。' : '音乐报告已生成。建议是创作起点，可以结合试听逐项尝试。');
    }

    renderAdvice(id, suggestions) {
      const container = byId(id); container.replaceChildren();
      for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
        const card = node('article', 'music-advice-card');
        card.append(node('h5', '', suggestion.title || '创作建议'));
        if (suggestion.evidence) card.append(node('p', 'music-advice-evidence', `音频依据：${suggestion.evidence}`));
        if (suggestion.action) card.append(node('p', '', suggestion.action));
        if (suggestion.expected_effect) card.append(node('p', 'music-advice-effect', `预期听感：${suggestion.expected_effect}`));
        container.append(card);
      }
      if (!container.childElementCount) container.append(node('p', 'music-insufficient', '音频依据不足，暂不提供具体调整建议。'));
    }

    renderMoodModel(model) {
      const scores = Array.isArray(model?.scores) ? model.scores.filter((item) => measured(item.score)) : [];
      byId('music-model-details').hidden = !model?.available || !scores.length;
      const container = byId('music-model-scores'); container.replaceChildren();
      if (!model?.available) return;
      byId('music-model-summary').textContent = model.summary || '模型标签相似度仅作补充参考，请结合音频特征与试听判断。';
      const coverage = model.coverage || {};
      const coverageText = measured(coverage.analyzed_seconds) ? ` · 采样分析 ${formatTime(coverage.analyzed_seconds)} / 总长 ${formatTime(coverage.total_seconds)}` : '';
      byId('music-model-method').textContent = `${model.model || '音频模型'} · ${model.method || '音频与情绪标签比较'}${coverageText}`;
      for (const item of scores) {
        const row = node('div', 'music-model-score');
        row.append(node('span', '', item.name_zh || item.label), node('strong', '', item.score.toFixed(3)));
        container.append(row);
      }
      for (const message of Array.isArray(model.warnings) ? model.warnings : []) container.append(node('p', 'field-help', message));
    }

    renderEnergy(timeline) {
      const segments = Array.isArray(timeline) ? timeline.filter((item) => measured(item.start) && measured(item.end) && measured(item.energy)) : [];
      const container = byId('music-energy-chart'); container.replaceChildren();
      if (!segments.length) {
        container.append(node('p', 'music-insufficient', '片段过短或能量证据不足，无法绘制变化曲线。'));
        byId('music-energy-note').textContent = '';
        return;
      }
      const namespace = 'http://www.w3.org/2000/svg';
      const svgNode = (tag, attributes, text) => {
        const item = document.createElementNS(namespace, tag);
        for (const [name, value] of Object.entries(attributes || {})) item.setAttribute(name, String(value));
        if (text !== undefined) item.textContent = String(text);
        return item;
      };
      const width = 540, height = 160, left = 30, right = 10, top = 10, bottom = 27;
      const duration = Math.max(...segments.map((item) => item.end));
      if (!(duration > 0)) { container.append(node('p', 'music-insufficient', '没有有效的音频时间范围。')); return; }
      const plotWidth = width - left - right, plotHeight = height - top - bottom;
      const chart = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `音频分为 ${segments.length} 段，纵轴显示零到一的相对能量。` });
      for (const value of [0, 0.5, 1]) {
        const y = top + (1 - value) * plotHeight;
        chart.append(svgNode('line', { x1: left, x2: width - right, y1: y, y2: y, class: 'music-energy-grid' }));
        chart.append(svgNode('text', { x: left - 7, y: y + 3, 'text-anchor': 'end' }, value.toFixed(1)));
      }
      const stride = Math.max(1, Math.ceil(segments.length / 120));
      for (let i = 0; i < segments.length; i += stride) {
        const group = segments.slice(i, i + stride);
        const start = group[0].start, end = group[group.length - 1].end;
        const energy = Math.max(0, Math.min(1, group.reduce((sum, item) => sum + item.energy, 0) / group.length));
        const rect = svgNode('rect', { x: left + start / duration * plotWidth, y: top + (1 - energy) * plotHeight, width: Math.max(1, (end - start) / duration * plotWidth - 2), height: energy * plotHeight, rx: 2, class: 'music-energy-bar' });
        rect.append(svgNode('title', {}, `${formatTime(start)}–${formatTime(end)}：相对能量 ${energy.toFixed(2)}`));
        chart.append(rect);
      }
      chart.append(svgNode('text', { x: left, y: height - 6 }, '0:00'));
      chart.append(svgNode('text', { x: width - right, y: height - 6, 'text-anchor': 'end' }, formatTime(duration)));
      container.append(chart);
      const highest = segments.reduce((current, item) => item.energy > current.energy ? item : current, segments[0]);
      const lowest = Math.min(...segments.map((item) => item.energy));
      const contrast = highest.energy - lowest < 0.05 ? '各段能量接近，未观察到明显起伏。'
        : `能量相对较高的片段在 ${formatTime(highest.start)}–${formatTime(highest.end)}。`;
      byId('music-energy-note').textContent = `${contrast}此图用于比较这段音频内部的能量，不表示情绪概率或音质好坏。${stride > 1 ? '较长音频已按连续片段平均后显示。' : ''}`;
    }

    saveReport() {
      if (!this.result?.music_analysis) return;
      const report = { exported_at: new Date().toISOString(), title: byId('audio-title').value || byId('audio-input-title').value,
        artist: byId('audio-artist').value || byId('audio-input-artist').value,
        filename: this.expectedFile?.name || this.file?.name || null, ...this.result };
      if (byId('audio-transcript').value.trim() && this.result.mode !== 'music' && !this.result.no_speech
          && (!this.result.transcription_status || this.result.transcription_status.status === 'completed')) {
        report.lyrics_draft = { text: byId('audio-transcript').value, reviewed: byId('audio-reviewed').checked };
      }
      save(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }), `${filename(report.title || 'music-analysis')}.music-analysis.json`);
      status('music-report-status', '音乐分析 JSON 报告已交给浏览器下载。');
    }

    renderResult(result) {
      this.result = result;
      const mode = Object.hasOwn(modes, result.mode) ? result.mode : result.music_analysis ? 'music' : 'transcribe';
      byId('audio-mode').value = mode;
      if (Object.hasOwn(goals, result.music_analysis?.goal)) byId('audio-goal').value = result.music_analysis.goal;
      this.updateMode();
      byId('audio-transcript').value = result.text || '';
      try {
        const draft = JSON.parse(sessionStorage.getItem('yinyue-audio-draft') || '{}');
        if (draft.id === this.jobId && typeof draft.text === 'string') {
          byId('audio-transcript').value = draft.text.slice(0, 50000);
          byId('audio-title').value = String(draft.title || '').slice(0, 200);
          byId('audio-artist').value = String(draft.artist || '').slice(0, 200);
        }
      } catch { /* The original transcript remains available without a saved draft. */ }
      byId('music-analysis-panel').hidden = !result.music_analysis;
      if (result.music_analysis) this.renderMusic(result.music_analysis);
      const transcriptionState = result.transcription_status?.status || (mode === 'music' ? 'skipped' : 'completed');
      const hasTranscript = transcriptionState === 'completed' && !result.no_speech && Boolean(byId('audio-transcript').value.trim());
      byId('audio-review-panel').hidden = mode === 'music';
      byId('audio-review-empty').hidden = hasTranscript;
      byId('audio-review-content').hidden = !hasTranscript;
      const transcriptionMessage = result.transcription_status?.message || (hasTranscript
        ? '识别完成。请对照试听校对，再导入歌词情感分析。'
        : mode === 'music' ? '本次仅分析音乐，未识别歌词。' : '没有识别到可靠歌词。纯音乐无需识词，也可以查看音乐分析。');
      status('audio-transcription-status', transcriptionMessage, ['failed', 'unavailable'].includes(transcriptionState));
      byId('audio-transcript-empty-title').textContent = transcriptionState === 'unavailable' ? '歌词识别暂不可用' : transcriptionState === 'failed' ? '本次歌词识别未完成' : '没有可靠歌词可供校对';
      byId('audio-transcript-empty-description').textContent = `${transcriptionMessage}${result.music_analysis ? ' 音乐分析结果已保留，可继续查看与导出。' : ''}`;
      byId('audio-reviewed').checked = false;
      byId('audio-result-meta').textContent = `${languages[result.language] || result.language || '未确定'} · ${formatTime(result.duration)} · ${(result.segments || []).length} 个片段`;
      const warnings = byId('audio-warnings');
      warnings.replaceChildren(...(result.warnings || []).map((message) => node('li', '', message)));
      warnings.hidden = !warnings.childElementCount;
      const segments = byId('audio-segments');
      segments.replaceChildren();
      for (const segment of result.segments || []) {
        const line = node('li', 'audio-segment');
        const time = button(formatTime(segment.start), () => {
          if (!this.objectURL) return;
          byId('audio-local-player').currentTime = Math.max(0, Number(segment.start) || 0);
          byId('audio-local-player').play().catch(() => status('audio-review-status', '浏览器无法播放此格式，请使用本机播放器试听。', true));
        }, 'segment-time');
        time.setAttribute('aria-label', `试听 ${formatTime(segment.start)} 处片段`);
        time.disabled = !this.objectURL;
        line.append(time, node('span', '', segment.text));
        if (Number(segment.avg_logprob) < -1 || Number(segment.no_speech_prob) > 0.5) line.append(node('span', 'segment-uncertain', '重点校对'));
        segments.append(line);
      }
      this.updateDownloads();
      this.saveDraft();
      if (this.restoredResult && !this.objectURL) {
        status('audio-file-status', this.expectedFile
          ? `分析结果和校对草稿已恢复。重新选择原音频“${this.expectedFile.name}”可恢复试听，无需重新分析。`
          : '分析结果和校对草稿已恢复。此旧任务未保存原文件信息，重新选择音频将开始新的分析。');
      }
      status('audio-review-status', hasTranscript ? '识别完成。请对照试听校对，再导入歌词情感分析。' : '没有可靠歌词，不能作为已识别歌词导入。', !hasTranscript);
    }

    saveDraft() {
      if (!this.jobId || !this.result) return;
      try {
        sessionStorage.setItem('yinyue-audio-draft', JSON.stringify({ id: this.jobId,
          text: byId('audio-transcript').value, title: byId('audio-title').value,
          artist: byId('audio-artist').value }));
      } catch { /* Editing remains available even when browser storage is full. */ }
    }

    clearDraft() {
      try { sessionStorage.removeItem('yinyue-audio-draft'); } catch { /* Optional browser storage. */ }
    }

    updateDownloads() {
      const text = byId('audio-transcript').value;
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      const segments = this.result?.segments || [];
      const usable = this.result?.mode !== 'music' && !this.result?.no_speech
        && (!this.result?.transcription_status || this.result.transcription_status.status === 'completed');
      byId('audio-save-txt').disabled = !text.trim() || !usable;
      byId('audio-import').disabled = !text.trim() || !usable;
      byId('audio-save-lrc').disabled = !usable || !lines.length || lines.length !== segments.length;
      byId('audio-text-count').textContent = `${text.length.toLocaleString()} 字`;
      byId('audio-lrc-help').textContent = lines.length === segments.length
        ? 'LRC 沿用识别时间点，包含当前校对文字；时间点可能需要调整。'
        : '歌词行数已变化，无法直接匹配原时间点；可下载校对后的 TXT。';
    }

    saveLRC() {
      const lines = byId('audio-transcript').value.split(/\r?\n/).filter((line) => line.trim());
      if (lines.length !== this.result?.segments?.length) return;
      const text = lines.map((line, index) => {
        const hundredths = Math.max(0, Math.round(Number(this.result.segments[index].start) * 100));
        return `[${String(Math.floor(hundredths / 6000)).padStart(2, '0')}:${String(Math.floor(hundredths / 100) % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}]${line.trim()}`;
      }).join('\n');
      save(new Blob(['\ufeff', text], { type: 'text/plain;charset=utf-8' }), `${filename(byId('audio-title').value)}.lrc`);
    }
  }

  class MusicSearchWorkspace {
    constructor() {
      this.sequence = 0;
      this.selectionSequence = 0;
      this.song = null;
      byId('music-search-form').addEventListener('submit', (event) => { event.preventDefault(); this.search(); });
      byId('music-search-type').addEventListener('change', () => {
        this.sequence++;
        this.selectionSequence++;
        this.stopPlayers();
        this.song = null;
        byId('music-search-results').replaceChildren();
        byId('music-lyrics-detail').hidden = true;
        byId('music-search-empty').hidden = false;
        byId('music-search-submit').disabled = false;
        byId('music-search-submit').classList.remove('is-busy');
        status('music-search-status', '输入关键词后搜索。');
      });
      byId('music-import-lyrics').addEventListener('click', () => {
        if (this.song) importLyrics(this.song.title, this.song.artist, this.song.plain_lyrics || this.song.synced_lyrics || '', 'music-detail-status');
      });
      for (const format of ['txt', 'lrc']) byId(`music-save-${format}`).addEventListener('click', (event) => {
        if (this.song) download(`/search/lyrics/${this.song.id}/download?format=${format}`, `${filename(this.song.title)}.${format}`, event.currentTarget, 'music-detail-status');
      });
      byId('music-close-detail').addEventListener('click', () => {
        this.selectionSequence++;
        byId('music-lyrics-detail').hidden = true;
        this.song = null;
      });
      window.addEventListener('hashchange', () => { if (location.hash !== '#search') this.stopPlayers(); });
    }

    stopPlayers() {
      byId('music-search-results').querySelectorAll('audio').forEach((audio) => audio.pause());
    }

    searchFor(query) {
      byId('music-search-type').value = 'lyrics';
      byId('music-search-query').value = query.slice(0, 200);
      window.app.navigate('search');
      this.search();
    }

    async search() {
      const query = byId('music-search-query').value.trim();
      if (!query) return;
      const sequence = ++this.sequence;
      this.selectionSequence++;
      const kind = byId('music-search-type').value;
      this.stopPlayers();
      byId('music-search-results').replaceChildren();
      byId('music-search-empty').hidden = true;
      byId('music-lyrics-detail').hidden = true;
      byId('music-search-submit').disabled = true;
      byId('music-search-submit').classList.add('is-busy');
      status('music-search-status', kind === 'lyrics' ? '正在搜索歌词与版本…' : '正在搜索并筛选开放许可音频…');
      try {
        const data = await api(`/search/${kind}?q=${encodeURIComponent(query)}`, { timeout: 40000 });
        if (sequence !== this.sequence) return;
        const results = Array.isArray(data.results) ? data.results : [];
        if (!results.length) {
          status('music-search-status', kind === 'lyrics'
            ? '未找到匹配歌词。试试歌名、歌手的其他写法，或手动导入。'
            : '未找到符合开放许可和大小要求的音频。可尝试原文歌名或传统曲目；热门商业歌曲通常不提供此类下载。');
          return;
        }
        status('music-search-status', `找到 ${results.length} 个候选 · ${data.provider || (kind === 'lyrics' ? 'LRCLIB' : 'Wikimedia Commons')} · 请核对版本`);
        for (const result of results) byId('music-search-results').append(kind === 'lyrics' ? this.lyricsCard(result) : this.audioCard(result));
      } catch (error) {
        if (sequence === this.sequence) status('music-search-status', error.message, true);
      } finally {
        if (sequence === this.sequence) {
          byId('music-search-submit').disabled = false;
          byId('music-search-submit').classList.remove('is-busy');
        }
      }
    }

    lyricsCard(song) {
      const card = node('article', 'media-result-card');
      const header = node('div', 'media-card-heading');
      header.append(node('h3', '', song.title || '未命名歌曲'), node('span', 'media-badge', song.instrumental ? '纯音乐' : song.synced_lyrics ? '含同步歌词' : '文本歌词'));
      card.append(header, node('p', 'media-card-artist', song.artist || '歌手未知'));
      card.append(node('p', 'field-help', `${song.album || '专辑未知'} · ${formatTime(song.duration)}`));
      const actions = node('div', 'media-card-actions');
      actions.append(button('查看这个版本', () => this.selectSong(song.id)), externalLink('LRCLIB 来源 ↗', song.source_url, 'lyrics'));
      card.append(actions);
      return card;
    }

    async selectSong(id) {
      const sequence = ++this.selectionSequence;
      const panel = byId('music-lyrics-detail');
      panel.hidden = false;
      this.song = null;
      byId('music-detail-title').textContent = '正在加载歌词…';
      byId('music-detail-meta').textContent = '';
      byId('music-detail-lyrics').textContent = '';
      byId('music-detail-source').replaceChildren();
      for (const key of ['music-import-lyrics', 'music-save-txt', 'music-save-lrc']) byId(key).disabled = true;
      status('music-detail-status', '正在获取所选版本。');
      try {
        const data = await api(`/search/lyrics/${encodeURIComponent(id)}`);
        if (sequence !== this.selectionSequence) return;
        const song = data.song;
        this.song = song;
        byId('music-detail-title').textContent = song.title;
        byId('music-detail-meta').textContent = `${song.artist} · ${song.album || '专辑未知'} · ${formatTime(song.duration)}`;
        byId('music-detail-lyrics').textContent = song.plain_lyrics || song.synced_lyrics || (song.instrumental ? '此版本标记为纯音乐，没有歌词。' : '此版本暂无可用歌词。');
        byId('music-detail-source').append(externalLink('查看 LRCLIB 原始记录 ↗', song.source_url, 'lyrics'));
        byId('music-import-lyrics').disabled = !(song.plain_lyrics || song.synced_lyrics);
        byId('music-save-txt').disabled = !song.plain_lyrics;
        byId('music-save-lrc').disabled = !song.synced_lyrics;
        status('music-detail-status', '请核对歌手、专辑与歌词。导入后仍可校对，不会自动保存到曲库。');
        panel.scrollIntoView({ behavior: window.app.scrollBehavior(), block: 'nearest' });
      } catch (error) {
        if (sequence === this.selectionSequence) status('music-detail-status', error.message, true);
      }
    }

    audioCard(item) {
      const card = node('article', 'media-result-card');
      const heading = node('div', 'media-card-heading');
      heading.append(node('h3', '', item.title), node('span', 'media-badge', item.license));
      card.append(heading, node('p', 'media-card-artist', item.artist), node('p', 'field-help', `${formatTime(item.duration)} · ${(Number(item.size) / 1024 / 1024).toFixed(2)} MB · 开放许可音频`));
      const audioURL = trustedLink(item.audio_url, 'audio');
      if (audioURL) {
        const player = node('audio', 'media-audio-player');
        player.controls = true;
        player.preload = 'none';
        player.src = audioURL;
        player.setAttribute('aria-label', `试听 ${item.title}`);
        player.addEventListener('play', () => byId('music-search-results').querySelectorAll('audio').forEach((audio) => { if (audio !== player) audio.pause(); }));
        player.addEventListener('error', () => { player.after(node('p', 'field-help error', '浏览器无法试听此格式；可下载后用本机播放器打开。')); }, { once: true });
        card.append(player);
      }
      const source = node('div', 'media-source-row');
      source.append(externalLink('来源与作者 ↗', item.source_url, 'source'), externalLink(`${item.license} 许可 ↗`, item.license_url, 'license'));
      card.append(source);
      if (item.attribution) card.append(node('p', 'field-help', `署名要求：${item.attribution}`));
      if (item.credit) card.append(node('p', 'field-help', `来源说明：${item.credit}`));
      if (item.restrictions) card.append(node('p', 'field-help', `其他说明：${item.restrictions}`));
      const actions = node('div', 'media-card-actions');
      actions.append(button('下载音频', (event) => download(`/search/audio/download?id=${encodeURIComponent(item.id)}`, item.title, event.currentTarget, 'music-download-status')));
      actions.append(button('保存署名信息', () => {
        const info = { title: item.title, author: item.artist, license: item.license, license_url: item.license_url,
          source_url: item.source_url, audio_url: item.audio_url, credit: item.credit || '',
          attribution: item.attribution || '', restrictions: item.restrictions || '', modifications: '原始文件，未作修改' };
        save(new Blob([JSON.stringify(info, null, 2)], { type: 'application/json;charset=utf-8' }), `${filename(item.title)}.attribution.json`);
      }));
      card.append(actions);
      return card;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!byId('view-audio') || !byId('view-search') || !window.app) return;
    window.audioWorkspace = new AudioWorkspace();
    window.musicSearchWorkspace = new MusicSearchWorkspace();
  });
})();
