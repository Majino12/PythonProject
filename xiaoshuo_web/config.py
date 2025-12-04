import os


class Config:
    # 基础配置
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-key-12345'

    # 路径配置
    BASE_DIR = os.path.abspath(os.path.dirname(__file__))
    UPLOAD_FOLDER = os.path.join(BASE_DIR, 'static', 'uploads')
    RESULTS_FOLDER = os.path.join(BASE_DIR, 'static', 'results')

    # 文件配置
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB
    ALLOWED_EXTENSIONS = {'txt', 'pdf', 'docx'}

    # 分析配置
    MAX_ANALYSIS_TEXT_LENGTH = 1000000