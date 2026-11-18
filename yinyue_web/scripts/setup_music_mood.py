#!/usr/bin/env python3
"""Explicitly install pinned music-CLAP safetensors; runtime stays offline."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from music_mood import MUSIC_MOOD_MODEL, default_music_mood_dir


def install(model_dir):
    from huggingface_hub import hf_hub_download

    destination = Path(model_dir)
    destination.mkdir(parents=True, exist_ok=True)
    manifest_path = destination / "manifest.json"
    manifest_path.unlink(missing_ok=True)
    metadata = {
        "schema_version": 1,
        "model": MUSIC_MOOD_MODEL["model"],
        "revision": MUSIC_MOOD_MODEL["revision"],
        "license": MUSIC_MOOD_MODEL["license"],
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "files": {},
    }
    for name in MUSIC_MOOD_MODEL["files"]:
        print(f"Downloading {name}", flush=True)
        path = Path(hf_hub_download(
            repo_id=MUSIC_MOOD_MODEL["model"], revision=MUSIC_MOOD_MODEL["revision"],
            filename=name, local_dir=str(destination), token=False,
        ))
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        checksum = digest.hexdigest()
        if name == "model.safetensors" and checksum != MUSIC_MOOD_MODEL["weights_sha256"]:
            raise ValueError("Downloaded music model does not match the upstream pinned SHA256.")
        metadata["files"][name] = {"size": path.stat().st_size, "sha256": checksum}
    temporary = destination / "manifest.json.tmp"
    temporary.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    temporary.replace(manifest_path)
    print(f"Music model ready: {destination}", flush=True)
    return metadata


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=default_music_mood_dir())
    args = parser.parse_args(argv)
    try:
        install(args.model_dir)
    except Exception as error:
        print(f"Music model setup failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
