import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  SHORT_HAIR_CHARACTER_PACK_URL, validateCharacterPackPath, validateShortHairCharacterPack,
  compileShortHairCharacterPack, summarizeShortHairCharacterPack, verifyShortHairCharacterPackFiles,
  loadShortHairCharacterPack, buildShortHairCharacterPack,
} from './short-hair-character-pack.js';

const readBytes = path => readFile(new URL(path, import.meta.url));
const original = JSON.parse(await readBytes(SHORT_HAIR_CHARACTER_PACK_URL));
const copy = value => structuredClone(value);
const metadata = new Map(await Promise.all(original.files.filter(file => file.kind !== 'artwork')
  .map(async file => [file.path, JSON.parse(await readBytes(file.path))])));
const pose = (pack, id = 'front') => pack.poses.find(item => item.id === id);

// A lightweight representation of the *actual* merged manifests. Canvas markers
// test inventory-vs-runtime coverage only, not browser pixel correctness.
function loadedAssets() {
  const result = {};
  for (const item of original.poses) {
    const base = metadata.get(item.baseManifest), extension = item.extensionManifest && metadata.get(item.extensionManifest);
    if (!result[item.family]) result[item.family] = {manifest: copy(base), compiled: {}, gazeLayers: {}};
    const family = result[item.family], record = item.id === 'front' ? family.manifest : family.manifest.poses[item.id];
    if (extension) {
      Object.assign(family.manifest.sources, extension.sources);
      for (const [group, states] of Object.entries(extension.poses[item.id].patches)) Object.assign(record.patches[group], copy(states));
    }
    const compiled = Object.fromEntries(Object.entries(record.patches).map(([group, states]) =>
      [group, Object.fromEntries(Object.keys(states).map(state => [state, {canvasMarker: true}]))]));
    if (item.id === 'front') { family.compiled = compiled; family.gazeLayers = {eyeLeft: {}, eyeRight: {}}; }
    else { family.compiled[item.id] = compiled; family.gazeLayers[item.id] = {eyeLeft: {}, eyeRight: {}}; }
  }
  return result;
}

test('the shipped pack verifies every current selected portrait and source document', async () => {
  const result = await verifyShortHairCharacterPackFiles(original, {readBytes});
  assert.deepEqual(result.verification, {verifiedFiles: 135, verifiedArtwork: 123, artworkBytesVerified: true, metadataVerified: true});
  assert.equal(result.summary.poseCount, 9);
  assert.equal(result.summary.artworkFileCount, 123);
  assert.ok(result.summary.poses.every(item => item.eyeStages === 5 && item.jawStages === 5 && item.specialMouths.length === 4));
  assert.equal(result.summary.poses.filter(item => item.baseStatus === 'approved').length, 6);
  assert.equal(result.summary.poses.filter(item => item.extensionStatus === 'candidate').length, 8);
  assert.equal(result.summary.fullCharacterAlpha, false);
});

test('rebuilding from selected source manifests reproduces the inventory without altering inputs', async () => {
  assert.deepEqual(await buildShortHairCharacterPack({readBytes}), original);
});

test('coverage checks use the currently compiled state sets', () => {
  const assets = loadedAssets();
  assert.equal(summarizeShortHairCharacterPack(original, assets).verificationLevel, 'compiled-studio-assets');
  delete assets.pitch.compiled['view-left-up'].mouth.parted;
  assert.throws(() => summarizeShortHairCharacterPack(original, assets), /view-left-up\/mouth\/parted.*已编译/);
});

test('runtime coordinates and missing gaze cannot silently pass inventory coverage', () => {
  const assets = loadedAssets();
  assets.front.manifest.patches.mouth.openSmall.destination[0] += 1;
  assert.throws(() => summarizeShortHairCharacterPack(original, assets), /front\/mouth\/openSmall.*已编译/);
  const missingGaze = loadedAssets(); delete missingGaze.complete.gazeLayers['view-down'].eyeRight;
  assert.throws(() => summarizeShortHairCharacterPack(original, missingGaze), /view-down.*视线/);
});

test('local-only path validation rejects traversal, encoded forms, URLs and archives', () => {
  for (const path of ['../assets/short-hair-v1/front.png', './assets/short-hair-v1/../front.png',
    './assets/short-hair-v1/%2e%2e/front.png', './assets/short-hair-v1/front.png?x=1',
    './assets/short-hair-v1/front.png#x', './assets/short-hair-v1\\front.png',
    '//example.test/front.png', 'https://example.test/front.png', '/assets/short-hair-v1/front.png',
    './iteration-prep-2026-10-29/historical-previews/front.png', './assets/short-hair-v1//front.png']) {
    assert.throws(() => validateCharacterPackPath(path), /项目内规范/);
  }
  assert.equal(validateCharacterPackPath('./assets/short-hair-v1/front.png'), './assets/short-hair-v1/front.png');
});

test('schema rejects wrong versions, absent fields and invented separation capabilities', () => {
  for (const mutate of [p => {p.schemaVersion = 2;}, p => {delete p.artBaseline;}, p => {p.unknown = true;},
    p => {p.layers.fullCharacterAlpha = true;}, p => {p.layers.separateBody = true;}]) {
    const pack = copy(original); mutate(pack); assert.throws(() => validateShortHairCharacterPack(pack), /角色素材清单/);
  }
});

