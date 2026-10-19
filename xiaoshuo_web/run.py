"""Start the local service; do not expose uploaded books on the network by default."""
import os
import sys
import webbrowser
from threading import Timer


def main():
    try:
        from app import app
    except ImportError as exc:
        print(f"缺少依赖 {exc.name}，请先运行：python -m pip install -r requirements.txt")
        return 1
    host = os.environ.get("NOVEL_HOST", "127.0.0.1")
    port = int(os.environ.get("NOVEL_PORT", "5003"))
    url = f"http://127.0.0.1:{port}"
    print(f"小说分析服务：{url}\n按 Ctrl+C 停止。")
    timer = None
    if os.environ.get("NOVEL_OPEN_BROWSER", "1").lower() not in {"0", "false", "no"}:
        timer = Timer(1.5, lambda: webbrowser.open_new(url))
        timer.daemon = True
        timer.start()
    try:
        app.run(host=host, port=port, debug=False, use_reloader=False)
    except OSError as exc:
        print(f"服务启动失败：{exc}")
        return 1
    finally:
        if timer:
            timer.cancel()
        app.extensions["novel_jobs"].shutdown(wait=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
