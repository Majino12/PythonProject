import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SIDE_GAZE_CHANNELS, sanitizeSideGazeChannels, selectSideGaze, sideGazeOffset,
  validateSideGazeManifest, compileSideGazeLayers, drawSideGaze} from './side-gaze.js';
import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const readApproved = () => JSON.parse(readFileSync(new URL('./assets/short-hair-side-expressions-v1/manifest.json', import.meta.url)));
const EYES = ['eyeLeft', 'eyeRight'];
const POSES = ['view-left', 'view-right'];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

function fixture() {
  const manifest = readApproved(); manifest.gaze = {version: 1, poses: {}};
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], p = {whiteSource: `${poseId}-whites`, irisSource: `${poseId}-irises`, eyes: {}};
    manifest.gaze.poses[poseId] = p;
    for (const key of [p.whiteSource, p.irisSource]) manifest.sources[key] = {src: `./assets/side-gaze/${key}.png`, pose: poseId, width: 1122, height: 1402};
    for (const [i, eye] of EYES.entries()) {
      const [x, y, w, h] = pose.patches[eye].half.destination;
      const poly = top => [[x + 8, y + top], [x + w - 8, y + top], [x + w - 8, y + h - 8], [x + 8, y + h - 8]];
      p.eyes[eye] = {bounds: [x, y, w, h], irisRect: [100 + i * 200, 800, 80, 100], irisDestination: [x + 20, y + 10, 40, 50],
        core: poly(15), maxShift: {x: i === 0 ? 8 : 5, up: 5, down: 4}, basis: {horizontal: [1, poseId === 'view-left' ? -.12 : .08], vertical: [0, 1]},
        frames: {open: {source: pose.reference, aperture: poly(8), fragment: poly(12)}, half: {source: pose.patches[eye].half.source, aperture: poly(35), fragment: poly(38)}}};
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

function installDOM(t) {
  const canvases = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, writable: true, value: {createElement: () => {const c = fakeCanvas(); canvases.push(c); return c;}}});
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document);
  return canvases;
}

function compiledAssets(t) {
  installDOM(t);
  const manifest = fixture(), images = Object.fromEntries(Object.keys(manifest.sources).map(key => [key, {name: key}]));
  const gazeLayers = compileSideGazeLayers(manifest, images);
  return {manifest, images, gazeLayers, compiled: Object.fromEntries(POSES.map(poseId => [poseId, Object.fromEntries(['eyeLeft', 'eyeRight', 'mouth'].map(group => [group,
    Object.fromEntries(Object.keys(manifest.poses[poseId].patches[group]).map(key => [key, {name: `${poseId}/${group}/${key}`}]))]))]))};
}

test('side gaze is opt-in and the approved side pack stays valid without gaze resources', () => {
  const approved = readApproved();
  assert.equal(validateSideGazeManifest(approved), approved);
  assert.equal(compileSideGazeLayers(approved, {}), null);
  assert.equal(validateSideGazeManifest(fixture()).gaze.version, 1);
  for (const gaze of [null, false, {}, {version: 2, poses: {}}]) assert.throws(() => validateSideGazeManifest({...approved, gaze}));
});

test('side gaze keeps anatomical inward/outward mapping independent from pose selection', () => {
  assert.equal(SIDE_GAZE_CHANNELS.length, 8);
  assert.ok(SIDE_GAZE_CHANNELS.every(c => c.key.startsWith('eyeLook')));
  assert.deepEqual(selectSideGaze({eyeLookInLeft: 1, eyeLookInRight: 1}, {gaze: true}), {eyeLeft: {x: -1, y: 0}, eyeRight: {x: 1, y: 0}});
  assert.deepEqual(selectSideGaze({eyeLookOutLeft: 1, eyeLookOutRight: 1}, {gaze: true}), {eyeLeft: {x: 1, y: 0}, eyeRight: {x: -1, y: 0}});
  assert.deepEqual(selectSideGaze({eyeLookUpLeft: .5, eyeLookDownRight: .8}, {gaze: true}), {eyeLeft: {x: 0, y: -.5}, eyeRight: {x: 0, y: .8}});
  const opposing = {eyeLookInLeft: 1, eyeLookOutLeft: 1, eyeLookUpRight: 1, eyeLookDownRight: 1};
  assert.deepEqual(selectSideGaze(opposing, {gaze: true}), selectSideGaze());
  assert.deepEqual(selectSideGaze({eyeLookInLeft: 1}), selectSideGaze());
  assert.deepEqual(selectSideGaze({eyeLookInLeft: 1}, {gaze: 1}), selectSideGaze());
});

