"""Audio jobs and provider-bound music search endpoints."""
from io import BytesIO
from pathlib import Path
import tempfile
from urllib.parse import urlsplit

from flask import jsonify, request, send_file
from werkzeug.utils import secure_filename

try:
    from .audio_jobs import AudioJobs, QueueFull
except ImportError:
    from audio_jobs import AudioJobs, QueueFull


ALLOWED_AUDIO = {'.mp3', '.wav', '.m4a', '.flac', '.ogg', '.oga', '.aiff', '.aif', '.aac', '.opus', '.webm'}


def register_media_api(app, transcriber, music_service):
    try:
        from .music_search import MusicSearchError
    except ImportError:
        from music_search import MusicSearchError
    jobs = AudioJobs(transcriber)
    app.extensions['audio_jobs'] = jobs
    app.extensions['audio_transcriber'] = transcriber
    app.extensions['music_search'] = music_service

    def failure(message, code, status):
        return jsonify(success=False, error=message, error_code=code), status

    @app.errorhandler(MusicSearchError)
    def search_error(error):
        return failure(str(error), error.code, error.http_status)

    @app.before_request
    def bound_media_requests():
        if request.method == 'POST' and request.path.startswith('/api/audio/'):
            origin = request.headers.get('Origin')
            if request.headers.get('Sec-Fetch-Site') == 'cross-site' or (origin and urlsplit(origin).netloc != request.host):
                return failure('请从本地应用页面上传音频。', 'invalid_origin', 403)
        if request.is_json and request.content_length and request.content_length > 2 * 1024 * 1024:
            return failure('请求内容过大，请缩短歌词。', 'request_too_large', 413)

    @app.get('/api/audio/status')
    def audio_status():
        return jsonify(transcriber.status())

    @app.post('/api/audio/jobs')
    def upload_audio():
        if transcriber.status().get('status') != 'ready':
            return failure('音频模型尚未就绪，请安装音频依赖并运行 scripts/setup_audio_model.py 后重启。', 'model_unavailable', 503)
        uploaded = request.files.get('file')
        language = request.form.get('language', 'auto')
        if language not in {'auto', 'zh', 'ko', 'en'}:
            return failure('请选择自动检测、中文、韩文或英文。', 'invalid_language', 400)
        if uploaded is None or not uploaded.filename:
            return failure('请选择需要识别的音频文件。', 'missing_file', 400)
        suffix = Path(uploaded.filename).suffix.lower()
        if suffix not in ALLOWED_AUDIO:
            return failure('请选择 MP3、WAV、M4A、FLAC、OGG 等受支持的音频文件。', 'invalid_audio_format', 400)
        directory = Path(app.config['UPLOAD_DIR'])
        directory.mkdir(parents=True, exist_ok=True)
        path = None
        try:
            with tempfile.NamedTemporaryFile(dir=directory, suffix=suffix, prefix='audio-', delete=False) as handle:
                path = Path(handle.name)
                size = 0
                while chunk := uploaded.stream.read(64 * 1024):
                    size += len(chunk)
                    if size > app.config['MAX_AUDIO_BYTES']:
                        return failure('音频不能超过 30 MB。', 'audio_too_large', 413)
                    handle.write(chunk)
                if not size:
                    return failure('音频文件为空。', 'empty_audio', 400)
            job_id = jobs.submit(path, None if language == 'auto' else language)
            path = None  # The job owns cleanup from here on.
            return jsonify(success=True, job=jobs.get(job_id)), 202
        except QueueFull as error:
            return failure(str(error), 'queue_full', 429)
        finally:
            if path is not None:
                path.unlink(missing_ok=True)

    @app.get('/api/audio/jobs/<job_id>')
    def audio_job(job_id):
        job = jobs.get(job_id)
        return jsonify(job=job) if job else failure('任务不存在或已过期，请重新上传。', 'job_not_found', 404)

    @app.delete('/api/audio/jobs/<job_id>')
    def cancel_audio(job_id):
        job = jobs.cancel(job_id)
        return jsonify(job=job) if job else failure('任务不存在或已过期。', 'job_not_found', 404)

    def query():
        text = request.args.get('q', '').strip()
        if not 1 <= len(text) <= 200:
            return None
        return text

    @app.get('/api/search/lyrics')
    def search_lyrics():
        text = query()
        if text is None:
            return failure('请输入 1–200 个字符的歌名或歌手。', 'invalid_query', 400)
        return jsonify(results=music_service.search_lyrics(text), provider='LRCLIB')

    @app.get('/api/search/audio')
    def search_audio():
        text = query()
        if text is None:
            return failure('请输入 1–200 个字符的搜索内容。', 'invalid_query', 400)
        return jsonify(results=music_service.search_audio(text), provider='Wikimedia Commons')

    @app.get('/api/search/lyrics/<int:lyric_id>')
    def lyric_detail(lyric_id):
        return jsonify(song=music_service.get_lyrics(lyric_id))

    @app.get('/api/search/lyrics/<int:lyric_id>/download')
    def download_lyrics(lyric_id):
        item = music_service.get_lyrics(lyric_id)
        synced = request.args.get('format', 'txt') == 'lrc'
        text = item.get('synced_lyrics') if synced else item.get('plain_lyrics')
        if not text:
            return failure('这个版本没有可下载的对应歌词。', 'lyrics_unavailable', 404)
        name = secure_filename(item.get('title', 'lyrics'))[:100] or 'lyrics'
        suffix = 'lrc' if synced else 'txt'
        return send_file(BytesIO(text.encode('utf-8-sig')), mimetype='text/plain; charset=utf-8',
                         as_attachment=True, download_name=f'{name}.{suffix}')

    @app.get('/api/search/audio/download')
    def download_audio():
        file_id = request.args.get('id', '')
        if not file_id or len(file_id) > 300:
            return failure('无效的音频记录。', 'invalid_audio_id', 400)
        directory = Path(app.config['DOWNLOAD_DIR'])
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=directory, prefix='licensed-', delete=False) as handle:
            path = Path(handle.name)
        try:
            metadata = music_service.download_audio(file_id, path)
            name = secure_filename(file_id.removeprefix('File:'))[:180] or 'licensed-audio.ogg'
            # A bounded in-memory response lets us remove the temporary download
            # immediately, even if the browser disconnects halfway through.
            content = BytesIO(path.read_bytes())
            response = send_file(content, as_attachment=True, download_name=name,
                                 mimetype=metadata.get('mime', 'application/octet-stream'))
            response.headers['X-Audio-License'] = metadata.get('license', '').encode('ascii', 'ignore').decode()
            return response
        finally:
            path.unlink(missing_ok=True)
