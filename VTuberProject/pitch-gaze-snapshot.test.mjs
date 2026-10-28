import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {preparePitchGazeLayers} from './pitch-gaze-snapshot.js';
import {loadSideExpressionAssets} from './side-expression-renderer.js';

const read = name => JSON.parse(readFileSync(new URL(`./assets/${name}/manifest.json`, import.meta.url)));
const base = () => read('short-hair-pitch-gaze-v1');
const imagesFor = manifest => Object.fromEntries(Object.keys(manifest.sources).map(key => [key, {id: key}]));

function environment(t) {
  const canvases = [], bitmaps = [], events = [];
  const makeDocument = () => ({createElement: () => {
    const calls = [], context = Object.fromEntries(['translate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'fill', 'stroke', 'fillRect'].map(name => [name, (...args) => calls.push([name, ...args])]));
    context.createLinearGradient = () => ({addColorStop() {}});
    const canvas = {width: 0, height: 0, calls, getContext: () => context};
    canvases.push(canvas); events.push('canvas'); return canvas;
  }});
  class ImageStub {naturalWidth = 1122; naturalHeight = 1402; set src(value) {this.srcValue = value; queueMicrotask(() => this.onload());}}
  const settings = {fail: false, wrongSize: false};
  const snapshot = async canvas => {
    events.push('snapshot');
    if (settings.fail && bitmaps.length === 0) {bitmaps.push(null); throw new Error('snapshot failed');}
    const bitmap = {width: canvas.width + (settings.wrongSize ? 1 : 0), height: canvas.height, closed: false,
      close() {this.closed = true;}};
    bitmaps.push(bitmap); return bitmap;
  };
  for (const [name, value] of [['document', makeDocument()], ['Image', ImageStub], ['createImageBitmap', snapshot]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  return {canvases, bitmaps, events, makeDocument, snapshot, settings};
}

test('concurrent approved and mouth-only packs share one immutable gaze snapshot without recompiling identical eyes', async t => {
  const env = environment(t), approved = base(), mouth = read('short-hair-pitch-mouth-v1');
  const [a, b] = await Promise.all([preparePitchGazeLayers(approved, imagesFor(approved)), preparePitchGazeLayers(mouth, imagesFor(mouth))]);
  assert.equal(a, b); assert.equal(env.canvases.length, 24); assert.equal(env.bitmaps.length, 18);
  assert.ok(Object.isFrozen(a));
  for (const pose of Object.values(a)) for (const layer of Object.values(pose)) {
    assert.ok(Object.isFrozen(layer)); assert.ok(Object.isFrozen(layer.frames));
    assert.ok(env.bitmaps.includes(layer.canvas)); assert.equal(layer.canvas.getContext, undefined);
    for (const state of ['open', 'half']) assert.ok(env.bitmaps.includes(layer.frames[state].clean));
  }
  const width = a['view-left-up'].eyeLeft.canvas.width;
  env.canvases[0].width = 1;
  assert.equal(a['view-left-up'].eyeLeft.canvas.width, width, 'materialized bitmap is independent from the original mutable canvas');
});

test('source URLs, hashes, eye registration, reference and gaze geometry invalidate the inherited snapshot', async t => {
  const env = environment(t), manifest = base();
  const first = await preparePitchGazeLayers(manifest, imagesFor(manifest));
  for (const mutate of [
    m => {m.sources[m.gaze.poses['view-left-up'].irisSource].src = './assets/new-irises.png';},
    m => {m.sources[m.gaze.poses['view-left-up'].irisSource].sha256 = 'b'.repeat(64);},
    m => {m.gaze.poses['view-left-up'].eyes.eyeLeft.maxShift.x += .1;},
    m => {m.poses['view-left-up'].patches.eyeLeft.half.feather += 1;},
    m => {
      const pose = m.poses['view-left-up'], old = pose.reference;
      m.sources['new-reference'] = {...m.sources[old], src: './assets/new-reference.png', sha256: 'c'.repeat(64)};
      pose.reference = 'new-reference';
      for (const eye of Object.values(m.gaze.poses['view-left-up'].eyes)) eye.frames.open.source = 'new-reference';
    },
  ]) {
    const next = structuredClone(manifest); mutate(next);
    assert.notEqual(await preparePitchGazeLayers(next, imagesFor(next)), first);
  }
  assert.equal(env.bitmaps.length, 6 * 18);
  for (const mutate of [
    m => {m.sources[m.gaze.poses['view-left-up'].irisSource].width--;},
    m => {m.sources[m.gaze.poses['view-left-up'].irisSource].height--;},
    m => {m.sources[m.gaze.poses['view-left-up'].irisSource].pose = 'view-left-down';},
    m => {delete m.sources[m.gaze.poses['view-left-up'].irisSource].sha256;},
  ]) {
    const broken = structuredClone(manifest); mutate(broken);
    await assert.rejects(preparePitchGazeLayers(broken, imagesFor(broken)));
  }
  assert.equal(env.bitmaps.length, 6 * 18, 'invalid source declarations never hit a cached snapshot');
});

test('non-eye metadata and object insertion order do not invalidate the same gaze content', async t => {
  const env = environment(t), manifest = base();
  const first = await preparePitchGazeLayers(manifest, imagesFor(manifest));
  const next = structuredClone(manifest); next.id = 'future-mouth-pack'; next.status = 'candidate'; next.limitations = ['new mouth limitation'];
  next.sources = Object.fromEntries(Object.entries(next.sources).reverse());
  next.gaze.poses = Object.fromEntries(Object.entries(next.gaze.poses).reverse());
  assert.equal(await preparePitchGazeLayers(next, imagesFor(next)), first);
  assert.equal(env.bitmaps.length, 18);
});

test('snapshot caches are isolated by document, Image constructor and bitmap factory', async t => {
  const env = environment(t), manifest = base();
  const first = await preparePitchGazeLayers(manifest, imagesFor(manifest));
  globalThis.document = env.makeDocument();
  const second = await preparePitchGazeLayers(manifest, imagesFor(manifest)); assert.notEqual(second, first);
  globalThis.Image = class OtherImage {};
  const third = await preparePitchGazeLayers(manifest, imagesFor(manifest)); assert.notEqual(third, second);
  globalThis.createImageBitmap = canvas => env.snapshot(canvas);
  const fourth = await preparePitchGazeLayers(manifest, imagesFor(manifest)); assert.notEqual(fourth, third);
  assert.equal(env.bitmaps.length, 4 * 18);
});

test('snapshot failure is never cached, partial bitmaps close and a later request retries successfully', async t => {
  const env = environment(t), manifest = base(); env.settings.fail = true;
  const pending = [preparePitchGazeLayers(manifest, imagesFor(manifest)), preparePitchGazeLayers(manifest, imagesFor(manifest))];
  const failures = await Promise.allSettled(pending);
  assert.ok(failures.every(result => result.status === 'rejected'));
  assert.equal(env.canvases.length, 24); assert.equal(env.bitmaps.length, 18);
  assert.ok(env.bitmaps.filter(Boolean).every(bitmap => bitmap.closed));
  env.settings.fail = false;
  const success = await preparePitchGazeLayers(manifest, imagesFor(manifest));
  assert.equal(env.canvases.length, 48); assert.equal(env.bitmaps.length, 36);
  assert.ok(env.bitmaps.slice(18).every(bitmap => !bitmap.closed));
  assert.equal(await preparePitchGazeLayers(manifest, imagesFor(manifest)), success);
  assert.equal(env.bitmaps.length, 36);
});

test('wrong-size snapshots and hosts without ImageBitmap fail explicitly instead of reusing mutable canvases', async t => {
  const env = environment(t), manifest = base(); env.settings.wrongSize = true;
  await assert.rejects(preparePitchGazeLayers(manifest, imagesFor(manifest)), /无法建立稳定/);
  assert.ok(env.bitmaps.every(bitmap => bitmap.closed));
  env.settings.wrongSize = false;
  const saved = globalThis.createImageBitmap; delete globalThis.createImageBitmap;
  await assert.rejects(preparePitchGazeLayers(manifest, imagesFor(manifest)), /ImageBitmap/);
  const basic = read('short-hair-pitch-expressions-v1');
  assert.equal(await preparePitchGazeLayers(basic, imagesFor(basic)), null);
  globalThis.createImageBitmap = saved;
  assert.ok(await preparePitchGazeLayers(manifest, imagesFor(manifest)));
});

test('player materializes inherited gaze before any new mouth or eyelid crop canvases', async t => {
  const env = environment(t), manifest = read('short-hair-pitch-mouth-v1');
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => manifest}));
  const assets = await loadSideExpressionAssets('pitchMouth');
  assert.equal(env.events.indexOf('snapshot'), 24, 'the only preceding canvases are the six four-layer eyes');
  assert.equal(env.events.slice(24, 42).filter(event => event === 'snapshot').length, 18);
  assert.equal(env.events.slice(42).filter(event => event === 'canvas').length, 30);
  assert.equal(env.canvases.length, 54); assert.equal(env.bitmaps.length, 18);
  assert.equal(assets.gazeLayers['view-left-down'].eyeLeft.canvas.getContext, undefined);
});