test('duplicate states, duplicate poses and unrecognized pose IDs have useful errors', () => {
  const duplicateState = copy(original); pose(duplicateState).states.eyeLeft[1].id = 'open';
  assert.throws(() => validateShortHairCharacterPack(duplicateState), /状态不存在或重复/);
  const duplicatePose = copy(original); duplicatePose.poses[0] = copy(duplicatePose.poses[1]);
  assert.throws(() => validateShortHairCharacterPack(duplicatePose), /姿态不存在或重复/);
  const invalidPose = copy(original); invalidPose.poses[0].id = 'new-unknown-pose';
  assert.throws(() => validateShortHairCharacterPack(invalidPose), /new-unknown-pose.*不存在/);
});

test('missing and duplicate file registrations are rejected', () => {
  const missing = copy(original); missing.files = missing.files.filter(file => file.path !== './assets/short-hair-v1/front.png');
  assert.throws(() => validateShortHairCharacterPack(missing), /原画没有文件登记/);
  const duplicate = copy(original); duplicate.files.push(copy(duplicate.files[0]));
  assert.throws(() => validateShortHairCharacterPack(duplicate), /文件重复登记/);
});

test('schema-valid coordinate, viewport and source substitutions fail against original manifests', () => {
  const mutations = [p => {pose(p).states.mouth[1].patch.rect[1] -= 1; pose(p).states.mouth[1].patch.anchor.source[1] -= 1;},
    p => {pose(p).viewports.face[0] += 1;}, p => {pose(p).mouthReference[0] += 1;},
    p => {pose(p).states.mouth[1].path = './assets/short-hair-v1/view-left.png';}];
  for (const mutate of mutations) {
    const pack = copy(original); mutate(pack); validateShortHairCharacterPack(pack);
    assert.throws(() => compileShortHairCharacterPack(pack, metadata), /登记内容与来源清单漂移/);
  }
});

test('candidate poses and frame extensions cannot inherit an unrelated approval', () => {
  const pack = copy(original);
  pose(pack, 'view-up').approval.base = copy(pose(pack).approval.base);
  validateShortHairCharacterPack(pack);
  assert.throws(() => compileShortHairCharacterPack(pack, metadata), /view-up.*漂移/);
  const extension = copy(original); pose(extension, 'view-left').approval.extension.status = 'approved';
  assert.throws(() => validateShortHairCharacterPack(extension), /项目内规范/);
});

test('source manifest absence and stale source image hashes are caught before rendering', () => {
  const missing = new Map(metadata); missing.delete(pose(original).baseManifest);
  assert.throws(() => compileShortHairCharacterPack(original, missing), /来源文档缺失/);
  const hash = copy(original), source = hash.files.find(file => file.kind === 'artwork' && file.path.includes('frame-art'));
  source.sha256 = '0'.repeat(64);
  assert.throws(() => compileShortHairCharacterPack(hash, metadata), /源图指纹与来源清单不一致/);
});

test('actual missing PNG reports its path instead of an incomplete successful pack', async () => {
  const absent = original.files.find(file => file.kind === 'artwork').path;
  await assert.rejects(verifyShortHairCharacterPackFiles(original, {readBytes: path => {
    if (path === absent) throw new Error('ENOENT'); return readBytes(path);
  }}), error => error.message.includes(absent) && /文件缺失.*ENOENT/.test(error.message));
});

test('same-length artwork mutation is rejected by SHA256 rather than size alone', async () => {
  const changed = original.files.find(file => file.kind === 'artwork').path;
  await assert.rejects(verifyShortHairCharacterPackFiles(original, {readBytes: async path => {
    const bytes = await readBytes(path); if (path === changed) bytes[bytes.length - 1] ^= 1; return bytes;
  }}), /文件内容已漂移/);
});

test('approval file drift is verified even when portrait-byte verification is deferred', async () => {
  const changed = original.files.find(file => file.kind === 'approval').path;
  await assert.rejects(verifyShortHairCharacterPackFiles(original, {verifyArtwork: false, readBytes: async path => {
    const bytes = await readBytes(path); if (path === changed) bytes[bytes.length - 1] ^= 1; return bytes;
  }}), /文件内容已漂移/);
});

test('default browser loading checks metadata without claiming artwork bytes were verified', async () => {
  const requested = [];
  const result = await loadShortHairCharacterPack({fetcher: async (path, options) => {
    requested.push(path); assert.equal(options.redirect, 'error');
    const bytes = await readBytes(path);
    return {ok: true, arrayBuffer: async () => bytes};
  }});
  assert.equal(result.verification.metadataVerified, true);
  assert.equal(result.verification.artworkBytesVerified, false);
  assert.equal(result.verification.verifiedArtwork, 0);
  assert.equal(result.verification.verifiedFiles, 12);
  assert.equal(requested.length, 13);
  assert.equal(requested.filter(path => path.endsWith('.png')).length, 0);
});

test('browser loading surfaces HTTP failures and malformed JSON without fallback artwork', async () => {
  await assert.rejects(loadShortHairCharacterPack({fetcher: async () => ({ok: false, status: 404})}), /character-pack.json.*HTTP 404/);
  await assert.rejects(loadShortHairCharacterPack({fetcher: async () => ({ok: true,
    arrayBuffer: async () => new TextEncoder().encode('{invalid')})}), /不是有效的 UTF-8 JSON/);
});

test('invalid crop geometry and unreferenced files cannot enter a schema 1 pack', () => {
  const geometry = copy(original); pose(geometry).states.eyeLeft[1].patch.rect = [0, 0, 2000, 2000];
  assert.throws(() => validateShortHairCharacterPack(geometry), /查看范围超出/);
  const extra = copy(original); extra.files.push({...copy(extra.files.find(file => file.kind === 'artwork')), path: './assets/short-hair-v1/unselected.png'});
  assert.throws(() => compileShortHairCharacterPack(extra, metadata), /不属于当前采用/);
});
