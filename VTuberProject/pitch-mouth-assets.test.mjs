import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SIDE_MOUTH_STATES} from './side-mouth-model.js';
import {validateSideExpressionManifest} from './side-expression-renderer.js';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)));
const manifest = read('./assets/short-hair-pitch-mouth-v1/manifest.json');
const approved = read('./assets/short-hair-pitch-gaze-v1/manifest.json');
const approval = read('./assets/short-hair-pitch-gaze-v1/approval.json');
const mouthApproval = read('./assets/short-hair-side-mouth-v1/approval.json');
const pitchMouthApproval = read('./assets/short-hair-pitch-mouth-v1/approval.json');
const staticReview = read('./assets/short-hair-v1/review.json');
const provenanceURL = new URL(manifest.provenance, import.meta.url);
const provenance = JSON.parse(readFileSync(provenanceURL));
const bytesFor = source => readFileSync(new URL(source.src, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const POSES = ['view-left-down', 'view-left-up', 'view-right-up'];
const newKeys = Object.keys(manifest.sources).filter(key => !Object.hasOwn(approved.sources, key)).sort();

test('approved pitch mouth pack has three poses, twelve new paintings and twenty-seven verified PNG sources', () => {
  validateSideExpressionManifest(manifest);
  assert.equal(manifest.id, 'short-hair-pitch-mouth-v1'); assert.equal(manifest.status, 'approved');
  assert.equal(manifest.poseFamily, 'pitch'); assert.equal(manifest.extends, approved.id);
  assert.deepEqual(Object.keys(manifest.poses).sort(), POSES);
  assert.deepEqual(manifest.mouthArt, {version: 1, states: [...SIDE_MOUTH_STATES]});
  assert.equal(manifest.browArt, undefined);
  assert.equal(Object.keys(manifest.sources).length, 27); assert.equal(newKeys.length, 12);
  for (const [key, source] of Object.entries(manifest.sources)) {
    const png = bytesFor(source);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), key);
    assert.equal(source.width, 1122, key); assert.equal(source.height, 1402, key);
    assert.equal(png.readUInt32BE(16), source.width, key); assert.equal(png.readUInt32BE(20), source.height, key);
    assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.equal(sha256(png), source.sha256, key);
  }
});

test('pitch mouth extension preserves all fifteen approved sources and the complete accepted gaze registration', () => {
  assert.equal(approved.status, 'approved'); assert.equal(approval.assetId, approved.id);
  for (const [key, source] of Object.entries(approved.sources)) {
    assert.deepEqual(manifest.sources[key], source, key); assert.deepEqual(source, approval.approvedSources[key], key);
    assert.equal(sha256(bytesFor(source)), approval.approvedSources[key].sha256, key);
  }
  assert.deepEqual(manifest.gaze, approved.gaze);
  assert.equal(sha256(JSON.stringify(manifest.gaze)), approval.approvedGazeSha256);
});

test('removing only four new mouth states restores every approved pitch pose field and original eye/jaw patch exactly', () => {
  const original = structuredClone(manifest.poses);
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], old = approved.poses[poseId];
    assert.deepEqual(pose.patches.eyeLeft, old.patches.eyeLeft);
    assert.deepEqual(pose.patches.eyeRight, old.patches.eyeRight);
    for (const state of ['openSmall', 'openWide']) assert.deepEqual(pose.patches.mouth[state], old.patches.mouth[state]);
    for (const state of SIDE_MOUTH_STATES) delete original[poseId].patches.mouth[state];
  }
  assert.deepEqual(original, approved.poses);
  assert.equal(sha256(JSON.stringify(original)), approval.approvedPosesSha256);
});

test('every pitch mouth state owns a distinct pose-specific painting, including separate left and right shifts', () => {
  const referenced = [], hashes = new Set(), oldHashes = new Set(Object.values(approved.sources).map(source => source.sha256));
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId];
    assert.deepEqual(Object.keys(pose.patches.mouth).sort(), ['openSmall', 'openWide', ...SIDE_MOUTH_STATES].sort());
    for (const state of SIDE_MOUTH_STATES) {
      const patch = pose.patches.mouth[state], source = manifest.sources[patch.source];
      assert.ok(newKeys.includes(patch.source), `${poseId}/${state}: new source`);
      assert.equal(source.pose, poseId); assert.ok(!oldHashes.has(source.sha256));
      referenced.push(patch.source); hashes.add(sha256(bytesFor(source)));
    }
    assert.notEqual(pose.patches.mouth.shiftLeft.source, pose.patches.mouth.shiftRight.source);
    assert.notEqual(pose.patches.mouth.shiftLeft.source, pose.patches.mouth.pucker.source);
    assert.notEqual(pose.patches.mouth.shiftRight.source, pose.patches.mouth.pucker.source);
  }
  assert.equal(hashes.size, 12); assert.equal(new Set(referenced).size, 12);
  assert.deepEqual(referenced.sort(), newKeys);
});

test('actual pitch mouths retain one-to-one source scale, upper-lip height and each authored shift direction', () => {
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], chin = staticReview.poses.find(p => p.id === poseId).landmarks.chin;
    for (const state of SIDE_MOUTH_STATES) {
      const p = pose.patches.mouth[state];
      assert.equal(p.transform, 'translation-only'); assert.equal(p.anchor.kind, 'upper-lip');
      assert.deepEqual(p.rect.slice(2), p.destination.slice(2));
      assert.deepEqual(p.anchor.source.map((v, axis) => v + p.destination[axis] - p.rect[axis]), p.anchor.destination);
      assert.equal(p.anchor.destination[1], pose.mouthReference[1], `${poseId}/${state}: fixed upper-lip height`);
      const dx = p.anchor.destination[0] - pose.mouthReference[0];
      if (state === 'shiftLeft') assert.ok(dx > 0 && dx <= 24, `${poseId}: character-left movement is canvas-right`);
      else if (state === 'shiftRight') assert.ok(dx < 0 && dx >= -24, `${poseId}: character-right movement is canvas-left`);
      else assert.equal(dx, 0, `${poseId}/${state}: stable non-shift upper lip`);
      assert.ok(Array.isArray(p.clip) && p.clip.length >= 3);
      assert.ok(p.destination[1] + p.destination[3] < chin[1], `${poseId}/${state}: preserve the chin and torso`);
    }
  }
});

