"""Private, atomic cache for parsed model JSON responses.

The caller hashes the exact model/request identity. This module receives no
prompts or credentials and stores only that hash and the parsed response.
Importing it performs no filesystem or network operations.
"""
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time


_KEY = re.compile(r"[0-9a-f]{64}\Z")


def _invalid_constant(_value):
    raise ValueError("Non-finite values are not valid JSON")


class ModelResponseCache:
    def __init__(self, directory, max_age=7 * 24 * 60 * 60):
        """max_age is seconds; None disables expiry and zero expires immediately."""
        if max_age is not None:
            max_age = float(max_age)
            if not math.isfinite(max_age) or max_age < 0:
                raise ValueError("max_age must be a nonnegative number of seconds or None")
        self.max_age = max_age
        self.directory = Path(directory).expanduser()
        self._available = False
        try:
            self.directory = self.directory.resolve()
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.directory.chmod(0o700)
            self._available = True
        except OSError:
            # Never fall back to writing a cache with unknown privacy settings.
            pass

    def _path(self, key):
        if not isinstance(key, str) or not _KEY.fullmatch(key):
            raise ValueError("Cache key must be a lowercase SHA-256 hexadecimal digest")
        return self.directory / f"{key}.json"

    def get(self, key):
        path = self._path(key)
        if not self._available:
            return None
        try:
            with path.open("r", encoding="utf-8") as stream:
                # Check the opened file so concurrent replacement cannot pair
                # the timestamp of one response with another response's data.
                if self.max_age is not None and time.time() - os.fstat(stream.fileno()).st_mtime >= self.max_age:
                    return None
                result = json.load(stream, parse_constant=_invalid_constant)
            return result if isinstance(result, dict) else None
        except (OSError, ValueError):
            return None

    def put(self, key, value):
        path = self._path(key)
        if not isinstance(value, dict):
            raise TypeError("Only parsed JSON objects can be cached")
        if not self._available:
            return
        temporary = None
        try:
            descriptor, temporary = tempfile.mkstemp(prefix=".pending-", suffix=".json", dir=self.directory)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                # mkstemp creates mode 0600; replacing never opens a public file.
                json.dump(value, stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        except OSError:
            # Disk exhaustion or read-only folders must not discard an otherwise
            # successful paid model response. A later call may try the cache again.
            pass
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def delete(self, key):
        """Invalidate one exact request after downstream domain validation fails."""
        path = self._path(key)
        if not self._available:
            return False
        try:
            path.unlink()
            return True
        except OSError:
            return False
