/** Extra authored eye/jaw frames. Accepted source manifests and compiled old
 * frames are reused unchanged; this module never re-rasterizes their irises. */
export const FRAME_ART_URL = './assets/short-hair-frame-art-v1/manifest.json';
export const FRAME_POSE_FAMILIES = Object.freeze({
  'view-left': 'side', 'view-right': 'side',
  'view-left-up': 'pitch', 'view-right-up': 'pitch', 'view-left-down': 'pitch',
  'view-up': 'complete', 'view-down': 'complete', 'view-right-down': 'complete',
});
const EYES = ['eyeLeft', 'eyeRight'];
const STATES = {eyeLeft: ['quarter', 'threeQuarter'], eyeRight: ['quarter', 'threeQuarter'], mouth: ['parted', 'openMedium']};
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const rect = r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] >= 0 && r[1] >= 0
  && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= 1122 && r[1] + r[3] <= 1402;
const inside = (p, r) => point(p) && p[0] >= r[0] && p[1] >= r[1] && p[0] <= r[0] + r[2] && p[1] <= r[1] + r[3];
const polygon = (p, bounds) => Array.isArray(p) && p.length >= 3 && p.every(v => inside(v, bounds));
const exactKeys = (o, keys) => object(o) && Object.keys(o).length === keys.length && keys.every(key => own(o, key));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const localImage = /^\.\/assets\/short-hair-frame-art-v1\/[a-zA-Z0-9_-]+\.png$/;

/** Status, descriptions and approval notes may evolve; the inherited art and
 * geometry used by this extension must match these exact semantic fields. */
export function frameBaseConfiguration(manifest) {
  return Object.fromEntries(['id', 'width', 'height', 'sources', 'poses', 'gaze', 'mouthArt', 'browArt'].map(key => [key, manifest[key]]));
}

