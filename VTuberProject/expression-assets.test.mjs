import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateExpressionManifest} from './expression-renderer.js';
const manifest = JSON.parse(readFileSync(new URL('./assets/short-hair-expressions-v1/manifest.json', import.meta.url)));
const extended = JSON.parse(readFileSync(new URL('./assets/short-hair-expressions-v2/manifest.json', import.meta.url)));
const gaze = JSON.parse(readFileSync(new URL('./assets/short-hair-gaze-v1/manifest.json', import.meta.url)));
const bytes = (source) => readFileSync(new URL(source.src, import.meta.url));
const hash = (source) => createHash('sha256').update(bytes(source)).digest('hex');
// Approval records use sorted-key JSON with Python's default separators.
// Keep numeric tokens from that serialized file (e.g. 528.0 versus 528), since
// JS numbers alone lose the representation used in the recorded fingerprint.
const numberToken = Symbol('JSON numeric token');
const approvedGeometry = JSON.parse(readFileSync(new URL('./assets/short-hair-gaze-v1/manifest.json', import.meta.url), 'utf8'),
  (_key, value, context) => typeof value === 'number' ? {[numberToken]: context.source} : value);
const approvalJson = value => value?.[numberToken] ?? (Array.isArray(value) ? `[${value.map(approvalJson).join(', ')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${approvalJson(key)}: ${approvalJson(value[key])}`).join(', ')}}`
    : JSON.stringify(value).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`));
const geometryHash = value => createHash('sha256').update(approvalJson(value)).digest('hex');

test('actual expression images exist at their registered dimensions and approved front is unchanged', () => {
  validateExpressionManifest(manifest);
  for (const source of Object.values(manifest.sources)) {
    const png = bytes(source);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), source.width);
    assert.equal(png.readUInt32BE(20), source.height);
  }
  const designApproval = JSON.parse(readFileSync(new URL('./assets/short-hair-v1/design-approval.json', import.meta.url)));
  const original = designApproval.referenceImage;
  // Pin the digest already recorded with the accepted design, independently
  // of the current manifest and PNG. No sibling development fixture is needed.
  assert.equal(original.sha256, '8743500c475f81ffd6054a9679db35f5538521e00afa09612a2045645569b822');
  assert.equal(original.id, 'front');
  assert.equal(original.file, 'assets/short-hair-v1/front.png');
  assert.equal(manifest.sources[manifest.reference].src, `./${original.file}`);
  assert.equal(hash(manifest.sources[manifest.reference]), original.sha256);
});

test('left and right mouth use independent source drawings, not a shared pucker or mirror', () => {
  const {shiftLeft, shiftRight, pucker} = manifest.patches.mouth;
  const hash = (p) => createHash('sha256').update(bytes(manifest.sources[p.source])).digest('hex');
  assert.equal(new Set([hash(shiftLeft), hash(shiftRight), hash(pucker)]).size, 3);
  assert.ok(shiftLeft.anchor.destination[0] > manifest.mouthReference[0]);
  assert.ok(shiftRight.anchor.destination[0] < manifest.mouthReference[0]);
});

test('registered jaw paintings share upper lip anchor and never scale with expression strength', () => {
  for (const state of ['openSmall', 'openWide']) {
    const p = manifest.patches.mouth[state];
    assert.equal(p.anchor.kind, 'upper-lip');
    assert.deepEqual(p.anchor.destination, manifest.mouthReference);
    assert.deepEqual(p.destination.slice(2), p.rect.slice(2));
  }
  // A finite register is not a test of whether the painted contour looks natural.
  for (const group of Object.values(manifest.patches)) for (const p of Object.values(group)) {
    assert.ok(p.destination[1] + p.destination[3] < 771, 'local crops do not reach chin, neck or torso');
    assert.equal(p.transform, 'translation-only');
  }
});

test('renderer refuses invalid registration instead of stretching or clipping silently', () => {
  for (const mutate of [
    m => { m.patches.mouth.openWide.destination[2] += 2; },
    m => { m.patches.mouth.openWide.rect[0] = -1; },
    m => { m.patches.mouth.openWide.anchor.source[1] += 1; },
    m => { m.sources.neutral.src = 'https://example.com/front.png'; },
    m => { m.patches.eyeLeft.half.feather = 100; },
    m => { delete m.patches.eyeLeft.half; },
  ]) {
    const candidate = structuredClone(manifest); mutate(candidate);
    assert.throws(() => validateExpressionManifest(candidate));
  }
});

