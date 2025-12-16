import os
import logging
from datetime import timedelta


class Config:
    """应用配置"""
    # 基础配置
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'lyric-analyzer-2025-secret-key'
    DEBUG = os.environ.get('DEBUG', 'True').lower() == 'true'

    # 路径配置
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    DATA_DIR = os.path.join(BASE_DIR, 'data')
    CACHE_DIR = os.path.join(DATA_DIR, 'cache')
    LOGS_DIR = os.path.join(BASE_DIR, 'logs')

    # 数据库
    DATABASE_PATH = os.path.join(DATA_DIR, 'songs.db')
    DATABASE_URI = f'sqlite:///{DATABASE_PATH}'

    # 爬虫配置
    CRAWLER_TIMEOUT = 30
    CACHE_ENABLED = True
    CACHE_EXPIRY = timedelta(hours=24)

    # 日志配置
    LOG_LEVEL = logging.INFO
    LOG_FORMAT = '%(asctime)s - %(name)s - %(levelname)s - %(message)s'

    @classmethod
    def init_directories(cls):
        """初始化目录"""
        for directory in [cls.DATA_DIR, cls.CACHE_DIR, cls.LOGS_DIR]:
            os.makedirs(directory, exist_ok=True)
        # 缓存子目录
        os.makedirs(os.path.join(cls.CACHE_DIR, 'lyrics'), exist_ok=True)

    @classmethod
    def get_logger_config(cls):
        return {
            'version': 1,
            'disable_existing_loggers': False,
            'formatters': {'standard': {'format': cls.LOG_FORMAT}},
            'handlers': {
                'console': {
                    'level': cls.LOG_LEVEL,
                    'class': 'logging.StreamHandler',
                    'formatter': 'standard',
                }
            },
            'loggers': {
                '': {'handlers': ['console'], 'level': cls.LOG_LEVEL}
            }
        }


Config.init_directories()