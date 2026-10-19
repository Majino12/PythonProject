#!/usr/bin/env python3
"""Inspect frozen, original lyric-style cases with the local model and lexicon.

This is a qualitative regression aid, not a representative benchmark. A run
fails if any example falls back to a lexicon, so an unavailable model cannot be
mistaken for a successful model evaluation. Disagreements remain in the report;
they do not make this diagnostic script fail.

Usage, after installing and downloading the configured models:
    python scripts/evaluate_sentiment.py --outputjson work/sentiment-evaluation.json
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from backend.lyric_analyzer import LocalLyricAnalyzer  # noqa: E402


DISCLAIMER = (
    "This is a small, manually authored qualitative regression set, not a "
    "representative benchmark. Agreement counts are not generalization accuracy. "
    "Neutral and ambiguous examples are reviewed separately; a binary model has "
    "no learned neutral class. All examples, including disagreements, are kept."
)


def load_examples(path):
    raw = path.read_bytes()
    fixture = json.loads(raw)
    examples = fixture['examples']
    seen = set()
    for example in examples:
        if not {'id', 'language', 'text', 'expected', 'phenomenon', 'notes'} <= example.keys():
            raise ValueError('Every example must include the documented fixture fields')
        if example['id'] in seen:
            raise ValueError(f"Duplicate example ID: {example['id']}")
        if example['language'] not in {'zh', 'ko'}:
            raise ValueError(f"Unsupported example language: {example['language']}")
        if example['expected'] not in {'positive', 'negative', 'neutral', 'ambiguous'}:
            raise ValueError(f"Unsupported expected label: {example['expected']}")
        if not isinstance(example['text'], str) or not example['text'].strip():
            raise ValueError(f"Empty text for example: {example['id']}")
        seen.add(example['id'])
    if not examples:
        raise ValueError('The fixture must contain at least one example')
    return fixture, hashlib.sha256(raw).hexdigest()


def evaluate_examples(examples, baseline, upgraded):
    """Return every case and counts, without excluding difficult predictions."""
    rows = []
    counts = {language: Counter() for language in ('zh', 'ko')}
    failures = []
    for example in examples:
        baseline_result = baseline.analyze_lyrics_comprehensive(example['text'])
        row = dict(example)
        row['baseline'] = {
            'sentiment': baseline_result['consensus_sentiment'],
            'polarity': baseline_result['overall_polarity'],
            'method': baseline_result['metadata']['method'],
        }
        try:
            result = upgraded.analyze_lyrics_comprehensive(example['text'])
            model = result.get('model_sentiment') or {}
            metadata = result.get('metadata') or {}
            available = model.get('available') is True
            row['upgraded'] = {
                'sentiment': result['consensus_sentiment'],
                'polarity': result['overall_polarity'],
                'method': metadata.get('method'),
                'model_available': available,
                'confidence': model.get('confidence'),
                'probabilities': model.get('probabilities'),
                'chunk_count': model.get('chunk_count'),
                'models': metadata.get('models', []),
                'limitations': metadata.get('limitations', []),
            }
            if not available:
                failures.append({
                    'id': example['id'],
                    'reason': 'Local model unavailable; reported prediction used fallback',
                })
        except Exception as error:
            # Keep later examples visible even if a particular inference fails.
            row['upgraded'] = {
                'model_available': False,
                'sentiment': None,
                'error': f'{type(error).__name__}: {error}',
            }
            failures.append({'id': example['id'], 'reason': row['upgraded']['error']})

        tally = counts[example['language']]
        tally['all_examples'] += 1
        tally['model_available_examples'] += row['upgraded']['model_available']
        binary = example['expected'] in {'positive', 'negative'}
        row['scored_as_binary'] = binary
        if binary:
            tally['binary_examples'] += 1
            row['baseline_matches_expected'] = (
                row['baseline']['sentiment'] == example['expected'])
            row['upgraded_matches_expected'] = (
                row['upgraded']['sentiment'] == example['expected']
                if row['upgraded']['model_available'] else None)
            tally['baseline_matches'] += row['baseline_matches_expected']
            tally['upgraded_matches'] += row['upgraded_matches_expected'] is True
            tally['upgraded_unavailable'] += row['upgraded_matches_expected'] is None
            tally['upgraded_uncertain'] += (
                row['upgraded']['model_available']
                and row['upgraded']['sentiment'] == 'uncertain')
        else:
            row['review_note'] = (
                'Qualitative only: no required binary label; inspect confidence '
                'and the explanatory notes instead of scoring a match.')
        rows.append(row)

    summary = {}
    keys = (
        'all_examples', 'model_available_examples', 'binary_examples',
        'baseline_matches', 'upgraded_matches', 'upgraded_unavailable',
        'upgraded_uncertain',
    )
    for language, tally in counts.items():
        if tally['all_examples']:
            summary[language] = {key: tally[key] for key in keys}
    return {
        'complete_model_run': not failures,
        'binary_agreement_counts': summary,
        'model_failures': failures,
        'examples': rows,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--examples', type=Path,
        default=PROJECT_ROOT / 'tests' / 'fixtures' / 'sentiment_examples.json',
        help='Frozen original examples to inspect (default: bundled fixture)',
    )
    parser.add_argument(
        '--outputjson', type=Path,
        help='Save the complete report, original texts, labels and model revisions',
    )
    args = parser.parse_args(argv)
    fixture, digest = load_examples(args.examples)
    print(DISCLAIMER, flush=True)
    baseline = LocalLyricAnalyzer(model_engine=False)
    upgraded = LocalLyricAnalyzer()
    report = {
        'created_at': datetime.now(timezone.utc).isoformat(),
        'disclaimer': DISCLAIMER,
        'fixture': {
            'name': fixture.get('name'),
            'version': fixture.get('version'),
            'sha256': digest,
            'authored_on': fixture.get('authored_on'),
            'limitations': fixture.get('limitations', []),
            'label_policy': fixture.get('label_policy', {}),
        },
        'analyzer_version': upgraded.VERSION,
    }
    report.update(evaluate_examples(fixture['examples'], baseline, upgraded))
    print('\nCase | Expected | Lexicon | Upgraded | Model available', flush=True)
    for row in report['examples']:
        print(
            f"{row['id']} | {row['expected']} | {row['baseline']['sentiment']} | "
            f"{row['upgraded'].get('sentiment')} | {row['upgraded']['model_available']}",
            flush=True,
        )
    for language, tally in report['binary_agreement_counts'].items():
        print(
            f"{language}: agreement on {tally['binary_examples']} authored binary cases: "
            f"lexicon {tally['baseline_matches']}; upgraded {tally['upgraded_matches']}; "
            f"model unavailable {tally['upgraded_unavailable']}; "
            f"uncertain {tally['upgraded_uncertain']}.",
            flush=True,
        )
    if args.outputjson:
        args.outputjson.parent.mkdir(parents=True, exist_ok=True)
        args.outputjson.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n',
            encoding='utf-8',
        )
        print(f'Full report: {args.outputjson.resolve()}', flush=True)
    if report['model_failures']:
        print(
            'INCOMPLETE: at least one example could not use the local model. '
            'Do not interpret fallback predictions as model evaluation results.',
            file=sys.stderr,
            flush=True,
        )
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
