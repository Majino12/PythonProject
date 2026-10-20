import json
import unittest
import tempfile
from unittest.mock import Mock
import requests
from model_client import ModelClient, ModelError


class ModelClientTests(unittest.TestCase):
    def client(self, **extra):
        settings = {'NOVEL_MODEL_PROVIDER': 'ollama', 'NOVEL_MODEL_RETRIES': 0, 'NOVEL_CACHE_ENABLED': '0'}
        settings.update(extra)
        self.session = Mock()
        return ModelClient(settings, self.session, sleep=lambda _: None)

    def respond(self, body, code=200):
        response = Mock(status_code=code)
        response.json.return_value = body
        self.session.post.return_value = response

    def test_local_json_request_and_stage_selection(self):
        client = self.client()
        self.respond({'done': True, 'done_reason': 'stop', 'message': {'content': '{"ok":true}'}})
        self.assertEqual(client.generate_json([{'role': 'user', 'content': 'Return JSON'}], 'reduce'), {'ok': True})
        args, kwargs = self.session.post.call_args
        self.assertTrue(args[0].endswith('/api/chat'))
        self.assertEqual(kwargs['json']['model'], 'qwen3.5:9b')
        self.assertFalse(kwargs['json']['think'])
        self.assertFalse(kwargs['json']['truncate'])
        self.assertFalse(kwargs['json']['shift'])
        self.assertFalse(kwargs['allow_redirects'])

    def test_mixed_provider_and_no_secret_in_metadata(self):
        client = self.client(NOVEL_REDUCE_PROVIDER='compatible', NOVEL_REDUCE_BASE_URL='https://api.example.com/v1', NOVEL_REDUCE_MODEL='strong', NOVEL_REDUCE_API_KEY='secret-value')
        self.respond({'choices': [{'finish_reason': 'stop', 'message': {'content': '{"summary":"结局"}'}}]})
        self.assertEqual(client.generate_json([], 'reduce')['summary'], '结局')
        self.assertEqual(self.session.post.call_args.kwargs['headers']['Authorization'], 'Bearer secret-value')
        self.assertNotIn('secret-value', json.dumps(client.describe()))
        self.assertNotIn('api.example', json.dumps(client.describe()))

    def test_no_silent_truncated_output(self):
        client = self.client()
        self.respond({'done': True, 'done_reason': 'length', 'message': {'content': '{"ok":true}'}})
        with self.assertRaises(ModelError): client.generate_json([])

    def test_invalid_json_rejected(self):
        client = self.client()
        for content in ('', '[]', 'not JSON', '{bad}', '{"value": NaN}'):
            self.respond({'done': True, 'message': {'content': content}})
            with self.assertRaises(ModelError): client.generate_json([])

    def test_oversize_input_rejected_before_request(self):
        client = self.client(NOVEL_MAX_PROMPT_CHARS=1000)
        with self.assertRaises(ModelError): client.generate_json([{'content': '字' * 1001}])
        self.session.post.assert_not_called()

    def test_transient_retry_but_no_auth_retry_or_body_leak(self):
        client = self.client(NOVEL_MODEL_RETRIES=2)
        self.respond({'secret': 'should-not-leak'}, code=401)
        with self.assertRaises(ModelError) as error: client.generate_json([])
        self.assertNotIn('should-not-leak', str(error.exception))
        self.assertEqual(self.session.post.call_count, 1)
        self.session.reset_mock()
        self.session.post.side_effect = requests.Timeout('secret prompt')
        with self.assertRaises(ModelError) as error: client.generate_json([])
        self.assertNotIn('secret prompt', str(error.exception))
        self.assertEqual(self.session.post.call_count, 3)

    def test_bad_endpoint_does_not_leak_credentials(self):
        for url in ('http://outside.example/v1', 'https://user:password@host/v1', 'https://host/v1?key=secret'):
            with self.assertRaises(ValueError) as error: self.client(NOVEL_BASE_URL=url)
            self.assertNotIn('password', str(error.exception))

    def test_unconfigured_never_claims_model_analysis(self):
        client = self.client(NOVEL_MODEL_PROVIDER='disabled')
        self.assertFalse(client.configured)
        with self.assertRaises(ModelError): client.generate_json([])

    def test_models_health_checks_exact_tags(self):
        client = self.client()
        response = Mock(status_code=200)
        response.json.return_value = {'models': [{'name': 'qwen3.5:4b'}]}
        self.session.get.return_value = response
        result = client.check_health()
        self.assertFalse(result['available'])
        self.assertFalse(result['stages']['map']['available'])
        self.assertTrue(result['stages']['quote']['available'])
        self.assertFalse(result['stages']['reduce']['available'])
        self.assertEqual(self.session.get.call_count, 1)

    def test_all_four_roles_are_reported_and_required_for_configuration(self):
        client = self.client()
        self.assertEqual(set(client.describe()['stages']), {'map', 'quote', 'verify', 'reduce'})
        self.assertTrue(client.configured)
        client = self.client(NOVEL_QUOTE_PROVIDER='disabled')
        self.assertFalse(client.configured)
        with self.assertRaises(ModelError):
            client.generate_json([], 'quote')

    def test_malformed_provider_structures_are_safe_errors(self):
        client = self.client()
        for body in ([], None, {'message': [], 'done': True}):
            self.respond(body)
            with self.assertRaises(ModelError): client.generate_json([])
        response = Mock(status_code=200)
        response.json.return_value = []
        self.session.get.return_value = response
        self.assertFalse(client.check_health()['available'])

    def test_repeated_requests_reuse_private_cache_and_new_prompt_misses(self):
        with tempfile.TemporaryDirectory() as directory:
            client = self.client(NOVEL_CACHE_ENABLED='1', DATA_DIR=directory)
            self.respond({'done': True, 'message': {'content': '{"ending":"未原谅"}'}})
            prompt = [{'role': 'user', 'content': 'one'}]
            self.assertEqual(client.generate_json(prompt), client.generate_json(prompt))
            self.assertEqual(self.session.post.call_count, 1)
            client.generate_json([{'role': 'user', 'content': 'two'}])
            self.assertEqual(self.session.post.call_count, 2)

    def test_invalid_cached_response_can_retry_without_evicting_other_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            client = self.client(NOVEL_CACHE_ENABLED='1', DATA_DIR=directory)
            prompt = [{'role': 'user', 'content': 'extract first chapter'}]
            other_prompt = [{'role': 'user', 'content': 'extract second chapter'}]
            self.respond({'done': True, 'message': {'content': '{"nonsense":true}'}})
            bad_live = client.generate_json(prompt)
            bad_cached = client.generate_json(prompt)
            self.assertEqual(self.session.post.call_count, 1)
            self.assertEqual(json.loads(json.dumps(bad_live)), {'nonsense': True})
            self.assertEqual(json.loads(json.dumps(bad_cached)), {'nonsense': True})
            self.respond({'done': True, 'message': {'content': '{"summary":[{"text":"a verified fact"}]}'}})
            valid_other = client.generate_json(other_prompt)
            # Validation of the earlier response can finish after another job's
            # request: its own identity, not the most recent key, is invalidated.
            self.assertTrue(client.invalidate_response(bad_cached))
            self.assertEqual(client.generate_json(other_prompt), valid_other)
            self.assertEqual(self.session.post.call_count, 2)
            fixed = client.generate_json(prompt)
            self.assertIn('summary', fixed)
            self.assertEqual(self.session.post.call_count, 3)
            self.assertEqual(client.generate_json(prompt), fixed)
            self.assertEqual(self.session.post.call_count, 3)
            self.assertFalse(client.invalidate_response({'nonsense': True}))

    def test_invalidation_without_cache_is_safe(self):
        client = self.client()
        self.respond({'done': True, 'message': {'content': '{"ok":true}'}})
        self.assertFalse(client.invalidate_response(client.generate_json([])))


if __name__ == '__main__': unittest.main()
