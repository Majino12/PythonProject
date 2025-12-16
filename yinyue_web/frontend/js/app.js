class LyricAnalyzerApp {
    constructor() {
        this.apiBase = 'http://localhost:5002/api';
        this.songs = [];
        this.batchQueue = [];
        this.init();
    }

    init() {
        console.log("App Initialized - View Jump Fixed");
        this.loadLibrary(true);
    }

    // ==========================================
    // 1. Library 管理
    // ==========================================
    async loadLibrary(updateDropdown = false) {
        try {
            const res = await fetch(`${this.apiBase}/library`);
            const data = await res.json();
            this.songs = data.songs;
            this.renderLibrary(this.songs);
            if(updateDropdown) this.updateDropdown();
        } catch (e) { console.error(e); }
    }

    renderLibrary(songs) {
        const tbody = document.getElementById('library-table-body');
        if (!tbody) return;
        if (songs.length === 0) { tbody.innerHTML = '<tr><td colspan="4" class="text-center p-4 text-muted">Empty</td></tr>'; return; }

        const sorted = [...songs].reverse();
        tbody.innerHTML = sorted.map(s => {
            // 情感颜色判断
            let badgeClass = 'bg-secondary';
            const sent = (s.sentiment || '').toLowerCase();
            if (sent.includes('pos')) badgeClass = 'bg-success';
            else if (sent.includes('neg')) badgeClass = 'bg-danger';
            else if (sent.includes('neu')) badgeClass = 'bg-warning text-dark';

            const displaySent = sent.charAt(0).toUpperCase() + sent.slice(1);

            return `
            <tr>
                <td class="p-3 fw-bold text-truncate" style="max-width: 200px;">${s.title}</td>
                <td>${s.artist}</td>
                <td><span class="badge ${badgeClass}">${displaySent}</span></td>
                <td class="text-end pe-4">
                    <button class="btn btn-sm btn-outline-primary me-1" onclick="app.viewAnalysis('${s.title.replace(/'/g, "\\'")}')">View</button>
                </td>
            </tr>`;
        }).join('');
    }

    updateDropdown() {
        const select = document.getElementById('rec_target_song');
        if(select) select.innerHTML = this.songs.map(s => `<option value="${s.title}">${s.title}</option>`).join('');
    }

    checkDuplicate(artist, title) {
        const normalize = (str) => str ? str.toLowerCase().trim() : '';
        const t = normalize(title);
        const a = normalize(artist);
        return this.songs.some(song => normalize(song.title) === t && normalize(song.artist) === a);
    }

    // ==========================================
    // 2. Analyze 核心逻辑
    // ==========================================
    async analyzeManual() {
        const title = document.getElementById('an_title').value;
        const artist = document.getElementById('an_artist').value;
        const lyrics = document.getElementById('an_lyrics').value;
        const placeholder = document.getElementById('analysis-placeholder');
        const content = document.getElementById('analysis-content');

        if(!title || !lyrics) return alert("Please input Title and Lyrics");

        placeholder.style.display = 'block';
        content.style.display = 'none';
        placeholder.innerHTML = '<div class="spinner-border text-primary mb-3"></div><p>AI is processing...</p>';

        try {
            const res = await fetch(`${this.apiBase}/add_song`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({title, artist, lyrics})
            });
            const data = await res.json();

            if (data.success && data.analysis) {
                this.displayAnalysisUI(data);
                this.loadLibrary(true);
            } else {
                placeholder.innerHTML = `<div class="text-danger">Error: ${data.error}</div>`;
            }
        } catch(e) {
            console.error(e);
            placeholder.innerHTML = '<div class="text-danger">Network Error</div>';
        }
    }

    displayAnalysisUI(song) {
        const placeholder = document.getElementById('analysis-placeholder');
        const content = document.getElementById('analysis-content');
        const a = song.analysis;

        if (!a) return;

        placeholder.style.display = 'none';
        content.style.display = 'block';

        // 1. Big Metrics
        const sentiment = song.sentiment || 'Neutral';
        const sentEl = document.getElementById('res-sentiment-main');
        sentEl.textContent = sentiment.replace('very ', '').toUpperCase();
        sentEl.className = 'analysis-big-metric';

        if(sentiment.includes('pos')) sentEl.classList.add('text-success');
        else if(sentiment.includes('neg')) sentEl.classList.add('text-danger');
        else sentEl.classList.add('text-warning');

        document.getElementById('res-polarity-main').textContent = (a.textblob?.polarity || 0).toFixed(2);
        document.getElementById('res-lexicon-main').textContent = (a.lexicon?.score || 0).toFixed(2);
        document.getElementById('res-diversity-main').textContent = ((a.lexical?.lexical_diversity || 0) * 100).toFixed(0) + '%';

        // 2. Cards
        document.getElementById('res-tb-polarity').textContent = (a.textblob?.polarity || 0).toFixed(3);
        document.getElementById('res-tb-subjectivity').textContent = (a.textblob?.subjectivity || 0).toFixed(3);

        document.getElementById('res-lx-pos').textContent = ((a.lexicon?.positive_ratio || 0) * 100).toFixed(1) + '%';
        document.getElementById('res-lx-neg').textContent = ((a.lexicon?.negative_ratio || 0) * 100).toFixed(1) + '%';

        // 3. Chart
        const trace = {
            x: ['Polarity', 'Subjectivity', 'Lexicon', 'Pos Ratio', 'Neg Ratio'],
            y: [
                a.textblob?.polarity || 0,
                a.textblob?.subjectivity || 0,
                a.lexicon?.score || 0,
                a.lexicon?.positive_ratio || 0,
                (a.lexicon?.negative_ratio || 0) * -1
            ],
            type: 'bar',
            marker: { color: ['#4e73df', '#36b9cc', '#1cc88a', '#f6c23e', '#e74a3b'] }
        };
        const layout = {
            margin: { t: 10, b: 30, l: 30, r: 10 },
            height: 220,
            yaxis: { range: [-1, 1] }
        };
        Plotly.newPlot('sentiment-chart', [trace], layout, {displayModeBar: false});
    }

    // ==========================================
    // 3. 关键修复：View 跳转逻辑
    // ==========================================
    viewAnalysis(title) {
        // 1. 在本地数据中查找
        const song = this.songs.find(s => s.title === title);

        if (song && song.analysis) {
            // 2. 回填数据到输入框，让用户知道当前看的是哪首歌
            document.getElementById('an_title').value = song.title;
            document.getElementById('an_artist').value = song.artist;
            document.getElementById('an_lyrics').value = song.lyrics;

            // 3. 渲染右侧图表
            this.displayAnalysisUI(song);

            // 4. 【修复】平滑滚动到分析区域顶部
            const section = document.getElementById('analyze');
            if (section) {
                section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        } else {
            alert("Error: Song details not found in memory. Please reload.");
        }
    }

    // --- Batch Crawler ---
    loadPopularBatch() {
        const songs = [
            {artist:"Adele", title:"Hello"}, {artist:"Coldplay", title:"Yellow"},
            {artist:"Ed Sheeran", title:"Perfect"}, {artist:"Taylor Swift", title:"Love Story"},
            {artist:"Imagine Dragons", title:"Believer"}
        ];
        this.batchQueue = songs;
        document.getElementById('btn-start-batch').disabled = false;
        const log = document.getElementById('batch-log');
        log.innerHTML = '<div class="text-info mb-2">Queue Loaded:</div>';
        songs.forEach((s, i) => {
            const exists = this.checkDuplicate(s.artist, s.title);
            const style = exists ? 'text-decoration-line-through opacity-50' : '';
            log.innerHTML += `<div class="ps-2 text-muted small ${style}">${i+1}. ${s.artist} - ${s.title} ${exists?'(Exists)':''}</div>`;
        });
    }

    async runBatchProcess() {
        const log = document.getElementById('batch-log');
        const bar = document.getElementById('batch-progress');
        for(let i=0; i<this.batchQueue.length; i++) {
            const s = this.batchQueue[i];
            const pct = ((i+1)/this.batchQueue.length)*100;
            bar.style.width = `${pct}%`;

            if(this.checkDuplicate(s.artist, s.title)) {
                log.innerHTML += `<div class="text-warning">Skip: ${s.title}</div>`;
                continue;
            }

            log.innerHTML += `<div>Processing ${s.title}...</div>`;
            try {
                await fetch(`${this.apiBase}/professional/crawl`, {
                    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(s)
                });
            } catch(e){}
        }
        log.innerHTML += '<div class="text-success">Done!</div>';
        this.loadLibrary(true);
    }

    async crawlSong() {
        const artist = document.getElementById('cr_artist').value;
        const title = document.getElementById('cr_title').value;
        const div = document.getElementById('crawler-results');

        if(this.checkDuplicate(artist, title)) return alert("Song exists!");

        div.innerHTML = 'Crawling...';
        try {
            const res = await fetch(`${this.apiBase}/professional/crawl`, {
                method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({artist, title})
            });
            const d = await res.json();
            if(d.status==='success') {
                div.innerHTML = `<div class="text-success">Saved ${d.title}</div>`;
                this.loadLibrary(true);
            } else div.innerHTML = `<div class="text-danger">${d.error}</div>`;
        } catch(e) { div.innerHTML = 'Error'; }
    }

    async getRecommendations() {
        const target = document.getElementById('rec_target_song').value;
        const div = document.getElementById('recommendation-results');
        div.innerHTML = 'Loading...';
        try {
            const res = await fetch(`${this.apiBase}/recommend`, {
                method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({target_song: target})
            });
            const d = await res.json();
            div.innerHTML = '<ul class="list-group">'+d.recommendations.map(r=>`<li class="list-group-item">${r.title} (${(r.similarity*100).toFixed(0)}%)</li>`).join('')+'</ul>';
        } catch(e) { div.innerHTML = 'Error'; }
    }
}

window.app = new LyricAnalyzerApp();