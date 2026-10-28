import {CHANNELS, selectGaze} from './expression-model.js';

const POSES = ['view-left', 'view-right'];
const EYES = ['eyeLeft', 'eyeRight'];
const STATES = ['open', 'half'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (o, key) => object(o) && Object.hasOwn(o, key);
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const rect = (r, w, h) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
  && r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= w && r[1] + r[3] <= h;
const inside = (p, r) => p[0] >= r[0] && p[0] <= r[0] + r[2] && p[1] >= r[1] && p[1] <= r[1] + r[3];
const polygon = (p, bounds) => Array.isArray(p) && p.length >= 3 && p.every(v => point(v) && inside(v, bounds));
const overlaps = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];

export const SIDE_GAZE_CHANNELS = Object.freeze(CHANNELS.filter(({group}) => group === 'gaze'));
export const selectSideGaze = selectGaze;

/** Same ARKit anatomy as the approved front view; each pose owns its geometry. */
export function sanitizeSideGazeChannels(input) {
  const source = object(input) ? input : {};
  return Object.fromEntries(SIDE_GAZE_CHANNELS.map(({key}) => [key,
    own(source, key) && Number.isFinite(source[key]) ? Math.max(0, Math.min(1, source[key])) : 0,
  ]));
}

/** Resource and registration integrity only; this does not assert visual quality. */
export function validateSideGazeManifest(manifest) {
  if (manifest.gaze === undefined) return manifest;
  const g = manifest.gaze, w = manifest.width, h = manifest.height;
  if (!object(g) || g.version !== 1 || !object(g.poses) || Object.keys(g.poses).length !== POSES.length
    || POSES.some(id => !own(g.poses, id))) throw new Error('侧转视线需要两个角度的独立登记。');
  const claimedPaths = new Set();
  for (const poseId of POSES) {
    const p = g.poses[poseId], pose = manifest.poses?.[poseId];
    if (!object(p) || !pose || !object(p.eyes) || Object.keys(p.eyes).length !== EYES.length) throw new Error('侧转视线缺少对应底图或逐眼登记。');
    for (const sourceId of [p.whiteSource, p.irisSource]) {
      const source = own(manifest.sources, sourceId) ? manifest.sources[sourceId] : null;
      if (!source || source.pose !== poseId || sourceId === pose.reference
        || source.width !== w || source.height !== h || claimedPaths.has(source.src)
        || Object.values(manifest.poses).some(base => manifest.sources[base.reference]?.src === source.src)) throw new Error('侧转视线眼白与虹膜必须使用本角度的独立源图。');
      claimedPaths.add(source.src);
    }
    for (const eye of EYES) {
      const e = own(p.eyes, eye) ? p.eyes[eye] : null;
      if (!object(e) || !rect(e.bounds, w, h) || !rect(e.irisRect, w, h) || !rect(e.irisDestination, w, h)
        || Math.abs(e.irisRect[2] / e.irisRect[3] - e.irisDestination[2] / e.irisDestination[3]) > 1e-9
        || !inside(e.irisDestination, e.bounds)
        || !inside([e.irisDestination[0] + e.irisDestination[2], e.irisDestination[1] + e.irisDestination[3]], e.bounds)
        || !polygon(e.core, e.bounds)) throw new Error('侧转虹膜裁切、固定等比登记或原画核心区域无效。');
      if (!object(e.maxShift) || ['x', 'up', 'down'].some(k => !Number.isFinite(e.maxShift[k]) || e.maxShift[k] <= 0 || e.maxShift[k] > 12)) throw new Error('侧转虹膜平移范围无效。');
      // A local eye axis follows perspective without rotating or scaling pixels.
      // Horizontal x remains one canvas pixel; slope only changes its y component.
      if (e.basis !== undefined && (!object(e.basis) || !point(e.basis.horizontal) || !point(e.basis.vertical)
        || e.basis.horizontal[0] !== 1 || Math.abs(e.basis.horizontal[1]) > .5
        || e.basis.vertical[0] !== 0 || e.basis.vertical[1] !== 1)) throw new Error('侧转眼轴仅允许有限斜度的平移方向。');
      if (!object(e.frames) || Object.keys(e.frames).length !== STATES.length) throw new Error('侧转视线只应登记睁眼与半闭眼；闭眼不显示虹膜。');
      for (const state of STATES) {
        const f = own(e.frames, state) ? e.frames[state] : null;
        const expected = state === 'open' ? pose.reference : pose.patches?.[eye]?.half?.source;
        if (!object(f) || !own(manifest.sources, f.source) || f.source !== expected || manifest.sources[f.source].pose !== poseId
          || !polygon(f.aperture, e.bounds) || !polygon(f.fragment, e.bounds)) throw new Error('侧转视线缺少本角度逐眼逐档的眼裂或旧虹膜遮罩。');
      }
    }
    if (overlaps(p.eyes.eyeLeft.irisRect, p.eyes.eyeRight.irisRect)
      || overlaps(p.eyes.eyeLeft.bounds, p.eyes.eyeRight.bounds)) throw new Error('侧转左右眼不能共用虹膜裁切或登记区域。');
  }
  return manifest;
}