test('all twelve final pitch mouth paintings record actual prompts and same-pose reference chains that reach approved originals', () => {
  assert.equal(provenance.tool, 'Built-in image_gen'); assert.equal(provenance.assets.length, 12);
  assert.deepEqual(provenance.assets.map(asset => asset.key).sort(), newKeys);
  const used = new Set(Object.values(manifest.sources).map(source => new URL(source.src, import.meta.url).href));
  const intermediates = new Map();
  const verifiedFile = entry => {
    assert.equal(typeof entry.file, 'string');
    const url = new URL(entry.file, provenanceURL);
    assert.equal(url.protocol, 'file:'); assert.ok(url.pathname.endsWith('.png'));
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(sha256(readFileSync(url)), entry.sha256, `${entry.file}: actual saved source fingerprint`);
    return url.href;
  };
  for (const intermediate of provenance.intermediateSources || []) {
    const href = verifiedFile(intermediate);
    assert.ok(POSES.includes(intermediate.pose), `${intermediate.file}: registered pose`);
    assert.ok(!used.has(href), `${intermediate.file}: intermediate is not a final runtime source`);
    assert.ok(!intermediates.has(href), `${intermediate.file}: no duplicate intermediate registration`);
    intermediates.set(href, intermediate);
  }
  const traceReference = (reference, poseId, visited) => {
    assert.equal(typeof reference, 'string');
    const url = new URL(reference, provenanceURL);
    const pose = approved.poses[poseId], original = approved.sources[pose.reference];
    if (url.href === new URL(original.src, import.meta.url).href) {
      assert.equal(sha256(readFileSync(url)), approval.approvedSources[pose.reference].sha256);
      return;
    }
    assert.ok(!visited.has(url.href), `${poseId}: reference chain contains a cycle`);
    const intermediate = intermediates.get(url.href);
    assert.ok(intermediate, `${reference}: non-original references must be registered intermediate sources`);
    assert.equal(intermediate.pose, poseId, `${reference}: reference chain cannot cross poses`);
    traceReference(intermediate.reference, poseId, new Set([...visited, url.href]));
  };
  // A refinement may honestly reference an earlier generated painting. Every
  // such step is checked; it must not be rewritten as a direct original edit.
  for (const asset of provenance.assets) {
    const source = manifest.sources[asset.key], href = verifiedFile(asset);
    assert.equal(href, new URL(source.src, import.meta.url).href);
    assert.equal(asset.sha256, source.sha256);
    traceReference(asset.reference, source.pose, new Set([href]));
    assert.equal(typeof asset.generationId, 'string'); assert.ok(asset.generationId.length > 10);
    assert.equal(typeof asset.prompt, 'string'); assert.ok(asset.prompt.length > 100);
  }
  for (const [href, intermediate] of intermediates) {
    traceReference(intermediate.reference, intermediate.pose, new Set([href]));
  }
});

test('accepted gaze compilation, gaze drawing and eye/jaw/mouth selection runtimes stay frozen', () => {
  for (const kind of ['Gaze', 'SharedGaze', 'Expression']) {
    const path = approval[`approved${kind}RuntimePath`];
    assert.equal(sha256(readFileSync(new URL(path, import.meta.url))), approval[`approved${kind}RuntimeSha256`], path);
  }
  assert.equal(sha256(readFileSync(new URL(mouthApproval.approvedMouthRuntimePath, import.meta.url))), mouthApproval.approvedMouthRuntimeSha256);
  // These checks establish resource and registration integrity, not visual approval.
});

test('accepted pitch mouth snapshot freezes all source bytes, registrations, gaze inheritance and mouth selection', () => {
  assert.equal(pitchMouthApproval.assetId, manifest.id);
  assert.equal(pitchMouthApproval.date, '2026-10-27');
  assert.equal(pitchMouthApproval.userFeedback, '不错，进展目前不错，请继续进步，且可以进行下一步了');
  assert.equal(manifest.approval, './assets/short-hair-pitch-mouth-v1/approval.json');
  assert.deepEqual(manifest.sources, pitchMouthApproval.approvedSources);
  for (const source of Object.values(pitchMouthApproval.approvedSources)) assert.equal(sha256(bytesFor(source)), source.sha256);
  for (const [field, hash] of [['poses', 'approvedPosesSha256'], ['gaze', 'approvedGazeSha256'], ['mouthArt', 'approvedMouthArtSha256']]) {
    assert.equal(sha256(JSON.stringify(manifest[field])), pitchMouthApproval[hash], field);
  }
  for (const kind of ['Gaze', 'SharedGaze', 'Expression', 'Mouth', 'GazeSnapshot']) {
    const runtime = pitchMouthApproval[`approved${kind}RuntimePath`];
    assert.equal(sha256(readFileSync(new URL(runtime, import.meta.url))), pitchMouthApproval[`approved${kind}RuntimeSha256`], runtime);
  }
  assert.match(pitchMouthApproval.pendingScope, /pitch eyebrow paintings/);
  assert.match(pitchMouthApproval.pendingScope, /right-down expressions/);
  assert.match(pitchMouthApproval.pendingScope, /final integrated software acceptance/);
});
