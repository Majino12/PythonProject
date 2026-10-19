"""Install the project's declared dependencies into the active Python environment."""
from pathlib import Path
import subprocess
import sys


if __name__ == '__main__':
    requirements = Path(__file__).resolve().parent / 'backend' / 'requirements.txt'
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-r', str(requirements)], check=True)
