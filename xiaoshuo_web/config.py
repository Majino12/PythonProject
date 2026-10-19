"""Application configuration. Novel text and reports stay outside static/."""
import os
from pathlib import Path


class Config:
    BASE_DIR = Path(__file__).resolve().parent
    DATA_DIR = str(BASE_DIR / "data")
    MAX_CONTENT_LENGTH = 64 * 1024 * 1024
    MAX_FORM_MEMORY_SIZE = 64 * 1024 * 1024
    MAX_ANALYSIS_TEXT_LENGTH = 20_000_000
    MAX_DOCUMENT_EXPANDED_BYTES = 256 * 1024 * 1024
    JOB_WORKERS = 1
    JOB_QUEUE_SIZE = 2
    ALLOWED_EXTENSIONS = {"txt", "pdf", "docx"}

    @classmethod
    def from_environment(cls):
        """Read after dotenv so a local .env is respected on startup."""
        values = {name: getattr(cls, name) for name in dir(cls) if name.isupper()}
        values["DATA_DIR"] = os.environ.get("NOVEL_DATA_DIR", cls.DATA_DIR)
        for name in ("MAX_CONTENT_LENGTH", "MAX_FORM_MEMORY_SIZE", "MAX_ANALYSIS_TEXT_LENGTH",
                     "MAX_DOCUMENT_EXPANDED_BYTES", "JOB_WORKERS", "JOB_QUEUE_SIZE"):
            if "NOVEL_" + name in os.environ:
                values[name] = int(os.environ["NOVEL_" + name])
        return values