export function validateFrameArtManifest(manifest, baseAssets, family) {
  const ids = Object.keys(FRAME_POSE_FAMILIES);
  if (!object(manifest) || manifest.version !== 1 || manifest.id !== 'short-hair-frame-art-v1'
    || manifest.kind !== 'painted-expression-frame-extension' || manifest.width !== 1122 || manifest.height !== 1402
    || !exactKeys(manifest.bases, ['side', 'pitch', 'complete']) || !exactKeys(manifest.poses, ids)
    || !object(manifest.sources) || Object.keys(manifest.sources).length !== 16) throw new Error('中间画稿包需要八个姿态的十六张独立源稿。');
  for (const base of Object.values(manifest.bases)) if (!object(base) || typeof base.id !== 'string' || !hash(base.configurationSha256)) {
    throw new Error('中间画稿缺少继承配置的完整指纹。');
  }
  const paths = new Set(), hashes = new Set();
  for (const source of Object.values(manifest.sources)) {
    if (!object(source) || !localImage.test(source.src) || source.width !== 1122 || source.height !== 1402
      || !own(FRAME_POSE_FAMILIES, source.pose) || !hash(source.sha256)
      || paths.has(source.src) || hashes.has(source.sha256)) throw new Error('中间源稿必须是独立的本姿态原生画稿。');
    paths.add(source.src); hashes.add(source.sha256);
  }
  for (const [poseId, pose] of Object.entries(manifest.poses)) {
    if (!object(pose) || pose.baseFamily !== FRAME_POSE_FAMILIES[poseId]
      || !exactKeys(pose.patches, Object.keys(STATES)) || !exactKeys(pose.gaze, EYES)) throw new Error(`${poseId} 的中间画稿归属或画稿组无效。`);
    for (const [group, states] of Object.entries(STATES)) {
      if (!exactKeys(pose.patches[group], states)) throw new Error(`${poseId}/${group} 缺少两档独立中间稿。`);
      for (const [index, state] of states.entries()) {
        const patch = pose.patches[group][state], expected = `${poseId}-${index ? 'three-quarter-medium' : 'quarter-parted'}`;
        if (!object(patch) || patch.source !== expected || !own(manifest.sources, expected) || manifest.sources[expected].pose !== poseId
          || !rect(patch.rect) || !rect(patch.destination) || !same(patch.rect.slice(2), patch.destination.slice(2))
          || patch.transform !== 'translation-only' || !Number.isFinite(patch.feather) || patch.feather < 0
          || patch.feather * 2 >= Math.min(...patch.rect.slice(2)) || !polygon(patch.clip, patch.destination)) throw new Error(`${poseId}/${group}/${state} 裁切或本姿态源稿无效。`);
        if (group !== 'mouth' && !same(patch.rect, patch.destination)) throw new Error('新眼睑必须原生定位，不能挪动眼球或变形。');
        if (group === 'mouth' && (!object(patch.anchor) || patch.anchor.kind !== 'upper-lip'
          || !inside(patch.anchor.source, patch.rect) || !inside(patch.anchor.destination, patch.destination)
          || !same(patch.anchor.source.map((v, i) => v + patch.destination[i] - patch.rect[i]), patch.anchor.destination))) throw new Error('中间嘴稿必须保持实际测量的固定上唇锚点。');
      }
    }
    for (const eye of EYES) {
      if (!exactKeys(pose.gaze[eye], STATES[eye])) throw new Error('每只眼需要两条从新画稿登记的独立眼裂。');
      for (const state of STATES[eye]) {
        const frame = pose.gaze[eye][state];
        if (!object(frame) || frame.source !== pose.patches[eye][state].source
          || !polygon(frame.aperture, pose.patches[eye][state].destination)
          || !polygon(frame.fragment, pose.patches[eye][state].destination)) throw new Error('新眼裂与旧虹膜清除范围必须属于这张中间稿。');
      }
    }
  }
  if (baseAssets !== undefined) {
    const base = baseAssets?.manifest;
    if (!own(manifest.bases, family) || !object(base) || base.id !== manifest.bases[family].id || !baseAssets.gazeLayers) throw new Error('中间稿与已载入的基础系列不匹配。');
    for (const [poseId, extension] of Object.entries(manifest.poses)) {
      if (extension.baseFamily !== family) continue;
      const pose = base.poses?.[poseId], gaze = base.gaze?.poses?.[poseId];
      if (!pose || !gaze || !own(baseAssets.gazeLayers, poseId)) throw new Error('中间稿不能替换或借用其他角度的底图。');
      for (const patch of Object.values(extension.patches.mouth)) if (!same(patch.anchor.destination, pose.mouthReference)) throw new Error('中间稿改变了已登记上唇位置。');
      for (const eye of EYES) {
        if (!baseAssets.gazeLayers[poseId][eye]?.canvas) throw new Error('缺少应当复用的已编译虹膜。');
        for (const frame of Object.values(extension.gaze[eye])) if (!polygon(frame.aperture, gaze.eyes[eye].bounds)
          || !polygon(frame.fragment, gaze.eyes[eye].bounds)) throw new Error('新眼裂超出了本姿态已有眼部边界。');
      }
    }
  }
  return manifest;
}

