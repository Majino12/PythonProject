"""Local-only lyric transcription with pinned Whisper large-v3-turbo assets.

No model is fetched by this module. Run scripts/setup_audio_model.py explicitly.
CTranslate2 model.bin is a native tensor format, not a Python pickle.
"""

import os
from pathlib import Path

AUDIO_MODEL = {
    "model": "dropbox-dash/faster-whisper-large-v3-turbo",
    "revision": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
    "license": "MIT",
    "display_name": "Whisper large-v3-turbo",
    "files": ("config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json"),
    "weights_sha256": "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da",
}


def default_audio_model_dir():
    data = Path(os.environ.get("YINYUE_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
    model_root = Path(os.environ.get("YINYUE_MODEL_DIR", data / "models"))
    return Path(os.environ.get("YINYUE_AUDIO_MODEL_DIR", model_root / "audio"))

import hashlib
import importlib.util
import json
import math
import re
import threading
import time

SAMPLE_RATE = 16000
MAX_DURATION_SECONDS = 600
MAX_AUDIO_BYTES = 30 * 1024 * 1024
AUDIO_FORMATS = {".wav": "wav", ".mp3": "mp3", ".m4a": "mov", ".flac": "flac", ".ogg": "ogg", ".aiff": "aiff", ".aif": "aiff", ".aac": "aac", ".opus": "ogg", ".oga": "ogg", ".webm": "matroska"}
SUPPORTED_LANGUAGES = {None, "auto", "zh", "ko", "en"}
BASE_WARNING = "自动识别可能遗漏或误听歌词；伴奏、合唱、唱腔和语言切换会降低准确性，请试听并校对后再分析。"


class AudioTranscriptionError(RuntimeError):
    """A local transcription could not be completed."""

    def __init__(self, message, code="transcription_failed", http_status=422):
        super().__init__(message)
        self.message = message
        self.code = code
        self.http_status = http_status


class AudioModelUnavailable(AudioTranscriptionError):
    """No verified offline transcription model is available."""

    def __init__(self, message):
        super().__init__(message, "audio_model_unavailable", 503)


class AudioValidationError(AudioTranscriptionError, ValueError):
    """Unsupported, corrupt, empty or excessive audio input."""

    def __init__(self, message):
        super().__init__(message, "invalid_audio", 400)


class AudioCancelled(AudioTranscriptionError):
    """Cooperatively cancelled between decoder/inference steps."""

    def __init__(self, message="识别已取消。"):
        super().__init__(message, "cancelled", 409)


AudioTranscriptionCancelled = AudioCancelled


def _check_cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise AudioTranscriptionCancelled("识别已取消。")


def _progress(callback, stage, value):
    if callback:
        messages = {"decoding": "正在读取音频", "loading": "正在加载本机语音模型", "transcribing": "正在识别歌词", "complete": "歌词识别完成"}
        callback(max(0.0, min(1.0, float(value) / 100)), messages.get(stage, stage))


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def decode_audio(path, cancel_event=None):
    """Decode a local file with bounded samples, time, channels and frame count.

    File-like IO plus a fixed demuxer avoids URL/playlist input. Limit decoded
    samples rather than trusting duration metadata in compressed containers.
    """
    import av
    import numpy as np

    path = Path(path)
    if path.suffix.lower() not in AUDIO_FORMATS:
        raise AudioValidationError("支持 WAV、MP3、M4A、FLAC、OGG、AIFF、AAC、Opus 和 WebM 音频。")
    if not path.is_file() or path.stat().st_size == 0:
        raise AudioValidationError("音频文件为空或不存在。")
    if path.stat().st_size > MAX_AUDIO_BYTES:
        raise AudioValidationError("音频文件不能超过 30 MB。")
    max_samples = SAMPLE_RATE * MAX_DURATION_SECONDS
    # One bounded allocation: 38.4 MB for the maximum 10-minute mono signal.
    audio = np.empty(max_samples, dtype=np.float32)
    count = 0
    started = time.monotonic()
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)

    def append(frame):
        nonlocal count
        values = frame.to_ndarray().reshape(-1)
        if count + values.size > max_samples:
            raise AudioValidationError("音频时长不能超过 10 分钟。")
        audio[count:count + values.size] = values
        count += values.size

    try:
        # Never pass a user-controlled URL to FFmpeg, nor permit a nested URL.
        with path.open("rb") as source, av.open(
            source, mode="r", format=AUDIO_FORMATS[path.suffix.lower()],
            options={"protocol_whitelist": "pipe"},
        ) as container:
            if not container.streams.audio:
                raise AudioValidationError("文件中没有可解码的音轨。")
            stream = container.streams.audio[0]
            stream.codec_context.thread_count = 1
            if stream.duration is not None and stream.time_base is not None:
                if float(stream.duration * stream.time_base) > MAX_DURATION_SECONDS + 0.1:
                    raise AudioValidationError("音频时长不能超过 10 分钟。")
            for index, frame in enumerate(container.decode(stream)):
                _check_cancel(cancel_event)
                if index >= 100000 or time.monotonic() - started > 45:
                    raise AudioValidationError("音频解码耗时过长，请转换为常规 WAV 或 MP3 后重试。")
                if frame.sample_rate > 192000 or len(frame.layout.channels) > 8:
                    raise AudioValidationError("音频采样率或声道数量过高，请转换为普通单声道或立体声音频。")
                # Avoid timestamp gaps creating silent allocation expansion.
                frame.pts = None
                for converted in resampler.resample(frame):
                    append(converted)
            for converted in resampler.resample(None):
                append(converted)
    except (AudioValidationError, AudioTranscriptionCancelled):
        raise
    except Exception as error:
        raise AudioValidationError("无法解码音频，请检查文件是否损坏或格式是否正确。") from error
    if count < SAMPLE_RATE // 4:
        raise AudioValidationError("音频至少需要 0.25 秒。")
    result = audio[:count]
    if not np.isfinite(result).all():
        raise AudioValidationError("音频包含无效采样值。")
    return result


def _is_silent(audio):
    import numpy as np
    return float(np.max(np.abs(audio))) < 0.0001


class AudioTranscriber:
    """Lazy, serialized CPU int8 inference; no network requests at runtime."""

    def __init__(self, model_dir=None):
        self.model_dir = Path(model_dir) if model_dir is not None else default_audio_model_dir()
        self._model = None
        self._lock = threading.Lock()
        self._error = None

    def _manifest(self):
        path = self.model_dir / "manifest.json"
        if not path.is_file():
            raise AudioModelUnavailable("未安装音频模型，请运行 scripts/setup_audio_model.py。")
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
            if manifest.get("model") != AUDIO_MODEL["model"] or manifest.get("revision") != AUDIO_MODEL["revision"]:
                raise ValueError("revision mismatch")
            files = manifest["files"]
            for filename in AUDIO_MODEL["files"]:
                asset = self.model_dir / filename
                expected = files[filename]
                if not asset.is_file() or asset.stat().st_size != expected["size"] or expected["size"] <= 0:
                    raise ValueError("missing/truncated asset")
                if not re.fullmatch(r"[0-9a-f]{64}", expected["sha256"]):
                    raise ValueError("invalid asset hash")
            if files["model.bin"]["sha256"] != AUDIO_MODEL["weights_sha256"]:
                raise ValueError("unrecognized model weights")
            return manifest
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
            raise AudioModelUnavailable("音频模型不完整或版本不匹配，请重新运行安装脚本。") from error

    def status(self):
        result = {
            "status": "ready", "ready": True, "loaded": self._model is not None,
            "model": AUDIO_MODEL["model"], "name": AUDIO_MODEL["display_name"],
            "revision": AUDIO_MODEL["revision"], "device": "cpu", "compute_type": "int8",
            "max_duration_seconds": MAX_DURATION_SECONDS,
            "formats": list(AUDIO_FORMATS), "languages": ["zh", "ko", "en"],
            "offline": True,
        }
        try:
            self._manifest()
            if importlib.util.find_spec("faster_whisper") is None:
                raise AudioModelUnavailable("尚未安装音频依赖，请安装 backend/requirements-audio.txt。")
            if self._error:
                result.update(status="error", ready=False, message=self._error)
        except AudioModelUnavailable as error:
            result.update(status="missing", ready=False, message=str(error))
        return result

    def _load_model(self):
        if self._model is not None:
            return self._model
        manifest = self._manifest()
        for filename in AUDIO_MODEL["files"]:
            if _sha256(self.model_dir / filename) != manifest["files"][filename]["sha256"]:
                raise AudioModelUnavailable("音频模型校验失败，请重新安装模型。")
        try:
            from faster_whisper import WhisperModel
            self._model = WhisperModel(
                str(self.model_dir.resolve()), device="cpu", compute_type="int8",
                cpu_threads=min(4, os.cpu_count() or 1), num_workers=1,
                local_files_only=True,
            )
            self._error = None
            return self._model
        except ImportError as error:
            raise AudioModelUnavailable("尚未安装音频依赖，请安装 backend/requirements-audio.txt。") from error
        except Exception as error:
            self._error = "音频模型加载失败，请检查模型文件与本机运行环境。"
            raise AudioModelUnavailable(self._error) from error

    def transcribe(self, path, language=None, progress=None, cancel_event=None):
        if language not in SUPPORTED_LANGUAGES:
            raise AudioValidationError("请选择自动识别、中文、韩文或英文。")
        language = None if language == "auto" else language
        _check_cancel(cancel_event)
        # Fail before decoding when setup is missing. Silence is not a fake
        # successful transcription when the actual model is unavailable.
        self._manifest()
        _progress(progress, "decoding", 2)
        try:
            audio = decode_audio(path, cancel_event)
        except ImportError as error:
            raise AudioModelUnavailable("尚未安装音频依赖，请安装 backend/requirements-audio.txt。") from error
        _check_cancel(cancel_event)
        duration = len(audio) / SAMPLE_RATE
        result = {
            "text": "", "language": language or "unknown", "language_probability": None,
            "duration": round(duration, 3), "segments": [],
            "model": AUDIO_MODEL["model"], "revision": AUDIO_MODEL["revision"],
            "warnings": [BASE_WARNING], "no_speech": False,
        }
        # Exact/near silence can be detected without running the decoder.
        if _is_silent(audio):
            result.update(no_speech=True)
            result["warnings"].append("音频几乎静音，没有可识别的歌词。")
            _progress(progress, "complete", 100)
            return result
        _progress(progress, "loading", 5)
        while not self._lock.acquire(timeout=0.2):
            _check_cancel(cancel_event)
        try:
            _check_cancel(cancel_event)
            model = self._load_model()
            _check_cancel(cancel_event)
            _progress(progress, "transcribing", 10)
            segments, info = model.transcribe(
                audio, language=language, task="transcribe", beam_size=5,
                temperature=(0.0, 0.2, 0.4), condition_on_previous_text=False,
                # Speech VAD can remove sung vocals. Keep it off and use
                # decoder no-speech/log-probability signals instead.
                vad_filter=False, no_speech_threshold=0.6,
                log_prob_threshold=-1.0, compression_ratio_threshold=2.4,
                word_timestamps=False, max_new_tokens=None,
                repetition_penalty=1.05,
            )
            result["language"] = info.language
            result["language_probability"] = round(float(info.language_probability), 4)
            discarded = 0
            text_length = 0
            low_confidence = 0
            for index, segment in enumerate(segments):
                _check_cancel(cancel_event)
                if index >= 2000:
                    raise AudioTranscriptionError("识别片段过多，可能出现重复输出；请截取较短音频重试。")
                text = re.sub(r"[ \t]+", " ", str(segment.text)).strip()
                start = float(segment.start)
                end = float(segment.end)
                logprob = float(segment.avg_logprob)
                no_speech = float(segment.no_speech_prob)
                if not all(math.isfinite(value) for value in (start, end, logprob, no_speech)):
                    discarded += 1
                    continue
                start = max(0.0, min(duration, start))
                end = max(start, min(duration, end))
                _progress(progress, "transcribing", 10 + 85 * end / duration)
                if not text or end <= start or (no_speech >= 0.6 and logprob < -1.0):
                    discarded += 1
                    continue
                # Drop only duplicate *overlapping* decoder segments. Repeated
                # choruses at different times are real lyrics and stay intact.
                if result["segments"]:
                    previous = result["segments"][-1]
                    if text == previous["text"] and start < previous["end"] - 0.05:
                        discarded += 1
                        continue
                if logprob < -1.0 or no_speech > 0.5:
                    low_confidence += 1
                text_length += len(text) + 1
                if text_length > 50000:
                    raise AudioTranscriptionError("识别文本超过 50,000 字符，请截取较短音频重试。")
                result["segments"].append({
                    "start": round(start, 3), "end": round(end, 3), "text": text,
                    "avg_logprob": round(logprob, 4), "no_speech_prob": round(no_speech, 4),
                })
            if discarded:
                result["warnings"].append("已忽略空白、重叠重复或模型判断为无语音的片段。")
            if low_confidence:
                result["warnings"].append(f"有 {low_confidence} 个片段的识别把握较低，请重点校对。")
            if not result["segments"]:
                result["no_speech"] = True
                result["warnings"].append("未识别到可靠歌词；音频可能为纯音乐、音量过低或人声被伴奏遮挡。")
            result["text"] = "\n".join(item["text"] for item in result["segments"])
            _check_cancel(cancel_event)
            _progress(progress, "complete", 100)
            return result
        except (AudioTranscriptionError, AudioValidationError):
            raise
        except Exception as error:
            raise AudioTranscriptionError("音频识别失败，请稍后重试或换用更清晰的录音。") from error
        finally:
            self._lock.release()
