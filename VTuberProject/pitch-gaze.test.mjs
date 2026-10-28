import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validatePitchGazeManifest, compilePitchGazeLayers} from './pitch-gaze.js';
import {SIDE_GAZE_CHANNELS, selectSideGaze, sideGazeOffset, drawSideGaze} from './side-gaze.js';
import {validateSideExpressionManifest, loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)));
const base = () => read('./assets/short-hair-pitch-expressions-v1/manifest.json');
const POSES = ['view-left-up', 'view-right-up', 'view-left-down'];
const EYES = ['eyeLeft', 'eyeRight'];
function fixture() {
  const manifest = base(); manifest.gaze = {version: 1, poses: {}};
  for (const [poseIndex, poseId] of POSES.entries()) {
    const pose = manifest.poses[poseId], p = {whiteSource: `${poseId}-whites`, irisSource: `${poseId}-irises`, eyes: {}};
    manifest.gaze.poses[poseId] = p;
    for (const key of [p.whiteSource, p.irisSource]) manifest.sources[key] = {src: `./assets/pitch-gaze/${key}.png`, pose: poseId, width: 1122, height: 1402, sha256: 'a'.repeat(64)};
    for (const [i, eye] of EYES.entries()) {
      const [x, y, w, h] = pose.patches[eye].half.destination;
      const poly = top => [[x + 8, y + top], [x + w - 8, y + top], [x + w - 8, y + h - 8], [x + 8, y + h - 8]];
      p.eyes[eye] = {bounds: [x, y, w, h], irisRect: [100 + i * 200, 800, 80, 100], irisDestination: [x + 20, y + 10, 40, 50],
        core: poly(15), maxShift: {x: 6 - i, up: 4, down: 3}, basis: {horizontal: [1, [.35, -.28, .12][poseIndex]], vertical: [0, 1]},
        frames: {open: {source: pose.reference, aperture: poly(8), fragment: poly(12)}, half: {source: pose.patches[eye].half.source, aperture: poly(35), fragment: poly(38)}}};
    }
  }
  return manifest;
}

function fakeCanvas() {
  const calls = [], context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'translate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'fill', 'stroke', 'fillRect'].map(name => [name, (...args) => calls.push([name, ...args])]));
  context.createLinearGradient = () => ({addColorStop() {}});
  return {width: 0, height: 0, getContext: () => context, calls};
}
function installDOM(t) {
  const canvases = [], descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, writable: true, value: {createElement: () => {const c = fakeCanvas(); canvases.push(c); return c;}}});
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document);
  return canvases;
}
function assetsFor(t) {
  installDOM(t);
  const manifest = fixture(), images = Object.fromEntries(Object.keys(manifest.sources).map(key => [key, {name: key}]));
  return {manifest, images, gazeLayers: compilePitchGazeLayers(manifest, images),
    compiled: Object.fromEntries(POSES.map(poseId => [poseId, Object.fromEntries(['eyeLeft', 'eyeRight', 'mouth'].map(group => [group,
      Object.fromEntries(Object.keys(manifest.poses[poseId].patches[group]).map(state => [state, {name: `${poseId}/${group}/${state}`}]))]))]))};
}
const draws = canvas => canvas.calls.filter(([name]) => name === 'drawImage');

test('pitch gaze is a separate explicit three-pose capability while the approved basic pack still has no gaze layers', () => {
  assert.equal(compilePitchGazeLayers(base(), {}), null);
  const m = fixture(); assert.equal(validatePitchGazeManifest(m), m); assert.equal(validateSideExpressionManifest(m), m);
  for (const mutate of [
    m => {delete m.poseFamily;}, m => {m.poseFamily = 'side';},
    m => {delete m.gaze.poses['view-left-down'];},
    m => {m.gaze.poses['view-right-down'] = m.gaze.poses['view-left-down'];},
    m => {m.gaze.poses['view-left'] = m.gaze.poses['view-left-up']; delete m.gaze.poses['view-left-up'];},
    m => {m.gaze = null;}, m => {m.gaze.version = 2;},
  ]) {const broken = fixture(); mutate(broken); assert.throws(() => validatePitchGazeManifest(broken));}
});

test('pitch eye whites and irises cannot reuse another pose, the neutral image, or an approved eyelid source', () => {
  for (const mutate of [
    m => {m.gaze.poses['view-left-up'].whiteSource = m.gaze.poses['view-right-up'].whiteSource;},
    m => {m.gaze.poses['view-left-up'].irisSource = m.gaze.poses['view-left-up'].whiteSource;},
    m => {m.gaze.poses['view-left-up'].whiteSource = m.poses['view-left-up'].reference;},
    m => {m.gaze.poses['view-left-up'].whiteSource = m.poses['view-left-up'].patches.eyeLeft.half.source;},
    m => {m.sources['view-right-up-whites'].src = m.sources['view-left-up-whites'].src;},
    m => {m.sources['view-left-up-irises'].src = m.sources[m.poses['view-left-up'].patches.eyeLeft.closed.source].src;},
    m => {m.sources['view-left-up-whites'].pose = 'view-left';},
    m => {m.sources['view-left-up-whites'].src = './assets/../white.png';},
    m => {m.sources['view-left-up-whites'].src = 'https://example.com/white.png';},
    m => {m.sources['view-left-up-whites'].height = 1024;},
  ]) {const m = fixture(); mutate(m); assert.throws(() => validatePitchGazeManifest(m));}
});

