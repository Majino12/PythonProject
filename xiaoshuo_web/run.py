import os
import sys
import webbrowser
import time
from threading import Timer


def open_browser():
    print("正在打开浏览器...")
    webbrowser.open_new("http://127.0.0.1:5003")


def main():
    print("=" * 50)
    print("   小说分析系统启动器")
    print("=" * 50)

    # 简单依赖检查
    try:
        import flask
        import psutil
        import nltk
    except ImportError as e:
        print(f"\n[错误] 缺少必要依赖: {e.name}")
        print("请先运行安装命令: pip install -r requirements.txt")
        input("\n按回车键退出...")
        sys.exit(1)

    # 导入应用
    try:
        from app import app
    except Exception as e:
        print(f"\n[错误] 导入应用失败: {e}")
        print("请检查 app.py 或项目结构是否完整。")
        input("\n按回车键退出...")
        sys.exit(1)

    print("\n服务启动中，访问地址: http://127.0.0.1:5003")
    print("按 Ctrl+C 可停止服务\n")

    # 在独立线程中打开网页，防止阻塞启动过程
    if os.environ.get('WERKZEUG_RUN_MAIN') != 'true':
        Timer(1.5, open_browser).start()

    # 启动 Flask 应用
    # debug=False 避免报错
    # 如果需要调试，请临时改为 True
    try:
        app.run(host='0.0.0.0', port=5003, debug=False)
    except OSError as e:
        if "Address already in use" in str(e):
            print("\n[错误] 端口 5003 已被占用。")
            print("请关闭占用该端口的程序，或修改 app.py 中的端口号。")
        else:
            print(f"\n[错误] 应用启动失败: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n[错误] 未知错误: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()