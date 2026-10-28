import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SIDE_MOUTH_STATES} from './side-mouth-model.js';
import {validateSideExpressionManifest} from './side-expression-renderer.js';

const manifest = JSON.parse(readFileSync(new URL('./assets/short-hair-side-mouth-v1/manifest.json', import.meta.url)));
const approved = JSON.parse(readFileSync(new URL('./assets/short-hair-side-gaze-v1/manifest.json', import.meta.url)));
const approval = JSON.parse(readFileSync(new URL('./assets/short-hair-side-gaze-v1/approval.json', import.meta.url)));
const mouthApproval = JSON.parse(readFileSync(new URL('./assets/short-hair-side-mouth-v1/approval.json', import.meta.url)));
const provenanceURL = new URL('./assets/short-hair-side-mouth-v1/provenance.json', import.meta.url);
const provenance = JSON.parse(readFileSync(provenanceURL));
const staticReview = JSON.parse(readFileSync(new URL('./assets/short-hair-v1/review.json', import.meta.url)));
const sourceBytes = source => readFileSync(new URL(source.src, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const POSES = ['view-left', 'view-right'];
const newKeys = Object.keys(manifest.sources).filter(key => !Object.hasOwn(approved.sources, key)).sort();

test('approved side mouth pack registers exactly eight new drawings and all eighteen PNG dimensions and hashes match the actual files', () => {
  validateSideExpressionManifest(manifest);
  assert.equal(manifest.status, 'approved');
  assert.equal(manifest.extends, 'short-hair-side-gaze-v1');
  assert.equal(manifest.extends, approved.id); assert.notEqual(manifest.id, approved.id);
  assert.deepEqual(manifest.mouthArt, {version: 1, states: [...SIDE_MOUTH_STATES]});
  assert.deepEqual(Object.keys(manifest.poses).sort(), POSES);
  assert.equal(Object.keys(manifest.sources).length, 18); assert.equal(newKeys.length, 8);
  for (const [key, source] of Object.entries(manifest.sources)) {
    const png = sourceBytes(source);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), key);
    assert.equal(source.width, 1122, key); assert.equal(source.height, 1402, key);
    assert.equal(png.readUInt32BE(16), source.width, key); assert.equal(png.readUInt32BE(20), source.height, key);
    assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.equal(sha256(png), source.sha256, key);
  }
});

test('new mouth pack preserves all ten approved gaze sources, eye geometry and accepted gaze runtime', () => {
  assert.equal(approved.status, 'approved'); assert.equal(approval.assetId, approved.id);
  for (const [key, source] of Object.entries(approved.sources)) {
    assert.deepEqual(manifest.sources[key], source, key);
    assert.deepEqual(manifest.sources[key], approval.approvedSources[key], key);
    assert.equal(sha256(sourceBytes(manifest.sources[key])), approval.approvedSources[key].sha256, key);
  }
  assert.deepEqual(manifest.gaze, approved.gaze);
  assert.equal(sha256(JSON.stringify(manifest.gaze)), approval.approvedGazeSha256);
  assert.equal(sha256(readFileSync(new URL(approval.approvedGazeRuntimePath, import.meta.url))), approval.approvedGazeRuntimeSha256);
});

test('both approved eye patches, two jaw patches and every other pose registration remain unchanged', () => {
  const originalPoses = structuredClone(manifest.poses);
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], old = approved.poses[poseId];
    assert.deepEqual(pose.patches.eyeLeft, old.patches.eyeLeft, poseId);
    assert.deepEqual(pose.patches.eyeRight, old.patches.eyeRight, poseId);
    for (const state of ['openSmall', 'openWide']) assert.deepEqual(pose.patches.mouth[state], old.patches.mouth[state], `${poseId}/${state}`);
    for (const state of SIDE_MOUTH_STATES) delete originalPoses[poseId].patches.mouth[state];
  }
  assert.deepEqual(originalPoses, approved.poses);
  assert.equal(sha256(JSON.stringify(originalPoses)), approval.approvedPosesSha256);
});

test('four mouth actions use eight distinct pose-owned source paintings with no runtime mirroring or reused pucker source', () => {
  const referenced = [];
  const oldHashes = new Set(Object.values(approved.sources).map(source => sha256(sourceBytes(source))));
  const newHashes = new Set();
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId];
    assert.deepEqual(Object.keys(pose.patches.mouth).sort(), ['openSmall', 'openWide', ...SIDE_MOUTH_STATES].sort());
    for (const state of SIDE_MOUTH_STATES) {
      const patch = pose.patches.mouth[state], source = manifest.sources[patch.source], hash = sha256(sourceBytes(source));
      assert.ok(newKeys.includes(patch.source), `${poseId}/${state} has a new source`);
      assert.equal(source.pose, poseId); assert.equal(patch.transform, 'translation-only');
      assert.ok(!oldHashes.has(hash), `${poseId}/${state} must not alias an approved source`);
      referenced.push(patch.source); newHashes.add(hash);
    }
    assert.notEqual(pose.patches.mouth.shiftLeft.source, pose.patches.mouth.shiftRight.source);
    assert.notEqual(pose.patches.mouth.shiftLeft.source, pose.patches.mouth.pucker.source);
    assert.notEqual(pose.patches.mouth.shiftRight.source, pose.patches.mouth.pucker.source);
  }
  assert.equal(newHashes.size, 8); assert.equal(new Set(referenced).size, 8);
  assert.deepEqual(referenced.sort(), newKeys);
});

