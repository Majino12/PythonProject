import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SIDE_BROW_STATES, selectSideBrowExpression} from './side-brow-model.js';
import {validateSideExpressionManifest, loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const read = pack => JSON.parse(readFileSync(new URL(`./assets/${pack}/manifest.json`, import.meta.url)));
const original = () => read('short-hair-pitch-mouth-v1');
function fixture() {
  const manifest = original(); manifest.id = 'pitch-brow-test';
  manifest.browArt = {version: 1, states: [...SIDE_BROW_STATES]};
  for (const [poseId, pose] of Object.entries(manifest.poses)) {
    const top = poseId === 'view-left-down' ? 470 : 345;
    pose.detailViews.brows = [250, top - 15, 600, 100];
    pose.patches.browLeft = {}; pose.patches.browRight = {};
    for (const state of SIDE_BROW_STATES) {
      const source = `${poseId}-brows-${state}`;
      manifest.sources[source] = {src: `./assets/pitch-brows/${source}.png`, width: 1122, height: 1402, pose: poseId};
      for (const [group, left] of [['browLeft', poseId === 'view-right-up' ? 715 : 500], ['browRight', poseId === 'view-right-up' ? 470 : 280]]) {
        const rect = [left, top, 85, 35];
        pose.patches[group][state] = {source, rect, destination: [...rect], transform: 'translation-only', feather: 3,
          clip: [[left + 2, top + 2], [left + 83, top + 2], [left + 83, top + 33], [left + 2, top + 33]]};
      }
    }
  }
  return manifest;
}

function fakeCanvas() {
  const calls = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'translate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'fill', 'stroke', 'fillRect', 'setLineDash', 'arc', 'fillText', 'strokeRect'].map(name => [name, (...args) => calls.push([name, ...args])]));
  context.createLinearGradient = () => ({addColorStop() {}});
  return {width: 0, height: 0, getContext: () => context, calls};
}

function assetsFor(manifest) {
  return {manifest, images: Object.fromEntries(Object.keys(manifest.sources).map(key => [key, {name: key}])),
    compiled: Object.fromEntries(Object.entries(manifest.poses).map(([poseId, pose]) => [poseId,
      Object.fromEntries(Object.entries(pose.patches).map(([group, states]) => [group, Object.fromEntries(Object.keys(states).map(state => [state, {name: `${poseId}/${group}/${state}`}]))]))])),
    gazeLayers: Object.fromEntries(Object.entries(manifest.gaze.poses).map(([poseId, pose]) => [poseId,
      Object.fromEntries(Object.entries(pose.eyes).map(([eye, registration]) => [eye, {bounds: registration.bounds, canvas: {name: `${poseId}/${eye}/iris`},
        frames: Object.fromEntries(Object.keys(registration.frames).map(state => [state, {clean: {name: `${poseId}/${eye}/${state}/clean`}}]))}]))]))};
}

function environment(t, getManifest) {
  const urls = [], canvases = [], snapshots = [], events = [];
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); return {ok: true, json: async () => getManifest(url)}; });
  class ImageStub {
    naturalWidth = 1122; naturalHeight = 1402; decoded = false;
    set src(value) { this.name = value; queueMicrotask(() => this.onload()); }
    async decode() { this.decoded = true; events.push('decode'); }
  }
  for (const [name, value] of [
    ['Image', ImageStub],
    ['document', {createElement: () => {const canvas = fakeCanvas(); canvases.push(canvas); events.push('canvas'); return canvas;}}],
    ['createImageBitmap', async canvas => {const bitmap = {width: canvas.width, height: canvas.height, close() {}}; snapshots.push(bitmap); events.push('snapshot'); return bitmap;}],
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  return {urls, canvases, snapshots, events};
}

test('pitch brows extend the complete accepted mouth and gaze families with all three independent poses', () => {
  const manifest = fixture();
  assert.equal(validateSideExpressionManifest(manifest), manifest);
  assert.doesNotThrow(() => validateSideExpressionManifest(original()));
  for (const mutate of [
    m => {delete m.gaze;}, m => {delete m.mouthArt;}, m => {delete m.browArt;},
    m => {delete m.poses['view-left-down'].patches.browRight.innerUp;},
    m => {m.poses['view-left-up'].patches.browLeft.down.source = 'view-right-up-brows-down';},
    m => {m.poses['view-right-up'].patches.browLeft.down.transform = 'mirror';},
    m => {m.poses['view-left-up'].patches.browLeft.down.destination[2]++;},
    m => {m.browArt.states.push('surprise');},
  ]) {const broken = fixture(); mutate(broken); assert.throws(() => validateSideExpressionManifest(broken));}
});

test('pitch variants reject a different capability family before loading any image', async t => {
  const packs = {pitch: read('short-hair-pitch-expressions-v1'), pitchGaze: read('short-hair-pitch-gaze-v1'), pitchMouth: original(), pitchBrows: fixture()};
  let manifest;
  environment(t, () => manifest);
  let images = 0; globalThis.Image = class {constructor() {images++;}};
  for (const requested of Object.keys(packs)) for (const [supplied, pack] of Object.entries(packs)) {
    if (requested === supplied) continue;
    manifest = pack; await assert.rejects(loadSideExpressionAssets(requested), /能力不一致/);
  }
  assert.equal(images, 0);
});

test('pitch brow loader decodes all portraits, snapshots inherited eyes first, then clips 48 native local patches', async t => {
  const manifest = fixture(), env = environment(t, () => manifest);
  const assets = await loadSideExpressionAssets('pitchBrows');
  assert.deepEqual(env.urls, ['./assets/short-hair-pitch-brows-v1/manifest.json']);
  assert.equal(Object.keys(assets.images).length, 36);
  assert.equal(env.events.indexOf('canvas'), 36, 'all images decode before any layer compilation');
  assert.deepEqual(env.events.slice(36, 60), Array(24).fill('canvas'));
  assert.deepEqual(env.events.slice(60, 78), Array(18).fill('snapshot'));
  assert.deepEqual(env.events.slice(78), Array(48).fill('canvas'));
  for (const [poseId, pose] of Object.entries(manifest.poses)) for (const group of ['browLeft', 'browRight']) for (const state of SIDE_BROW_STATES) {
    const patch = pose.patches[group][state], canvas = assets.compiled[poseId][group][state];
    assert.deepEqual([canvas.width, canvas.height], patch.rect.slice(2));
    const drawIndex = canvas.calls.findIndex(call => call[0] === 'drawImage');
    assert.ok(canvas.calls.findIndex(call => call[0] === 'clip') < drawIndex);
    assert.equal(canvas.calls[drawIndex][1].name, manifest.sources[patch.source].src);
    assert.equal(canvas.calls[drawIndex][1].decoded, true);
    assert.deepEqual(canvas.calls[drawIndex].slice(2), [...patch.rect, 0, 0, ...patch.rect.slice(2)]);
  }
});

test('brow-first and accepted-mouth loads reuse the exact immutable gaze layers without recompilation', async t => {
  const brows = fixture(), mouth = original();
  const env = environment(t, url => url.includes('brows') ? brows : mouth);
  const candidate = await loadSideExpressionAssets('pitchBrows');
  const approved = await loadSideExpressionAssets('pitchMouth');
  assert.equal(candidate.gazeLayers, approved.gazeLayers);
  assert.equal(env.snapshots.length, 18);
  assert.equal(env.canvases.length, 24 + 48 + 30);
  for (const pose of Object.values(candidate.gazeLayers)) for (const layer of Object.values(pose)) {
    assert.ok(Object.isFrozen(layer)); assert.equal(layer.canvas.getContext, undefined);
  }
});

test('pitch brow and mouth selectors retain anatomical left-right channels through the actual draw order', () => {
  const assets = assetsFor(fixture()), poseId = 'view-left-down', canvas = fakeCanvas();
  const state = selectSideBrowExpression({eyeBlinkLeft: 1, eyeBlinkRight: .5, mouthRight: 1, browOuterUpLeft: 1, browDownRight: 1}, {}, {mouthArt: true, browArt: true});
  assert.deepEqual(state, {eyeLeft: 'closed', eyeRight: 'half', mouth: 'shiftRight', browLeft: 'outerUp', browRight: 'down'});
  drawSideExpression(canvas, assets, poseId, state, {gaze: {eyeLeft: {x: 1}, eyeRight: {x: 1}}});
  const draws = canvas.calls.filter(call => call[0] === 'drawImage');
  assert.deepEqual(draws.map(call => call[1].name), [assets.manifest.poses[poseId].reference,
    `${poseId}/eyeLeft/closed`, `${poseId}/eyeRight/half`, `${poseId}/mouth/shiftRight`, `${poseId}/browLeft/outerUp`, `${poseId}/browRight/down`, `${poseId}/eyeRight/half/clean`, `${poseId}/eyeRight/iris`]);
  assert.ok(draws.every(call => call.length === 4), 'every runtime draw preserves native image dimensions');
});

test('pitch original comparison bypasses selected brows and detail framing does not alter native patches', () => {
  const assets = assetsFor(fixture()), state = {eyeLeft: 'closed', eyeRight: 'half', mouth: 'pucker', browLeft: 'down', browRight: 'innerUp'};
  for (const poseId of Object.keys(assets.manifest.poses)) {
    const canvas = fakeCanvas();
    drawSideExpression(canvas, assets, poseId, state, {original: true, detail: 'brows', gaze: {eyeLeft: {x: 1}}});
    assert.equal(canvas.calls.filter(call => call[0] === 'drawImage').length, 1);
    assert.deepEqual([canvas.width, canvas.height], assets.manifest.poses[poseId].detailViews.brows.slice(2));
    const neutralCanvas = fakeCanvas();
    drawSideExpression(neutralCanvas, assets, poseId, {...state, browLeft: 'neutral', browRight: '__proto__'});
    assert.ok(neutralCanvas.calls.filter(call => call[0] === 'drawImage').every(call => !call[1].name.includes('/brow')));
  }
});