test('side coefficients reject inherited, nonnumeric and nonfinite inputs without changing caller data', () => {
  for (const input of [undefined, null, [], '1', {eyeLookInLeft: '1', eyeLookUpLeft: NaN, eyeLookOutRight: Infinity}, Object.create({eyeLookInLeft: 1})]) {
    assert.ok(Object.values(sanitizeSideGazeChannels(input)).every(v => v === 0));
  }
  const input = Object.freeze({eyeLookInLeft: 2, eyeLookOutLeft: -.2, eyeLookUpRight: .4, jawOpen: .9});
  const clean = sanitizeSideGazeChannels(input);
  assert.equal(clean.eyeLookInLeft, 1); assert.equal(clean.eyeLookOutLeft, 0); assert.equal(clean.eyeLookUpRight, .4); assert.equal(clean.jawOpen, undefined);
});

test('each perspective has independent finite travel and the eye-axis slope affects translation only', () => {
  const m = fixture();
  for (const poseId of POSES) for (const eye of EYES) {
    const e = m.gaze.poses[poseId].eyes[eye], slope = e.basis.horizontal[1];
    for (const x of [-5, -1, -.7, 0, .7, 1, 5]) for (const y of [-5, -1, -.7, 0, .7, 1, 5]) {
      const offset = sideGazeOffset({x, y}, e), localY = offset.y - offset.x * slope;
      assert.ok((offset.x / e.maxShift.x) ** 2 + (localY / (y < 0 ? e.maxShift.up : e.maxShift.down)) ** 2 <= 1 + 1e-12);
    }
    near(sideGazeOffset({x: 1}, e).y, e.maxShift.x * slope);
    for (const amount of [1e-9, .001, .1, .5]) near(sideGazeOffset({x: amount}, e).x, amount * e.maxShift.x);
    for (const input of [undefined, null, {}, {x: '1', y: Infinity}, {x: NaN, y: false}]) assert.deepEqual(sideGazeOffset(input, e), {x: 0, y: 0});
  }
});

test('side gaze refuses cross-pose art, missing authored states, closed-eye irises and reused crops', () => {
  for (const mutate of [
    m => {delete m.gaze.poses['view-right'];},
    m => {m.gaze.poses.front = m.gaze.poses['view-left'];},
    m => {m.gaze.poses['view-left'].whiteSource = m.gaze.poses['view-right'].whiteSource;},
    m => {m.sources[m.gaze.poses['view-left'].whiteSource].src = m.sources[m.gaze.poses['view-right'].whiteSource].src;},
    m => {m.gaze.poses['view-left'].whiteSource = m.gaze.poses['view-left'].irisSource;},
    m => {m.gaze.poses['view-left'].whiteSource = m.poses['view-left'].reference;},
    m => {delete m.gaze.poses['view-left'].eyes.eyeLeft.frames.half;},
    m => {m.gaze.poses['view-left'].eyes.eyeLeft.frames.half.source = m.poses['view-right'].patches.eyeLeft.half.source;},
    m => {m.gaze.poses['view-left'].eyes.eyeLeft.frames.closed = m.gaze.poses['view-left'].eyes.eyeLeft.frames.open;},
    m => {m.gaze.poses['view-left'].eyes.eyeLeft.irisRect = m.gaze.poses['view-left'].eyes.eyeRight.irisRect;},
    m => {m.gaze.poses['view-left'].eyes.eyeLeft.bounds = m.gaze.poses['view-left'].eyes.eyeRight.bounds;},
  ]) {const m = fixture(); mutate(m); assert.throws(() => validateSideGazeManifest(m));}
});

test('registration refuses stretching, unbounded travel, invalid masks and an axis that could invert anatomy', () => {
  for (const mutate of [
    e => {e.irisDestination[2] += 1;}, e => {e.irisRect[0] = -1;}, e => {e.irisDestination[0] = 0;},
    e => {e.bounds[2] = 0;}, e => {e.core[0][0] = 1122;}, e => {e.core = [[1, 1], [2, 2]];},
    e => {e.frames.open.aperture[0][0] = NaN;}, e => {e.frames.half.fragment[0][1] = 1402;},
    e => {e.maxShift.x = 13;}, e => {e.maxShift.up = 0;}, e => {e.maxShift.down = Infinity;},
    e => {e.basis.horizontal = [-1, 0];}, e => {e.basis.horizontal = [1, .8];}, e => {e.basis.vertical = [0, -1];},
  ]) {const m = fixture(); mutate(m.gaze.poses['view-left'].eyes.eyeLeft); assert.throws(() => validateSideGazeManifest(m));}
});

