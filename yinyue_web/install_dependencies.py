"""Install declared dependencies; model downloads remain an explicit setup step."""
import argparse
from pathlib import Path
import subprocess
import sys


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--with-models', action='store_true', help='Install PyTorch and Transformers for Chinese/Korean models')
    args = parser.parse_args()
    backend = Path(__file__).resolve().parent / 'backend'
    command = [sys.executable, '-m', 'pip', 'install', '-r', str(backend / 'requirements.txt')]
    if args.with_models:
        command += ['-r', str(backend / 'requirements-models.txt')]
    subprocess.run(command, check=True)
    if args.with_models:
        print('Next: python scripts/setup_models.py')