/** Elliptical local travel, then projection along the registered eye axis.
 * The iris image always retains its fixed registered dimensions. */
export function sideGazeOffset(input = {}, eye = {}) {
  const clamp = value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  let x = clamp(input?.x), y = clamp(input?.y);
  const length = Math.max(1, Math.hypot(x, y));
  const limits = eye.maxShift || {x: 8, up: 5, down: 4};
  x = x / length * limits.x; y = y / length * (y < 0 ? limits.up : limits.down);
  const basis = eye.basis || {horizontal: [1, 0], vertical: [0, 1]};
  return {x: x * basis.horizontal[0] + y * basis.vertical[0], y: x * basis.horizontal[1] + y * basis.vertical[1]};
}

function path(c, points) {
  c.beginPath(); points.forEach(([x, y], i) => c[i ? 'lineTo' : 'moveTo'](x, y)); c.closePath();
}

function surface(bounds) {
  const canvas = document.createElement('canvas'); canvas.width = bounds[2]; canvas.height = bounds[3];
  const context = canvas.getContext('2d'); context.translate(-bounds[0], -bounds[1]);
  return {canvas, context};
}

export function compileSideGazeLayers(manifest, images) {
  if (manifest.gaze === undefined) return null;
  validateSideGazeManifest(manifest);
  return Object.fromEntries(POSES.map(poseId => {
    const p = manifest.gaze.poses[poseId], pose = manifest.poses[poseId];
    return [poseId, Object.fromEntries(EYES.map(eye => {
      const e = p.eyes[eye], {canvas, context: c} = surface(e.bounds);
      // One complete iris for both visible eyelid states. The original open
      // iris interior keeps its pigment and highlights; the new painting only
      // supplies the edge and arcs that the approved eyelid had hidden.
      c.drawImage(images[p.irisSource], ...e.irisRect, ...e.irisDestination);
      const {canvas: core, context: kc} = surface(e.bounds);
      kc.filter = 'blur(1px)'; path(kc, e.core); kc.fill(); kc.filter = 'none';
      kc.globalCompositeOperation = 'source-in'; kc.drawImage(images[pose.reference], 0, 0);
      c.drawImage(core, e.bounds[0], e.bounds[1]);
      const frames = Object.fromEntries(STATES.map(state => {
        const {canvas: clean, context: cc} = surface(e.bounds);
        path(cc, e.frames[state].fragment); cc.lineWidth = 7; cc.lineJoin = 'round'; cc.fill(); cc.stroke();
        cc.globalCompositeOperation = 'source-in'; cc.drawImage(images[p.whiteSource], 0, 0);
        return [state, {clean}];
      }));
      return [eye, {canvas, bounds: e.bounds, frames}];
    }))];
  }));
}

export function drawSideGaze(c, assets, poseId, state, gaze) {
  if (!own(assets.gazeLayers, poseId)) return;
  const p = assets.manifest.gaze.poses[poseId], layers = assets.gazeLayers[poseId];
  for (const eye of EYES) {
    const eyeState = state?.[eye] || 'open', layer = layers[eye];
    if (!own(layer.frames, eyeState)) continue;
    const frame = p.eyes[eye].frames[eyeState], offset = sideGazeOffset(gaze?.[eye], p.eyes[eye]);
    c.save(); path(c, frame.aperture); c.clip();
    // The clip protects eyelids, lashes and foreground bangs. Only the old
    // iris fragment is cleared; all other sclera pixels stay in their artwork.
    c.drawImage(layer.frames[eyeState].clean, layer.bounds[0], layer.bounds[1]);
    c.drawImage(layer.canvas, layer.bounds[0] + offset.x, layer.bounds[1] + offset.y);
    c.restore();
  }
}
