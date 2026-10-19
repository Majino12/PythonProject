"""Application defaults. Importing configuration does not create files."""

import logging
import os
from datetime import timedelta
from pathlib import Path


class Config:
    BASE_DIR = str(Path(__file__).resolve().parent.parent)
    DATA_DIR = os.environ.get("YINYUE_DATA_DIR", os.path.join(BASE_DIR, "data"))
    CACHE_DIR = os.environ.get("YINYUE_CACHE_DIR", os.path.join(DATA_DIR, "cache"))
    LOGS_DIR = os.path.join(BASE_DIR, "logs")
    DATABASE_PATH = os.environ.get("YINYUE_DATABASE_PATH", os.path.join(DATA_DIR, "songs.db"))
    DATABASE_URI = f"sqlite:///{DATABASE_PATH}"
    FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
    DEBUG = os.environ.get("YINYUE_DEBUG", "false").lower() in {"true", "1", "yes"}
    HOST = os.environ.get("YINYUE_HOST", "127.0.0.1")
    PORT = int(os.environ.get("YINYUE_PORT", "5002"))
    MAX_CONTENT_LENGTH = 2 * 1024 * 1024
    MAX_TITLE_LENGTH = 200
    MAX_ARTIST_LENGTH = 200
    MAX_LYRICS_LENGTH = 50000
    MAX_BATCH_SIZE = 10
    VERSION = "2.0.0"
    CRAWLER_TIMEOUT = 12
    CACHE_ENABLED = True
    CACHE_EXPIRY = timedelta(hours=24)
    LOG_LEVEL = logging.INFO
    LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

    @classmethod
    def init_directories(cls):
        for directory in (cls.DATA_DIR, cls.CACHE_DIR, cls.LOGS_DIR):
            os.makedirs(directory, exist_ok=True)

    @classmethod
    def get_logger_config(cls):
        return {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {"standard": {"format": cls.LOG_FORMAT}},
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "standard",
                    "level": cls.LOG_LEVEL,
                }
            },
            "root": {"handlers": ["console"], "level": cls.LOG_LEVEL},
        }
