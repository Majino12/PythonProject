"""Repeatable authored-story smoke test, not an accuracy benchmark.

--live explicitly calls configured models; without it only the baseline runs.
"""
import argparse
import json
import re
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv
from model_client import ModelClient
from novel_analyzer import SimpleNovelAnalyzer

parser = argparse.ArgumentParser()
parser.add_argument('--live', action='store_true')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
load_dotenv(ROOT / '.env')
text = (ROOT / 'tests/fixtures/river_lantern.txt').read_text(encoding='utf-8')
start = time.monotonic()
result = SimpleNovelAnalyzer(model_client=ModelClient()).analyze_novel_text(
    text, '河灯 · 原创验证短篇', mode='model' if args.live else 'baseline',
    progress_callback=lambda value: print(json.dumps(value, ensure_ascii=False), flush=True))
if result.get('error'):
    print(result['error'], file=sys.stderr)
    sys.exit(1)
metadata = result['analysis_metadata']
evidence = result['evidence']
checks = {
    'all_chapters_present': len(result['hierarchical_summary']['chapter_summaries']) == 2,
    'full_coverage': metadata['coverage_ratio'] == 1,
    'all_quotes_match_source': bool(evidence) and all(text[row['start']:row['end']] == row['quote'] for row in evidence),
    'ending_evidence_present': any('留下来' in row['quote'] or '原谅' in row['quote'] for row in evidence),
}
if args.live:
    summary = result['hierarchical_summary']['overall_summary']
    checks['ending_negation_preserved'] = bool(re.search(r'(?:未|没有|尚未|并未|还没).{0,4}原谅|不代表.{0,8}原谅', summary))
report = {'mode': metadata['mode'], 'status': metadata['status'], 'seconds': round(time.monotonic() - start, 2),
          'models': metadata.get('models'), 'checks': checks, 'result': result,
          'note': '作者自制两章短篇的结构/引用冒烟测试，不是小说理解准确率评测；需人工检查语义。'}
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in report.items() if key != 'result'}, ensure_ascii=False, indent=2))
sys.exit(0 if all(checks.values()) and metadata['status'] == 'complete' else 1)
