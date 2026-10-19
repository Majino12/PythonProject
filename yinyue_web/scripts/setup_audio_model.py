#!/usr/bin/env python3
"""Explicitly install the pinned multilingual Whisper model (about 1.62 GB).

The web server never downloads model files or sends audio to a model service.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from audio_transcriber import AUDIO_MODEL, default_audio_model_dir


def download_model(model_dir):
    from huggingface_hub import hf_hub_download

    destination = Path(model_dir)
    destination.mkdir(parents=True, exist_ok=True)
    manifest = destination / "manifest.json"
    manifest.unlink(missing_ok=True)
    files = {}
    for filename in AUDIO_MODEL["files"]:
        print(f"[audio] Downloading {filename} @ {AUDIO_MODEL['revision']}", flush=True)
        path = Path(hf_hub_download(
            repo_id=AUDIO_MODEL["model"], revision=AUDIO_MODEL["revision"],
            filename=filename, local_dir=str(destination),
        ))
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        sha256 = digest.hexdigest()
        if filename == "model.bin" and sha256 != AUDIO_MODEL["weights_sha256"]:
            raise ValueError("Downloaded audio weights do not match the pinned SHA-256.")
        files[filename] = {"sha256": sha256, "size": path.stat().st_size}
    result = {
        "schema_version": 1, "model": AUDIO_MODEL["model"],
        "revision": AUDIO_MODEL["revision"], "license": AUDIO_MODEL["license"],
        "downloaded_at": datetime.now(timezone.utc).isoformat(), "files": files,
    }
    temporary = destination / "manifest.json.tmp"
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(manifest)
    print(f"[audio] Ready: {destination}", flush=True)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=default_audio_model_dir())
    args = parser.parse_args(argv)
    try:
        download_model(args.model_dir)
    except Exception as error:
        print(f"Audio model setup failed: {error}", file=sys.stderr)
        print("Install backend/requirements-audio.txt and retry; completed downloads can be reused.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
