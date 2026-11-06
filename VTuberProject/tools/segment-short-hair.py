#!/usr/bin/env python3
"""Rebuild registered hair ownership, without changing runtime assets.

proposals: refine the archived official-model outputs (NO model inference).
sam: run the pinned official SAM2.1 Large, then apply the same refinement.
Dependencies and provenance are documented in assets/short-hair-fringe-v1/segmentation/README.txt.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import cv2
import numpy as np
from PIL import Image


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pixel_sha(mask):
    return hashlib.sha256(mask.astype(np.uint8).tobytes()).hexdigest()


def checked_path(root, record):
    path = (root / record['path']).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Input path must remain inside its registered root.')
    if sha(path) != record['sha256']:
        raise ValueError(f'Input SHA-256 mismatch: {path}')
    return path


def binary_image(path):
    a = np.array(Image.open(path).convert('L'))
    if not np.isin(a, [0, 255]).all():
        raise ValueError(f'Not a binary ownership image: {path}')
    return a > 127


def baseline_refinement(rgb, alpha, proposal, config):
    brow = np.zeros(proposal.shape, np.uint8)
    eye = brow.copy()
    cv2.fillPoly(brow, [np.array(p, np.int32) for p in config['protectedBrowPolygons']], 1)
    exclusions = config.get('protectedBrowHairExclusions', [])
    if exclusions:
        cv2.fillPoly(brow, [np.array(p, np.int32) for p in exclusions], 0)
    cv2.fillPoly(eye, [np.array(p, np.int32) for p in config['protectedEyePolygons']], 1)
    protection = (brow | eye) > 0
    size = int(config['boundedExpansionRadius']) * 2 + 1
    near = cv2.dilate(proposal.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))) > 0
    blue = rgb[:, :, 2].astype(np.int16) - rgb[:, :, 0].astype(np.int16)
    refined = (proposal | ((blue >= config['blueMinusRedMin']) & near)) & ~((blue < config['strongSkinBlueMinusRedMax']) & proposal)
    refined[protection | (alpha == 0)] = False
    _, labels, stats, _ = cv2.connectedComponentsWithStats((~refined).astype(np.uint8), 8)
    small = np.flatnonzero(stats[:, cv2.CC_STAT_AREA] <= config['maxHolePixels'])
    small = small[small != 0]
    fill = np.isin(labels, small) & ~np.isin(labels, np.unique(labels[protection]))
    refined |= fill
    refined[alpha == 0] = False
    return refined, protection


def tip_refinement(rgb, alpha, proposal, previous, protection, underpaint, config):
    s = rgb.astype(np.int16)
    u = underpaint.astype(np.int16)
    skin = (u[:, :, 0] - u[:, :, 2] > config['generatedSkinRedMinusBlueMinExclusive']) & (u[:, :, 0] > config['generatedSkinRedMinExclusive'])
    changed = np.abs(s - u).sum(axis=2) > config['sourceUnderpaintRGBL1MinExclusive']
    roi = np.zeros(previous.shape, bool)
    x0, y0, x1, y1 = config['roi']
    roi[y0:y1, x0:x1] = True
    if config['anchor'] != 'original-sam':
        raise ValueError('The registered tip-refinement recipe requires the original SAM anchor.')
    size = int(config['boundedExpansionRadius']) * 2 + 1
    near = cv2.dilate(proposal.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))) > 0
    local = np.zeros(previous.shape, np.uint8)
    polygons = config.get('reviewedLocalTipPolygons', [])
    if polygons:
        cv2.fillPoly(local, [np.array(p, np.int32) for p in polygons], 1)
        near |= local > 0
    allowed = near & skin & changed & roi & ~protection & (alpha > 0) & ~previous
    br = s[:, :, 2] - s[:, :, 0]
    bg = s[:, :, 2] - s[:, :, 1]
    core = allowed & (br >= config['sourceBlueMinusRedCoreMin']) & (bg >= config['sourceBlueMinusGreenMin'])
    if polygons:
        core |= allowed & (local > 0) & (br >= config['reviewedLocalTipCoreBlueMinusRedMin']) & (bg >= config['reviewedLocalTipCoreBlueMinusGreenMin'])
    size = int(config['antialiasBandRadius']) * 2 + 1
    neighbor = cv2.dilate(core.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_RECT, (size, size))) > 0
    edge = allowed & neighbor & (br >= config['antialiasBlueMinusRedMin']) & (bg >= config['antialiasBlueMinusGreenMin'])
    return previous | core | edge


def official_predictor(args, model_record):
    if not args.sam2_source or not args.checkpoint:
        raise ValueError('sam mode requires --sam2-source and --checkpoint; this script downloads neither.')
    repo = args.sam2_source.resolve()
    commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != model_record['sourceCommit']:
        raise ValueError('SAM2 source commit does not match the recorded official commit.')
    if subprocess.run(['git', '-C', str(repo), 'diff', '--quiet', 'HEAD', '--', 'sam2'], check=False).returncode != 0:
        raise ValueError('Tracked SAM2 implementation/configuration has local changes.')
    if sha(args.checkpoint) != model_record['checkpointSha256']:
        raise ValueError('Checkpoint SHA-256 mismatch.')
    config_path = repo / 'sam2' / model_record['config']
    if sha(config_path) != model_record['configSha256']:
        raise ValueError('Official model configuration SHA-256 mismatch.')
    sys.path.insert(0, str(repo))
    import torch
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    torch.set_num_threads(8)
    model = build_sam2(model_record['config'], str(args.checkpoint.resolve()), device='cpu', apply_postprocessing=False)
    model.eval()
    return torch, SAM2ImagePredictor(model)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['proposals', 'sam'], required=True)
    parser.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--pose', default='all')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sam2-source', type=Path)
    parser.add_argument('--checkpoint', type=Path)
    args = parser.parse_args()
    root = args.project_root.resolve()
    package = root / 'assets/short-hair-fringe-v1/segmentation'
    manifest = json.loads((package / 'manifest.json').read_text())
    poses = list(manifest['poses']) if args.pose == 'all' else [args.pose]
    if any(p not in manifest['poses'] for p in poses):
        raise ValueError('Unknown pose.')
    output = args.output.resolve()
    if output.is_relative_to(root / 'assets'):
        raise ValueError('--output must not overwrite runtime assets; compare results before integration.')
    output.mkdir(parents=True, exist_ok=True)
    torch, predictor = official_predictor(args, manifest['model']) if args.mode == 'sam' else (None, None)
    reports = []
    for pose in poses:
        recipe = json.loads(checked_path(package, manifest['poses'][pose]['recipe']).read_text())
        rgb = np.array(Image.open(checked_path(root, recipe['source'])).convert('RGB'))
        alpha = np.array(Image.open(checked_path(root, recipe['alpha'])).convert('RGBA'))[:, :, 3]
        start = time.perf_counter()
        if predictor:
            prompt = recipe['prompt']
            points = np.array(prompt['positive'] + prompt['negative'], np.float32)
            labels = np.array([1] * len(prompt['positive']) + [0] * len(prompt['negative']), np.int32)
            with torch.inference_mode():
                predictor.set_image(rgb)
                masks, scores, _ = predictor.predict(point_coords=points, point_labels=labels, multimask_output=True, return_logits=True)
            proposal = masks[recipe['proposal']['selectedCandidate']] > 0
            scores = scores.tolist()
        else:
            proposal = binary_image(checked_path(package, recipe['proposal']))
            scores = recipe['proposal']['scores']
        if proposal.shape != alpha.shape or rgb.shape[:2] != alpha.shape:
            raise ValueError(f'{pose}: native source/alpha/proposal size mismatch.')
        baseline, protection = baseline_refinement(rgb, alpha, proposal, recipe['baselineRefinement'])
        refined = baseline
        baseline_matches = True
        if 'tipRefinement' in recipe:
            tip = recipe['tipRefinement']
            underpaint = np.array(Image.open(checked_path(root, tip['underpaint'])).convert('RGB'))
            if underpaint.shape != rgb.shape:
                raise ValueError('Full pose underpaint reference has the wrong dimensions.')
            baseline_matches = pixel_sha(baseline) == tip['baselineBinaryPixelSha256']
            refined = tip_refinement(rgb, alpha, proposal, baseline, protection, underpaint, tip['configuration'])
        result_path = output / f'{pose}-hairOwnership.png'
        Image.fromarray(refined.astype(np.uint8) * 255).save(result_path)
        Image.fromarray(proposal.astype(np.uint8) * 255).save(output / f'{pose}-proposal.png')
        report = {'poseId': pose, 'mode': args.mode, 'modelInferenceRan': args.mode == 'sam', 'seconds': time.perf_counter() - start,
                  'scores': scores, 'proposalMatchesRecordedPixels': pixel_sha(proposal) == recipe['proposal']['binaryPixelSha256'],
                  'baselineMatchesRecordedPixels': baseline_matches, 'finalMatchesRecordedPixels': pixel_sha(refined) == recipe['expected']['binaryPixelSha256'],
                  'foregroundPixels': int(refined.sum()), 'protectedOverlapPixels': int((refined & protection).sum()),
                  'outsideAlphaPixels': int((refined & (alpha == 0)).sum()), 'outputPngSha256': sha(result_path),
                  'binaryPixelSha256': pixel_sha(refined), 'runtimeAssetsModified': False, 'artworkApprovalChanged': False}
        report['passed'] = all(report[k] for k in ['proposalMatchesRecordedPixels', 'baselineMatchesRecordedPixels', 'finalMatchesRecordedPixels']) and report['protectedOverlapPixels'] == 0 and report['outsideAlphaPixels'] == 0
        (output / f'{pose}-report.json').write_text(json.dumps(report, indent=2) + '\n')
        reports.append(report)
        print(f'{pose}: {"PASS" if report["passed"] else "MISMATCH"}; {report["foregroundPixels"]} hair pixels; inference={report["modelInferenceRan"]}', flush=True)
    (output / 'reproduction-report.json').write_text(json.dumps({'mode': args.mode, 'reports': reports, 'passed': all(r['passed'] for r in reports)}, indent=2) + '\n')
    return 0 if all(r['passed'] for r in reports) else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f'Reproduction stopped: {error}', file=sys.stderr)
        raise SystemExit(1)
