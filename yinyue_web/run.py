#!/usr/bin/env python3
"""Start the frontend and API together; run from any working directory."""
import argparse
import os
import sys
import threading
import webbrowser


def main():
    parser = argparse.ArgumentParser(description='音绪 · 歌词情感工作台')
    parser.add_argument('--host', default=os.environ.get('YINYUE_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('YINYUE_PORT', '5002')))
    parser.add_argument('--no-browser', action='store_true', help='不自动打开浏览器')
    parser.add_argument('--debug', action='store_true', help='开启本地调试模式')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('端口必须在 1–65535 之间')
    try:
        from backend.app import create_app
        from werkzeug.serving import make_server
    except ModuleNotFoundError as exc:
        print(f'缺少依赖 {exc.name}。请运行：{sys.executable} -m pip install -r backend/requirements.txt', file=sys.stderr)
        return 1
    application = create_app({'DEBUG': args.debug})
    # Bind first so a port conflict never opens an unrelated service.
    server = make_server(args.host, args.port, application, threaded=True)
    url = f'http://{args.host if args.host != "0.0.0.0" else "127.0.0.1"}:{args.port}'
    print(f'音绪已启动：{url}\n按 Ctrl+C 关闭。', flush=True)
    if not args.no_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已关闭音绪。')
    finally:
        server.server_close()
        jobs = application.extensions.get('audio_jobs')
        if jobs is not None:
            jobs.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