test('pitch registration refuses cross-pose eyelid frames, closed irises, stretched crops and invalid local axes', () => {
  for (const mutate of [
    (e, m) => {e.frames.half.source = m.poses['view-right-up'].patches.eyeLeft.half.source;},
    e => {e.frames.open.source = e.frames.half.source;}, e => {e.frames.closed = e.frames.open;},
    e => {delete e.frames.half;}, e => {e.irisDestination[2]++;},
    e => {e.irisDestination[0] = 0;}, e => {e.core[0][0] = -1;},
    e => {e.frames.half.aperture[0][0] = NaN;}, e => {e.frames.open.fragment[0][1] = 1402;},
    e => {e.maxShift.x = 13;}, e => {e.maxShift.up = 0;}, e => {e.maxShift.down = Infinity;},
    e => {e.basis.horizontal = [-1, .1];}, e => {e.basis.horizontal = [1, .6];}, e => {e.basis.vertical = [1, 1];},
    (e, m) => {e.irisRect = m.gaze.poses['view-left-up'].eyes.eyeRight.irisRect;},
  ]) {const m = fixture(); mutate(m.gaze.poses['view-left-up'].eyes.eyeLeft, m); assert.throws(() => validatePitchGazeManifest(m));}
});

test('pitch gaze reuses the approved ARKit mapping and bounded local travel at extreme and diagonal inputs', () => {
  assert.equal(SIDE_GAZE_CHANNELS.length, 8);
  const inward = selectSideGaze({eyeLookInLeft: 1, eyeLookInRight: 1}, {gaze: true});
  assert.deepEqual(inward, {eyeLeft: {x: -1, y: 0}, eyeRight: {x: 1, y: 0}});
  for (const p of Object.values(fixture().gaze.poses)) for (const e of Object.values(p.eyes)) {
    for (const x of [-1e6, -1, -.2, 0, .2, 1, 1e6]) for (const y of [-1e6, -1, 0, 1, 1e6]) {
      const shift = sideGazeOffset({x, y}, e), localY = shift.y - shift.x * e.basis.horizontal[1];
      assert.ok((shift.x / e.maxShift.x) ** 2 + (localY / (y < 0 ? e.maxShift.up : e.maxShift.down)) ** 2 <= 1 + 1e-12);
    }
    const tiny = sideGazeOffset({x: 1e-9}, e);
    assert.ok(Math.abs(tiny.x - 1e-9 * e.maxShift.x) < 1e-15);
    assert.ok(Math.abs(tiny.y - tiny.x * e.basis.horizontal[1]) < 1e-15);
    assert.deepEqual(sideGazeOffset({x: NaN, y: Infinity}, e), {x: 0, y: 0});
  }
});

test('pitch compiles one shared complete iris per eye with the approved open-eye pigment core and separate fragment cleanup', t => {
  const assets = assetsFor(t);
  assert.deepEqual(Object.keys(assets.gazeLayers), POSES);
  for (const poseId of POSES) for (const eye of EYES) {
    const p = assets.manifest.gaze.poses[poseId], e = p.eyes[eye], layer = assets.gazeLayers[poseId][eye];
    const iris = draws(layer.canvas);
    assert.equal(iris[0][1], assets.images[p.irisSource]); assert.deepEqual(iris[0].slice(2), [...e.irisRect, ...e.irisDestination]);
    assert.equal(draws(iris[1][1])[0][1], assets.images[assets.manifest.poses[poseId].reference]);
    assert.deepEqual(Object.keys(layer.frames), ['open', 'half']);
    assert.notEqual(layer.frames.open.clean, layer.frames.half.clean);
    for (const state of ['open', 'half']) {
      assert.equal(draws(layer.frames[state].clean)[0][1], assets.images[p.whiteSource]);
      assert.deepEqual(layer.frames[state].clean.calls.filter(([kind]) => ['moveTo', 'lineTo'].includes(kind)).map(call => call.slice(1)), e.frames[state].fragment);
    }
  }
});

