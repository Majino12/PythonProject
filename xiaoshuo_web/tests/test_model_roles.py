"""Role-specific reasoning/budgets and response-local cache telemetry."""
import json
import tempfile
import unittest
from unittest.mock import Mock

from model_client import ModelClient


class ModelRoleTests(unittest.TestCase):
    def make_client(self, **overrides):
        settings = {"NOVEL_MODEL_PROVIDER": "ollama", "NOVEL_MODEL_RETRIES": 0, "NOVEL_CACHE_ENABLED": "0"}
        settings.update(overrides)
        self.session = Mock()
        response = Mock(status_code=200)
        response.json.return_value = {"done": True, "done_reason": "stop", "message": {"content": '{"ok":true}'}}
        self.session.post.return_value = response
        return ModelClient(settings, session=self.session)

    def test_ollama_thinking_is_optional_with_larger_verifier_budget(self):
        client = self.make_client()
        self.assertEqual(client.describe()["models"], {"map": "qwen3.5:9b", "reduce": "qwen3.5:9b",
                                                      "verify": "qwen3.5:9b", "quote": "qwen3.5:4b"})
        for role in ("map", "reduce", "verify", "quote"):
            client.generate_json([], role=role)
            request = self.session.post.call_args.kwargs
            self.assertFalse(request["json"]["think"])
            self.assertEqual(request["json"]["options"]["num_predict"], 8192 if role in {"verify", "quote"} else 4096)
            self.assertEqual(request["timeout"], (10, 300 if role in {"verify", "quote"} else 180))

    def test_local_quote_inherits_verifier_connection_but_defaults_to_4b(self):
        client = self.make_client(NOVEL_VERIFY_BASE_URL="http://127.0.0.1:11435", NOVEL_VERIFY_API_KEY="local-key")
        client.generate_json([], role="quote")
        args, request = self.session.post.call_args
        self.assertEqual(args[0], "http://127.0.0.1:11435/api/chat")
        self.assertEqual(request["json"]["model"], "qwen3.5:4b")
        self.assertEqual(request["headers"]["Authorization"], "Bearer local-key")
        self.assertNotIn("local-key", json.dumps(client.describe()))
        self.assertEqual(self.make_client(NOVEL_MODEL="shared-local").stages["quote"]["model"], "shared-local")

    def test_compatible_quote_inherits_verifier_and_accepts_all_role_overrides(self):
        client = self.make_client(NOVEL_VERIFY_PROVIDER="compatible", NOVEL_VERIFY_BASE_URL="https://verify.example/v1",
                                  NOVEL_VERIFY_MODEL="cloud-reviewer", NOVEL_VERIFY_API_KEY="verify-key")
        self.assertEqual(client.stages["quote"]["provider"], "compatible")
        self.assertEqual(client.stages["quote"]["base_url"], "https://verify.example/v1")
        self.assertEqual(client.stages["quote"]["api_key"], "verify-key")
        self.assertEqual(client.stages["quote"]["model"], "cloud-reviewer")
        client = self.make_client(NOVEL_QUOTE_PROVIDER="compatible", NOVEL_QUOTE_BASE_URL="https://quote.example/v1",
                                  NOVEL_QUOTE_MODEL="other-reviewer", NOVEL_QUOTE_API_KEY="quote-key",
                                  NOVEL_QUOTE_THINKING="enabled", NOVEL_QUOTE_TIMEOUT=25, NOVEL_QUOTE_MAX_OUTPUT_TOKENS=256)
        self.session.post.return_value.json.return_value = {"choices": [{"finish_reason": "stop", "message": {"content": '{"ok":true}'}}]}
        client.generate_json([], role="quote")
        args, request = self.session.post.call_args
        self.assertEqual(args[0], "https://quote.example/v1/chat/completions")
        self.assertEqual(request["json"]["model"], "other-reviewer")
        self.assertEqual(request["json"]["thinking"], {"type": "enabled"})
        self.assertEqual(request["json"]["max_tokens"], 256)
        self.assertEqual(request["timeout"], (10, 25))
        self.assertEqual(request["headers"]["Authorization"], "Bearer quote-key")

    def test_explicit_role_controls_accept_boolean_and_named_thinking(self):
        for value in (False, "false", "disabled"):
            client = self.make_client(NOVEL_VERIFY_THINKING=value, NOVEL_VERIFY_MAX_OUTPUT_TOKENS=128, NOVEL_VERIFY_TIMEOUT=1)
            client.generate_json([], role="verify")
            request = self.session.post.call_args.kwargs
            self.assertFalse(request["json"]["think"])
            self.assertEqual(request["json"]["options"]["num_predict"], 128)
            self.assertEqual(request["timeout"], (10, 1))
        for value in (True, "true", "enabled"):
            client = self.make_client(NOVEL_VERIFY_THINKING=value)
            client.generate_json([], role="verify")
            self.assertTrue(self.session.post.call_args.kwargs["json"]["think"])

    def test_cloud_verifier_does_not_send_thinking_unless_explicit(self):
        client = self.make_client(NOVEL_VERIFY_PROVIDER="compatible", NOVEL_VERIFY_BASE_URL="https://models.example/v1",
                                  NOVEL_VERIFY_MODEL="reviewer")
        self.session.post.return_value.json.return_value = {"choices": [{"finish_reason": "stop", "message": {"content": '{"ok":true}'}}]}
        client.generate_json([], role="verify")
        self.assertNotIn("thinking", self.session.post.call_args.kwargs["json"])
        client = self.make_client(NOVEL_VERIFY_PROVIDER="compatible", NOVEL_VERIFY_BASE_URL="https://models.example/v1",
                                  NOVEL_VERIFY_MODEL="reviewer", NOVEL_VERIFY_THINKING="disabled")
        self.session.post.return_value.json.return_value = {"choices": [{"finish_reason": "stop", "message": {"content": '{"ok":true}'}}]}
        client.generate_json([], role="verify")
        self.assertEqual(self.session.post.call_args.kwargs["json"]["thinking"], {"type": "disabled"})

    def test_cache_hit_is_per_response_and_never_serialized(self):
        with tempfile.TemporaryDirectory() as directory:
            client = self.make_client(NOVEL_CACHE_ENABLED="1", DATA_DIR=directory)
            live = client.generate_json([], role="verify")
            cached = client.generate_json([], role="verify")
            self.assertFalse(live.cache_hit)
            self.assertTrue(cached.cache_hit)
            self.assertEqual(json.loads(json.dumps(live)), {"ok": True})
            self.assertEqual(json.loads(json.dumps(cached)), {"ok": True})
            self.assertEqual(self.session.post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
