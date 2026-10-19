"""Explicit model connectivity check. No model download or paid inference."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
from model_client import ModelClient

load_dotenv(Path(__file__).resolve().parents[1] / '.env')
report = ModelClient().check_health()
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(0 if report['available'] else 1)
