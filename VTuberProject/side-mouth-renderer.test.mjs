import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SIDE_MOUTH_STATES} from './side-mouth-model.js';
import {validateSideExpressionManifest, loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const readApproved = () => JSON.parse(readFileSync(new URL('./assets/short-hair-side-expressions-v1/manifest.json', import.meta.url)));

function fixture() {
  const m = readApproved(); m.id = 'side-mouth-fixture';
  m.mouthArt = {version: 1, states: [...SIDE_MOUTH_STATES]};
  for (const [poseId, pose] of Object.entries(m.poses)) for (const state of SIDE_MOUTH_STATES) {
    const source = `${poseId}-${state}`;
    m.sources[source] = {src: `./assets/side-mouth/${source}.png`, width: m.width, height: m.height, pose: poseId};
    const p = structuredClone(pose.patches.mouth.openSmall); p.source = source;
    const shift = state === 'shiftLeft' ? 10 : state === 'shiftRight' ? -10 : 0;
    p.destination[0] += shift; p.anchor.destination[0] += shift;
    if (p.clip) p.clip = p.clip.map(([x, y]) => [x + shift, y]);
    pose.patches.mouth[state] = p;
  }
  return m;
}

function fakeCanvas() {
  const calls = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'translate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip'].map(name => [name, (...args) => calls.push([name, ...args])]));
  return {width: 0, height: 0, getContext: () => context, calls};
}

test('mouth extension requires both poses and all four independent new drawings while old manifests keep only the original mouth states', () => {
  assert.equal(validateSideExpressionManifest(fixture()).mouthArt.version, 1);
  assert.doesNotThrow(() => validateSideExpressionManifest(readApproved()));
  for (const mutate of [
    m => {delete m.mouthArt;}, m => {m.mouthArt = true;}, m => {m.mouthArt = null;},
    m => {m.mouthArt.version = 2;}, m => {m.mouthArt.states.pop();},
    m => {m.mouthArt.states[0] = 'press';}, m => {m.mouthArt.states[0] = 'freeform';},
    m => {m.mouthArt.allowOffset = true;},
    m => {delete m.poses['view-left'].patches.mouth.press;},
    m => {m.poses['view-right'].patches.mouth.puckerShift = m.poses['view-right'].patches.mouth.pucker;},
  ]) {const m = fixture(); mutate(m); assert.throws(() => validateSideExpressionManifest(m));}
});

test('new source registration refuses shared or mirrored states and cross-pose assets', () => {
  for (const mutate of [
    m => {m.poses['view-left'].patches.mouth.shiftRight.source = 'view-left-shiftLeft';},
    m => {m.sources['view-left-shiftRight'].src = m.sources['view-left-shiftLeft'].src;},
    m => {m.sources['view-left-pucker'].src = m.sources['view-right-pucker'].src;},
    m => {m.poses['view-left'].patches.mouth.pucker.source = 'view-right-pucker';},
    m => {m.poses['view-left'].patches.mouth.shiftLeft.transform = 'mirror';},
    m => {m.poses['view-left'].patches.mouth.press.destination[2] += 1;},
  ]) {const m = fixture(); mutate(m); assert.throws(() => validateSideExpressionManifest(m));}
});

test('mouth shift anchors carry a fixed signed offset from the anatomical reference, never a state-independent recentering', () => {
  const m = fixture(); validateSideExpressionManifest(m);
  for (const pose of Object.values(m.poses)) for (const state of ['shiftLeft', 'shiftRight']) {
    const p = pose.patches.mouth[state];
    assert.equal(p.anchor.kind, 'upper-lip'); assert.equal(p.anchor.destination[1], pose.mouthReference[1]);
    assert.equal(p.anchor.destination[0] - pose.mouthReference[0], state === 'shiftLeft' ? 10 : -10);
    assert.deepEqual(p.anchor.source.map((v, i) => v + p.destination[i] - p.rect[i]), p.anchor.destination);
  }
});

test('mouth offset limits cannot be bypassed by zero, wrong sign, vertical drift or an arbitrary anchor flag', () => {
  for (const [state, dx, dy] of [['shiftLeft', 0, 0], ['shiftLeft', -10, 0], ['shiftLeft', 25, 0], ['shiftRight', 0, 0], ['shiftRight', 10, 0], ['shiftRight', -25, 0], ['shiftLeft', 10, 1], ['shiftRight', -10, -1], ['pucker', 1, 0], ['press', -1, 0], ['openSmall', 1, 0]]) {
    const m = fixture(), pose = m.poses['view-left'], p = pose.patches.mouth[state];
    const delta = [pose.mouthReference[0] + dx - p.anchor.destination[0], pose.mouthReference[1] + dy - p.anchor.destination[1]];
    p.anchor.destination = p.anchor.destination.map((v, i) => v + delta[i]);
    p.destination[0] += delta[0]; p.destination[1] += delta[1];
    p.allowOffset = true; p.anchor.allowOffset = true;
    if (p.clip) p.clip = p.clip.map(pt => pt.map((v, i) => v + delta[i]));
    assert.throws(() => validateSideExpressionManifest(m), `${state} dx=${dx} dy=${dy}`);
  }
});

test('new mouth state draws only its independent registered crop without movement, resizing or blending', () => {
  const manifest = fixture(), images = Object.fromEntries(Object.keys(manifest.sources).map(key => [key, {name: key}]));
  const compiled = Object.fromEntries(Object.entries(manifest.poses).map(([poseId, pose]) => [poseId, Object.fromEntries(Object.entries(pose.patches).map(([group, states]) => [group, Object.fromEntries(Object.keys(states).map(state => [state, {name: `${poseId}/${group}/${state}`}]))]))]));
  const assets = {manifest, images, compiled, gazeLayers: null};
  for (const poseId of Object.keys(manifest.poses)) for (const mouth of SIDE_MOUTH_STATES) {
    const canvas = fakeCanvas(); drawSideExpression(canvas, assets, poseId, {eyeLeft: 'open', eyeRight: 'open', mouth});
    const draws = canvas.calls.filter(call => call[0] === 'drawImage');
    assert.equal(draws.length, 2); assert.equal(draws[1][1], compiled[poseId].mouth[mouth]);
    assert.equal(draws[1].length, 4); assert.deepEqual(draws[1].slice(2), manifest.poses[poseId].patches.mouth[mouth].destination.slice(0, 2));
  }
  const original = fakeCanvas(); drawSideExpression(original, assets, 'view-left', {mouth: 'shiftLeft'}, {original: true});
  assert.equal(original.calls.filter(call => call[0] === 'drawImage').length, 1);
});

test('mouth variant resolves to its own manifest and never replaces default approved or gaze URLs', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {urls.push(url); return {ok: false};});
  for (const variant of [undefined, 'approved', 'gaze', 'mouth']) await assert.rejects(loadSideExpressionAssets(variant), /无法读取/);
  assert.deepEqual(urls, ['./assets/short-hair-side-expressions-v1/manifest.json', './assets/short-hair-side-expressions-v1/manifest.json', './assets/short-hair-side-gaze-v1/manifest.json', './assets/short-hair-side-mouth-v1/manifest.json']);
});
