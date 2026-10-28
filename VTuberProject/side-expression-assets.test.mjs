import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateSideExpressionManifest} from './side-expression-renderer.js';

const manifestURL = new URL('./assets/short-hair-side-expressions-v1/manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestURL));
const provenanceURL = new URL(manifest.provenance, import.meta.url);
const provenance = JSON.parse(readFileSync(provenanceURL));
const designApproval = JSON.parse(readFileSync(new URL('./assets/short-hair-v1/design-approval.json', import.meta.url)));
const staticReview = JSON.parse(readFileSync(new URL('./assets/short-hair-v1/review.json', import.meta.url)));
const sourceBytes = source => readFileSync(new URL(source.src, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('approved side pack has two poses and all six actual PNGs match their recorded dimensions and fingerprints', () => {
  validateSideExpressionManifest(manifest);
  assert.equal(manifest.status, 'approved');
  assert.deepEqual(Object.keys(manifest.poses).sort(), ['view-left', 'view-right']);
  assert.equal(Object.keys(manifest.sources).length, 6);
  for (const [key, source] of Object.entries(manifest.sources)) {
    const png = sourceBytes(source);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), key);
    assert.equal(png.readUInt32BE(16), source.width, key);
    assert.equal(png.readUInt32BE(20), source.height, key);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(sha256(png), source.sha256, key);
  }
});

test('side expression approval protects all six source files, pose registrations and the authored-state model', () => {
  const approval = JSON.parse(readFileSync(new URL('./assets/short-hair-side-expressions-v1/approval.json', import.meta.url)));
  assert.equal(approval.assetId, manifest.id);
  assert.equal(manifest.status, 'approved');
  assert.deepEqual(manifest.sources, approval.approvedSources);
  for (const [key, source] of Object.entries(manifest.sources)) assert.equal(sha256(sourceBytes(source)), approval.approvedSources[key].sha256, key);
  assert.equal(sha256(JSON.stringify(manifest.poses)), approval.approvedPosesSha256);
  assert.equal(sha256(readFileSync(new URL('./side-expression-model.js', import.meta.url))), approval.approvedModelSha256);
});

test('each neutral background uses its approved static pose and all six approved angles remain byte-identical', () => {
  const approval = designApproval.approvals.find(item => item.id === 'six-static-angles-2026-10-23');
  assert.ok(approval);
  for (const image of approval.approvedImages) {
    const actual = readFileSync(new URL(`./${image.file}`, import.meta.url));
    assert.equal(sha256(actual), image.sha256, image.id);
  }
  for (const [poseId, pose] of Object.entries(manifest.poses)) {
    const source = manifest.sources[pose.reference];
    const approved = approval.approvedImages.find(item => item.id === poseId);
    assert.equal(source.pose, poseId);
    assert.equal(source.src, `./${approved.file}`);
    assert.equal(sha256(sourceBytes(source)), approved.sha256);
  }
});

test('four expression paintings are distinct from each other and their approved backgrounds', () => {
  const references = new Set(Object.values(manifest.poses).map(pose => pose.reference));
  const expressions = Object.entries(manifest.sources).filter(([key]) => !references.has(key));
  assert.equal(expressions.length, 4);
  assert.equal(new Set(Object.values(manifest.sources).map(source => sha256(sourceBytes(source)))).size, 6);
  for (const [poseId, pose] of Object.entries(manifest.poses)) {
    const localExpressions = expressions.filter(([, source]) => source.pose === poseId);
    assert.equal(localExpressions.length, 2);
    for (const [group, states] of Object.entries(pose.patches)) {
      assert.equal(new Set(Object.values(states).map(p => sha256(sourceBytes(manifest.sources[p.source])))).size, 2, group);
      for (const patch of Object.values(states)) {
        assert.equal(manifest.sources[patch.source].pose, poseId);
        assert.notEqual(patch.source, pose.reference);
      }
    }
  }
});

test('source provenance identifies each saved painting and the corresponding approved pose reference', () => {
  const references = new Set(Object.values(manifest.poses).map(pose => pose.reference));
  const newKeys = Object.keys(manifest.sources).filter(key => !references.has(key)).sort();
  assert.deepEqual(provenance.files.map(file => file.key).sort(), newKeys);
  for (const file of provenance.files) {
    const source = manifest.sources[file.key];
    const pose = manifest.poses[source.pose];
    assert.equal(new URL(file.output, provenanceURL).href, new URL(source.src, import.meta.url).href);
    assert.equal(new URL(file.inputReference, provenanceURL).href, new URL(manifest.sources[pose.reference].src, import.meta.url).href);
    assert.equal(typeof file.prompt, 'string'); assert.ok(file.prompt.trim().length > 0);
    assert.equal(typeof file.sourceToolFile, 'string'); assert.ok(file.sourceToolFile.endsWith('.png'));
  }
});

test('local eye registration preserves anatomical sides and avoids replacing the chin or torso', () => {
  for (const [poseId, pose] of Object.entries(manifest.poses)) {
    const chin = staticReview.poses.find(item => item.id === poseId).landmarks.chin;
    for (const state of ['half', 'closed']) {
      const left = pose.patches.eyeLeft[state].destination;
      const right = pose.patches.eyeRight[state].destination;
      assert.ok(left[0] > right[0] + right[2], `${poseId}: character-left eye stays on viewer-right`);
    }
    for (const states of Object.values(pose.patches)) for (const p of Object.values(states)) {
      assert.equal(p.transform, 'translation-only');
      assert.deepEqual(p.rect.slice(2), p.destination.slice(2));
      assert.ok(p.destination[1] + p.destination[3] < chin[1], `${poseId}: local expression does not replace chin / torso`);
    }
  }
});

test('each angle independently registers both mouth drawings to one stable upper-lip point', () => {
  assert.notDeepEqual(manifest.poses['view-left'].mouthReference, manifest.poses['view-right'].mouthReference);
  for (const pose of Object.values(manifest.poses)) for (const state of ['openSmall', 'openWide']) {
    const p = pose.patches.mouth[state];
    assert.equal(p.anchor.kind, 'upper-lip');
    assert.deepEqual(p.anchor.destination, pose.mouthReference);
    assert.deepEqual(p.anchor.source.map((value, axis) => value + p.destination[axis] - p.rect[axis]), pose.mouthReference);
    assert.ok(Array.isArray(p.clip) && p.clip.length >= 3, 'mouth has an explicit local silhouette mask');
  }
  // These tests establish resource and registration integrity, not appearance.
});
