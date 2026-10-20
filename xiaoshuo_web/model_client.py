"""Explicit JSON client with independent map, quote, verify and reduce models."""
import json
import hashlib
import os
from pathlib import Path
import re
import time
from urllib.parse import urlsplit

import requests


class ModelError(RuntimeError):
    """Safe error message: never includes provider responses or credentials."""


class ModelResponse(dict):
    """Ordinary JSON object with per-response, non-serialized cache identity."""
    __slots__ = ('_cache_key', 'cache_hit')

    def __init__(self, value, cache_key=None, cache_hit=False):
        super().__init__(value)
        self._cache_key = cache_key
        self.cache_hit = cache_hit


def _invalid_constant(_value):
    raise ValueError('Non-finite JSON value')


class ModelClient:
    def __init__(self, settings=None, session=None, sleep=time.sleep):
        self.settings = settings or {}
        self.session = session or requests.Session()
        self.sleep = sleep
        self.provider = str(self._get('NOVEL_MODEL_PROVIDER', 'disabled')).lower()
        self.timeout = self._number('NOVEL_MODEL_TIMEOUT', 180, 1, 1800)
        self.retries = int(self._number('NOVEL_MODEL_RETRIES', 2, 0, 5))
        self.max_input = int(self._number('NOVEL_MAX_PROMPT_CHARS', 24000, 1000, 1000000))
        self.max_output = int(self._number('NOVEL_MAX_OUTPUT_TOKENS', 4096, 128, 32768))
        self.context = int(self._number('NOVEL_CONTEXT_TOKENS', 32768, 4096, 262144))
        self.stages = {role: self._stage(role) for role in ('map', 'reduce', 'verify')}
        self.stages['quote'] = self._stage('quote')
        self.configured = all(self._ready(stage) for stage in self.stages.values())
        self.cache = None
        if self.configured and str(self._get('NOVEL_CACHE_ENABLED', '1')).lower() in ('1', 'true', 'yes'):
            from model_cache import ModelResponseCache
            data_dir = self._get('DATA_DIR', self._get('NOVEL_DATA_DIR', str(Path(__file__).resolve().parent / 'data')))
            self.cache = ModelResponseCache(Path(data_dir) / 'model_cache')

    def _get(self, key, default=None):
        return self.settings.get(key, os.environ.get(key, default))

    def _number(self, name, default, minimum, maximum):
        try:
            value = float(self._get(name, default))
            if not minimum <= value <= maximum:
                raise ValueError
            return value
        except (ValueError, TypeError):
            raise ValueError(f'{name} 必须在 {minimum}–{maximum} 之间') from None

    def _stage(self, role):
        prefix = 'NOVEL_' + role.upper()
        inherited = self.stages['verify'] if role == 'quote' else None
        provider = str(self._get(prefix + '_PROVIDER', inherited['provider'] if inherited else self.provider)).lower()
        if provider not in ('disabled', 'ollama', 'compatible'):
            raise ValueError('模型提供方须为 disabled、ollama 或 compatible')
        if inherited:
            # A cloud verifier keeps its endpoint/auth/model unless quote is
            # explicitly overridden. Local default quote support uses 4B; an
            # explicit shared NOVEL_MODEL still applies to local installations.
            default_model = self._get('NOVEL_MODEL', 'qwen3.5:4b') if provider == 'ollama' else inherited['model']
            url = str(self._get(prefix + '_BASE_URL', inherited['base_url'])).rstrip('/')
            model = str(self._get(prefix + '_MODEL', default_model))
            key = str(self._get(prefix + '_API_KEY', inherited['api_key']))
        else:
            default_url = 'http://127.0.0.1:11434' if provider == 'ollama' else ''
            url = str(self._get(prefix + '_BASE_URL', self._get('NOVEL_BASE_URL', default_url))).rstrip('/')
            model_default = 'qwen3.5:9b' if provider == 'ollama' else ''
            model = str(self._get(prefix + '_MODEL', self._get('NOVEL_MODEL', model_default)))
            key = str(self._get(prefix + '_API_KEY', self._get('NOVEL_API_KEY', '')))
        if url:
            parsed = urlsplit(url)
            if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError(f'{prefix}_BASE_URL 必须是无凭据、无查询参数的 HTTP(S) 地址')
            if parsed.scheme == 'http' and parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
                raise ValueError('远程模型服务须使用 HTTPS；HTTP 仅限本机')
        thinking_default = 'disabled' if provider == 'ollama' else self._get('NOVEL_COMPATIBLE_THINKING', '')
        thinking = str(self._get(prefix + '_THINKING', thinking_default)).lower()
        thinking = {'true': 'enabled', 'false': 'disabled'}.get(thinking, thinking)
        if thinking not in ('', 'enabled', 'disabled'):
            raise ValueError('thinking 配置须为空、enabled/disabled 或 true/false')
        default_output = inherited['max_output'] if inherited else (max(self.max_output, 8192) if role == 'verify' else self.max_output)
        default_timeout = inherited['timeout'] if inherited else (max(self.timeout, 300) if role == 'verify' else self.timeout)
        max_output = int(self._number(prefix + '_MAX_OUTPUT_TOKENS', default_output, 128, 32768))
        timeout = self._number(prefix + '_TIMEOUT', default_timeout, 1, 1800)
        return {'provider': provider, 'model': model, 'base_url': url, 'api_key': key,
                'thinking': thinking, 'max_output': max_output, 'timeout': timeout}

    @staticmethod
    def _ready(stage):
        return bool(stage['provider'] != 'disabled' and stage['base_url'] and stage['model'])

    def describe(self):
        return {
            'configured': self.configured, 'provider': self.provider,
            'models': {role: stage['model'] for role, stage in self.stages.items()},
            'stages': {role: {'provider': stage['provider'], 'model': stage['model'], 'thinking': stage['thinking'],
                             'max_output_tokens': stage['max_output'], 'timeout_seconds': stage['timeout']}
                       for role, stage in self.stages.items()},
            'warnings': ([] if self.configured else ['尚未配置语义分析模型；基础模式仅提供全文摘录和统计。']),
            'availability_checked': False,
            'response_cache_enabled': self.cache is not None,
        }

    def check_health(self):
        """Explicit connectivity check; never starts downloads or inference."""
        report = self.describe()
        checked = {}
        report['availability_checked'] = True
        for role, stage in self.stages.items():
            fingerprint = (stage['provider'], stage['base_url'], stage['api_key'])
            if not self._ready(stage):
                report['stages'][role]['available'] = False
                continue
            try:
                if fingerprint not in checked:
                    path = '/api/tags' if stage['provider'] == 'ollama' else '/models'
                    response = self.session.get(stage['base_url'] + path, headers=self._headers(stage), timeout=(5, 15), allow_redirects=False)
                    if response.status_code != 200:
                        raise ModelError('无法读取模型列表')
                    body = response.json()
                    if not isinstance(body, dict):
                        raise ModelError('模型列表格式无效')
                    checked[fingerprint] = {item.get('name', item.get('id')) for item in body.get('models', body.get('data', [])) if isinstance(item, dict)}
                report['stages'][role]['available'] = stage['model'] in checked[fingerprint]
            except (requests.RequestException, ValueError, TypeError, ModelError):
                report['stages'][role]['available'] = False
        report['available'] = all(item.get('available', False) for item in report['stages'].values())
        return report

    @staticmethod
    def _headers(stage):
        headers = {'Content-Type': 'application/json'}
        if stage['api_key']:
            headers['Authorization'] = 'Bearer ' + stage['api_key']
        return headers

    @staticmethod
    def _parse_json(content):
        if not isinstance(content, str) or not content.strip():
            raise ModelError('模型未返回 JSON 正文')
        content = content.strip()
        if content.startswith('```'):
            content = re.sub(r'^```(?:json)?\s*', '', content, count=1)
            content = re.sub(r'\s*```$', '', content, count=1)
        try:
            result = json.loads(content, parse_constant=_invalid_constant)
        except (ValueError, TypeError):
            raise ModelError('模型返回了无效 JSON；本次结果未冒充成功') from None
        if not isinstance(result, dict):
            raise ModelError('模型 JSON 顶层必须是对象')
        return result

    def generate_json(self, messages, role='map'):
        if role not in self.stages:
            raise ValueError('未知模型阶段')
        stage = self.stages[role]
        if not self._ready(stage):
            raise ModelError(f'{role} 阶段未配置模型；请参考 README 配置 .env')
        if sum(len(message.get('content', '')) for message in messages) > self.max_input:
            raise ModelError('模型输入超过分块预算；请减小分块/汇总批次，正文未被截断')
        if stage['provider'] == 'ollama':
            path = '/api/chat'
            payload = {'model': stage['model'], 'messages': messages, 'stream': False, 'format': 'json',
                       'think': stage['thinking'] == 'enabled',
                       'truncate': False, 'shift': False,
                       'options': {'temperature': 0, 'num_ctx': self.context, 'num_predict': stage['max_output']}, 'keep_alive': '5m'}
        else:
            path = '/chat/completions'
            payload = {'model': stage['model'], 'messages': messages, 'stream': False, 'temperature': 0,
                       'max_tokens': stage['max_output'], 'response_format': {'type': 'json_object'}}
            if stage['thinking']:
                payload['thinking'] = {'type': stage['thinking']}
        cache_key = hashlib.sha256(json.dumps({'schema': 1, 'role': role, 'provider': stage['provider'],
                                              'endpoint': stage['base_url'], 'payload': payload},
                                             ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        if self.cache is not None:
            cached = self.cache.get(cache_key)
            if cached is not None:
                return ModelResponse(cached, cache_key, cache_hit=True)
        for attempt in range(self.retries + 1):
            try:
                response = self.session.post(stage['base_url'] + path, json=payload, headers=self._headers(stage),
                                             timeout=(10, stage['timeout']), allow_redirects=False)
                if response.status_code == 429 or response.status_code >= 500:
                    if attempt < self.retries:
                        self.sleep(min(8, 2 ** attempt))
                        continue
                if response.status_code != 200:
                    hint = '；请检查服务、模型名称和 API 密钥' if response.status_code in (400, 401, 403, 404) else ''
                    raise ModelError(f'{role} 模型请求失败（HTTP {response.status_code}）{hint}')
                try:
                    body = response.json()
                    if not isinstance(body, dict):
                        raise ModelError('模型服务返回了无效响应结构')
                    if stage['provider'] == 'ollama':
                        if body.get('error') or not body.get('done', False) or body.get('done_reason') == 'length':
                            raise ModelError('模型输出未完成；请减小分块或增大输出预算')
                        content = body['message']['content']
                    else:
                        choice = body['choices'][0]
                        if not isinstance(choice, dict):
                            raise ModelError('模型服务返回了无效响应结构')
                        if choice.get('finish_reason') != 'stop':
                            raise ModelError('模型输出未正常结束，拒绝将截断结果计为完成')
                        content = choice['message']['content']
                except (ValueError, KeyError, IndexError, TypeError):
                    raise ModelError('模型服务返回了无效响应结构') from None
                result = self._parse_json(content)
                if self.cache is not None:
                    self.cache.put(cache_key, result)
                return ModelResponse(result, cache_key if self.cache is not None else None)
            except requests.RequestException:
                if attempt == self.retries:
                    raise ModelError(f'{role} 模型连接失败或超时；请检查服务是否启动') from None
                self.sleep(min(8, 2 ** attempt))
        raise ModelError('模型请求失败')

    def invalidate_response(self, response):
        """Discard invalid domain output without invalidating another job's call.

        The analyzer calls this when valid JSON fails evidence/schema checks.
        There is no shared last-request key, so interleaved jobs remain isolated.
        """
        if self.cache is not None and isinstance(response, ModelResponse) and response._cache_key:
            return self.cache.delete(response._cache_key)
        return False