test('each final mouth source retains its exact generation prompt and corresponding approved pose reference', () => {
  assert.equal(provenance.tool, 'Built-in image_gen');
  assert.equal(provenance.assets.length, 8);
  assert.deepEqual(provenance.assets.map(asset => asset.key).sort(), newKeys);
  assert.equal(new Set(provenance.assets.map(asset => asset.generationId)).size, 8);
  for (const asset of provenance.assets) {
    const source = manifest.sources[asset.key], pose = manifest.poses[source.pose];
    assert.equal(new URL(asset.file, provenanceURL).href, new URL(source.src, import.meta.url).href);
    assert.equal(new URL(asset.reference, provenanceURL).href, new URL(manifest.sources[pose.reference].src, import.meta.url).href);
    assert.equal(typeof asset.generationId, 'string'); assert.ok(asset.generationId.length > 10);
    assert.equal(typeof asset.prompt, 'string'); assert.ok(asset.prompt.length > 100);
  }
  // Rejected generations may be retained as provenance, but cannot become a
  // registered final source simply because the original file still exists.
  const used = new Set(Object.values(manifest.sources).map(source => new URL(source.src, import.meta.url).href));
  for (const intermediate of provenance.intermediateSources || []) {
    if (typeof intermediate.file === 'string') assert.ok(!used.has(new URL(intermediate.file, provenanceURL).href));
  }
});

test('actual new mouths keep one-to-one registration and stable upper lip height while signed shifts retain their authored direction', () => {
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], chin = staticReview.poses.find(p => p.id === poseId).landmarks.chin;
    for (const state of SIDE_MOUTH_STATES) {
      const p = pose.patches.mouth[state];
      assert.equal(p.anchor.kind, 'upper-lip'); assert.equal(p.transform, 'translation-only');
      assert.deepEqual(p.rect.slice(2), p.destination.slice(2));
      assert.deepEqual(p.anchor.source.map((v, axis) => v + p.destination[axis] - p.rect[axis]), p.anchor.destination);
      assert.equal(p.anchor.destination[1], pose.mouthReference[1], `${poseId}/${state}: stable upper-lip height`);
      const dx = p.anchor.destination[0] - pose.mouthReference[0];
      if (state === 'shiftLeft') assert.ok(dx > 0 && dx <= 24, `${poseId}: character left moves toward canvas-right`);
      else if (state === 'shiftRight') assert.ok(dx < 0 && dx >= -24, `${poseId}: character right moves toward canvas-left`);
      else assert.equal(dx, 0, `${poseId}/${state}: fixed upper-lip reference`);
      assert.ok(p.destination[1] + p.destination[3] < chin[1], `${poseId}/${state}: patch does not replace chin or torso`);
    }
  }
  // Registration/resource checks are not a claim of artistic acceptance.
});

test('accepted mouth snapshot freezes the delivered sources, pose registration, gaze and mouth-art scope', () => {
  assert.equal(mouthApproval.assetId, manifest.id);
  assert.equal(mouthApproval.userFeedback, '太棒了，请继续！');
  assert.equal(mouthApproval.date, '2026-10-26');
  assert.equal(manifest.approval, './assets/short-hair-side-mouth-v1/approval.json');
  assert.deepEqual(manifest.sources, mouthApproval.approvedSources);
  for (const [key, source] of Object.entries(mouthApproval.approvedSources)) {
    assert.equal(sha256(sourceBytes(source)), source.sha256, `${key}: approved source bytes`);
  }
  assert.equal(sha256(JSON.stringify(manifest.poses)), mouthApproval.approvedPosesSha256);
  assert.equal(sha256(JSON.stringify(manifest.gaze)), mouthApproval.approvedGazeSha256);
  assert.equal(sha256(JSON.stringify(manifest.mouthArt)), mouthApproval.approvedMouthArtSha256);
  assert.deepEqual(manifest.mouthArt.states, ['pucker', 'press', 'shiftLeft', 'shiftRight']);
  assert.match(mouthApproval.pendingScope, /eyebrow states/);
  assert.match(mouthApproval.pendingScope, /pitch\/diagonal/);
  assert.match(mouthApproval.pendingScope, /continuous head movement/);
});

test('approved mouth action selection stays frozen while future features use separate assets and models', () => {
  assert.equal(mouthApproval.approvedMouthRuntimePath, './side-mouth-model.js');
  assert.equal(
    sha256(readFileSync(new URL(mouthApproval.approvedMouthRuntimePath, import.meta.url))),
    mouthApproval.approvedMouthRuntimeSha256,
    'later brow work must not silently alter the accepted mouth-selection behavior',
  );
});