test('one full iris and its approved original core are compiled per eye; cleanup remains specific to each eyelid drawing', t => {
  const assets = compiledAssets(t);
  for (const poseId of POSES) for (const eye of EYES) {
    const layer = assets.gazeLayers[poseId][eye], p = assets.manifest.gaze.poses[poseId], e = p.eyes[eye];
    const draws = layer.canvas.calls.filter(([kind]) => kind === 'drawImage');
    assert.equal(draws[0][1], assets.images[p.irisSource]);
    assert.deepEqual(draws[0].slice(2), [...e.irisRect, ...e.irisDestination]);
    const core = draws[1][1];
    assert.equal(core.calls.find(([kind]) => kind === 'drawImage')[1], assets.images[assets.manifest.poses[poseId].reference]);
    assert.deepEqual(Object.keys(layer.frames), ['open', 'half']);
    assert.notEqual(layer.frames.open.clean, layer.frames.half.clean);
    for (const state of ['open', 'half']) assert.equal(layer.frames[state].clean.calls.find(([kind]) => kind === 'drawImage')[1], assets.images[p.whiteSource]);
  }
});

test('neutral and moving gaze follow the same clipped pipeline; closed and unknown eye states never leak an iris', t => {
  const assets = compiledAssets(t), poseId = 'view-right';
  for (const state of ['open', 'half']) {
    const center = fakeCanvas(), moving = fakeCanvas();
    drawSideGaze(center.getContext('2d'), assets, poseId, {eyeLeft: state, eyeRight: 'closed'}, {});
    drawSideGaze(moving.getContext('2d'), assets, poseId, {eyeLeft: state, eyeRight: 'closed'}, {eyeLeft: {x: .6, y: .2}});
    assert.deepEqual(center.calls.map(call => call[0]), moving.calls.map(call => call[0]));
    const draws = moving.calls.filter(([kind]) => kind === 'drawImage'), layer = assets.gazeLayers[poseId].eyeLeft;
    assert.equal(draws.length, 2); assert.ok(draws.every(call => call.length === 4));
    assert.equal(draws[0][1], layer.frames[state].clean); assert.equal(draws[1][1], layer.canvas);
    assert.ok(moving.calls.findIndex(call => call[0] === 'clip') < moving.calls.findIndex(call => call[0] === 'drawImage'));
    const offset = sideGazeOffset({x: .6, y: .2}, assets.manifest.gaze.poses[poseId].eyes.eyeLeft);
    assert.deepEqual(draws[1].slice(2), [layer.bounds[0] + offset.x, layer.bounds[1] + offset.y]);
  }
  for (const invalid of ['closed', '__proto__', 'constructor', 'missing']) {
    const canvas = fakeCanvas(); drawSideGaze(canvas.getContext('2d'), assets, poseId, {eyeLeft: invalid, eyeRight: invalid}, {eyeLeft: {x: 1}});
    assert.equal(canvas.calls.length, 0);
  }
});

test('side renderer applies gaze after authored patches and original comparison bypasses the complete extension', t => {
  const assets = compiledAssets(t), canvas = fakeCanvas();
  const state = {eyeLeft: 'half', eyeRight: 'closed', mouth: 'openSmall'};
  drawSideExpression(canvas, assets, 'view-left', state, {gaze: {eyeLeft: {x: 1}}});
  const draws = canvas.calls.filter(([kind]) => kind === 'drawImage');
  assert.equal(draws.length, 6); assert.equal(draws[3][1].name, 'view-left/mouth/openSmall');
  assert.equal(draws[4][1], assets.gazeLayers['view-left'].eyeLeft.frames.half.clean);
  const original = fakeCanvas(); drawSideExpression(original, assets, 'view-left', state, {original: true, gaze: {eyeLeft: {x: 1}}});
  assert.equal(original.calls.filter(([kind]) => kind === 'drawImage').length, 1);
  const approved = {...assets, manifest: readApproved(), gazeLayers: null}, plain = fakeCanvas();
  drawSideExpression(plain, approved, 'view-left', {}, {gaze: {eyeLeft: {x: 1}}});
  assert.equal(plain.calls.filter(([kind]) => kind === 'drawImage').length, 1);
});

test('side loader resolves explicit approved and gaze packs while refusing unknown variant names', async t => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async url => {requested.push(url); return {ok: false};});
  await assert.rejects(loadSideExpressionAssets(), /无法读取/);
  await assert.rejects(loadSideExpressionAssets('approved'), /无法读取/);
  await assert.rejects(loadSideExpressionAssets('gaze'), /无法读取/);
  for (const bad of ['__proto__', 'constructor', 'not-a-version']) await assert.rejects(loadSideExpressionAssets(bad), /未知/);
  assert.deepEqual(requested, ['./assets/short-hair-side-expressions-v1/manifest.json', './assets/short-hair-side-expressions-v1/manifest.json', './assets/short-hair-side-gaze-v1/manifest.json']);
});