test('pitch center and tiny gaze inputs use exactly the same clipped drawing path with fixed iris size', t => {
  const assets = assetsFor(t);
  for (const poseId of POSES) for (const eye of EYES) for (const state of ['open', 'half']) {
    const lidState = {eyeLeft: 'closed', eyeRight: 'closed', [eye]: state}, centered = fakeCanvas(), tiny = fakeCanvas();
    drawSideGaze(centered.getContext('2d'), assets, poseId, lidState, {});
    drawSideGaze(tiny.getContext('2d'), assets, poseId, lidState, {[eye]: {x: 1e-9}});
    assert.deepEqual(centered.calls.map(c => c[0]), tiny.calls.map(c => c[0]));
    assert.equal(draws(tiny).length, 2); assert.ok(draws(tiny).every(c => c.length === 4));
    assert.ok(tiny.calls.findIndex(c => c[0] === 'clip') < tiny.calls.findIndex(c => c[0] === 'drawImage'));
    assert.equal(draws(tiny)[1][1], draws(centered)[1][1]);
    assert.ok(Math.abs(draws(tiny)[1][2] - draws(centered)[1][2]) < 1e-7);
  }
});

test('pitch closed or unknown eye states strictly skip every iris even at maximum gaze, independently for each eye', t => {
  const assets = assetsFor(t);
  for (const poseId of POSES) for (const invalid of ['closed', '__proto__', 'constructor', 'missing']) {
    const canvas = fakeCanvas();
    drawSideGaze(canvas.getContext('2d'), assets, poseId, {eyeLeft: invalid, eyeRight: invalid}, {eyeLeft: {x: 1, y: 1}, eyeRight: {x: -1, y: -1}});
    assert.equal(canvas.calls.length, 0);
  }
  for (const poseId of POSES) for (const eye of EYES) {
    const canvas = fakeCanvas(), state = {eyeLeft: 'closed', eyeRight: 'closed', [eye]: 'half'};
    drawSideGaze(canvas.getContext('2d'), assets, poseId, state, {[eye]: {x: 1, y: 1}});
    assert.equal(draws(canvas).length, 2);
    assert.equal(draws(canvas)[1][1], assets.gazeLayers[poseId][eye].canvas);
  }
});

test('pitch player applies gaze after local eye/mouth drawings and original comparison bypasses gaze completely', t => {
  const assets = assetsFor(t), poseId = 'view-left-down', canvas = fakeCanvas();
  const state = {eyeLeft: 'half', eyeRight: 'closed', mouth: 'openSmall'};
  drawSideExpression(canvas, assets, poseId, state, {gaze: {eyeLeft: {x: 1, y: -1}}});
  const calls = draws(canvas);
  assert.equal(calls.length, 6); assert.equal(calls[3][1].name, `${poseId}/mouth/openSmall`);
  assert.equal(calls[4][1], assets.gazeLayers[poseId].eyeLeft.frames.half.clean);
  const original = fakeCanvas(); drawSideExpression(original, assets, poseId, state, {original: true, gaze: {eyeLeft: {x: 1}}});
  assert.equal(draws(original).length, 1); assert.equal(draws(original)[0][1], assets.images[assets.manifest.poses[poseId].reference]);
});

test('pitchGaze loader selects the independent pack and rejects basic/gaze capability mismatches before image loading', async t => {
  const canvases = installDOM(t), requested = []; let manifest = fixture(), loaded = 0;
  t.mock.method(globalThis, 'fetch', async url => {requested.push(url); return {ok: true, json: async () => manifest};});
  class ImageStub {naturalWidth = 1122; naturalHeight = 1402; set src(value) {loaded++; this.name = value; queueMicrotask(() => this.onload());}}
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', {configurable: true, writable: true, value: ImageStub});
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'Image', descriptor) : delete globalThis.Image);
  const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', {configurable: true, writable: true, value: async canvas => ({width: canvas.width, height: canvas.height})});
  t.after(() => bitmapDescriptor ? Object.defineProperty(globalThis, 'createImageBitmap', bitmapDescriptor) : delete globalThis.createImageBitmap);
  const assets = await loadSideExpressionAssets('pitchGaze');
  assert.equal(requested[0], './assets/short-hair-pitch-gaze-v1/manifest.json');
  assert.equal(loaded, 15); assert.equal(canvases.length, 42); assert.deepEqual(Object.keys(assets.gazeLayers), POSES);
  await assert.rejects(loadSideExpressionAssets('pitch'), /能力不一致/);
  for (const variant of ['approved', 'gaze', 'mouth', 'brows']) await assert.rejects(loadSideExpressionAssets(variant), /姿态系列/);
  manifest = base(); await assert.rejects(loadSideExpressionAssets('pitchGaze'), /能力不一致/);
  manifest = read('./assets/short-hair-side-gaze-v1/manifest.json');
  await assert.rejects(loadSideExpressionAssets('pitchGaze'), /姿态系列/);
  assert.equal(loaded, 15); assert.equal(canvases.length, 42);
});

test('the accepted side gaze runtime remains byte-for-byte frozen while pitch owns its new validator/compiler', () => {
  const approval = read('./assets/short-hair-side-gaze-v1/approval.json');
  const bytes = readFileSync(new URL(approval.approvedGazeRuntimePath, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), approval.approvedGazeRuntimeSha256);
});
