import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SIDE_BROW_STATES} from './side-brow-model.js';
import {validateSideExpressionManifest, loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const original = () => JSON.parse(readFileSync(new URL('./assets/short-hair-side-mouth-v1/manifest.json', import.meta.url)));
function fixture() {
  const m = original(); m.browArt = {version: 1, states: [...SIDE_BROW_STATES]}; m.id = 'side-brow-fixture';
  for (const [poseId, pose] of Object.entries(m.poses)) {
    pose.detailViews.brows = [280, 350, 550, 110];
    pose.patches.browLeft = {}; pose.patches.browRight = {};
    for (const [index, state] of SIDE_BROW_STATES.entries()) {
      const source = `${poseId}-brows-${state}`;
      m.sources[source] = {src: `./assets/side-brow/${source}.png`, width: m.width, height: m.height, pose: poseId};
      for (const [group, x] of [['browLeft', poseId === 'view-left' ? 500 : 705], ['browRight', poseId === 'view-left' ? 300 : 450]]) {
        const y = state === 'down' ? 430 : 375 + index * 10;
        const rect = [x, y, 100, 30];
        pose.patches[group][state] = {source, rect, destination: [...rect], transform: 'translation-only', feather: 3};
      }
    }
  }
  return m;
}

function fakeCanvas() {
  const calls = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'translate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'fill', 'stroke', 'fillRect', 'setLineDash', 'arc', 'fillText', 'strokeRect'].map(name => [name, (...args) => calls.push([name, ...args])]));
  context.createLinearGradient = () => ({addColorStop() {}});
  return {width: 0, height: 0, getContext: () => context, calls};
}

function assetsFor(manifest) {
  const images = Object.fromEntries(Object.keys(manifest.sources).map(key => [key, {name: key}]));
  const compiled = Object.fromEntries(Object.entries(manifest.poses).map(([poseId, pose]) => [poseId, Object.fromEntries(Object.entries(pose.patches).map(([group, states]) => [group, Object.fromEntries(Object.keys(states).map(state => [state, {name: `${poseId}/${group}/${state}`}]))]))]));
  const gazeLayers = Object.fromEntries(Object.entries(manifest.gaze.poses).map(([poseId, pose]) => [poseId, Object.fromEntries(Object.entries(pose.eyes).map(([eye, e]) => [eye, {bounds: e.bounds, canvas: {name: `${poseId}/${eye}/iris`}, frames: Object.fromEntries(Object.keys(e.frames).map(state => [state, {clean: {name: `${poseId}/${eye}/${state}/clean`}}]))}]))]));
  return {manifest, images, compiled, gazeLayers};
}

test('brow extension requires both independent brow groups and all three authored states while old packs remain valid', () => {
  assert.equal(validateSideExpressionManifest(fixture()).browArt.version, 1);
  assert.doesNotThrow(() => validateSideExpressionManifest(original()));
  for (const mutate of [
    m => {delete m.browArt;}, m => {m.browArt = true;}, m => {m.browArt = null;},
    m => {m.browArt.version = 2;}, m => {m.browArt.states.pop();}, m => {m.browArt.states[0] = 'down';},
    m => {m.browArt.states[0] = 'combined';}, m => {m.browArt.allowStretch = true;},
    m => {delete m.poses['view-left'].patches.browLeft;}, m => {delete m.poses['view-right'].patches.browRight.innerUp;},
    m => {m.poses['view-left'].patches.browLeft.neutral = m.poses['view-left'].patches.browLeft.down;},
  ]) {const m = fixture(); mutate(m); assert.throws(() => validateSideExpressionManifest(m));}
});

test('same-pose paired brows use separate crops of their corresponding double-brow painting, never a reused state or opposite pose', () => {
  for (const mutate of [
    m => {m.poses['view-left'].patches.browLeft.innerUp.source = 'view-right-brows-innerUp';},
    m => {m.poses['view-left'].patches.browLeft.innerUp.source = 'view-left-brows-outerUp';},
    m => {m.sources['view-left-brows-innerUp'].src = m.sources['view-left-brows-down'].src;},
    m => {m.sources['view-right-brows-innerUp'].src = m.sources['view-left-brows-innerUp'].src;},
    m => {m.poses['view-left'].patches.browLeft.down.rect = [...m.poses['view-left'].patches.browRight.down.rect];},
    m => {m.poses['view-left'].patches.browLeft.down.transform = 'mirror';},
    m => {m.poses['view-left'].patches.browRight.down.destination[2] += 1;},
  ]) {const m = fixture(); mutate(m); assert.throws(() => validateSideExpressionManifest(m));}
});

test('brow roots may move in the drawing without a fake fixed-root anchor, and eyebrow rectangles may share forehead skin with an eye crop', () => {
  const m = fixture(), brow = m.poses['view-left'].patches.browLeft.down;
  assert.equal(brow.anchor, undefined);
  assert.ok(brow.destination[1] + brow.destination[3] > m.poses['view-left'].patches.eyeLeft.half.destination[1]);
  assert.doesNotThrow(() => validateSideExpressionManifest(m));
  brow.anchor = {kind: 'drawing-landmark', source: [530, 438], destination: [530, 438]};
  assert.doesNotThrow(() => validateSideExpressionManifest(m));
  brow.anchor.destination[0] += 1;
  assert.throws(() => validateSideExpressionManifest(m));
});

test('asymmetric eyebrow selections cannot overlap each other or replace the mouth', () => {
  for (const mutate of [
    m => {m.poses['view-left'].patches.browLeft.innerUp.destination[0] = 350;},
    m => {m.poses['view-right'].patches.browRight.outerUp.destination[0] = 750;},
    m => {m.poses['view-left'].patches.browRight.down.destination = [395, 640, 100, 30];},
    m => {m.poses['view-right'].detailViews.brows = [-1, 350, 550, 110];},
  ]) {const m = fixture(); mutate(m); assert.throws(() => validateSideExpressionManifest(m));}
});

test('draw order is approved eyes/mouth, selected brows, then gaze; every eyebrow is drawn at fixed scale', () => {
  const assets = assetsFor(fixture()), canvas = fakeCanvas(), poseId = 'view-left';
  drawSideExpression(canvas, assets, poseId, {eyeLeft: 'half', eyeRight: 'closed', mouth: 'press', browLeft: 'outerUp', browRight: 'down'}, {gaze: {eyeLeft: {x: .4}}});
  const draws = canvas.calls.filter(call => call[0] === 'drawImage');
  assert.deepEqual(draws.map(call => call[1].name), [assets.manifest.poses[poseId].reference,
    'view-left/eyeLeft/half', 'view-left/eyeRight/closed', 'view-left/mouth/press',
    'view-left/browLeft/outerUp', 'view-left/browRight/down', 'view-left/eyeLeft/half/clean', 'view-left/eyeLeft/iris']);
  for (const call of draws) assert.equal(call.length, 4, 'runtime draw is image,x,y only');
  assert.deepEqual(draws[4].slice(2), assets.manifest.poses[poseId].patches.browLeft.outerUp.destination.slice(0, 2));
  assert.deepEqual(draws[5].slice(2), assets.manifest.poses[poseId].patches.browRight.down.destination.slice(0, 2));
});

test('neutral brows use the base portrait, original comparison skips all patches, and brow details use their own crop', () => {
  const assets = assetsFor(fixture());
  for (const brow of ['neutral', undefined, '__proto__', 'constructor']) {
    const canvas = fakeCanvas(); drawSideExpression(canvas, assets, 'view-right', {eyeLeft: 'closed', eyeRight: 'closed', browLeft: brow, browRight: brow}, {detail: 'brows'});
    assert.deepEqual([canvas.width, canvas.height], [550, 110]);
    const draws = canvas.calls.filter(call => call[0] === 'drawImage');
    assert.equal(draws.length, 3); assert.ok(draws.every(call => !call[1].name.includes('/brow')));
  }
  const canvas = fakeCanvas(); drawSideExpression(canvas, assets, 'view-left', {mouth: 'pucker', browLeft: 'down', browRight: 'innerUp'}, {original: true});
  assert.equal(canvas.calls.filter(call => call[0] === 'drawImage').length, 1);
});

test('loader compiles each brow from its pose-owned source at one-to-one dimensions and resolves the isolated brows variant', async t => {
  const manifest = fixture(), urls = [];
  t.mock.method(globalThis, 'fetch', async url => {urls.push(url); return {ok: true, json: async () => manifest};});
  class ImageStub {
    naturalWidth = 1122; naturalHeight = 1402;
    set src(value) {this.name = value; queueMicrotask(() => this.onload());}
  }
  for (const [key, value] of [['Image', ImageStub], ['document', {createElement: () => fakeCanvas()}]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const assets = await loadSideExpressionAssets('brows');
  assert.deepEqual(urls, ['./assets/short-hair-side-brows-v1/manifest.json']);
  for (const [poseId, pose] of Object.entries(manifest.poses)) for (const group of ['browLeft', 'browRight']) for (const state of SIDE_BROW_STATES) {
    const patch = pose.patches[group][state], canvas = assets.compiled[poseId][group][state];
    assert.deepEqual([canvas.width, canvas.height], patch.rect.slice(2));
    const call = canvas.calls.find(call => call[0] === 'drawImage');
    assert.equal(call[1].name, manifest.sources[patch.source].src);
    assert.deepEqual(call.slice(2), [...patch.rect, 0, 0, ...patch.rect.slice(2)]);
  }
});
