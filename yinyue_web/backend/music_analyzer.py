"""Bounded offline music measurements and evidence-based editing suggestions.

The DSP is intentionally independent of language/lyric models. Spectral centroid,
RMS and onset autocorrelation follow the usual signal-processing definitions;
dominant spectral peaks are NOT a transcription of a polyphonic lead melody.
Reference definitions: https://librosa.org/doc/main/api/generated/librosa.piptrack.html
and https://librosa.org/doc/main/api/generated/librosa.beat.beat_track.html .
No dependency/model is downloaded at runtime; imports of numeric packages are lazy.
"""

import importlib.util
import math
from collections import Counter

try:
    from .audio_transcriber import (decode_audio, AudioCancelled, AudioValidationError,
                                    AudioTranscriptionError, SAMPLE_RATE,
                                    MAX_DURATION_SECONDS, MAX_AUDIO_BYTES, AUDIO_FORMATS)
except ImportError:
    from audio_transcriber import (decode_audio, AudioCancelled, AudioValidationError,
                                   AudioTranscriptionError, SAMPLE_RATE,
                                   MAX_DURATION_SECONDS, MAX_AUDIO_BYTES, AUDIO_FORMATS)

GOALS = {'preserve', 'uplifting', 'calmer', 'darker'}
METHOD = 'offline-dsp-heuristic-v1'
NOTE_NAMES = ('C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B')
PITCH_WARNING = '这是混音中显著频谱峰的轮廓，可能来自低音、伴奏或泛音；不是多声部主旋律识别、和弦转录或精确乐谱。'
BASE_WARNINGS = [
    '使用 16 kHz 单声道分析；频谱亮度仅覆盖 0–8 kHz，无法评价立体声宽度或 8 kHz 以上细节。',
    '情绪倾向来自明确规则，不是情绪概率或对听众感受的科学判定；音量、音色和节奏不能确定喜悲。',
    '时间段按固定窗口划分，不代表已识别主歌、副歌或小节；建议是可试听的编辑方案，不会自动改写原音频。',
]


class MusicAnalysisUnavailable(AudioTranscriptionError):
    def __init__(self, message):
        super().__init__(message, 'music_dependencies_missing', 503)


def _cancel(event):
    if event is not None and event.is_set():
        raise AudioCancelled('音乐分析已取消。')


def _report(callback, value, message):
    if callback:
        callback(max(0.0, min(1.0, value)), message)


def _number(value, places=4):
    return round(float(value), places) if value is not None and math.isfinite(float(value)) else None