test('approved five-stage pack preserves every original source and registration and adds actual in-between images', () => {
  validateExpressionManifest(extended);
  const approval = JSON.parse(readFileSync(new URL('./assets/short-hair-expressions-v1/approval.json', import.meta.url)));
  assert.equal(manifest.status, 'approved');
  assert.equal(extended.status, 'approved');
  for (const [key, source] of Object.entries(manifest.sources)) {
    assert.deepEqual(extended.sources[key], source);
    assert.equal(createHash('sha256').update(bytes(source)).digest('hex'), approval.approvedSources[key].sha256);
  }
  for (const [group, states] of Object.entries(manifest.patches)) for (const [state, p] of Object.entries(states)) {
    assert.deepEqual(extended.patches[group][state], p);
  }
  for (const name of ['quarter-parted', 'three-quarter-medium']) {
    const png = bytes(extended.sources[name]);
    assert.equal(png.readUInt32BE(16), 1122);
    assert.equal(png.readUInt32BE(20), 1402);
  }
  for (const state of ['parted', 'openMedium']) assert.deepEqual(extended.patches.mouth[state].anchor.destination, manifest.mouthReference);
});

test('five-stage approval fingerprints still match every source drawing', () => {
  const approval = JSON.parse(readFileSync(new URL('./assets/short-hair-expressions-v2/approval.json', import.meta.url)));
  assert.equal(approval.assetId, extended.id);
  assert.equal(extended.status, 'approved');
  assert.deepEqual(Object.keys(approval.approvedSources).sort(), Object.keys(extended.sources).sort());
  for (const [key, source] of Object.entries(extended.sources)) {
    const {sha256, ...registeredSource} = approval.approvedSources[key];
    assert.deepEqual(source, registeredSource);
    assert.equal(hash(source), sha256, key);
  }
  assert.equal(createHash('sha256').update(readFileSync(new URL('./expression-motion.js', import.meta.url))).digest('hex'), approval.approvedMotionSha256);
});

test('approved gaze pack preserves all approved five-stage artwork and registers separate gaze resources', () => {
  validateExpressionManifest(gaze);
  assert.equal(gaze.status, 'approved');
  assert.equal(gaze.basedOn, extended.id);
  assert.notEqual(gaze.id, extended.id);
  assert.notEqual(gaze.id, manifest.id);
  assert.equal(gaze.reference, extended.reference);
  assert.deepEqual(gaze.patches, extended.patches);
  assert.equal(gaze.extensions.eyes, true);
  assert.equal(gaze.extensions.jaw, true);
  assert.equal(gaze.extensions.gaze, true);
  for (const [key, source] of Object.entries(extended.sources)) assert.deepEqual(gaze.sources[key], source, key);
  const additions = Object.entries(gaze.sources).filter(([key]) => !Object.hasOwn(extended.sources, key));
  assert.equal(additions.length, 2);
  assert.equal(new Set(additions.map(([, source]) => hash(source))).size, 2);
  for (const [, source] of additions) {
    const png = bytes(source);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), source.width);
    assert.equal(png.readUInt32BE(20), source.height);
  }
});

test('approved gaze source images, expression registration and eye-layer geometry retain their accepted fingerprints', () => {
  const approval = JSON.parse(readFileSync(new URL('./assets/short-hair-gaze-v1/approval.json', import.meta.url)));
  assert.equal(approval.assetId, gaze.id);
  assert.equal(gaze.status, 'approved');
  assert.deepEqual(Object.keys(approval.approvedSources).sort(), Object.keys(gaze.sources).sort());
  for (const [key, source] of Object.entries(gaze.sources)) {
    const {sha256, ...registeredSource} = approval.approvedSources[key];
    assert.deepEqual(source, registeredSource);
    assert.equal(hash(source), sha256, key);
  }
  assert.equal(geometryHash(approvedGeometry.patches), approval.approvedPatchesSha256);
  assert.equal(geometryHash(approvedGeometry.gaze), approval.approvedGazeSha256);
  assert.equal(createHash('sha256').update(readFileSync(new URL('./expression-gaze.js', import.meta.url))).digest('hex'), approval.approvedGazeRendererSha256);
});

test('partial extended packs are rejected rather than claiming five-stage support', () => {
  for (const [group, state] of [['eyeLeft', 'quarter'], ['eyeRight', 'threeQuarter'], ['mouth', 'parted'], ['mouth', 'openMedium']]) {
    const broken = structuredClone(extended); delete broken.patches[group][state];
    assert.throws(() => validateExpressionManifest(broken));
  }
});
