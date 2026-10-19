from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from model_cache import ModelResponseCache


class ModelCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cache = ModelResponseCache(Path(self.temporary.name) / "cache")
        self.key = hashlib.sha256(b"request-signature-one").hexdigest()

    def test_keys_do_not_mix_and_response_is_only_stored_payload(self):
        other = hashlib.sha256(b"request-signature-two").hexdigest()
        value = {"summary": "最终一章的证据", "facts": [{"supported": True}]}
        self.assertIsNone(self.cache.get(self.key))
        self.cache.put(self.key, value)
        self.cache.put(other, {"summary": "另一请求"})
        self.assertEqual(self.cache.get(self.key), value)
        self.assertEqual(self.cache.get(other), {"summary": "另一请求"})
        path = self.cache.directory / f"{self.key}.json"
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), value)
        # A fresh instance can reuse the completed response after a restart.
        self.assertEqual(ModelResponseCache(self.cache.directory).get(self.key), value)

    def test_bad_keys_cannot_become_paths(self):
        for key in ("../outside", "/tmp/outside", "a" * 63, "z" * 64, "a" * 64 + "\n", None):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    self.cache.get(key)
                with self.assertRaises(ValueError):
                    self.cache.put(key, {})
        self.assertEqual(list(self.cache.directory.iterdir()), [])

    def test_corrupt_non_object_and_non_json_values_are_misses(self):
        path = self.cache.directory / f"{self.key}.json"
        for content in (b"{broken", b"[]", b"null", b'{"number":NaN}', b"\xff\xfe"):
            path.write_bytes(content)
            self.assertIsNone(self.cache.get(self.key))

    def test_expiry_uses_file_age_and_can_be_disabled(self):
        self.cache.put(self.key, {"summary": "previous response"})
        path = self.cache.directory / f"{self.key}.json"
        old = time.time() - 120
        os.utime(path, (old, old))
        self.assertIsNone(ModelResponseCache(self.cache.directory, max_age=60).get(self.key))
        self.assertEqual(ModelResponseCache(self.cache.directory, max_age=None).get(self.key),
                         {"summary": "previous response"})
        self.assertIsNone(ModelResponseCache(self.cache.directory, max_age=0).get(self.key))

    def test_atomic_replacement_keeps_previous_entry_if_commit_fails(self):
        original = {"summary": "completed before failure"}
        self.cache.put(self.key, original)
        with patch("model_cache.os.replace", side_effect=OSError("simulated write failure")):
            self.cache.put(self.key, {"summary": "new response"})
        self.assertEqual(self.cache.get(self.key), original)
        self.assertEqual([path.name for path in self.cache.directory.iterdir()], [f"{self.key}.json"])

    def test_delete_invalidates_only_the_requested_key_and_is_best_effort(self):
        other = hashlib.sha256(b"other-valid-response").hexdigest()
        self.cache.put(self.key, {"nonsense": True})
        self.cache.put(other, {"summary": "valid response"})
        self.assertTrue(self.cache.delete(self.key))
        self.assertIsNone(self.cache.get(self.key))
        self.assertFalse(self.cache.delete(self.key))
        self.assertEqual(self.cache.get(other), {"summary": "valid response"})
        with self.assertRaises(ValueError):
            self.cache.delete("../outside")
        with patch("model_cache.Path.unlink", side_effect=PermissionError("read-only cache")):
            self.assertFalse(self.cache.delete(other))

    def test_unavailable_private_directory_disables_cache_without_failing(self):
        with patch("model_cache.Path.chmod", side_effect=PermissionError("private permissions unavailable")):
            disabled = ModelResponseCache(Path(self.temporary.name) / "not-private")
        disabled.put(self.key, {"ok": True})
        self.assertIsNone(disabled.get(self.key))
        self.assertEqual(list(disabled.directory.iterdir()), [])
        with patch("model_cache.tempfile.mkstemp", side_effect=OSError("disk full")):
            self.cache.put(self.key, {"ok": True})
        self.assertIsNone(self.cache.get(self.key))

    def test_only_json_dicts_and_private_permissions(self):
        for value in ([], "text", None, 3):
            with self.assertRaises(TypeError):
                self.cache.put(self.key, value)
        with self.assertRaises(ValueError):
            self.cache.put(self.key, {"value": float("nan")})
        self.assertEqual(list(self.cache.directory.iterdir()), [])
        self.cache.put(self.key, {"ok": True})
        self.assertEqual(self.cache.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.cache.directory / f"{self.key}.json").stat().st_mode & 0o777, 0o600)

    def test_concurrent_replacements_never_expose_partial_json(self):
        self.cache.put(self.key, {"writer": "seed", "body": "seed" * 2000})

        def writer(index):
            identity = str(index)
            for _ in range(10):
                self.cache.put(self.key, {"writer": identity, "body": identity * 2000})
                value = self.cache.get(self.key)
                self.assertIsInstance(value, dict)
                self.assertEqual(value["body"], value["writer"] * 2000)

        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(writer, range(4)))
        self.assertEqual(len(list(self.cache.directory.iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
