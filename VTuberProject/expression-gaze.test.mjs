import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gazeOffset, validateGazeManifest} from './expression-gaze.js';

const readManifest = (directory) => JSON.parse(readFileSync(new URL(`./assets/${directory}/manifest.json`, import.meta.url)));
const manifest = readManifest('short-hair-gaze-v1');
const states = ['open', 'quarter', 'half', 'threeQuarter'];
const eyes = ['eyeLeft', 'eyeRight'];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const rejects = (mutate) => {
  const broken = structuredClone(manifest);
  mutate(broken);
  assert.throws(() => validateGazeManifest(broken));
};

test('registered gaze uses separate iris crops and an individual mask for every visible eyelid stage', () => {
  assert.doesNotThrow(() => validateGazeManifest(manifest));
  assert.notEqual(manifest.gaze.whiteSource, manifest.gaze.irisSource);
  assert.notDeepEqual(manifest.gaze.eyes.eyeLeft.irisRect, manifest.gaze.eyes.eyeRight.irisRect);
  for (const eye of eyes) {
    const entry = manifest.gaze.eyes[eye];
    assert.deepEqual(Object.keys(entry.frames).sort(), [...states].sort());
    assert.equal(new Set(states.map(state => JSON.stringify(entry.frames[state].aperture))).size, states.length);
    for (const state of states) {
      const expectedSource = state === 'open' ? manifest.reference : manifest.patches[eye][state].source;
      assert.equal(entry.frames[state].source, expectedSource, `${eye}/${state} keeps its approved visible fragment`);
    }
  }
});

test('approved packs without gaze remain valid and an explicit opt-in is required', () => {
  for (const directory of ['short-hair-expressions-v1', 'short-hair-expressions-v2']) {
    assert.doesNotThrow(() => validateGazeManifest(readManifest(directory)));
  }
  for (const flag of [undefined, false, 1, 'true']) {
    const oldPack = readManifest('short-hair-expressions-v2');
    oldPack.extensions.gaze = flag;
    assert.doesNotThrow(() => validateGazeManifest(oldPack));
  }
});

test('gaze validation refuses missing eye masks, missing painted fragments and a visible closed-eye iris', () => {
  for (const eye of eyes) {
    rejects(m => { delete m.gaze.eyes[eye]; });
    for (const state of states) {
      rejects(m => { delete m.gaze.eyes[eye].frames[state]; });
      rejects(m => { delete m.gaze.eyes[eye].frames[state].aperture; });
      rejects(m => { delete m.gaze.eyes[eye].frames[state].fragment; });
      rejects(m => { m.gaze.eyes[eye].frames[state].source = 'absent-art'; });
    }
    rejects(m => { m.gaze.eyes[eye].frames.closed = structuredClone(m.gaze.eyes[eye].frames.open); });
  }
});

test('gaze validation refuses shared or overlapping iris crops and nonuniform registration', () => {
  rejects(m => { m.gaze.eyes.eyeLeft.irisRect = [...m.gaze.eyes.eyeRight.irisRect]; });
  rejects(m => { m.gaze.eyes.eyeLeft.irisRect[0] = m.gaze.eyes.eyeRight.irisRect[0] + 1; });
  for (const eye of eyes) {
    rejects(m => { m.gaze.eyes[eye].irisDestination[2] += 1; });
    rejects(m => { m.gaze.eyes[eye].irisDestination[3] += 1; });
  }
});

test('gaze validation refuses out-of-bounds or nonfinite iris registrations and masks', () => {
  for (const eye of eyes) {
    for (const field of ['irisRect', 'irisDestination']) {
      rejects(m => { m.gaze.eyes[eye][field][0] = -1; });
      rejects(m => { m.gaze.eyes[eye][field][0] = m.width; });
      rejects(m => { m.gaze.eyes[eye][field][1] = m.height; });
      rejects(m => { m.gaze.eyes[eye][field][2] = 0; });
      rejects(m => { m.gaze.eyes[eye][field][3] = Infinity; });
    }
    for (const field of ['aperture', 'fragment']) {
      rejects(m => { m.gaze.eyes[eye].frames.open[field][0][0] = -1; });
      rejects(m => { m.gaze.eyes[eye].frames.open[field][0][0] = m.width; });
      rejects(m => { m.gaze.eyes[eye].frames.open[field][0][1] = m.height; });
      rejects(m => { m.gaze.eyes[eye].frames.open[field][0][1] = NaN; });
      rejects(m => { m.gaze.eyes[eye].frames.open[field] = [[1, 1], [2, 2]]; });
    }
  }
});

test('gaze validation refuses unavailable sources or invalid travel limits', () => {
  rejects(m => { delete m.gaze; });
  rejects(m => { m.gaze.version = 2; });
  rejects(m => { m.gaze.irisSource = 'missing'; });
  rejects(m => { m.gaze.whiteSource = 'missing'; });
  rejects(m => { m.gaze.whiteSource = m.gaze.irisSource; });
  for (const axis of ['x', 'up', 'down']) for (const value of [0, -1, 13, NaN, Infinity, '5']) {
    rejects(m => { m.gaze.maxShift[axis] = value; });
  }
});

test('zero and invalid gaze inputs give exactly zero displacement', () => {
  for (const input of [undefined, null, {}, {x: 0, y: 0}, {x: NaN, y: Infinity}, {x: -Infinity, y: '1'}, {x: true, y: null}]) {
    assert.deepEqual(gazeOffset(input), {x: 0, y: 0});
  }
});

test('small gaze movement remains continuous and preserves distinct up/down travel', () => {
  const limits = manifest.gaze.maxShift;
  for (const value of [1e-9, .001, .01, .1, .25, .5]) {
    near(gazeOffset({x: value, y: 0}, limits).x, limits.x * value);
    near(gazeOffset({x: -value, y: 0}, limits).x, -limits.x * value);
    near(gazeOffset({x: 0, y: value}, limits).y, limits.down * value);
    near(gazeOffset({x: 0, y: -value}, limits).y, -limits.up * value);
  }
  assert.deepEqual(gazeOffset({x: .6, y: .8}, {x: 10, up: 6, down: 5}), {x: 6, y: 4});
});

test('saturation and diagonal travel remain within the registered ellipse', () => {
  const limits = Object.freeze({x: 10, up: 6, down: 5});
  assert.deepEqual(gazeOffset({x: 500, y: 0}, limits), {x: 10, y: 0});
  assert.deepEqual(gazeOffset({x: -500, y: 0}, limits), {x: -10, y: 0});
  assert.deepEqual(gazeOffset({x: 0, y: 500}, limits), {x: 0, y: 5});
  assert.deepEqual(gazeOffset({x: 0, y: -500}, limits), {x: 0, y: -6});
  for (const x of [-5, -1, -.7, 0, .7, 1, 5]) for (const y of [-5, -1, -.7, 0, .7, 1, 5]) {
    const input = Object.freeze({x, y});
    const result = gazeOffset(input, limits);
    const yLimit = y < 0 ? limits.up : limits.down;
    assert.ok((result.x / limits.x) ** 2 + (result.y / yLimit) ** 2 <= 1 + 1e-12);
    if (Math.abs(x) >= 1 && Math.abs(y) >= 1) {
      near(result.x, Math.sign(x) * limits.x / Math.sqrt(2));
      near(result.y, Math.sign(y) * yLimit / Math.sqrt(2));
    }
  }
});
