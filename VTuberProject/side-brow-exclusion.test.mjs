import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateBrowExclusion, browExclusionCoverage, rasterizeBrowExclusion} from './side-brow-exclusion.js';
import {validateSideExpressionManifest, loadSideExpressionAssets} from './side-expression-renderer.js';

const square = [[2, 2], [8, 2], [8, 8], [2, 8]];
const patch = () => ({destination: [0, 0, 10, 10], exclude: [structuredClone(square)], excludeFeather: 1.5});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('fixed exclusions are optional only for brows and require paired finite feather and destination-bounded polygons', () => {
  for (const group of ['eyeLeft', 'mouth', 'browLeft', 'browRight']) assert.doesNotThrow(() => validateBrowExclusion({destination: [0, 0, 10, 10]}, group));
  for (const group of ['browLeft', 'browRight']) assert.doesNotThrow(() => validateBrowExclusion(patch(), group));
  for (const group of ['eyeLeft', 'eyeRight', 'mouth', 'gaze', 'unknown']) assert.throws(() => validateBrowExclusion(patch(), group));
  for (const mutate of [
    p => {delete p.exclude;}, p => {delete p.excludeFeather;}, p => {p.exclude = [];}, p => {p.exclude = true;},
    p => {p.exclude = [[]];}, p => {p.exclude = [[[1, 1], [2, 2]]];}, p => {p.exclude = [[[1, 1], [2, 2], [3, 3]]];},
    p => {p.exclude[0][0][0] = -1;}, p => {p.exclude[0][0][1] = 11;}, p => {p.exclude[0][0][0] = NaN;},
    p => {p.excludeFeather = 0;}, p => {p.excludeFeather = -1;}, p => {p.excludeFeather = 3.01;},
    p => {p.excludeFeather = Infinity;}, p => {p.excludeFeather = '1.5';},
  ]) {const p = patch(); mutate(p); assert.throws(() => validateBrowExclusion(p, 'browLeft'));}
  const outsideClip = patch(); outsideClip.clip = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.doesNotThrow(() => validateBrowExclusion(outsideClip, 'browLeft'), 'exclusion may extend beyond the outer clip within the crop');
});

test('coverage stays zero outside and on polygon edges, and increases smoothly only inward', () => {
  for (const [x, y] of [[0, 5], [1.999, 5], [2, 5], [8, 5], [9, 5], [2, 2], [5, 8], [5, 8.001]]) assert.equal(browExclusionCoverage(x, y, [square], 1.5), 0);
  near(browExclusionCoverage(2.375, 5, [square], 1.5), .15625);
  near(browExclusionCoverage(2.75, 5, [square], 1.5), .5);
  near(browExclusionCoverage(3.125, 5, [square], 1.5), .84375);
  assert.equal(browExclusionCoverage(3.5, 5, [square], 1.5), 1);
  assert.equal(browExclusionCoverage(5, 5, [square], 1.5), 1);
  assert.ok(browExclusionCoverage(2 + 1e-6, 5, [square], 1.5) < 1e-10, 'boundary is continuous, not a new hard notch');
});

test('overlapping exclusions take maximum coverage rather than compounding alpha removal', () => {
  const a = [[0, 0], [6, 0], [6, 6], [0, 6]], b = [[4, 0], [10, 0], [10, 6], [4, 6]];
  near(browExclusionCoverage(5, 3, [a], 2), .5);
  near(browExclusionCoverage(5, 3, [b], 2), .5);
  near(browExclusionCoverage(5, 3, [a, b], 2), .5);
  assert.equal(browExclusionCoverage(3, 3, [a, b], 2), 1);
  assert.equal(browExclusionCoverage(5, -1, [a, b], 2), 0);
});

test('concave polygons, winding direction and repeated closing points retain the intended interior', () => {
  const concave = [[1, 1], [8, 1], [8, 3], [3, 3], [3, 8], [1, 8]];
  assert.equal(browExclusionCoverage(5, 5, [concave], .5), 0, 'concave missing corner remains untouched');
  assert.equal(browExclusionCoverage(2, 5, [concave], .5), 1);
  for (const x of [0, 1, 1.25, 2, 3, 5, 8, 9]) for (const y of [0, 1, 2, 3, 5, 8, 9]) {
    const forward = browExclusionCoverage(x, y, [concave], 1.5);
    near(forward, browExclusionCoverage(x, y, [[...concave].reverse()], 1.5));
    near(forward, browExclusionCoverage(x, y, [[...concave, concave[0]]], 1.5));
  }
});

