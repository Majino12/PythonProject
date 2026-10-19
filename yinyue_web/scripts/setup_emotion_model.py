#!/usr/bin/env python3
"""Explicitly install the pinned multilingual NLI emotion checkpoint (about 0.6 GB)."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from emotion_models import MODEL_SPEC, default_emotion_model_dir


def download_emotion_model(destination):
    from huggingface_hub import hf_hub_download

    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    manifest = destination / "manifest.json"
    manifest.unlink(missing_ok=True)
    files = {}
    for filename in MODEL_SPEC["files"]:
        print(f"[emotion] Downloading {filename} @ {MODEL_SPEC['revision']}", flush=True)
        path = Path(hf_hub_download(repo_id=MODEL_SPEC["model"], filename=filename,
                    revision=MODEL_SPEC["revision"], local_dir=str(destination)))
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        files[filename] = {"size": path.stat().st_size, "sha256": digest.hexdigest()}
    metadata = {"schema_version": 1, "task": "emotion", "model": MODEL_SPEC["model"],
                "revision": MODEL_SPEC["revision"], "license": MODEL_SPEC["license"],
                "downloaded_at": datetime.now(timezone.utc).isoformat(), "files": files}
    temporary = destination / "manifest.json.tmp"
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(manifest)
    print(f"[emotion] Ready: {destination}", flush=True)
    return metadata


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=default_emotion_model_dir())
    args = parser.parse_args(argv)
    try:
        download_emotion_model(args.model_dir)
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        print(f"Emotion setup failed: {error}", file=sys.stderr)
        print("Install backend/requirements-models.txt first; retrying reuses downloaded assets.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
