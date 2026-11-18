"""Independent music analysis and optional lyric recognition for one upload."""
import logging
import math

try:
    from .audio_transcriber import AudioCancelled, AudioModelUnavailable, _check_cancel
except ImportError:
    from audio_transcriber import AudioCancelled, AudioModelUnavailable, _check_cancel

logger = logging.getLogger(__name__)
MODES = {'music', 'combined', 'transcribe'}
GOALS = {'preserve', 'uplifting', 'calmer', 'darker'}


class AudioPipeline:
    def __init__(self, transcriber, music_analyzer):
        self.transcriber = transcriber
        self.music_analyzer = music_analyzer

    def process(self, path, *, language=None, mode='transcribe', goal='preserve',
                progress=None, cancel_event=None):
        if mode not in MODES or goal not in GOALS:
            raise ValueError('Invalid audio analysis mode or goal')
        _check_cancel(cancel_event)

        latest_progress = 0.0

        def report(value, message):
            nonlocal latest_progress
            try:
                value = float(value)
            except (ValueError, TypeError):
                return
            if not math.isfinite(value):
                return
            latest_progress = max(latest_progress, min(1.0, max(0.0, value)))
            if progress:
                progress(latest_progress, message)

        if mode == 'transcribe':
            result = self.transcriber.transcribe(path, language=language, progress=report,
                                                 cancel_event=cancel_event)
            return {**result, 'mode': mode, 'transcription_status': {
                'status': 'completed', 'message': '识词完成，请试听并校对。'}}

        if self.music_analyzer is None:
            raise AudioModelUnavailable('音乐分析依赖尚未安装。')
        analysis = self.music_analyzer.analyze(
            path, goal=goal, cancel_event=cancel_event,
            progress=lambda value, message: report(value * (0.65 if mode == 'combined' else 1), message))
        _check_cancel(cancel_event)
        result = {'mode': mode, 'music_analysis': analysis, 'duration': analysis.get('duration'),
                  'text': '', 'segments': [], 'language': language or 'unknown',
                  'warnings': [], 'no_speech': False,
                  'transcription_status': {'status': 'skipped', 'message': '本次仅分析音乐，没有识别歌词。'}}
        if mode == 'music':
            return result
        try:
            if self.transcriber.status().get('status') != 'ready':
                result['transcription_status'] = {'status': 'unavailable',
                    'message': '音乐分析已完成。识词模型尚未就绪，歌词未识别。'}
                return result
            report(0.66, '音乐分析已完成，正在尝试识别歌词')
            transcript = self.transcriber.transcribe(
                path, language=language, cancel_event=cancel_event,
                progress=lambda value, message: report(0.66 + value * 0.33, message))
            _check_cancel(cancel_event)
            result.update(transcript)
            result['transcription_status'] = {'status': 'completed',
                'message': '识词完成，请试听校对；纯音乐也可能被语音模型误识别为文字。'}
        except AudioCancelled:
            raise
        except Exception as error:
            _check_cancel(cancel_event)
            logger.warning('Optional lyric recognition failed: %s', type(error).__name__)
            result['transcription_status'] = {'status': 'failed', 'message':
                '音乐分析已完成。歌词识别失败，可改用手动歌词或单独重试识词。'}
        return result
