"""Install declared dependencies; model downloads remain an explicit setup step."""
import argparse
from pathlib import Path
import subprocess
import sys


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--with-models', action='store_true', help='Install PyTorch and Transformers for Chinese/Korean models')
    parser.add_argument('--with-audio', action='store_true', help='Install local audio decoding and Whisper transcription')
    parser.add_argument('--with-music', action='store_true', help='Install music feature analysis; add --with-models for music-CLAP')
    args = parser.parse_args()
    backend = Path(__file__).resolve().parent / 'backend'
    command = [sys.executable, '-m', 'pip', 'install', '-r', str(backend / 'requirements.txt')]
    if args.with_models:
        command += ['-r', str(backend / 'requirements-models.txt')]
    if args.with_audio:
        command += ['-r', str(backend / 'requirements-audio.txt')]
    if args.with_music:
        command += ['-r', str(backend / 'requirements-music.txt')]
    subprocess.run(command, check=True)
    if args.with_models:
        print('Next: python scripts/setup_models.py && python scripts/setup_emotion_model.py')
    if args.with_audio:
        print('Next: python scripts/setup_audio_model.py')
    if args.with_music and args.with_models:
        print('Next: python scripts/setup_music_mood.py')
