import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSideExpressionManifest, loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

function fixture() {
  const sources = {}, poses = {};
  for (const [poseId, dx] of [['view-left', -50], ['view-right', 50]]) {
    const reference = `${poseId}-neutral`;
    for (const name of ['neutral', 'half-small', 'closed-wide']) sources[`${poseId}-${name}`] = {src: `./assets/side/${poseId}-${name}.png`, width: 1122, height: 1402, pose: poseId};
    const mouthReference = [558 + dx, 674];
    const patch = (source, destination, anchor) => ({source: `${poseId}-${source}`, rect: [...destination], destination, transform: 'translation-only', feather: 6, ...(anchor ? {anchor} : {})});
    const mouth = source => patch(source, [468 + dx, 646, 194, 98], {kind: 'upper-lip', source: [...mouthReference], destination: [...mouthReference]});
    poses[poseId] = {reference, label: poseId, directionNote: '角色左右', faceView: [245, 350, 630, 460], mouthReference,
      detailViews: {eyes: [300, 440, 500, 140], mouth: [440 + dx, 640, 240, 110]}, patches: {
        eyeLeft: {half: patch('half-small', [606 + dx, 448, 155, 116]), closed: patch('closed-wide', [606 + dx, 448, 155, 116])},
        eyeRight: {half: patch('half-small', [347 + dx, 448, 167, 116]), closed: patch('closed-wide', [347 + dx, 448, 167, 116])},
        mouth: {openSmall: mouth('half-small'), openWide: mouth('closed-wide')},
      }};
  }
  return {id: 'side-test', version: 1, status: 'candidate', width: 1122, height: 1402, sources, poses};
}

function fakeCanvas() {
  const calls = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'translate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'fillRect', 'setLineDash', 'stroke', 'arc', 'fillText', 'strokeRect'].map(name => [name, (...args) => calls.push([name, ...args])]));
  context.createLinearGradient = (...args) => ({addColorStop: (...stops) => calls.push(['gradient', args, ...stops])});
  return {width: 0, height: 0, getContext: () => context, calls};
}

function assetsFor(manifest) {
  return {manifest, images: Object.fromEntries(Object.keys(manifest.sources).map(key => [key, {name: key}])),
    compiled: Object.fromEntries(Object.entries(manifest.poses).map(([poseId, pose]) => [poseId,
      Object.fromEntries(Object.entries(pose.patches).map(([group, states]) => [group, Object.fromEntries(Object.keys(states).map(key => [key, {name: `${poseId}/${group}/${key}`}]))])),
    ]))};
}

test('independent side registrations validate with distinct poses, drawings and lip anchors', () => {
  const manifest = fixture();
  assert.equal(validateSideExpressionManifest(manifest), manifest);
  assert.notDeepEqual(manifest.poses['view-left'].mouthReference, manifest.poses['view-right'].mouthReference);
});

test('missing states and unsupported pose sets cannot silently become a partial side sample', () => {
  for (const mutate of [
    m => { delete m.poses['view-right']; },
    m => { m.poses.front = m.poses['view-left']; },
    m => { delete m.poses['view-left'].patches.eyeLeft.half; },
    m => { m.poses['view-left'].patches.mouth.pucker = m.poses['view-left'].patches.mouth.openSmall; },
    m => { m.poses['view-left'].reference = 'view-right-neutral'; },
    m => { m.poses['view-left'].patches.eyeLeft.half.source = 'view-right-half-small'; },
  ]) {
    const broken = fixture(); mutate(broken); assert.throws(() => validateSideExpressionManifest(broken));
  }
});

test('local source validation rejects remote, traversing, mis-sized, shared and duplicate art', () => {
  for (const mutate of [
    m => { m.sources['view-left-half-small'].src = 'https://example.com/a.png'; },
    m => { m.sources['view-left-half-small'].src = './assets/../a.png'; },
    m => { m.sources['view-left-half-small'].width = 1024; },
    m => { m.sources['view-left-half-small'].pose = 'front'; },
    m => { m.sources['view-right-half-small'].src = m.sources['view-left-half-small'].src; },
    m => { m.sources['view-left-half-small'].src = m.sources['view-left-closed-wide'].src; },
    m => { m.sources['view-left-half-small'].src = m.sources['view-left-neutral'].src; },
  ]) {
    const broken = fixture(); mutate(broken); assert.throws(() => validateSideExpressionManifest(broken));
  }
});

test('stretching, invalid crops, drifting upper lips and masks beyond registration are refused', () => {
  for (const mutate of [
    p => { p.destination[2] += 1; }, p => { p.transform = 'mirror'; },
    p => { p.rect[0] = -1; }, p => { p.destination[0] = 1122; },
    p => { p.feather = 49; }, p => { p.feather = NaN; },
    p => { p.anchor.source[1] += 1; }, p => { delete p.anchor; },
    p => { p.anchor.kind = 'center'; }, p => { p.anchor.source[0] += 1; p.anchor.destination[0] += 1; },
    p => { p.clip = [[0, 0], [500, 700], [550, 740]]; },
  ]) {
    const broken = fixture(); mutate(broken.poses['view-left'].patches.mouth.openWide);
    assert.throws(() => validateSideExpressionManifest(broken));
  }
  const broken = fixture(); broken.poses['view-left'].detailViews.eyes = [-1, 440, 500, 140];
  assert.throws(() => validateSideExpressionManifest(broken));
});

