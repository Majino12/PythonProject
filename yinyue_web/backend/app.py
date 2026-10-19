"""Same-origin Flask API for the local lyrics workspace."""

from datetime import datetime, timezone
import logging
import math
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

try:
    from .config import Config
    from .database import DatabaseManager
except ImportError:
    from config import Config
    from database import DatabaseManager

logger = logging.getLogger(__name__)


class APIError(Exception):
    def __init__(self, message, code="invalid_request", status=400):
        super().__init__(message)
        self.message, self.code, self.status = message, code, status


def create_app(config=None, *, database=None, lyric_analyzer=None, song_crawler=None):
    app = Flask(__name__, static_folder=None)
    app.config.from_object(Config)
    if config is not None:
        if isinstance(config, dict):
            app.config.update(config)
        else:
            app.config.from_object(config)
    app.json.ensure_ascii = False
    app.json.sort_keys = False
    if lyric_analyzer is None:
        if __package__:
            from .lyric_analyzer import LocalLyricAnalyzer
        else:
            from lyric_analyzer import LocalLyricAnalyzer
        if __package__:
            from .sentiment_models import ModelSentimentEngine
        else:
            from sentiment_models import ModelSentimentEngine
        lyric_analyzer = LocalLyricAnalyzer(ModelSentimentEngine(
            model_dir=app.config.get("MODEL_DIR"), enabled=app.config.get("MODELS_ENABLED", True)))
    if song_crawler is None:
        if __package__:
            from .crawler import UnifiedCrawler
        else:
            from crawler import UnifiedCrawler
        song_crawler = UnifiedCrawler(cache_dir=Path(app.config["CACHE_DIR"]) / "lyrics")
    database = database if database is not None else DatabaseManager(app.config["DATABASE_PATH"])
    app.extensions["database"] = database
    app.extensions["lyric_analyzer"] = lyric_analyzer
    app.extensions["song_crawler"] = song_crawler

    def body():
        if not request.is_json:
            raise APIError("请使用 JSON 格式提交请求。", "unsupported_media_type", 415)
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise APIError("请求内容必须是有效的 JSON 对象。", "invalid_json")
        return data

    def text_field(data, key, limit, label):
        value = data.get(key, "")
        if not isinstance(value, str):
            raise APIError(f"{label}必须是文本。", "invalid_field")
        value = value.strip()
        if not value:
            raise APIError(f"请填写{label}。", "missing_field")
        if len(value) > limit:
            raise APIError(f"{label}不能超过 {limit} 个字符。", "field_too_long")
        if "\x00" in value:
            raise APIError(f"{label}包含无效字符。", "invalid_field")
        return value

    def song_fields(data, include_lyrics=False):
        if not isinstance(data, dict):
            raise APIError("每首歌曲必须包含歌名和歌手。", "invalid_song")
        song = {
            "title": text_field(data, "title", app.config["MAX_TITLE_LENGTH"], "歌名"),
            "artist": text_field(data, "artist", app.config["MAX_ARTIST_LENGTH"], "歌手"),
        }
        if include_lyrics:
            song["lyrics"] = text_field(data, "lyrics", app.config["MAX_LYRICS_LENGTH"], "歌词")
        return song

    def positive_integer(value, label, maximum, default=None):
        if value is None and default is not None:
            return default
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
            raise APIError(f"{label}必须是 1 到 {maximum} 之间的整数。", "invalid_field")
        return value

    def query_integer(key, default, maximum):
        try:
            number = int(request.args.get(key, str(default)))
        except (TypeError, ValueError):
            raise APIError(f"{key}必须是整数。", "invalid_query")
        if not 1 <= number <= maximum:
            raise APIError(f"{key}必须在 1 到 {maximum} 之间。", "invalid_query")
        return number

    def persist(song):
        analysis = lyric_analyzer.analyze_lyrics_comprehensive(song["lyrics"])
        vector = lyric_analyzer.create_emotion_vector(analysis)
        song_id = database.store_crawled_song_with_analysis(song, analysis, vector)
        saved = database.get_song(song_id) if song_id else None
        if saved is None or saved.get("analysis") is None:
            raise RuntimeError("Song/analysis persistence did not complete")
        return saved

    def saved_payload(song):
        return {**song, "success": True, "status": "success", "song_id": song["id"],
                "db_saved": True, "saved": True, "song": song}

    def process_crawl(song, use_cache=True):
        result = song_crawler.crawl_song(song["artist"], song["title"], use_cache=use_cache)
        if result.get("status") != "success":
            status = result.get("http_status", 502)
            if status not in (400, 404, 408, 422, 429, 500, 502, 503, 504):
                status = 502
            return {
                **song, "success": False, "status": "failed", "db_saved": False,
                "error": result.get("error") or "未能获取歌词，请稍后重试或手动粘贴歌词。",
                "error_code": result.get("error_code") or "crawl_failed",
            }, status
        crawled = song_fields({
            "title": result.get("title", song["title"]),
            "artist": result.get("artist", song["artist"]),
            "lyrics": result.get("lyrics"),
        }, include_lyrics=True)
        crawled["source"] = "crawler"
        payload = saved_payload(persist(crawled))
        payload["cached"] = bool(result.get("cached") or result.get("from_cache")
                                 or result.get("source") == "cache")
        return payload, 200

    @app.errorhandler(APIError)
    def api_error(error):
        return jsonify(success=False, status="failed", error=error.message, error_code=error.code), error.status

    @app.errorhandler(HTTPException)
    def http_error(error):
        messages = {404: "未找到请求的资源。", 405: "请求方法不受支持。",
                    413: "请求内容过大，请缩短歌词或减少批次。",
                    400: "请求格式无效。", 415: "请使用 JSON 格式提交请求。"}
        return jsonify(success=False, status="failed",
                       error=messages.get(error.code, "请求无法处理。"),
                       error_code=f"http_{error.code}"), error.code

    @app.errorhandler(Exception)
    def unexpected_error(error):
        logger.exception("Request failed: %s %s", request.method, request.path)
        return jsonify(success=False, status="failed",
                       error="服务暂时无法完成请求，请稍后重试。",
                       error_code="internal_error"), 500

    @app.after_request
    def response_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["X-Frame-Options"] = "DENY"
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    def health():
        with database.get_connection() as conn:
            conn.execute("SELECT COUNT(*) FROM songs").fetchone()
        return jsonify(status="ok", service="yinyue-web", version=app.config["VERSION"],
                       analyzer=type(lyric_analyzer).__name__,
                       models=lyric_analyzer.model_status() if hasattr(lyric_analyzer, "model_status") else {})

    @app.post("/api/add_song")
    def add_song():
        song = song_fields(body(), include_lyrics=True)
        song["source"] = "manual"
        return jsonify(saved_payload(persist(song)))

    @app.post("/api/professional/crawl")
    def crawl_song():
        data = body()
        song = song_fields(data)
        use_cache = data.get("use_cache", True)
        if not isinstance(use_cache, bool):
            raise APIError("use_cache必须是布尔值。", "invalid_field")
        result, status = process_crawl(song, use_cache)
        return jsonify(result), status

    @app.post("/api/professional/crawl_batch")
    def crawl_batch():
        songs = body().get("songs")
        if not isinstance(songs, list) or not 1 <= len(songs) <= app.config["MAX_BATCH_SIZE"]:
            raise APIError(f"每批请提交 1 到 {app.config['MAX_BATCH_SIZE']} 首歌曲。", "invalid_batch")
        # Validate the whole batch before the first network request or write.
        songs = [song_fields(song) for song in songs]
        results = []
        for song in songs:
            try:
                result, status = process_crawl(song)
            except APIError as error:
                status = error.status
                result = {**song, "success": False, "status": "failed", "db_saved": False,
                          "error": error.message, "error_code": error.code}
            except Exception:
                logger.exception("Failed to process a batch song")
                status = 500
                result = {**song, "success": False, "status": "failed", "db_saved": False,
                          "error": "该歌曲处理失败，未完成保存。", "error_code": "processing_failed"}
            result["http_status"] = status
            results.append(result)
        succeeded = sum(result["status"] == "success" for result in results)
        return jsonify(crawled_songs=results,
                       summary={"total": len(results), "succeeded": succeeded,
                                "failed": len(results) - succeeded})

    @app.get("/api/library")
    def library():
        page = query_integer("page", 1, 1000000)
        per_page = query_integer("per_page", 20, 100)
        query = request.args.get("q", "").strip().casefold()
        if len(query) > 200:
            raise APIError("搜索内容不能超过 200 个字符。", "invalid_query")
        sentiment = request.args.get("sentiment", "").strip().lower()
        if sentiment not in ("", "all", "positive", "negative", "neutral", "uncertain", "mixed", "unanalyzed"):
            raise APIError("不支持该情感筛选条件。", "invalid_query")
        sort = request.args.get("sort", "recent")
        if sort == "newest":
            sort = "recent"
        if sort not in ("recent", "oldest", "title", "artist"):
            raise APIError("不支持该排序方式。", "invalid_query")
        songs = database.get_all_songs_with_analysis()
        if query:
            songs = [song for song in songs if query in song["title"].casefold()
                     or query in song["artist"].casefold()]
        if sentiment not in ("", "all"):
            songs = [song for song in songs if song["sentiment"].lower() == sentiment]
        if sort in ("title", "artist"):
            songs.sort(key=lambda song: (song[sort].casefold(), song["id"]))
        elif sort == "oldest":
            songs.reverse()
        total = len(songs)
        offset = (page - 1) * per_page
        return jsonify(songs=songs[offset:offset + per_page], total=total, page=page,
                       per_page=per_page, total_pages=max(1, math.ceil(total / per_page)))

    @app.get("/api/stats")
    def stats():
        return jsonify(database.get_analysis_stats())

    @app.get("/api/songs/<int:song_id>")
    def song_detail(song_id):
        song = database.get_song(song_id)
        if song is None:
            raise APIError("找不到这首歌曲。", "song_not_found", 404)
        return jsonify(song=song)

    @app.post("/api/songs/<int:song_id>/reanalyze")
    def reanalyze_song(song_id):
        song = database.get_song(song_id)
        if song is None:
            raise APIError("找不到这首歌曲。", "song_not_found", 404)
        # Updating only analysis preserves all song metadata, IDs and favorites.
        lyrics = text_field(song, "lyrics", app.config["MAX_LYRICS_LENGTH"], "歌词")
        analysis = lyric_analyzer.analyze_lyrics_comprehensive(lyrics)
        failures = (analysis.get("metadata", {}).get("fallback_reasons")
                    or analysis.get("model_sentiment", {}).get("fallback_reasons"))
        if failures:
            raise APIError("专用模型当前不可用，已保留原有分析。请安装或修复模型后重试。",
                           "model_unavailable", 503)
        vector = lyric_analyzer.create_emotion_vector(analysis)
        database.save_analysis(song_id, analysis, vector)
        return jsonify(saved_payload(database.get_song(song_id)))

    @app.delete("/api/songs/<int:song_id>")
    def delete_song(song_id):
        if not database.delete_song(song_id):
            raise APIError("找不到这首歌曲。", "song_not_found", 404)
        return jsonify(success=True, song_id=song_id)

    @app.post("/api/recommend")
    def recommend():
        data = body()
        top_k = positive_integer(data.get("top_k"), "推荐数量", 20, default=5)
        songs = database.get_all_songs_with_analysis()
        if "song_id" in data:
            song_id = positive_integer(data["song_id"], "歌曲 ID", 9223372036854775807)
            target = next((song for song in songs if song["id"] == song_id), None)
        else:
            title = text_field(data, "target_song", app.config["MAX_TITLE_LENGTH"], "目标歌名")
            matches = [song for song in songs if song["title"] == title]
            if len(matches) > 1:
                raise APIError("存在同名歌曲，请使用歌曲 ID 选择具体歌曲。", "ambiguous_song")
            target = matches[0] if matches else None
        if target is None:
            raise APIError("找不到这首歌曲。", "song_not_found", 404)
        if not target.get("analysis") or not target.get("emotion_vector"):
            raise APIError("这首歌曲尚无可用分析，请重新添加歌词后再推荐。", "analysis_unavailable", 422)
        recommendations = lyric_analyzer.recommend_songs(target["id"], songs, top_k=top_k)
        return jsonify(target_song=target, recommendations=recommendations)

    @app.get("/api/export")
    def export():
        songs = database.get_all_songs_with_analysis()
        response = jsonify(version=app.config["VERSION"],
                           exported_at=datetime.now(timezone.utc).isoformat(),
                           total=len(songs), songs=songs)
        response.headers["Content-Disposition"] = 'attachment; filename="yinyue-library.json"'
        return response

    @app.get("/")
    def index():
        return send_from_directory(app.config["FRONTEND_DIR"], "index.html")

    @app.get("/<path:path>")
    def static_files(path):
        if path == "api" or path.startswith("api/"):
            raise APIError("未找到该接口。", "not_found", 404)
        return send_from_directory(app.config["FRONTEND_DIR"], path)

    return app


if __name__ == "__main__":
    logging.basicConfig(level=Config.LOG_LEVEL, format=Config.LOG_FORMAT)
    application = create_app()
    application.run(host=application.config["HOST"], port=application.config["PORT"],
                    debug=application.config["DEBUG"], use_reloader=False)
