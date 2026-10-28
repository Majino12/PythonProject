import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSideExpressionManifest, loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';
import {selectSideExpression} from './side-expression-model.js';

const POSES = ['view-left-up', 'view-right-up', 'view-left-down'];
function fixture() {
  const sources = {}, poses = {};
  for (const [index, poseId] of POSES.entries()) {
    for (const name of ['neutral', 'half-small', 'closed-wide']) sources[`${poseId}-${name}`] = {
      src: `./assets/pitch/${poseId}-${name}.png`, width: 1122, height: 1402, pose: poseId,
    };
    const dx = index * 35, dy = index * 30, mouthReference = [430 + dx, 575 + dy];
    const patch = (source, destination, anchor) => ({source: `${poseId}-${source}`, rect: [...destination], destination,
      transform: 'translation-only', feather: 5, ...(anchor ? {anchor} : {})});
    const mouth = source => patch(source, [390 + dx, 555 + dy, 100, 95], {kind: 'upper-lip', source: [...mouthReference], destination: [...mouthReference]});
    poses[poseId] = {reference: `${poseId}-neutral`, label: poseId, directionNote: '固定斜向姿态，角色左右',
      faceView: [230, 330, 680, 500], mouthReference, detailViews: {eyes: [250, 390, 600, 160], mouth: [370 + dx, 540 + dy, 150, 120]},
      patches: {
        eyeLeft: {half: patch('half-small', [490 + dx, 415 + dy, 155, 100]), closed: patch('closed-wide', [490 + dx, 415 + dy, 155, 100])},
        eyeRight: {half: patch('half-small', [280 + dx, 440 + dy, 145, 90]), closed: patch('closed-wide', [280 + dx, 440 + dy, 145, 90])},
        mouth: {openSmall: mouth('half-small'), openWide: mouth('closed-wide')},
      }};
  }
  return {id: 'pitch-test', version: 1, poseFamily: 'pitch', width: 1122, height: 1402, sources, poses};
}

function fakeCanvas() {
  const calls = [], context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'translate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'fillRect'].map(name => [name, (...args) => calls.push([name, ...args])]));
  context.createLinearGradient = () => ({addColorStop() {}});
  return {width: 0, height: 0, getContext: () => context, calls};
}
function assetsFor(manifest) {
  return {manifest, images: Object.fromEntries(Object.keys(manifest.sources).map(key => [key, {name: key}])),
    compiled: Object.fromEntries(Object.entries(manifest.poses).map(([poseId, pose]) => [poseId,
      Object.fromEntries(Object.entries(pose.patches).map(([group, states]) => [group,
        Object.fromEntries(Object.keys(states).map(state => [state, {name: `${poseId}/${group}/${state}`}]))])),
    ]))};
}
const draws = canvas => canvas.calls.filter(([name]) => name === 'drawImage');

test('pitch validation accepts the three explicit poses with individual tilted eye and mouth registrations', () => {
  const manifest = fixture();
  assert.equal(validateSideExpressionManifest(manifest), manifest);
  assert.equal(new Set(Object.values(manifest.poses).map(p => JSON.stringify(p.mouthReference))).size, 3);
  for (const pose of Object.values(manifest.poses)) assert.notEqual(pose.patches.eyeLeft.half.destination[1], pose.patches.eyeRight.half.destination[1]);
});

test('pitch family cannot be omitted, invented, mixed with side poses, or expanded to unprepared views', () => {
  for (const mutate of [
    m => { delete m.poseFamily; }, m => { m.poseFamily = 'any'; }, m => { m.poseFamily = null; },
    m => { delete m.poses['view-left-down']; },
    m => { m.poses['view-right-down'] = m.poses['view-left-down']; },
    m => { m.poses['view-left'] = m.poses['view-left-up']; delete m.poses['view-left-up']; },
    m => { m.poses = {'view-left': m.poses['view-left-up'], 'view-right': m.poses['view-right-up']}; },
  ]) { const m = fixture(); mutate(m); assert.throws(() => validateSideExpressionManifest(m)); }
});

test('pitch basic family rejects mouth and brow extensions that omit their accepted prerequisites', () => {
  for (const extension of ['mouthArt', 'browArt']) for (const value of [{}, null, {version: 1, states: []}]) {
    const m = fixture(); m[extension] = value;
    assert.throws(() => validateSideExpressionManifest(m));
  }
});

test('pitch patches and base images cannot borrow another pose or disguise a shared PNG as independent art', () => {
  for (const mutate of [
    m => { m.poses['view-left-up'].reference = 'view-right-up-neutral'; },
    m => { m.poses['view-left-up'].patches.eyeLeft.half.source = 'view-right-up-half-small'; },
    m => { m.sources['view-left-up-half-small'].pose = 'view-left'; },
    m => { m.sources['view-right-up-half-small'].src = m.sources['view-left-up-half-small'].src; },
    m => { m.sources['view-left-up-half-small'].src = m.sources['view-left-up-neutral'].src; },
    m => { delete m.poses['view-left-down'].patches.eyeRight.closed; },
  ]) { const m = fixture(); mutate(m); assert.throws(() => validateSideExpressionManifest(m)); }
});

