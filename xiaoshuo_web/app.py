"""Local novel-analysis web service with real asynchronous task state."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from flask import Flask, abort, jsonify, make_response, render_template, request
from werkzeug.exceptions import RequestEntityTooLarge

from config import Config
from document_loader import DocumentError, load_document, validate_text
from jobs import JobStore, QueueFullError


SAMPLE_TEXT = """第一章 归乡
林秋在多年后回到河畔的小镇，母亲留下的信只有一句话：去找旧桥下的木盒。她找到木盒时，邻居陈明正在桥边修船。他说自己从未见过这个盒子，却准确说出了盒底刻着的年份。
第二章 旧账
林秋打开木盒，里面是二十年前修桥的账册。账册最后一页有陈明父亲的签名，也有一张救济粮的收据。她原以为父亲卷走修桥款离乡，现在才知道他用钱买粮救了遭洪水围困的村民。
第三章 河灯
陈明承认，父亲曾因恐惧承担责任而隐瞒真相。林秋没有撕掉账册，而是把复印件交给村里，留下原件。天黑时，两人在新桥上放下一盏河灯。林秋决定留下来整理镇上的旧档案，但她还没有原谅所有人。
"""


def create_app(config=None, analyzer=None, model_client=None):
    load_dotenv(Path(__file__).resolve().parent / ".env", override=False)
    application = Flask(__name__)
    application.config.update(Config.from_environment())
    if config:
        application.config.update(config)
    data_dir = Path(application.config["DATA_DIR"]).expanduser().resolve()
    if data_dir == Path(application.static_folder).resolve() or Path(application.static_folder).resolve() in data_dir.parents:
        raise ValueError("NOVEL_DATA_DIR 必须位于 static 公开目录之外。")

    if model_client is None:
        from model_client import ModelClient
        model_client = ModelClient(settings=application.config)
    if analyzer is None:
        from novel_analyzer import SimpleNovelAnalyzer
        analyzer = SimpleNovelAnalyzer(settings=application.config, model_client=model_client)
    jobs = JobStore(data_dir, workers=application.config["JOB_WORKERS"], queue_size=application.config["JOB_QUEUE_SIZE"])
    application.extensions["novel_jobs"] = jobs
    application.extensions["novel_analyzer"] = analyzer
    application.extensions["novel_model_client"] = model_client

    @application.before_request
    def protect_legacy_uploads():
        # Earlier releases saved private source novels/reports in public static/.
        if request.path.startswith(("/static/uploads/", "/static/results/")):
            abort(404)

    @application.errorhandler(RequestEntityTooLarge)
    def upload_too_large(_error):
        return jsonify(error=f"请求超过 {application.config['MAX_CONTENT_LENGTH'] // (1024 * 1024)} MB 上限，未提交分析。"), 413

    @application.get("/")
    def index():
        return render_template("index.html")

    @application.get("/dashboard")
    def dashboard():
        return render_template("dashboard.html")

    @application.get("/about")
    def about():
        return render_template("about.html")

    @application.get("/features")
    def features():
        return render_template("features.html")

    @application.get("/tutorial")
    def tutorial():
        return render_template("tutorial.html")

    @application.get("/result/<result_id>")
    def show_result(result_id):
        result = jobs.get_result(result_id)
        if result is None:
            return render_template("error.html", error="找不到该分析结果，或分析尚未完成。"), 404
        return render_template("result.html", result=result)

    @application.get("/api/models")
    def api_models():
        return jsonify(model_client.check_health() if request.args.get("check") == "1" else model_client.describe())

    @application.post("/analyze")
    def analyze():
        try:
            analysis_type = request.form.get("analysis_type", "text")
            mode = request.form.get("analysis_mode", request.form.get("mode", "auto"))
            if mode not in {"auto", "model", "baseline"}:
                return jsonify(error="分析模式必须是 auto、model 或 baseline。"), 400
            if mode == "model" and not model_client.configured:
                return jsonify(error="尚未配置可用模型。请在 .env 配置 Ollama 或兼容 API，或选择基础分析模式。"), 400
            title = (request.form.get("title") or "未命名文档").strip()[:500]
            source = "text"
            content = None
            url = None
            max_chars = application.config["MAX_ANALYSIS_TEXT_LENGTH"]
            if analysis_type == "text":
                content = validate_text(request.form.get("text_content", ""), max_chars)
            elif analysis_type == "file":
                upload = request.files.get("file")
                if not upload or not upload.filename:
                    return jsonify(error="未选择文件。"), 400
                # No source novel is ever written into a public upload directory.
                title = Path(upload.filename.replace("\\", "/")).name[:500]
                source = title
                content = load_document(upload.read(), title, max_chars,
                                        application.config["MAX_DOCUMENT_EXPANDED_BYTES"])
            elif analysis_type in {"url_news", "url_novel"}:
                url = request.form.get("url", "").strip()
                parsed = urlparse(url)
                if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                    return jsonify(error="请提供不含用户名或密码的 HTTP/HTTPS 网页地址。"), 400
                source = url
                title = request.form.get("title") or parsed.hostname
            else:
                return jsonify(error="不支持的输入类型。"), 400

            def perform_analysis(progress):
                novel_title, novel_content = title, content
                if url:
                    progress({"stage": "fetching", "progress": 0})
                    novel_title, novel_content = analyzer.fetch_content_from_url(url, analysis_type)
                    validate_text(novel_content, max_chars)
                return analyzer.analyze_novel_text(novel_content, novel_title,
                                                  progress_callback=progress, mode=mode)

            task_id = jobs.submit(perform_analysis, title, source, analysis_type, mode)
            return jsonify(success=True, task_id=task_id, result_id=task_id), 202
        except DocumentError as exc:
            return jsonify(error=str(exc)), 400
        except QueueFullError as exc:
            response = jsonify(error=str(exc))
            response.headers["Retry-After"] = "10"
            return response, 429
        except RequestEntityTooLarge:
            raise
        except Exception:
            application.logger.exception("Failed to submit analysis")
            return jsonify(error="无法提交分析任务，请查看本地服务日志。"), 500

    @application.get("/analysis/status/<task_id>")
    def analysis_status(task_id):
        job = jobs.get_job(task_id)
        if job is None:
            return jsonify(error="不存在此分析任务。"), 404
        return jsonify(job)

    @application.get("/example")
    def example_data():
        return jsonify(title="河灯（示例短篇）", text_content=SAMPLE_TEXT, analysis_type="text")

    @application.get("/export/<result_id>")
    def export_result(result_id):
        result = jobs.get_result(result_id)
        if result is None:
            return jsonify(error="找不到该分析结果。"), 404
        format_type = request.args.get("format", "json")
        if format_type == "json":
            response = make_response(json.dumps(result, ensure_ascii=False, indent=2))
            response.headers["Content-Type"] = "application/json; charset=utf-8"
            response.headers["Content-Disposition"] = f'attachment; filename="analysis_{result_id}.json"'
        elif format_type == "html":
            response = make_response(render_template("export_report.html", result=result))
            response.headers["Content-Disposition"] = f'attachment; filename="report_{result_id}.html"'
        elif format_type == "pdf":
            return jsonify(error="请导出 HTML 报告并使用浏览器的“打印 → 保存为 PDF”。"), 400
        else:
            return jsonify(error="不支持的导出格式。"), 400
        return response

    @application.get("/api/history")
    def api_history():
        history = []
        for job in jobs.list_jobs()[:100]:
            result = jobs.get_result(job["task_id"]) or {}
            info = result.get("novel_info", {})
            metadata = result.get("analysis_metadata", {})
            duration = job.get("duration_seconds")
            history.append({"id": job["task_id"], "title": info.get("title", job.get("title", "未命名文档")),
                            "timestamp": job["created_at"], "type": job["type"], "status": job["status"],
                            "chapters": info.get("total_chapters"), "error": job.get("error"),
                            "analysis_status": metadata.get("status"),
                            "mode": metadata.get("mode", job.get("mode")),
                            "coverage_ratio": metadata.get("coverage_ratio"),
                            "duration": f"{duration}s" if duration is not None else None,
                            "duration_seconds": duration})
        return jsonify(history)

    @application.get("/api/stats")
    def api_stats():
        all_jobs = jobs.list_jobs()
        application_stats = {"queue_size": sum(job["status"] == "queued" for job in all_jobs),
                             "active_tasks": sum(job["status"] == "processing" for job in all_jobs),
                             "total_analyses": len(all_jobs),
                             "completed": sum(job["status"] == "completed" for job in all_jobs),
                             "failed": sum(job["status"] == "failed" for job in all_jobs)}
        try:
            import psutil
            memory = psutil.virtual_memory()
            disk = psutil.disk_usage(str(data_dir))
            system = {"cpu": {"percent": psutil.cpu_percent(interval=None)},
                      "memory": {"used": round(memory.used / 1024 ** 3, 1),
                                 "total": round(memory.total / 1024 ** 3, 1), "percent": memory.percent},
                      "disk": {"used": round(disk.used / 1024 ** 3, 1),
                               "total": round(disk.total / 1024 ** 3, 1), "percent": disk.percent}}
            return jsonify(system=system, application=application_stats)
        except (ImportError, OSError):
            return jsonify(system=None, application=application_stats, metrics_error="系统指标暂不可用。")

    return application


# WSGI entry point. Keep a single process; workers are bounded inside JobStore.
app = create_app()


if __name__ == "__main__":
    app.run(host=os.environ.get("NOVEL_HOST", "127.0.0.1"),
            port=int(os.environ.get("NOVEL_PORT", "5003")), debug=False, use_reloader=False)
