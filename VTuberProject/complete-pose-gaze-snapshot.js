import {validateCompletePoseGazeManifest, compileCompletePoseGazeLayers} from './complete-pose-gaze.js';

// The completion family owns its compiler and cache, leaving both accepted
// pose families frozen. Identical completion eye artwork shares a materialized
// snapshot across players; later canvas readbacks cannot alter these sources.
const environments = new WeakMap();
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function fingerprint(manifest) {
  const ids = new Set(), poses = {};
  for (const poseId of Object.keys(manifest.gaze.poses).sort()) {
    const pose = manifest.poses[poseId], gaze = manifest.gaze.poses[poseId];
    poses[poseId] = {reference: pose.reference, eyeLeft: pose.patches.eyeLeft, eyeRight: pose.patches.eyeRight};
    ids.add(pose.reference); ids.add(gaze.whiteSource); ids.add(gaze.irisSource);
    for (const eye of ['eyeLeft', 'eyeRight']) {
      for (const patch of Object.values(pose.patches[eye])) ids.add(patch.source);
      for (const frame of Object.values(gaze.eyes[eye].frames)) ids.add(frame.source);
    }
  }
  const sources = Object.fromEntries([...ids].sort().map(id => {
    const source = manifest.sources[id];
    if (!source || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('视线快照需要所有相关源图的 SHA-256 登记。');
    return [id, {src: source.src, width: source.width, height: source.height, pose: source.pose, sha256: source.sha256}];
  }));
  return JSON.stringify(canonical({poseFamily: manifest.poseFamily, width: manifest.width, height: manifest.height,
    gaze: manifest.gaze, poses, sources}));
}

function cacheFor(document, Image, snapshot) {
  let images = environments.get(document);
  if (!images) environments.set(document, images = new WeakMap());
  let factories = images.get(Image);
  if (!factories) images.set(Image, factories = new WeakMap());
  let cache = factories.get(snapshot);
  if (!cache) factories.set(snapshot, cache = new Map());
  return cache;
}

async function snapshotLayers(layers, snapshot) {
  const items = [];
  for (const [poseId, pose] of Object.entries(layers)) for (const [eye, layer] of Object.entries(pose)) {
    items.push({poseId, eye, state: null, canvas: layer.canvas});
    for (const [state, frame] of Object.entries(layer.frames)) items.push({poseId, eye, state, canvas: frame.clean});
  }
  const results = await Promise.allSettled(items.map(async item => {
    const bitmap = await snapshot.call(globalThis, item.canvas);
    if (!bitmap || bitmap.width !== item.canvas.width || bitmap.height !== item.canvas.height) {
      bitmap?.close?.(); throw new Error('视线图像快照尺寸不匹配。');
    }
    return bitmap;
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) {
    for (const result of results) if (result.status === 'fulfilled') result.value.close?.();
    throw new Error('无法建立稳定的视线图像快照，请重新载入。', {cause: failure.reason});
  }
  const prepared = Object.fromEntries(Object.entries(layers).map(([poseId, pose]) => [poseId,
    Object.fromEntries(Object.entries(pose).map(([eye, layer]) => [eye, {bounds: Object.freeze([...layer.bounds]), frames: {}}])),
  ]));
  for (const [index, item] of items.entries()) {
    const layer = prepared[item.poseId][item.eye], bitmap = results[index].value;
    if (item.state === null) layer.canvas = bitmap;
    else layer.frames[item.state] = Object.freeze({clean: bitmap});
  }
  for (const pose of Object.values(prepared)) {
    for (const layer of Object.values(pose)) {Object.freeze(layer.frames); Object.freeze(layer);}
    Object.freeze(pose);
  }
  return Object.freeze(prepared);
}

/** No mutable-canvas fallback: hosts without ImageBitmap cannot promise stable
 * inheritance, so loading fails explicitly rather than silently changing eyes. */
export async function prepareCompletePoseGazeLayers(manifest, images) {
  validateCompletePoseGazeManifest(manifest);
  if (manifest.gaze === undefined) return null;
  const document = globalThis.document, Image = globalThis.Image, snapshot = globalThis.createImageBitmap;
  if (!document || typeof Image !== 'function' || typeof snapshot !== 'function') throw new Error('此浏览器不支持稳定视线所需的 ImageBitmap，请使用支持此功能的浏览器。');
  const key = fingerprint(manifest), cache = cacheFor(document, Image, snapshot);
  if (cache.has(key)) return cache.get(key);
  const pending = Promise.resolve().then(() => snapshotLayers(compileCompletePoseGazeLayers(manifest, images), snapshot));
  cache.set(key, pending);
  try {
    const result = await pending;
    // Bound retained signatures without closing bitmaps still used by players.
    while (cache.size > 4) cache.delete(cache.keys().next().value);
    return result;
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  }
}
