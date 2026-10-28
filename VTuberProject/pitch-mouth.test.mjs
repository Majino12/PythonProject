import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SIDE_MOUTH_STATES, selectSideMouthExpression} from './side-mouth-model.js';
import {selectSideGaze} from './side-gaze.js';
import {validateSideExpressionManifest, loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)));
const base = () => read('./assets/short-hair-pitch-gaze-v1/manifest.json');
const POSES = ['view-left-up', 'view-right-up', 'view-left-down'];
function fixture() {
  const m = base(); m.id = 'pitch-mouth-fixture'; m.mouthArt = {version: 1, states: [...SIDE_MOUTH_STATES]};
  for (const [poseId, pose] of Object.entries(m.poses)) for (const state of SIDE_MOUTH_STATES) {
    const source = `${poseId}-${state}`;
    m.sources[source] = {src: `./assets/pitch-mouth/${source}.png`, width: m.width, height: m.height, pose: poseId};
    const p = structuredClone(pose.patches.mouth.openSmall); p.source = source;
    const shift = state === 'shiftLeft' ? 6 : state === 'shiftRight' ? -6 : 0;
    p.destination[0] += shift; p.anchor.destination[0] += shift;
    if (p.clip) p.clip = p.clip.map(([x, y]) => [x + shift, y]);
    pose.patches.mouth[state] = p;
  }
  return m;
}
function fakeCanvas() {
  const calls = [], context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'translate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'fillRect', 'fill', 'stroke'].map(name => [name, (...args) => calls.push([name, ...args])]));
  context.createLinearGradient = () => ({addColorStop() {}});
  return {width: 0, height: 0, getContext: () => context, calls};
}
function installDOM(t) {
  const canvases = []; let loaded = 0;
  class ImageStub {naturalWidth = 1122; naturalHeight = 1402; set src(value) {this.name = value; loaded++; queueMicrotask(() => this.onload());}}
  for (const [name, value] of [['Image', ImageStub], ['createImageBitmap', async canvas => ({width: canvas.width, height: canvas.height})], ['document', {createElement: () => {const c = fakeCanvas(); canvases.push(c); return c;}}]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  return {canvases, loaded: () => loaded};
}
const draws = canvas => canvas.calls.filter(([name]) => name === 'drawImage');

test('pitch mouth requires the exact four authored states, existing gaze and the three supported pitch poses', () => {
  const m = fixture(); assert.equal(validateSideExpressionManifest(m), m);
  for (const mutate of [
    m => {delete m.gaze;}, m => {delete m.mouthArt;}, m => {m.browArt = {version: 1, states: []};},
    m => {delete m.poses['view-left-down'];}, m => {m.poses['view-right-down'] = m.poses['view-left-down'];},
    m => {m.poseFamily = 'side';}, m => {m.mouthArt.version = 2;}, m => {m.mouthArt.states.pop();},
    m => {m.mouthArt.states[0] = 'press';}, m => {m.mouthArt.allowOffset = true;},
    m => {delete m.poses['view-left-up'].patches.mouth.press;},
    m => {m.poses['view-left-down'].patches.mouth.puckerShift = m.poses['view-left-down'].patches.mouth.pucker;},
  ]) {const broken = fixture(); mutate(broken); assert.throws(() => validateSideExpressionManifest(broken));}
});

test('pitch mouth sources cannot be mirrored, shared across directions, borrowed from another angle or stretched', () => {
  for (const mutate of [
    m => {m.poses['view-left-up'].patches.mouth.pucker.source = 'view-right-up-pucker';},
    m => {m.poses['view-left-up'].patches.mouth.shiftRight.source = 'view-left-up-shiftLeft';},
    m => {m.sources['view-left-down-shiftRight'].src = m.sources['view-left-down-shiftLeft'].src;},
    m => {m.sources['view-left-down-pucker'].src = m.sources['view-left-up-pucker'].src;},
    m => {m.poses['view-right-up'].patches.mouth.press.source = m.poses['view-right-up'].patches.mouth.openSmall.source;},
    m => {m.poses['view-left-down'].patches.mouth.shiftLeft.transform = 'mirror';},
    m => {m.poses['view-left-down'].patches.mouth.pucker.destination[2]++;},
  ]) {const m = fixture(); mutate(m); assert.throws(() => validateSideExpressionManifest(m));}
});

test('pitch directional upper-lip registration keeps its signed offset instead of recentering both drawings', () => {
  const m = fixture();
  for (const poseId of POSES) for (const state of SIDE_MOUTH_STATES) {
    const pose = m.poses[poseId], p = pose.patches.mouth[state];
    assert.deepEqual(p.rect.slice(2), p.destination.slice(2));
    assert.deepEqual(p.anchor.source.map((value, axis) => value + p.destination[axis] - p.rect[axis]), p.anchor.destination);
    assert.equal(p.anchor.destination[1], pose.mouthReference[1]);
    assert.equal(p.anchor.destination[0] - pose.mouthReference[0], state === 'shiftLeft' ? 6 : state === 'shiftRight' ? -6 : 0);
  }
  for (const [state, dx, dy] of [['shiftLeft', 0, 0], ['shiftLeft', -6, 0], ['shiftLeft', 25, 0], ['shiftRight', 0, 0], ['shiftRight', 6, 0], ['shiftRight', -25, 0], ['shiftLeft', 6, 1], ['pucker', 1, 0], ['press', -1, 0]]) {
    const broken = fixture(), pose = broken.poses['view-left-up'], p = pose.patches.mouth[state];
    const delta = [pose.mouthReference[0] + dx - p.anchor.destination[0], dy];
    p.anchor.destination = p.anchor.destination.map((v, i) => v + delta[i]);
    p.destination[0] += delta[0]; p.destination[1] += delta[1];
    if (p.clip) p.clip = p.clip.map(pt => pt.map((v, i) => v + delta[i]));
    p.allowOffset = true; p.anchor.allowOffset = true;
    assert.throws(() => validateSideExpressionManifest(broken), `${state}: dx=${dx}, dy=${dy}`);
  }
});

test('pitch mouths reuse close/press/pucker/signed-shift priority and cancellation without altering independent eyes or gaze', () => {
  const available = {mouthArt: true}, eye = {eyeBlinkLeft: 1, eyeBlinkRight: .5};
  for (const [signals, expected] of [
    [{jawOpen: 1, mouthLeft: 1}, 'shiftLeft'], [{jawOpen: 1, mouthRight: 1}, 'shiftRight'],
    [{jawOpen: .4, mouthLeft: 1, mouthRight: 1}, 'openSmall'],
    [{mouthPucker: 1, mouthLeft: 1}, 'pucker'], [{mouthPucker: 1, mouthPressRight: 1}, 'press'],
    [{jawOpen: 1, mouthPressLeft: 1, mouthPucker: 1, mouthRight: 1, mouthClose: .6}, 'neutral'],
  ]) {
    const state = selectSideMouthExpression({...eye, ...signals}, {}, available);
    assert.deepEqual(state, {eyeLeft: 'closed', eyeRight: 'half', mouth: expected});
  }
  assert.equal(selectSideMouthExpression({mouthLeft: .3}, {mouth: 'shiftLeft'}, available).mouth, 'shiftLeft');
  assert.equal(selectSideMouthExpression({mouthLeft: .3}, {}, available).mouth, 'neutral');
  assert.equal(selectSideMouthExpression({mouthPucker: 1, jawOpen: .4}, {}, {mouthArt: false}).mouth, 'openSmall');
  const input = {mouthPucker: 1, eyeLookInLeft: 1, eyeLookOutRight: 1};
  assert.deepEqual(selectSideGaze(input, {gaze: true}), {eyeLeft: {x: -1, y: 0}, eyeRight: {x: -1, y: 0}});
});

test('pitchMouth loading compiles thirty native expression crops and retains all six independent gaze layers', async t => {
  const dom = installDOM(t), manifest = fixture(), urls = [];
  t.mock.method(globalThis, 'fetch', async url => {urls.push(url); return {ok: true, json: async () => manifest};});
  const assets = await loadSideExpressionAssets('pitchMouth');
  assert.deepEqual(urls, ['./assets/short-hair-pitch-mouth-v1/manifest.json']);
  assert.equal(dom.loaded(), 27); assert.equal(dom.canvases.length, 54);
  assert.deepEqual(Object.keys(assets.gazeLayers), POSES);
  for (const poseId of POSES) for (const state of SIDE_MOUTH_STATES) {
    const patch = manifest.poses[poseId].patches.mouth[state], compiled = assets.compiled[poseId].mouth[state];
    const draw = draws(compiled)[0];
    assert.equal(draw[1], assets.images[patch.source]); assert.deepEqual(draw.slice(4, 6), draw.slice(8, 10));
    const canvas = fakeCanvas(); drawSideExpression(canvas, assets, poseId, {eyeLeft: 'closed', eyeRight: 'closed', mouth: state});
    const calls = draws(canvas);
    assert.equal(calls.length, 4, 'base, two closed eyelids and the selected mouth only');
    assert.equal(calls.at(-1)[1], compiled); assert.equal(calls.at(-1).length, 4);
    assert.deepEqual(calls.at(-1).slice(2), patch.destination.slice(0, 2));
  }
  const original = fakeCanvas(); drawSideExpression(original, assets, POSES[0], {mouth: 'shiftRight'}, {original: true});
  assert.equal(draws(original).length, 1);
});

test('pitch base and gaze variants reject mouth capability while pitchMouth rejects either older pack before loading images', async t => {
  const dom = installDOM(t); let manifest = fixture();
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => manifest}));
  for (const variant of ['pitch', 'pitchGaze']) await assert.rejects(loadSideExpressionAssets(variant), /能力不一致/);
  for (const variant of ['approved', 'gaze', 'mouth', 'brows']) await assert.rejects(loadSideExpressionAssets(variant), /姿态系列/);
  manifest = base(); await assert.rejects(loadSideExpressionAssets('pitchMouth'), /能力不一致/);
  manifest = read('./assets/short-hair-pitch-expressions-v1/manifest.json');
  await assert.rejects(loadSideExpressionAssets('pitchMouth'), /能力不一致/);
  assert.equal(dom.loaded(), 0); assert.equal(dom.canvases.length, 0);
});

test('the accepted mouth selector is byte-identical while pitch extends only the shared player', () => {
  const approval = read('./assets/short-hair-side-mouth-v1/approval.json');
  const bytes = readFileSync(new URL(approval.approvedMouthRuntimePath, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), approval.approvedMouthRuntimeSha256);
});