test('rendering selects one pose and translates its local drawings without scaling or blending', () => {
  const manifest = fixture(), assets = assetsFor(manifest), canvas = fakeCanvas();
  drawSideExpression(canvas, assets, 'view-right', {eyeLeft: 'closed', eyeRight: 'half', mouth: 'openSmall'});
  assert.deepEqual([canvas.width, canvas.height], [630, 460]);
  const draws = canvas.calls.filter(([kind]) => kind === 'drawImage');
  assert.deepEqual(draws.map(([, image]) => image.name), ['view-right-neutral', 'view-right/eyeLeft/closed', 'view-right/eyeRight/half', 'view-right/mouth/openSmall']);
  assert.ok(draws.every(call => call.length === 4), 'each draw has image,x,y only, without destination scaling');
  assert.deepEqual(draws.at(-1).slice(2), manifest.poses['view-right'].patches.mouth.openSmall.destination.slice(0, 2));
  assert.deepEqual(canvas.calls.find(([kind]) => kind === 'translate'), ['translate', -245, -350]);
});

test('neutral and original mode draw the exact approved pose, and unknown states never expose object properties', () => {
  const assets = assetsFor(fixture());
  for (const [state, options] of [[{}, {}], [{eyeLeft: 'closed', mouth: 'openWide'}, {original: true}], [{eyeLeft: '__proto__', mouth: 'constructor'}, {}]]) {
    const canvas = fakeCanvas(); drawSideExpression(canvas, assets, 'view-left', state, options);
    const draws = canvas.calls.filter(([kind]) => kind === 'drawImage');
    assert.equal(draws.length, 1); assert.equal(draws[0][1].name, 'view-left-neutral');
  }
  assert.throws(() => drawSideExpression(fakeCanvas(), assets, '__proto__', {}));
});

test('detail and full views use the pose-specific crop, and guides use its own upper-lip anchor', () => {
  const assets = assetsFor(fixture()), canvas = fakeCanvas();
  drawSideExpression(canvas, assets, 'view-left', {}, {faceOnly: false});
  assert.deepEqual([canvas.width, canvas.height], [1122, 1402]);
  drawSideExpression(canvas, assets, 'view-left', {}, {detail: 'mouth', guides: true});
  assert.deepEqual([canvas.width, canvas.height], [240, 110]);
  assert.deepEqual(canvas.calls.find(([kind]) => kind === 'arc').slice(1, 3), assets.manifest.poses['view-left'].mouthReference);
  drawSideExpression(canvas, assets, 'view-left', {}, {detail: 'constructor'});
  assert.deepEqual([canvas.width, canvas.height], [630, 460]);
});

test('loader compiles each state from its owned source at one-to-one dimensions and fails unavailable assets', async t => {
  const manifest = fixture(), canvases = [];
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => manifest}));
  class ImageStub {
    naturalWidth = 1122; naturalHeight = 1402;
    set src(value) { this.name = value; queueMicrotask(() => this.onload()); }
  }
  for (const [name, value] of [['Image', ImageStub], ['document', {createElement: () => {const c = fakeCanvas(); canvases.push(c); return c;}}]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  const assets = await loadSideExpressionAssets();
  assert.equal(canvases.length, 12);
  for (const canvas of canvases) {
    const draw = canvas.calls.find(([kind]) => kind === 'drawImage');
    assert.deepEqual(draw.slice(4, 6), draw.slice(8, 10));
    assert.equal(draw[6], 0); assert.equal(draw[7], 0);
  }
  assert.equal(assets.compiled['view-left'].eyeLeft.half.calls[0][1].name, './assets/side/view-left-half-small.png');
  globalThis.fetch = async () => ({ok: false});
  await assert.rejects(loadSideExpressionAssets(), /无法读取/);
});

test('loader waits for every image decode before creating any expression canvas', async t => {
  const manifest = fixture(), pending = [], canvases = [];
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => manifest}));
  class ImageStub {
    naturalWidth = 1122; naturalHeight = 1402; decoded = false;
    set src(value) { this.name = value; queueMicrotask(() => this.onload()); }
    decode() { return new Promise(resolve => pending.push(() => {this.decoded = true; resolve();})); }
  }
  for (const [name, value] of [['Image', ImageStub], ['document', {createElement: () => {const c = fakeCanvas(); canvases.push(c); return c;}}]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  const loading = loadSideExpressionAssets();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 6); assert.equal(canvases.length, 0);
  for (const complete of pending.slice(0, -1)) complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canvases.length, 0, 'one outstanding decode still blocks every crop');
  pending.at(-1)();
  const assets = await loading;
  assert.equal(canvases.length, 12); assert.ok(Object.values(assets.images).every(image => image.decoded));
  for (const canvas of canvases) assert.equal(canvas.calls.find(([kind]) => kind === 'drawImage')[1].decoded, true);
});

test('decode errors fail loading before compilation and a later retry can succeed', async t => {
  const manifest = fixture(), canvases = []; let failing = true;
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => manifest}));
  class ImageStub {
    naturalWidth = 1122; naturalHeight = 1402;
    set src(value) { this.name = value; queueMicrotask(() => this.onload()); }
    decode() { return failing ? Promise.reject(new Error('decode unavailable')) : Promise.resolve(); }
  }
  for (const [name, value] of [['Image', ImageStub], ['document', {createElement: () => {const c = fakeCanvas(); canvases.push(c); return c;}}]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  await assert.rejects(loadSideExpressionAssets(), /画稿无法解码/);
  assert.equal(canvases.length, 0);
  failing = false; await loadSideExpressionAssets();
  assert.equal(canvases.length, 12);
});