export async function loadFrameArtManifest() {
  const response = await fetch(FRAME_ART_URL, {cache: 'no-store'});
  if (!response.ok) throw new Error('无法读取实际中间画稿包。');
  return validateFrameArtManifest(await response.json());
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = async () => {
      if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) return reject(new Error(`中间稿尺寸不符：${source.src}`));
      try { if (typeof image.decode === 'function') await image.decode(); resolve(image); } catch { reject(new Error(`中间稿无法解码：${source.src}`)); }
    };
    image.onerror = () => reject(new Error(`中间稿无法加载：${source.src}`)); image.src = source.src;
  });
}
function path(context, points, origin = [0, 0]) {
  context.beginPath(); points.forEach(([x, y], index) => context[index ? 'lineTo' : 'moveTo'](x - origin[0], y - origin[1])); context.closePath();
}
function surface(width, height) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  return {canvas, context: canvas.getContext('2d')};
}
function compilePatch(image, patch) {
  const [x, y, width, height] = patch.rect, {canvas, context} = surface(width, height);
  path(context, patch.clip, patch.destination); context.clip();
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  if (patch.feather) {
    context.globalCompositeOperation = 'destination-in';
    for (const [x1, y1, extent] of [[width, 0, width], [0, height, height]]) {
      const gradient = context.createLinearGradient(0, 0, x1, y1);
      gradient.addColorStop(0, 'rgba(0,0,0,0)'); gradient.addColorStop(patch.feather / extent, '#000');
      gradient.addColorStop(1 - patch.feather / extent, '#000'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient; context.fillRect(0, 0, width, height);
    }
  }
  return canvas;
}
function compileCleanFrame(whiteImage, bounds, frame) {
  const {canvas, context} = surface(bounds[2], bounds[3]); context.translate(-bounds[0], -bounds[1]);
  path(context, frame.fragment); context.lineWidth = 7; context.lineJoin = 'round'; context.fill(); context.stroke();
  context.globalCompositeOperation = 'source-in'; context.drawImage(whiteImage, 0, 0);
  return {clean: canvas};
}
async function digestConfiguration(manifest) {
  const bytes = new TextEncoder().encode(JSON.stringify(frameBaseConfiguration(manifest)));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join('');
}

/** Must run before a studio loader releases full source portraits. Old compiled
 * eye/mouth/brow canvases and iris canvases are shared by identity, never altered. */
export async function extendFrameArtAssets(baseAssets, extension, family) {
  validateFrameArtManifest(extension, baseAssets, family);
  if (await digestConfiguration(baseAssets.manifest) !== extension.bases[family].configurationSha256) throw new Error('基础画稿配置已变化；不能套用旧中间稿登记。');
  const additions = Object.fromEntries(Object.entries(extension.sources).filter(([, source]) => FRAME_POSE_FAMILIES[source.pose] === family));
  const entries = await Promise.all(Object.entries(additions).map(async ([id, source]) => [id, await loadImage(source)]));
  const images = {...baseAssets.images, ...Object.fromEntries(entries)}, base = baseAssets.manifest;
  const poses = {...base.poses}, gazePoses = {...base.gaze.poses}, compiled = {...baseAssets.compiled}, gazeLayers = {...baseAssets.gazeLayers};
  for (const [poseId, extra] of Object.entries(extension.poses)) {
    if (extra.baseFamily !== family) continue;
    const pose = base.poses[poseId], gaze = base.gaze.poses[poseId];
    const patches = {...pose.patches}, compiledPose = {...baseAssets.compiled[poseId]}, eyes = {...gaze.eyes}, eyeLayers = {...baseAssets.gazeLayers[poseId]};
    for (const group of Object.keys(STATES)) {
      patches[group] = {...pose.patches[group], ...extra.patches[group]};
      compiledPose[group] = {...compiledPose[group], ...Object.fromEntries(Object.entries(extra.patches[group]).map(([state, patch]) => [state, compilePatch(images[patch.source], patch)]))};
    }
    const white = images[gaze.whiteSource];
    if (!white) throw new Error('需要在释放全图之前编译新眼裂的眼白。');
    for (const eye of EYES) {
      eyes[eye] = {...gaze.eyes[eye], frames: {...gaze.eyes[eye].frames, ...extra.gaze[eye]}};
      const previous = baseAssets.gazeLayers[poseId][eye];
      eyeLayers[eye] = {...previous, frames: {...previous.frames, ...Object.fromEntries(Object.entries(extra.gaze[eye]).map(([state, frame]) => [state, compileCleanFrame(white, previous.bounds, frame)]))}};
    }
    poses[poseId] = {...pose, patches}; compiled[poseId] = compiledPose;
    gazePoses[poseId] = {...gaze, eyes}; gazeLayers[poseId] = eyeLayers;
  }
  return {...baseAssets, manifest: {...base, id: `${base.id}+${extension.id}`, status: extension.status,
    sources: {...base.sources, ...additions}, poses, gaze: {...base.gaze, poses: gazePoses},
    frameArt: {id: extension.id, baseId: base.id, states: {eyes: ['quarter', 'threeQuarter'], mouth: ['parted', 'openMedium']}}},
    images, compiled, gazeLayers, frameArt: extension};
}
