#!/usr/bin/env python3
"""Explicitly download pinned model assets; the web application never downloads.

Run from any directory, for example:
    python yinyue_web/scripts/setup_models.py --language both
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from sentiment_models import MODEL_SPECS, default_model_dir


def download_model(language, model_dir):
    # Import only for an explicit setup action. Its default TLS verification
    # remains enabled, and no credentials or lyrics are required.
    from huggingface_hub import hf_hub_download

    spec = MODEL_SPECS[language]
    destination = Path(model_dir) / language
    destination.mkdir(parents=True, exist_ok=True)
    manifest = destination / "manifest.json"
    # Never leave an old completion marker while files are being replaced.
    manifest.unlink(missing_ok=True)
    files = {}
    for filename in spec["files"]:
        print(f"[{language}] Downloading {filename} @ {spec['revision']}", flush=True)
        downloaded = Path(hf_hub_download(
            repo_id=spec["model"],
            filename=filename,
            revision=spec["revision"],
            local_dir=str(destination),
        ))
        digest = hashlib.sha256()
        with downloaded.open("rb") as asset:
            for block in iter(lambda: asset.read(1024 * 1024), b""):
                digest.update(block)
        files[filename] = {"size": downloaded.stat().st_size, "sha256": digest.hexdigest()}
    metadata = {
        "schema_version": 1,
        "language": language,
        "model": spec["model"],
        "revision": spec["revision"],
        "license": spec["license"],
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "files": files,
    }
    temporary = destination / "manifest.json.tmp"
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(manifest)
    print(f"[{language}] Ready: {destination}", flush=True)
    return metadata


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=("both", "zh", "ko"), default="both")
    parser.add_argument("--model-dir", type=Path, default=default_model_dir())
    args = parser.parse_args(argv)
    languages = ("zh", "ko") if args.language == "both" else (args.language,)
    try:
        for language in languages:
            download_model(language, args.model_dir)
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        print(f"Model setup failed: {error}", file=sys.stderr)
        print("Install backend/requirements-models.txt and retry; completed downloads can be reused.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
