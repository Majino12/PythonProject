import subprocess
import sys


def install_packages():
    packages = [
        "Flask",
        "numpy",
        "nltk",
        "scikit-learn",
        "networkx",
        "textstat",
        "textblob",
        "spacy",
        "keybert",
        "textacy",
        "sumy",
        "requests",
        "beautifulsoup4",
        "lxml",
        "flask-sqlalchemy",
        "flask-login",
        "flask-wtf",
        "email-validator",
        "python-dotenv",
        "gunicorn",
        "pandas",
        "plotly",
        "wordcloud",
        "matplotlib",
        "seaborn",
        "Pillow",
        "openpyxl",
        "reportlab",
        "flask-caching",
        "flask-limiter",
        "python-docx",
        "pdfplumber",
        "chardet",
        "psutil",
        "Werkzeug"
    ]

    for package in packages:
        print(f"安装 {package}...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", package])

    # 安装 spaCy 英语模型
    print("安装 spaCy 英语模型...")
    subprocess.check_call([sys.executable, "-m", "spacy", "download", "en_core_web_sm"])

    print("所有依赖安装完成！")


if __name__ == "__main__":
    install_packages()