def _note(hz):
    midi = int(round(69 + 12 * math.log2(hz / 440)))
    return NOTE_NAMES[midi % 12] + str(midi // 12 - 1)


def _feature(key, label, value, unit, reliability, note):
    return dict(key=key, label=label, value=_number(value), unit=unit,
                reliability=_number(reliability if value is not None else 0), note=note)


class MusicAnalyzer:
    def __init__(self, mood_engine=None, *, audio_mood_engine=None):
        self.mood_engine = audio_mood_engine if audio_mood_engine is not None else mood_engine

    def status(self):
        dependencies = {name: importlib.util.find_spec(name) is not None for name in ('numpy', 'av')}
        ready = all(dependencies.values())
        result = dict(ready=ready, available=ready, status='ready' if ready else 'missing',
                      offline=True, method=METHOD, dependencies=dependencies,
                      max_duration_seconds=MAX_DURATION_SECONDS, max_audio_bytes=MAX_AUDIO_BYTES,
                      sample_rate=SAMPLE_RATE, formats=list(AUDIO_FORMATS),
                      message='本机音乐特征分析可用。' if ready else '请安装 backend/requirements-music.txt。')
        if self.mood_engine is not None:
            try:
                result['mood_model'] = self.mood_engine.status()
            except Exception:
                result['mood_model'] = {'available': False, 'ready': False, 'message': '音频情绪模型状态暂不可用。'}
        return result

    def analyze(self, path, goal='preserve', progress=None, cancel_event=None):
        if not isinstance(goal, str) or goal not in GOALS:
            raise AudioValidationError('请选择保持风格、更加明亮、更加舒缓或更加暗沉。')
        _cancel(cancel_event)
        if not self.status()['ready']:
            raise MusicAnalysisUnavailable('尚未安装音乐分析依赖，请安装 backend/requirements-music.txt。')
        _report(progress, 0.02, '正在解码本机音频')
        try:
            audio = decode_audio(path, cancel_event)
        except ImportError as error:
            raise MusicAnalysisUnavailable('音乐分析依赖无法载入，请检查 backend/requirements-music.txt。') from error
        _cancel(cancel_event)
        duration = len(audio) / SAMPLE_RATE
        if duration > MAX_DURATION_SECONDS or duration < 0.25:
            raise AudioValidationError('音乐音频时长应在 0.25 秒到 10 分钟之间。')
        result = self._extract(audio, progress, cancel_event)
        result.update(available=True, duration=_number(duration, 3), method=METHOD, goal=goal)
        result['mood_model'] = {'available': False, 'model': None, 'revision': None,
                                'method': 'not-configured', 'scores': [], 'coverage': None,
                                'warnings': ['未启用音频情绪模型；下方情绪倾向仅由声学规则估计。']}
        # Silence and very short clips do not become model-based mood evidence.
        if self.mood_engine is not None and result.get('mood_evidence', not result['insufficient_evidence']):
            _report(progress, 0.84, '正在检查本机音频情绪模型')
            try:
                result['mood_model'] = self.mood_engine.analyze(
                    audio, sample_rate=SAMPLE_RATE, cancel_event=cancel_event,
                    progress=lambda message: _report(progress, 0.87, message))
            except AudioCancelled:
                raise
            except Exception:
                _cancel(cancel_event)
                result['mood_model']['warnings'] = ['音频情绪模型本次不可用，已保留实测音乐特征；没有生成模型分数。']
        _cancel(cancel_event)
        _report(progress, 0.94, '正在生成有时间段依据的修改建议')
        result['suggestions'] = self._suggest(result)
        result.pop('insufficient_evidence', None)
        result.pop('mood_evidence', None)
        _report(progress, 1.0, '音乐分析完成')
        return result

    def _extract(self, audio, progress, cancel_event):
        import numpy as np

        y = np.asarray(audio, dtype=np.float32)
        if y.ndim != 1 or not np.isfinite(y).all():
            raise AudioValidationError('音频采样值无效。')
        duration = len(y) / SAMPLE_RATE
        n_fft, hop = 2048, 256
        total_frames = max(1, int(math.ceil(len(y) / hop)))
        window = np.hanning(n_fft).astype(np.float32)
        frequencies = np.fft.rfftfreq(n_fft, 1 / SAMPLE_RATE)
        pitch_bins = np.flatnonzero((frequencies >= 65) & (frequencies <= 1600))
        chroma_bins = np.flatnonzero((frequencies >= 65) & (frequencies <= 2000))
        chroma_classes = np.rint(69 + 12 * np.log2(frequencies[chroma_bins] / 440)).astype(int) % 12
        rms_parts, centroid_parts, low_parts, flux_parts, pitch_parts, confidence_parts = [], [], [], [], [], []
        chroma = np.zeros(12, dtype=float)
        prior_spectrum = None
        # 1024 frames/chunk bounds temporary FFT matrices independently of length.
        for first in range(0, total_frames, 1024):
            _cancel(cancel_event)
            count = min(1024, total_frames - first)
            start = first * hop
            needed = (count - 1) * hop + n_fft
            samples = y[start:start + needed]
            if len(samples) < needed:
                samples = np.pad(samples, (0, needed - len(samples)))
            frames = np.lib.stride_tricks.sliding_window_view(samples, n_fft)[::hop][:count]
            rms = np.sqrt(np.mean(frames * frames, axis=1))
            spectrum = np.abs(np.fft.rfft(frames * window, axis=1))
            spectrum[:, 0] = 0  # DC offsets are not musical bass or pitch evidence.
            power = spectrum * spectrum
            total_power = power.sum(axis=1)
            sums = spectrum.sum(axis=1)
            centroid = (spectrum @ frequencies) / np.maximum(sums, 1e-12)
            low = power[:, frequencies < 250].sum(axis=1) / np.maximum(total_power, 1e-12)
            log_spectrum = np.log1p(spectrum)
            previous = np.vstack([prior_spectrum if prior_spectrum is not None else log_spectrum[0], log_spectrum[:-1]])
            flux = np.maximum(log_spectrum - previous, 0).mean(axis=1)
            prior_spectrum = log_spectrum[-1]
            peaks = pitch_bins[np.argmax(spectrum[:, pitch_bins], axis=1)]
            rows = np.arange(count)
            a = np.log(np.maximum(spectrum[rows, peaks - 1], 1e-12))
            b = np.log(np.maximum(spectrum[rows, peaks], 1e-12))
            c = np.log(np.maximum(spectrum[rows, peaks + 1], 1e-12))
            denominator = a - 2 * b + c
            offset = np.divide(0.5 * (a - c), denominator, out=np.zeros(count), where=np.abs(denominator) > 1e-9)
            hz = (peaks + np.clip(offset, -0.5, 0.5)) * SAMPLE_RATE / n_fft
            concentration = (power[rows, peaks - 1] + power[rows, peaks] + power[rows, peaks + 1]) / np.maximum(total_power, 1e-12)
            flatness = np.exp(np.mean(np.log(np.maximum(power[:, 1:], 1e-12)), axis=1)) / np.maximum(power[:, 1:].mean(axis=1), 1e-12)
            tonal = (concentration >= 0.18) & (flatness < 0.18) & (rms > 0.0001)
            confidence = np.where(tonal, np.minimum(1.0, concentration), 0)
            hz = np.where(tonal, hz, np.nan)
            # Fold sufficiently prominent local spectral peaks into pitch classes.
            local_peaks = (spectrum[:, chroma_bins] > spectrum[:, chroma_bins - 1]) & (spectrum[:, chroma_bins] >= spectrum[:, chroma_bins + 1])
            local_peaks &= spectrum[:, chroma_bins] >= spectrum.max(axis=1, keepdims=True) * 0.15
            local_peaks &= tonal[:, None]
            weights = np.where(local_peaks, power[:, chroma_bins], 0).sum(axis=0)
            chroma += np.bincount(chroma_classes, weights=weights, minlength=12)
            for parts, values in ((rms_parts, rms), (centroid_parts, centroid), (low_parts, low),
                                  (flux_parts, flux), (pitch_parts, hz), (confidence_parts, confidence)):
                parts.append(values)
            _report(progress, 0.08 + 0.57 * (first + count) / total_frames, '正在测量能量、频谱与主导音高')
        rms, centroid, low, flux, hz, confidence = [np.concatenate(parts) for parts in
                                                   (rms_parts, centroid_parts, low_parts, flux_parts, pitch_parts, confidence_parts)]
        times = np.minimum((np.arange(total_frames) * hop + n_fft / 2) / SAMPLE_RATE, duration)
        signal_rms = float(np.sqrt(np.mean(y * y)))
        silent = float(np.max(np.abs(y))) < 0.0001 or signal_rms < 0.00003
        active = rms > max(0.0001, float(rms.max()) * 0.01)
        active_seconds = float(active.sum() * hop / SAMPLE_RATE)
        insufficient = silent or duration < 3 or active_seconds < 1.5
        frame_db = 20 * np.log10(np.maximum(rms, 1e-10))
        rms_db = 20 * math.log10(signal_rms) if signal_rms > 0 else None
        dynamic = float(np.percentile(frame_db[active], 90) - np.percentile(frame_db[active], 10)) if active.sum() >= 8 else None
        brightness = float(np.average(centroid[active], weights=rms[active])) if active.any() else None
        bass = float(np.average(low[active], weights=rms[active] ** 2)) if active.any() else None
        _cancel(cancel_event)
        onset_indices, tempo, tempo_reliability, pulse = self._rhythm(flux, duration, hop, insufficient)
        onset_density = len(onset_indices) / duration if not silent else None
        pitch = self._pitch(hz, confidence, active, times, chroma, insufficient, hop)
        timeline = self._timeline(duration, times, rms, centroid, hz, active, onset_indices)
        quality = min(1.0, active_seconds / 8) if not silent else 0.0
        features = [
            _feature('tempo', '估计速度', tempo, 'BPM', tempo_reliability, '由起音周期估计；可能存在半速/倍速歧义，不识别拍号。缺少稳定周期时不输出 BPM。'),
            _feature('rms_dbfs', '平均采样能量', rms_db, 'dBFS', 1, '样本 RMS 相对数字满幅；不是 LUFS 或主观响度，受原录音增益影响。'),
            _feature('dynamic_range_db', '能量起伏', dynamic, 'dB', quality, '有效帧 RMS 的第 90 与第 10 百分位差；不是标准响度范围 LRA。'),
            _feature('spectral_centroid_hz', '频谱亮度', brightness, 'Hz', quality, '有效帧幅度谱重心，按能量加权；仅覆盖 0–8 kHz，不等同音高或刺耳程度。'),
            _feature('low_frequency_ratio', '低频能量占比', bass, 'ratio', quality, '250 Hz 以下谱功率占比；可能来自低音乐器、底鼓或录音噪声。'),
            _feature('onset_density', '起音密度', onset_density, '次/秒', quality, '检测到的明显声音起始次数；不是精确音符数。'),
            _feature('pulse_clarity', '周期律动清晰度', pulse, 'ratio', tempo_reliability if tempo is not None else 0.25 * quality, '起音包络的归一化周期相关强度；无法确认切分或拍号。'),
            _feature('pitch_coverage', '主导音高覆盖率', pitch['coverage'] if not silent else None, 'ratio', quality, '有显著窄带频谱峰的有效帧比例；不是主旋律识别准确率。'),
        ]
        warnings = list(BASE_WARNINGS) + [PITCH_WARNING]
        if silent:
            warnings.append('音频接近静音，没有足够音乐证据；未推断节拍、调式或情绪。')
        elif insufficient:
            warnings.append('音频过短或有效声音不足，未推断节拍或情绪；请提供至少数秒的连续乐句。')
        elif tempo is None:
            warnings.append('未找到足够稳定的节拍周期；自由速度、长音或复杂节奏都可能导致此结果。')
        if float(np.mean(np.abs(y) >= 0.999)) > 0.001:
            warnings.append('部分采样接近数字满幅，可能有削波；建议先检查源文件。')
        if not pitch['available']:
            warnings.append('主导音高证据不足，不生成音域或调式判断。')
        # Constant tones and stationary noise have measurable timbre, but those
        # measurements alone do not establish a musical mood or a composition.
        mood_evidence = not insufficient and (tempo is not None or
            (pitch['available'] and pitch['range_semitones'] >= 2) or
            (dynamic is not None and dynamic >= 3 and len(onset_indices) >= 4))
        if not insufficient and not mood_evidence:
            warnings.append('可测量音色，但乐句或节奏变化证据不足（例如持续单音或稳定噪声），不生成情绪倾向。')
        emotions = self._emotions(features, timeline) if mood_evidence else []
        summary = '有效音乐证据不足，请参考采样能量或换用更长、更清晰的片段。' if insufficient else (
            f'已分析 {duration:.1f} 秒音频；' + (f'起音周期约 {tempo:.0f} BPM，' if tempo is not None else '节拍周期尚不明确，')
            + ('可查看主导音高轮廓和分段变化。' if pitch['available'] else '可查看分段能量和音色变化。'))
        return dict(summary=summary, features=features, timeline=timeline, pitch=pitch,
                    emotions=emotions, emotion_method='acoustic-rules-not-probabilities',
                    warnings=warnings, insufficient_evidence=insufficient, mood_evidence=mood_evidence)

    @staticmethod
    def _rhythm(flux, duration, hop, insufficient):
        import numpy as np
        if insufficient or len(flux) < 5 or float(flux.max()) < 1e-5:
            return [], None, 0.0, None
        threshold = float(np.median(flux) + max(2 * np.median(np.abs(flux - np.median(flux))), 0.12 * flux.max()))
        candidates = np.flatnonzero((flux[1:-1] > flux[:-2]) & (flux[1:-1] >= flux[2:]) & (flux[1:-1] > threshold)) + 1
        spacing = max(1, int(0.12 * SAMPLE_RATE / hop))
        selected = []
        blocked = np.zeros(len(flux), dtype=bool)
        for index in sorted(candidates, key=lambda index: -flux[index]):
            if not blocked[index]:
                selected.append(int(index))
                blocked[max(0, index - spacing + 1):index + spacing] = True
        selected.sort()
        if len(selected) < 4 or duration < 4:
            return selected, None, 0.0, None
        envelope = np.maximum(flux - np.median(flux), 0)
        envelope -= envelope.mean()
        lags = np.arange(max(1, int(60 * SAMPLE_RATE / hop / 210)), int(60 * SAMPLE_RATE / hop / 45) + 1)
        correlations = []
        for lag in lags:
            left, right = envelope[:-lag], envelope[lag:]
            norm = math.sqrt(float(np.dot(left, left) * np.dot(right, right)))
            correlations.append(float(np.dot(left, right)) / norm if norm > 1e-12 else 0)
        correlations = np.asarray(correlations)
        peak_ids = np.flatnonzero((correlations[1:-1] >= correlations[:-2]) & (correlations[1:-1] >= correlations[2:])) + 1
        if not len(peak_ids):
            return selected, None, 0.0, _number(float(correlations.max()))
        strongest = float(correlations[peak_ids].max())
        # Prefer the first strong periodicity over its slower integer multiples.
        best = int(next(index for index in peak_ids if correlations[index] >= strongest * 0.9))
        pulse = float(correlations[best])
        lag = float(lags[best])
        denom = correlations[best - 1] - 2 * correlations[best] + correlations[best + 1]
        if abs(denom) > 1e-9:
            lag += float(np.clip(0.5 * (correlations[best - 1] - correlations[best + 1]) / denom, -0.5, 0.5))
        tempo = 60 * SAMPLE_RATE / hop / lag
        reliability = min(0.9, pulse * min(1, len(selected) / 12) * min(1, duration / 10))
        if pulse < 0.22 or pulse - float(np.median(correlations)) < 0.12 or reliability < 0.18:
            return selected, None, 0.0, _number(pulse)
        return selected, _number(tempo, 1), _number(reliability), _number(pulse)

    @staticmethod
    def _pitch(hz, confidence, active, times, chroma, insufficient, hop):
        import numpy as np
        valid = np.isfinite(hz) & active
        coverage = float(valid.sum() / max(1, active.sum()))
        available = bool(not insufficient and valid.sum() * hop / SAMPLE_RATE >= 1 and coverage >= 0.15)
        result = dict(available=available, method='dominant-spectral-peak', note=PITCH_WARNING,
                      coverage=_number(coverage), dominant_note=None, range_semitones=None,
                      contour=[], chroma=[], key=None, mode=None)
        if not available:
            return result
        indices = np.flatnonzero(valid)
        midi = 69 + 12 * np.log2(hz[valid] / 440)
        dominant_midi = Counter(np.rint(midi).astype(int).tolist()).most_common(1)[0][0]
        result['dominant_note'] = NOTE_NAMES[dominant_midi % 12] + str(dominant_midi // 12 - 1)
        result['range_semitones'] = _number(np.percentile(midi, 90) - np.percentile(midi, 10), 1)
        sample_indices = indices[np.linspace(0, len(indices) - 1, min(240, len(indices)), dtype=int)]
        result['contour'] = [dict(time=_number(times[index], 3), hz=_number(hz[index], 2),
                                  note=_note(float(hz[index])), confidence=_number(confidence[index])) for index in sample_indices]
        if chroma.sum() > 0:
            result['chroma'] = [dict(note=NOTE_NAMES[index], weight=_number(value / chroma.sum()))
                                for index, value in enumerate(chroma)]
        return result

    @staticmethod
    def _timeline(duration, times, rms, centroid, hz, active, onset_indices):
        import numpy as np
        count = min(60, max(1, int(math.ceil(duration / 5))))
        bounds = np.linspace(0, duration, count + 1)
        reference = max(float(np.percentile(rms, 95)), float(rms.max()) * 0.1, 1e-6)
        onset_times = times[onset_indices] if len(onset_indices) else np.array([])
        result = []
        for start, end in zip(bounds[:-1], bounds[1:]):
            selection = (times >= start) & (times < end if end < duration else times <= end)
            valid = selection & active
            pitches = selection & np.isfinite(hz) & active
            energy = float(np.sqrt(np.mean(rms[selection] ** 2))) if selection.any() else 0.0
            result.append(dict(start=_number(start, 3), end=_number(end, 3),
                               energy=_number(min(1, energy / reference)),
                               brightness=_number(np.mean(centroid[valid]), 1) if valid.any() else None,
                               rms_dbfs=_number(20 * math.log10(energy), 1) if energy > 0 else None,
                               onset_density=_number(float(((onset_times >= start) & (onset_times < end)).sum()) / (end - start)),
                               pitch_hz=_number(np.median(hz[pitches]), 1) if pitches.any() else None))
        return result

    @staticmethod
    def _emotions(features, timeline):
        values = {feature['key']: feature['value'] for feature in features}
        tempo, density, brightness = (values[key] for key in ('tempo', 'onset_density', 'spectral_centroid_hz'))
        evidence = []
        activity = []
        if tempo is not None:
            activity.append(max(0, min(1, (tempo - 55) / 120)))
            evidence.append(f'起音周期约 {tempo:.0f} BPM（有半速/倍速歧义）。')
        if density is not None:
            activity.append(min(1, density / 4))
            evidence.append(f'检测起音密度 {density:.2f} 次/秒。')
        emotions = []
        if activity:
            score = sum(activity) / len(activity)
            emotions.append(dict(label='活跃倾向' if score >= 0.45 else '舒缓倾向',
                                 score=round(score if score >= 0.45 else 1 - score, 3), evidence=evidence))
        if brightness is not None:
            tone = max(0, min(1, (brightness - 300) / 3000))
            emotions.append(dict(label='明亮音色倾向' if tone >= 0.5 else '厚暗音色倾向',
                                 score=round(tone if tone >= 0.5 else 1 - tone, 3),
                                 evidence=[f'0–8 kHz 范围的平均谱重心 {brightness:.0f} Hz；描述音色，不等同快乐或悲伤。']))
        return emotions

    @staticmethod
    def _suggest(result):
        if result.get('insufficient_evidence'):
            return {'arrangement': [], 'melody': []}
        features = {item['key']: item['value'] for item in result['features']}
        timeline = result['timeline']
        goal, pitch = result['goal'], result['pitch']
        arrangement, melody = [], []
        if not timeline:
            return dict(arrangement=arrangement, melody=melody)
        loud = max(timeline, key=lambda item: item['energy'])
        bright = max(timeline, key=lambda item: item['brightness'] or 0)
        region = lambda row: f"{row['start']:.1f}–{row['end']:.1f} 秒"
        def add(group, title, evidence, action, effect):
            group.append(dict(title=title, evidence=evidence, action=action, expected_effect=effect))
        tempo, brightness, bass, dynamic, density = [features.get(key) for key in
            ('tempo', 'spectral_centroid_hz', 'low_frequency_ratio', 'dynamic_range_db', 'onset_density')]
        if goal == 'uplifting' and tempo is not None and tempo < 115:
            add(arrangement, '试听略快的律动版本', f'周期约 {tempo:.0f} BPM；{region(loud)}为能量较高窗口。',
                f'复制一个版本，将速度试调至 {tempo * 1.04:.0f}–{tempo * 1.08:.0f} BPM；在上述窗口加入轻量切分打击，先核对节拍倍速歧义。',
                '提高推进感；若破坏原句呼吸，恢复速度，仅保留打击层变化。')
        elif goal == 'calmer' and tempo is not None and tempo > 95:
            add(arrangement, '降低推进密度', f'周期约 {tempo:.0f} BPM；{region(loud)}为能量较高窗口。',
                f'先在该窗口撤掉一半装饰性打击；另做 {tempo * 0.90:.0f}–{tempo * 0.95:.0f} BPM 的试听版本，比较呼吸感。',
                '减弱紧迫感，同时保留原有拍点骨架。')
        elif density is not None and density >= 1.5 and goal in {'calmer', 'darker'}:
            add(arrangement, '为密集起音留空隙', f'检测起音密度 {density:.2f} 次/秒；重点试听 {region(loud)}。',
                '在该窗口每隔一个重复单元去掉一次填充音或装饰打击，并延长尾音；保留主要重拍。',
                '让乐句更从容、厚重；减少同时出现的瞬态。')
        if brightness is not None and goal in {'calmer', 'darker'} and brightness > 1200:
            add(arrangement, '收敛最亮窗口的音色', f"{region(bright)}谱重心约 {bright['brightness']:.0f} Hz。",
                '仅对伴奏总线试听缓降高频或柔化拨弦/镲片瞬态；从很小的调整开始，与原版等响度对比，保留人声清晰度。',
                '降低明亮刺激感；不把低通后的更小音量误当成改善。')
        elif brightness is not None and goal == 'uplifting' and brightness < 2200:
            add(arrangement, '用轻量高音层提亮', f'平均谱重心 {brightness:.0f} Hz；先试 {region(loud)}。',
                '在该窗口添加轻量铃音、短拨弦或高八度和声音型，句尾收掉该层；保持总音量后比较。',
                '增加明亮与展开感，避免仅靠整体增益制造变化。')
        if bass is not None and bass > 0.55:
            add(arrangement, '检查低频重叠', f'250 Hz 以下能量占比 {bass:.0%}；从 {region(loud)} 开始试听。',
                '若底鼓与低音同时发声，先错开部分起音或缩短低音尾巴；逐轨检查后再决定是否削减 150–250 Hz。',
                '减少潜在低频堆积；如果该厚度是风格核心，可保留低频并只调整重叠时刻。')
        if dynamic is not None and dynamic < 4 and goal in {'preserve', 'uplifting'}:
            add(arrangement, '在重复段之间制造小幅对比', f'有效帧能量起伏仅 {dynamic:.1f} dB；参考 {region(loud)}。',
                '保留主音型，选择一次重复前暂撤一个伴奏层，随后恢复；先用编配增减制造对比，不直接增加总线压缩。',
                '保持主题辨识度，让回归时刻更清楚。')
        if not arrangement and brightness is not None:
            add(arrangement, '保留音色骨架，局部留白', f'平均谱重心 {brightness:.0f} Hz；{region(loud)}为能量较高窗口。',
                '保留该窗口的主要音色与节奏，只在一个乐句末尾撤掉次要伴奏一次，再以等响度试听决定是否保留。',
                '在不大改风格的前提下增加呼吸和层次。')
        if pitch['available']:
            contour = pitch['contour']
            anchor = contour[len(contour) // 2]
            evidence = (f"{anchor['time']:.1f} 秒附近的显著峰约 {anchor['hz']:.0f} Hz（{anchor['note']}）；"
                        f"轮廓第 10–90 百分位跨度约 {pitch['range_semitones']:.1f} 半音。此峰可能是伴奏，需先核对旋律分轨。")
            if goal == 'uplifting':
                action = '先在分轨或 MIDI 中确认该段主旋律；复制末尾短句，尝试让最后 2–3 个音逐级上行，并按伴奏和弦校正音级。'
                effect = '制造向前或向上展开的听感；保留原句作 A/B 对照。'
                title = '为已确认的旋律做上行回应'
            elif goal == 'darker':
                action = '确认主旋律后，将该短句的回应部分尝试下移一个八度或改为下行收尾；保持起始动机，并按和弦试听解决音。'
                effect = '尝试更低沉的落点；不依据当前混音自动推断小调。'
                title = '试听低音区或下行回应'
            elif goal == 'calmer':
                action = ('确认主旋律后，把该句最大跳进改成两次级进，并延长收尾音；' if pitch['range_semitones'] > 8 else
                          '确认主旋律后，保留现有音区，将一次装饰性重复音合并成长音，并在句尾加入一次短停顿；') + '所有改音先在伴奏上试听。'
                effect = '减少旋律活动感，增强呼吸；不假设混音峰就是主旋律。'
                title = '让旋律收尾更从容'
            elif pitch['range_semitones'] < 5:
                title = '在重复旋律中加入一次小回应'
                action = '确认该窄音区确属主旋律后，只在第二次重复尾部尝试一个邻音回应，随后回到原落点；保持其余音高不变。'
                effect = '保留动机，同时减少完全相同重复的单调感。'
            else:
                title = '保留音高轮廓，改变一次句尾节奏'
                action = '先核对旋律分轨，保留主要音高和最高点，把第二次重复的末音延长并减少一个装饰音，比较乐句方向是否更清楚。'
                effect = '维持旋律身份，以局部节奏变化增加辨识度。'
            add(melody, title, evidence, action, effect)
        return dict(arrangement=arrangement[:3], melody=melody[:2])
