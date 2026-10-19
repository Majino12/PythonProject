#!/usr/bin/env python3
"""Reproduce a small qualitative emotion check; this is not an accuracy benchmark."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR / "backend"))
from emotion_models import EmotionEngine, MODEL_SPEC, default_emotion_model_dir


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=default_emotion_model_dir())
    parser.add_argument("--fixtures", type=Path, default=APP_DIR / "tests/fixtures/emotion_examples.json")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    raw = args.fixtures.read_bytes()
    fixture = json.loads(raw)
    engine = EmotionEngine(args.model_dir)
    if not engine.status()["available"]:
        print(json.dumps(engine.status(), ensure_ascii=False), file=sys.stderr)
        return 1
    totals = {language: {"count": 0, "top1_matches": 0, "top3_matches": 0}
              for language in ("zh", "ko", "en")}
    rows = []
    for example in fixture["examples"]:
        started = time.monotonic()
        result = engine.analyze(example["text"], example["language"])
        ranked = [row["label"] for row in result["scores"]]
        expected = set(example["expected"])
        top1 = bool(expected.intersection(ranked[:1])) if expected else None
        top3 = bool(expected.intersection(ranked[:3])) if expected else None
        rows.append(dict(example, result=result, top1_match=top1, top3_match=top3,
                         elapsed_seconds=round(time.monotonic() - started, 3)))
        if expected:
            counts = totals[example["language"]]
            counts["count"] += 1
            counts["top1_matches"] += int(top1)
            counts["top3_matches"] += int(top3)
        print(f"{example['id']}: available={result['available']} top3={ranked[:3]}", flush=True)
    output = {"schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
              "model": MODEL_SPEC, "fixtures_sha256": hashlib.sha256(raw).hexdigest(),
              "interpretation": "Only a frozen original smoke set; no representative lyrics accuracy is estimated. Top-three agreement concerns an annotator's expected emotion and does not validate numeric score calibration. Korean uses cross-lingual transfer, not Korean NLI fine-tuning.",
              "fixture_purpose": fixture["purpose"], "summary_by_language": totals, "results": rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(totals, ensure_ascii=False), flush=True)
    return 0 if all(row["result"]["available"] for row in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