test('pitch mouths require stable anatomical upper-lip anchors and native-size local registration', () => {
  for (const mutate of [
    p => { delete p.anchor; }, p => { p.anchor.kind = 'crop-center'; },
    p => { p.anchor.source[1]++; },
    p => { p.anchor.source[1]++; p.anchor.destination[1]++; },
    p => { p.destination[2]++; }, p => { p.transform = 'mirror'; },
    p => { p.clip = [[0, 0], [1, 0], [0, 1]]; },
  ]) { const m = fixture(); mutate(m.poses['view-left-down'].patches.mouth.openWide); assert.throws(() => validateSideExpressionManifest(m)); }
  const m = fixture(), p = m.poses['view-left-down'].patches.mouth.openWide;
  p.rect[1] += 3; p.anchor.source[1] += 3;
  assert.equal(validateSideExpressionManifest(m), m, 'source upper lip may be registered by a fixed translation without changing its target');
});

test('pitch uses independent anatomical blink channels and close-mouth priority without applying unused full portraits', () => {
  const assets = assetsFor(fixture());
  for (const poseId of POSES) {
    const canvas = fakeCanvas(), state = selectSideExpression({eyeBlinkLeft: 1, eyeBlinkRight: .5, jawOpen: 1, mouthClose: 1});
    drawSideExpression(canvas, assets, poseId, state);
    assert.deepEqual(draws(canvas).map(([, image]) => image.name), [`${poseId}-neutral`, `${poseId}/eyeLeft/closed`, `${poseId}/eyeRight/half`]);
    assert.ok(draws(canvas).every(call => call.length === 4), 'runtime draws fixed images at x/y without stretch arguments');
    const rightOnly = fakeCanvas(); drawSideExpression(rightOnly, assets, poseId, selectSideExpression({eyeBlinkRight: 1}));
    assert.deepEqual(draws(rightOnly).map(([, image]) => image.name), [`${poseId}-neutral`, `${poseId}/eyeRight/closed`]);
  }
});

test('changing pitch pose clears the preceding pose and chooses only the new pose reference and patches', () => {
  const assets = assetsFor(fixture()), canvas = fakeCanvas();
  drawSideExpression(canvas, assets, POSES[0], selectSideExpression({eyeBlinkLeft: 1, jawOpen: 1}));
  canvas.calls.length = 0;
  drawSideExpression(canvas, assets, POSES[2], selectSideExpression({eyeBlinkRight: .5, jawOpen: .4}));
  assert.deepEqual(canvas.calls[0], ['setTransform', 1, 0, 0, 1, 0, 0]);
  assert.deepEqual(canvas.calls[1], ['clearRect', 0, 0, 680, 500]);
  assert.deepEqual(draws(canvas).map(([, image]) => image.name), [`${POSES[2]}-neutral`, `${POSES[2]}/eyeRight/half`, `${POSES[2]}/mouth/openSmall`]);
});

test('neutral and original pitch views use only the approved pose image', () => {
  const assets = assetsFor(fixture());
  for (const poseId of POSES) for (const original of [false, true]) {
    const canvas = fakeCanvas(), state = selectSideExpression(original ? {eyeBlinkLeft: 1, jawOpen: 1} : {});
    drawSideExpression(canvas, assets, poseId, state, {original});
    assert.deepEqual(draws(canvas).map(([, image]) => image.name), [`${poseId}-neutral`]);
  }
});

test('pitch loader uses its explicit URL and compiles only eighteen native local patches', async t => {
  const manifest = fixture(), requested = [], canvases = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {requested.push(args); return {ok: true, json: async () => manifest};});
  class ImageStub {
    naturalWidth = 1122; naturalHeight = 1402;
    set src(value) { this.name = value; queueMicrotask(() => this.onload()); }
  }
  for (const [name, value] of [['Image', ImageStub], ['document', {createElement: () => {const c = fakeCanvas(); canvases.push(c); return c;}}]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  const assets = await loadSideExpressionAssets('pitch');
  assert.deepEqual(requested, [['./assets/short-hair-pitch-expressions-v1/manifest.json', {cache: 'no-store'}]]);
  assert.equal(Object.keys(assets.images).length, 9); assert.equal(canvases.length, 18);
  assert.equal(assets.gazeLayers, null);
  for (const canvas of canvases) {
    const draw = draws(canvas)[0];
    assert.deepEqual(draw.slice(4, 6), draw.slice(8, 10));
    assert.equal(draw[6], 0); assert.equal(draw[7], 0);
  }
  for (const variant of ['approved', 'gaze', 'mouth', 'brows']) await assert.rejects(loadSideExpressionAssets(variant), /姿态系列/);
  assert.equal(canvases.length, 18, 'mismatched family is rejected before images or patches compile');
});

test('pitch loader refuses a valid old-side manifest before any images are loaded', async t => {
  const {readFileSync} = await import('node:fs');
  const side = JSON.parse(readFileSync(new URL('./assets/short-hair-side-expressions-v1/manifest.json', import.meta.url)));
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => side}));
  await assert.rejects(loadSideExpressionAssets('pitch'), /姿态系列/);
});