test('native alpha raster respects destination coordinates and can only reduce an existing clipped alpha', () => {
  const alpha = rasterizeBrowExclusion(10, 10, [0, 0], [square], 1.5);
  const translated = square.map(([x, y]) => [x + 440, y + 392]);
  assert.deepEqual(rasterizeBrowExclusion(10, 10, [440, 392], [translated], 1.5), alpha);
  assert.equal(alpha[0], 255); assert.equal(alpha[5 * 10 + 1], 255); assert.equal(alpha[5 * 10 + 5], 0);
  assert.ok(alpha[5 * 10 + 2] > 0 && alpha[5 * 10 + 2] < 255);
  for (const a of alpha) for (const original of [0, 1, 64, 127, 255]) {
    const multiplied = original * a / 255;
    assert.ok(multiplied >= 0 && multiplied <= original);
    if (original === 0) assert.equal(multiplied, 0, 'outside original clip remains exactly transparent');
  }
});

function browManifest() {
  const m = JSON.parse(readFileSync(new URL('./assets/short-hair-side-brows-v1/manifest.json', import.meta.url)));
  for (const pose of Object.values(m.poses)) for (const group of ['browLeft', 'browRight']) for (const p of Object.values(pose.patches[group])) {
    delete p.exclude; delete p.excludeFeather;
  }
  return m;
}

test('manifest rejects exclusions on approved eyes or mouths even when a brow extension is present', () => {
  for (const [group, state] of [['eyeLeft', 'half'], ['eyeRight', 'closed'], ['mouth', 'press']]) {
    const m = browManifest(), p = m.poses['view-right'].patches[group][state], [x, y] = p.destination;
    p.exclude = [[[x + 1, y + 1], [x + 5, y + 1], [x + 5, y + 5], [x + 1, y + 5]]]; p.excludeFeather = 1.5;
    assert.throws(() => validateSideExpressionManifest(m));
  }
});

function fakeCanvas() {
  const calls = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'translate', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'fill', 'stroke', 'fillRect'].map(name => [name, (...args) => calls.push([name, ...args])]));
  context.drawImage = (...args) => calls.push(['drawImage', context.globalCompositeOperation, ...args]);
  context.createLinearGradient = () => ({addColorStop() {}});
  context.createImageData = (width, height) => ({width, height, data: new Uint8ClampedArray(width * height * 4)});
  context.putImageData = (...args) => calls.push(['putImageData', ...args]);
  return {width: 0, height: 0, getContext: () => context, calls};
}

test('only an opted-in brow compiles one fixed destination-in mask, while all original compilation paths stay untouched', async t => {
  const m = browManifest(), target = m.poses['view-right'].patches.browRight.down, [x, y] = target.destination;
  target.exclude = [[[x + 10, y + 10], [x + 20, y + 10], [x + 20, y + 20], [x + 10, y + 20]]]; target.excludeFeather = 1.5;
  const canvases = [];
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => m}));
  class ImageStub {naturalWidth = 1122; naturalHeight = 1402; set src(value) {this.name = value; queueMicrotask(() => this.onload());}}
  for (const [key, value] of [['Image', ImageStub], ['document', {createElement: () => {const c = fakeCanvas(); canvases.push(c); return c;}}]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const assets = await loadSideExpressionAssets('brows');
  const masks = canvases.filter(c => c.calls.some(call => call[0] === 'putImageData'));
  assert.equal(masks.length, 1);
  const mask = masks[0], data = mask.calls.find(call => call[0] === 'putImageData')[1];
  const expected = rasterizeBrowExclusion(mask.width, mask.height, target.destination, target.exclude, target.excludeFeather);
  assert.deepEqual(Uint8ClampedArray.from({length: expected.length}, (_, i) => data.data[i * 4 + 3]), expected);
  const compiled = assets.compiled['view-right'].browRight.down;
  assert.deepEqual(compiled.calls.filter(call => call[0] === 'drawImage').at(-1), ['drawImage', 'destination-in', mask, 0, 0]);
  for (const [poseId, groups] of Object.entries(assets.compiled)) for (const [group, states] of Object.entries(groups)) for (const [state, canvas] of Object.entries(states)) {
    if (poseId === 'view-right' && group === 'browRight' && state === 'down') continue;
    assert.equal(canvas.calls.filter(call => call[0] === 'drawImage').length, 1, `${poseId}/${group}/${state}: original compilation unchanged`);
  }
});
