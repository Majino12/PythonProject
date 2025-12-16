#!/usr/bin/env python3
import os
import sys
import time
import webbrowser
import subprocess
import platform

# 配置
BACKEND_PORT = 5002
FRONTEND_PORT = 8000
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))


def check_env():
    print("🔍 Checking environment...")
    req_file = os.path.join(PROJECT_ROOT, 'backend', 'requirements.txt')
    if not os.path.exists(req_file):
        print("❌ Missing backend/requirements.txt")
        sys.exit(1)
    # 这里可以添加 pip install 逻辑，但为了速度通常建议手动安装


def start_backend():
    print(f"🔧 Starting Backend (Port {BACKEND_PORT})...")
    backend_dir = os.path.join(PROJECT_ROOT, 'backend')
    env = os.environ.copy()
    env['PYTHONPATH'] = backend_dir

    # Windows/Linux 兼容
    cmd = [sys.executable, "app.py"]
    return subprocess.Popen(cmd, cwd=backend_dir, env=env)


def start_frontend():
    print(f"🎨 Starting Frontend (Port {FRONTEND_PORT})...")
    frontend_dir = os.path.join(PROJECT_ROOT, 'frontend')
    # 使用 Python 自带 http.server
    cmd = [sys.executable, "-m", "http.server", str(FRONTEND_PORT)]
    return subprocess.Popen(cmd, cwd=frontend_dir)


def main():
    check_env()

    # 1. 尝试初始化数据库
    print("🗃️  Initializing Database...")
    try:
        subprocess.run([sys.executable, "backend/database.py"], cwd=PROJECT_ROOT)
        # 注意：这里假设 database.py 直接运行会执行 init，如果不是，请调用 init_database.py
    except:
        pass

    # 2. 启动服务
    be_process = start_backend()
    time.sleep(2)  # 等待后端
    fe_process = start_frontend()

    url = f"http://localhost:{FRONTEND_PORT}/professional_crawler.html"
    print(f"\n🚀 System Running!")
    print(f"👉 Open: {url}")

    webbrowser.open(url)

    try:
        be_process.wait()
        fe_process.wait()
    except KeyboardInterrupt:
        print("\n👋 Shutting down...")
        be_process.terminate()
        fe_process.terminate()


if __name__ == "__main__":
    main()