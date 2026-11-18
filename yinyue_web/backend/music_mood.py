"""Offline music/audio mood descriptions with CLAP (not speech emotion).

Primary sources:
https://huggingface.co/laion/clap-htsat-unfused (Apache-2.0, general audio CLAP)
https://huggingface.co/laion/clap-htsat-unfused/discussions/3 (HF safe conversion)
https://github.com/LAION-AI/CLAP (music training; GTZAN is not mood accuracy)
https://github.com/huggingface/transformers/blob/v4.57.6/src/transformers/models/clap/feature_extraction_clap.py

This is a general audio/text model, not a supervised music-emotion classifier.
The larger_clap_music conversion was excluded after local tests reproduced
collapsed text embeddings reported at https://github.com/embeddings-benchmark/mteb/issues/5069.

The upstream processor randomly crops >10-second inputs. We explicitly sample
at most four deterministic 10-second windows instead. Scores are cosine text /
audio similarities, never calibrated mood probabilities. English descriptions
match the model's text encoder; the audio need not contain intelligible lyrics.
"""

import os
from pathlib import Path
import hashlib
import importlib.util
import json
import logging
import math
import threading

try:
    from .audio_transcriber import AudioCancelled
except ImportError:
    from audio_transcriber import AudioCancelled

MUSIC_MOOD_MODEL = {
    "model": "laion/clap-htsat-unfused",
    "revision": "79b58ed25fc00386262a2bea4b19fd21dc4310a0",
    "license": "Apache-2.0",
    "weights_sha256": "abba8294f0c63d00eb3f8d998dacd16177cc5860cad3a11618e7f361a75587fe",
    "files": ("config.json", "preprocessor_config.json", "merges.txt", "vocab.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "model.safetensors"),
}


def default_music_mood_dir():
    data = Path(os.environ.get("YINYUE_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
    root = Path(os.environ.get("YINYUE_MODEL_DIR", data / "models"))
    return Path(os.environ.get("YINYUE_MUSIC_MOOD_MODEL_DIR", root / "music_mood"))


# Each group uses three descriptions. Average their normalized embeddings so a
# single prompt wording does not determine the whole mood comparison.
MOOD_PROMPTS = (
    ("joyful", "欢快", ("This music sounds joyful and cheerful.", "This is happy, uplifting music.", "The music has a playful and optimistic mood.")),
    ("calm", "平静", ("This music sounds calm and peaceful.", "This is soothing, relaxing music.", "The music has a gentle and tranquil mood.")),
    ("sad", "忧伤", ("This music sounds sad and melancholy.", "This is sorrowful, mournful music.", "The music has a wistful and lonely mood.")),
    ("tense", "紧张", ("This music sounds tense and suspenseful.", "This is ominous, unsettling music.", "The music has an anxious and dramatic mood.")),
    ("energetic", "活力", ("This music sounds energetic and lively.", "This is powerful, driving music.", "The music has an exciting and dynamic mood.")),
    ("romantic", "温柔浪漫", ("This music sounds romantic and tender.", "This is warm, intimate music.", "The music has an affectionate and sentimental mood.")),
    ("dreamy", "梦幻", ("This music sounds dreamy and ethereal.", "This is atmospheric, floating music.", "The music has a hazy and contemplative mood.")),
    ("aggressive", "激烈", ("This music sounds aggressive and fierce.", "This is angry, forceful music.", "The music has an intense and confrontational mood.")),
)
BASE_WARNING = "通用音频CLAP比较音乐与情绪描述的余弦相似度，不是情绪概率；并非音乐情绪专项训练，未针对你的音乐校准。"
logger = logging.getLogger(__name__)


class MusicMoodCancelled(AudioCancelled):
    def __init__(self):
        super().__init__("音乐分析已取消。")


def _check_cancel(event):
    if event is not None and event.is_set():
        raise MusicMoodCancelled()


class MusicMoodEngine:
    """Optional offline music-CLAP, with bounded CPU inference and no downloads."""

    def __init__(self, model_dir=None):
        self.model_dir = Path(model_dir) if model_dir is not None else default_music_mood_dir()
        self._lock = threading.Lock()
        self._runtime = None
        self._error = None

    def status(self):
        result = {"model": MUSIC_MOOD_MODEL["model"], "revision": MUSIC_MOOD_MODEL["revision"], "available": False}
        if os.environ.get("YINYUE_MUSIC_MOOD_ENABLED", "true").lower() in {"0", "false", "no"}:
            return dict(result, status="disabled", reason="音乐情绪模型已关闭。")
        if self._error:
            return dict(result, status="error", reason=self._error)
        manifest = self.model_dir / "manifest.json"
        if not manifest.is_file():
            return dict(result, status="missing", reason="本机尚未安装音乐情绪模型。")
        try:
            metadata = json.loads(manifest.read_text(encoding="utf-8"))
            if metadata.get("schema_version") != 1 or any(metadata.get(key) != MUSIC_MOOD_MODEL[key] for key in ("model", "revision")):
                raise ValueError("音乐模型版本清单不匹配。")
            for name in MUSIC_MOOD_MODEL["files"]:
                path = self.model_dir / name
                entry = metadata.get("files", {}).get(name, {})
                checksum = entry.get("sha256", "")
                if not path.is_file():
                    return dict(result, status="missing", reason=f"音乐模型文件缺失：{name}")
                if not isinstance(checksum, str) or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum) or not isinstance(entry.get("size"), int) or entry["size"] <= 0 or path.stat().st_size != entry["size"]:
                    raise ValueError(f"音乐模型文件清单无效：{name}")
                if name == "model.safetensors" and checksum != MUSIC_MOOD_MODEL["weights_sha256"]:
                    raise ValueError("音乐模型权重SHA256与固定版本不符。")
            if any(importlib.util.find_spec(name) is None for name in ("torch", "transformers", "scipy")):
                return dict(result, status="missing", reason="本机缺少音乐情绪模型依赖。")
        except OSError:
            return dict(result, status="error", reason="读取本机音乐模型清单失败。")
        except (ValueError, TypeError, AttributeError) as error:
            return dict(result, status="error", reason=str(error))
        return dict(result, available=True, status="ready", reason=None)

    def _load(self, cancel_event):
        if self._runtime is not None:
            return self._runtime
        metadata = json.loads((self.model_dir / "manifest.json").read_text(encoding="utf-8"))
        for name in MUSIC_MOOD_MODEL["files"]:
            digest = hashlib.sha256()
            with (self.model_dir / name).open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    _check_cancel(cancel_event)
                    digest.update(block)
            if digest.hexdigest() != metadata["files"][name]["sha256"]:
                raise ValueError(f"音乐模型文件校验失败：{name}")
        import torch
        from transformers import ClapModel, ClapProcessor

        torch.set_num_threads(min(4, torch.get_num_threads()))
        local_options = {"local_files_only": True, "trust_remote_code": False}
        processor = ClapProcessor.from_pretrained(str(self.model_dir), **local_options)
        model, loading = ClapModel.from_pretrained(str(self.model_dir), use_safetensors=True, output_loading_info=True, **local_options)
        if any(loading.get(key) for key in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs")):
            raise ValueError("Music model weights do not completely match the expected architecture.")
        model = model.to("cpu").eval()
        _check_cancel(cancel_event)
        prompts = [text for _, _, texts in MOOD_PROMPTS for text in texts]
        text_inputs = processor(text=prompts, padding=True, truncation=True, return_tensors="pt")
        text_inputs = {key: value.to("cpu") for key, value in text_inputs.items()}
        with torch.inference_mode():
            features = model.get_text_features(**text_inputs)
            features = torch.nn.functional.normalize(features, dim=-1)
            text_features = torch.nn.functional.normalize(features.reshape(len(MOOD_PROMPTS), 3, -1).mean(dim=1), dim=-1)
        self._validate_text_features(text_features.cpu().numpy())
        _check_cancel(cancel_event)
        self._runtime = (processor, model, torch, text_features)
        return self._runtime

    @staticmethod
    def _validate_text_features(features):
        # A collapse check catches a known broken checkpoint. It is not an
        # emotion-quality benchmark or a calibration of the similarity scores.
        import numpy as np
        features = np.asarray(features)
        if features.ndim != 2 or features.shape[0] != len(MOOD_PROMPTS) or not np.isfinite(features).all():
            raise ValueError("Invalid CLAP text embeddings.")
        if not np.allclose(np.linalg.norm(features, axis=1), 1, atol=0.01):
            raise ValueError("CLAP text embeddings must have unit length.")
        similarity = features @ features.T
        off_diagonal = similarity[~np.eye(len(features), dtype=bool)]
        if float(np.mean(off_diagonal)) > 0.98:
            raise ValueError("CLAP text embeddings are collapsed; no reliable comparison is possible.")

    @staticmethod
    def _windows(length, sample_rate):
        """At most four evenly distributed, bounded, deterministic windows."""
        window = 10 * sample_rate
        if length <= window:
            return [(0, length)]
        count = min(4, math.ceil(length / window))
        return [(round(index * (length - window) / (count - 1)), round(index * (length - window) / (count - 1)) + window) for index in range(count)]

    @staticmethod
    def _coverage(windows, sample_rate, length):
        merged_end = 0
        covered = 0
        for start, end in windows:
            covered += max(0, end - max(start, merged_end))
            merged_end = max(merged_end, end)
        return {
            "segments": [{"start": round(start / sample_rate, 3), "end": round(end / sample_rate, 3)} for start, end in windows],
            "segment_count": len(windows),
            "analyzed_seconds": round(covered / sample_rate, 3),
            "total_seconds": round(length / sample_rate, 3),
            "ratio": covered / length if length else 0.0,
        }

    def _predict_window(self, waveform, runtime):
        processor, model, torch, text_features = runtime
        inputs = processor(audio=waveform, sampling_rate=48000, return_tensors="pt", padding="repeatpad", truncation="rand_trunc")
        inputs = {key: value.to("cpu") for key, value in inputs.items()}
        with torch.inference_mode():
            features = torch.nn.functional.normalize(model.get_audio_features(**inputs), dim=-1)
            return (features @ text_features.T).cpu().numpy()[0]

    def analyze(self, audio, sample_rate=16000, cancel_event=None, progress=None):
        import numpy as np

        _check_cancel(cancel_event)
        result = {
            "available": False, "model": MUSIC_MOOD_MODEL["model"], "revision": MUSIC_MOOD_MODEL["revision"],
            "method": "music_clap_cosine", "score_type": "cosine_similarity", "scores": [],
            "summary": "音乐情绪模型未参与本次分析。", "warnings": [BASE_WARNING],
            "coverage": {"segments": [], "segment_count": 0, "analyzed_seconds": 0, "total_seconds": 0, "ratio": 0},
        }
        waveform = np.asarray(audio, dtype=np.float32)
        if not isinstance(sample_rate, int) or not 8000 <= sample_rate <= 192000 or waveform.ndim != 1 or not np.isfinite(waveform).all():
            result["warnings"].append("音乐情绪模型需要有效的单声道音频和采样率。")
            return result
        result["coverage"]["total_seconds"] = round(len(waveform) / sample_rate, 3)
        if len(waveform) < 3 * sample_rate:
            result["warnings"].append("音频不足3秒，无法提供有意义的音乐情绪比较。")
            return result
        if len(waveform) > 600 * sample_rate:
            result["warnings"].append("音频超过10分钟的本机分析上限。")
            return result
        state = self.status()
        if not state["available"]:
            result["warnings"].append(state["reason"])
            return result
        windows = self._windows(len(waveform), sample_rate)
        windows = [(start, end) for start, end in windows if float(np.sqrt(np.mean(waveform[start:end].astype(np.float64) ** 2))) > 1e-5]
        if not windows:
            result["warnings"].append("抽样片段接近静音，未生成情绪分数。")
            return result
        if len(waveform) < 10 * sample_rate:
            result["warnings"].append("音频短于模型的10秒窗口，内容较少，结果仅供试听参考。")
        result["coverage"] = self._coverage(windows, sample_rate, len(waveform))
        if result["coverage"]["ratio"] < 0.999:
            result["warnings"].append("音乐模型仅比较最多4个分布片段；未覆盖的段落可能具有不同情绪。")
        while not self._lock.acquire(timeout=0.2):
            _check_cancel(cancel_event)
        try:
            _check_cancel(cancel_event)
            if progress:
                progress("正在加载本机音乐情绪模型")
            runtime = self._load(cancel_event)
            from scipy.signal import resample_poly

            values = []
            divisor = math.gcd(sample_rate, 48000)
            for index, (start, end) in enumerate(windows):
                _check_cancel(cancel_event)
                if progress:
                    progress(f"正在比较音乐情绪片段 {index + 1}/{len(windows)}")
                segment = waveform[start:end]
                if sample_rate != 48000:
                    segment = resample_poly(segment, 48000 // divisor, sample_rate // divisor).astype(np.float32)
                row = np.asarray(self._predict_window(segment[:480000], runtime))
                _check_cancel(cancel_event)
                if row.shape != (len(MOOD_PROMPTS),) or not np.isfinite(row).all():
                    raise ValueError("音乐模型返回了无效相似度。")
                values.append(np.clip(row, -1, 1))
            mean_scores = np.mean(values, axis=0)
            result["scores"] = sorted([
                {"label": label, "name_zh": name, "score": round(float(score), 6)}
                for (label, name, _), score in zip(MOOD_PROMPTS, mean_scores)
            ], key=lambda value: value["score"], reverse=True)
            result["available"] = True
            names = "、".join(item["name_zh"] for item in result["scores"][:2])
            if result["scores"][0]["score"] - result["scores"][1]["score"] < 0.01:
                result["summary"] = "多种情绪描述的分数接近，模型未给出明显区分；请结合节奏、音色和试听判断。"
            else:
                result["summary"] = f"抽样音乐与「{names}」的描述较接近；这是相似度排序，不是唯一情绪判定。"
            return result
        except AudioCancelled:
            raise
        except Exception as error:
            logger.warning("Music mood inference failed (%s)", type(error).__name__)
            self._error = "本机音乐情绪模型加载或推理失败，请检查模型安装后重试。"
            result["warnings"].append(self._error)
            result["coverage"] = self._coverage([], sample_rate, len(waveform))
            return result
        finally:
            self._lock.release()
