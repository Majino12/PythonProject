import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {COMPLETE_POSE_IDS, validateCompletePoseGazeManifest, compileCompletePoseGazeLayers} from './complete-pose-gaze.js';
import {prepareCompletePoseGazeLayers} from './complete-pose-gaze-snapshot.js';
import {loadSideExpressionAssets, validateSideExpressionManifest} from './side-expression-renderer.js';
import {loadShortHairStudioAssets, renderShortHairStudio, getStudioPaintStates} from './short-hair-studio-renderer.js';

const read = pack => JSON.parse(readFileSync(new URL(`./assets/${pack}/manifest.json`, import.meta.url)));
// Synthetic ownership fixture only: these relabeled paths are consumed by
// Image stubs. Production registration must use independently generated art.
function completionFixture() {
  let encoded = JSON.stringify(read('short-hair-pitch-brows-v1'));
  for (const [from, to] of [['view-left-up', 'view-up'], ['view-right-up', 'view-down'], ['view-left-down', 'view-right-down']]) encoded = encoded.replaceAll(from, to);
  const manifest = JSON.parse(encoded); manifest.poseFamily = 'completePitch'; manifest.id = 'completion-fixture';
  return manifest;
}
function fakeCanvas() {
  const calls = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'translate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'fill', 'stroke', 'fillRect', 'setLineDash', 'arc', 'fillText', 'strokeRect', 'putImageData'].map(name => [name, (...args) => calls.push([name, ...args])]));
  context.createLinearGradient = () => ({addColorStop() {}});
  context.createImageData = (w, h) => ({data: new Uint8ClampedArray(w * h * 4)});
  return {width: 0, height: 0, getContext: () => context, calls};
}
function environment(t, response = () => completionFixture()) {
  const urls = [], canvases = [], snapshots = [], options = {fail: false};
  t.mock.method(globalThis, 'fetch', async url => {urls.push(url); return {ok: true, json: async () => response(url)};});
  class ImageStub {
    naturalWidth = 1122; naturalHeight = 1402; decoded = false;
    set src(value) {this.sourcePath = value; queueMicrotask(() => this.onload());}
    get src() {return this.sourcePath;}
    async decode() {this.decoded = true;}
  }
  for (const [name, value] of [
    ['Image', ImageStub], ['document', {createElement: () => {const canvas = fakeCanvas(); canvases.push(canvas); return canvas;}}],
    ['createImageBitmap', async canvas => {
      if (options.fail && snapshots.length === 0) {snapshots.push(null); throw new Error('snapshot unavailable');}
      const bitmap = {width: canvas.width, height: canvas.height, closed: false, close() {this.closed = true;}}; snapshots.push(bitmap); return bitmap;
    }],
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  return {urls, canvases, snapshots, options};
}
const imagesFor = manifest => Object.fromEntries(Object.keys(manifest.sources).map(key => [key, {id: key}]));

test('completion family requires all three real pose IDs and all facial capabilities', () => {
  const manifest = completionFixture(); assert.equal(validateSideExpressionManifest(manifest), manifest);
  assert.deepEqual(Object.keys(manifest.poses), COMPLETE_POSE_IDS);
  for (const mutate of [
    m => {m.poseFamily = 'pitch';}, m => {m.poseFamily = 'complete';}, m => {delete m.poses['view-up'];},
    m => {m.poses['view-left-up'] = m.poses['view-up'];}, m => {delete m.gaze;}, m => {delete m.mouthArt;}, m => {delete m.browArt;},
    m => {m.sources[m.gaze.poses['view-down'].whiteSource].pose = 'view-up';},
    m => {m.gaze.poses['view-up'].irisSource = m.poses['view-up'].reference;},
    m => {m.gaze.poses['view-up'].eyes.eyeLeft.frames.half.source = m.poses['view-down'].patches.eyeLeft.half.source;},
    m => {m.gaze.poses['view-up'].eyes.eyeLeft.frames.closed = m.gaze.poses['view-up'].eyes.eyeLeft.frames.open;},
    m => {m.gaze.poses['view-up'].eyes.eyeLeft.basis = {horizontal: [-1, 0], vertical: [0, 1]};},
  ]) {const broken = completionFixture(); mutate(broken); assert.throws(() => validateSideExpressionManifest(broken));}
});

test('completion compiler preserves the new IDs and creates no visible closed-eye iris', t => {
  const env = environment(t), manifest = completionFixture();
  const layers = compileCompletePoseGazeLayers(manifest, imagesFor(manifest));
  assert.deepEqual(Object.keys(layers), COMPLETE_POSE_IDS); assert.equal(env.canvases.length, 24);
  for (const poseId of COMPLETE_POSE_IDS) for (const eye of ['eyeLeft', 'eyeRight']) {
    assert.deepEqual(Object.keys(layers[poseId][eye].frames), ['open', 'half']);
    const imageDraw = layers[poseId][eye].canvas.calls.find(call => call[0] === 'drawImage');
    assert.equal(imageDraw[1].id, manifest.gaze.poses[poseId].irisSource);
    assert.deepEqual(imageDraw.slice(2), [...manifest.gaze.poses[poseId].eyes[eye].irisRect, ...manifest.gaze.poses[poseId].eyes[eye].irisDestination]);
  }
});

test('completion snapshots share stable content, invalidate changed gaze, and retry failed compilation', async t => {
  const env = environment(t), manifest = completionFixture(); env.options.fail = true;
  await assert.rejects(prepareCompletePoseGazeLayers(manifest, imagesFor(manifest)), /无法建立稳定/);
  assert.ok(env.snapshots.filter(Boolean).every(bitmap => bitmap.closed)); env.options.fail = false;
  const [first, second] = await Promise.all([prepareCompletePoseGazeLayers(manifest, imagesFor(manifest)), prepareCompletePoseGazeLayers(manifest, imagesFor(manifest))]);
  assert.equal(first, second); assert.equal(env.snapshots.length, 36); assert.ok(Object.isFrozen(first));
  const next = structuredClone(manifest); next.gaze.poses['view-up'].eyes.eyeLeft.maxShift.x -= .1;
  assert.notEqual(await prepareCompletePoseGazeLayers(next, imagesFor(next)), first); assert.equal(env.snapshots.length, 54);
});

test('completion loader resolves its own URL and refuses an old-family manifest before image loading', async t => {
  let manifest = completionFixture(); const env = environment(t, () => manifest);
  const assets = await loadSideExpressionAssets('completePitch');
  assert.deepEqual(env.urls, ['./assets/short-hair-complete-poses-v1/manifest.json']);
  assert.deepEqual(Object.keys(assets.compiled), COMPLETE_POSE_IDS); assert.equal(env.snapshots.length, 18);
  assert.ok(Object.values(assets.images).every(image => image.decoded));
  manifest = read('short-hair-pitch-brows-v1');
  await assert.rejects(loadSideExpressionAssets('completePitch'), /姿态系列/);
  manifest = completionFixture(); await assert.rejects(loadSideExpressionAssets('pitchBrows'), /姿态系列/);
});

test('studio loads all four asset families into nine uniquely owned head poses', async t => {
  // Integration uses the actual accepted family configurations. The frame-art
  // extension is intentionally bound to their IDs and geometry fingerprints;
  // the relabeled compiler fixture above must not bypass that ownership check.
  const env = environment(t, url => JSON.parse(readFileSync(new URL(url, import.meta.url))));
  const assets = await loadShortHairStudioAssets();
  assert.deepEqual(new Set(env.urls), new Set(['./assets/short-hair-gaze-v1/manifest.json', './assets/short-hair-side-brows-v1/manifest.json', './assets/short-hair-pitch-brows-v1/manifest.json', './assets/short-hair-complete-poses-v1/manifest.json', './assets/short-hair-frame-art-v1/manifest.json']));
  assert.equal(assets.poses.length, 9); assert.equal(new Set(assets.poses.map(pose => pose.id)).size, 9);
  assert.ok(Object.isFrozen(assets.poses));
  assert.equal(['front', 'side', 'pitch', 'complete'].reduce((count, family) => count + Object.keys(assets[family].images).length, 0), 9,
    'compiled studio keeps only nine full neutral portraits; expression canvases and gaze layers own their pixels');
  for (const pose of assets.poses) {
    assert.equal(pose.assetId, assets[pose.sourceFamily].manifest.id);
    assert.deepEqual(getStudioPaintStates(assets, pose.id), {
      eyes: ['open', 'quarter', 'half', 'threeQuarter', 'closed'],
      mouth: ['neutral', 'parted', 'openSmall', 'openMedium', 'openWide'],
    });
  }
  const channels = {eyeBlinkLeft: 1, eyeBlinkRight: .5, mouthLeft: 1, browOuterUpLeft: 1, browDownRight: 1, eyeLookOutRight: 1, eyeLookUpRight: 1};
  for (const pose of assets.poses) {
    const canvas = fakeCanvas(), result = renderShortHairStudio(canvas, assets, pose.id, channels);
    assert.deepEqual([canvas.width, canvas.height], [630, 460]);
    assert.equal(result.state.eyeLeft, 'closed'); assert.equal(result.state.eyeRight, 'half'); assert.equal(result.state.mouth, 'shiftLeft');
    assert.equal(result.state.browLeft, pose.id === 'front' ? 'up' : 'outerUp'); assert.equal(result.state.browRight, 'down');
    assert.deepEqual(result.gaze.eyeRight, {x: -1, y: -1});
    const draws = canvas.calls.filter(call => call[0] === 'drawImage');
    const source = assets[pose.sourceFamily], reference = pose.id === 'front' ? source.manifest.reference : source.manifest.poses[pose.id].reference;
    assert.equal(draws[0][1], source.images[reference]); assert.ok(draws.every(call => call.length === 4));
  }
  const frontResult = renderShortHairStudio(fakeCanvas(), assets, 'front', {eyeBlinkLeft: .2, jawOpen: .2});
  assert.equal(frontResult.state.eyeLeft, 'quarter'); assert.equal(frontResult.state.mouth, 'parted');
});

test('studio original exports neutral rendered metadata, retains target metadata, and never substitutes missing views', async t => {
  environment(t, url => JSON.parse(readFileSync(new URL(url, import.meta.url))));
  const assets = await loadShortHairStudioAssets();
  for (const pose of assets.poses) {
    const canvas = fakeCanvas(), result = renderShortHairStudio(canvas, assets, pose.id, {mouthPucker: 1, eyeBlinkLeft: 1, eyeLookUpLeft: 1}, {}, {original: true, faceOnly: false});
    assert.deepEqual([canvas.width, canvas.height], [1122, 1402]);
    assert.equal(canvas.calls.filter(call => call[0] === 'drawImage').length, 1);
    assert.equal(result.state.mouth, 'neutral'); assert.equal(result.state.eyeLeft, 'open'); assert.equal(result.gaze.eyeLeft.y, 0);
    assert.equal(result.targetState.mouth, 'pucker'); assert.equal(result.targetState.eyeLeft, 'closed'); assert.equal(result.targetGaze.eyeLeft.y, -1);
  }
  for (const pose of ['__proto__', 'view-rear', 'constructor']) assert.throws(() => renderShortHairStudio(fakeCanvas(), assets, pose, {}));
  delete assets.complete; assert.throws(() => renderShortHairStudio(fakeCanvas(), assets, 'view-up', {}));
});
