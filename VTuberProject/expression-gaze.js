const EYES = ['eyeLeft', 'eyeRight'];
const STATES = ['open', 'quarter', 'half', 'threeQuarter'];
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const polygon = (p, w, h) => Array.isArray(p) && p.length >= 3 && p.every(v => point(v) && v[0] >= 0 && v[0] < w && v[1] >= 0 && v[1] < h);
const rect = (r, w, h) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= w && r[1] + r[3] <= h;

export function validateGazeManifest(manifest) {
  if (manifest.extensions?.gaze !== true) return;
  const g = manifest.gaze, w = manifest.width, h = manifest.height;
  if (!g || g.version !== 1 || !manifest.sources[g.whiteSource] || !manifest.sources[g.irisSource]
    || g.whiteSource === g.irisSource || !g.maxShift || ['x', 'up', 'down'].some(k => !Number.isFinite(g.maxShift[k]) || g.maxShift[k] <= 0 || g.maxShift[k] > 12)) throw new Error('独立视线素材或平移范围无效。');
  for (const eye of EYES) {
    const e = g.eyes?.[eye];
    if (!e || !rect(e.irisRect, w, h) || !rect(e.irisDestination, w, h)
      || Math.abs(e.irisRect[2] / e.irisRect[3] - e.irisDestination[2] / e.irisDestination[3]) > 1e-9) throw new Error('虹膜登记必须是固定等比尺寸。');
    if (!polygon(e.core, w, h)) throw new Error('缺少原画虹膜核心区域。');
    for (const state of STATES) {
      const f = e.frames?.[state];
      if (!f || !manifest.sources[f.source] || !polygon(f.aperture, w, h) || !polygon(f.fragment, w, h)) throw new Error('缺少逐眼逐档的视线遮罩。');
    }
    if (e.frames.closed) throw new Error('闭眼不应含可见虹膜。');
  }
  const l = g.eyes.eyeLeft.irisRect, r = g.eyes.eyeRight.irisRect;
  if (l[0] < r[0] + r[2] && l[0] + l[2] > r[0] && l[1] < r[1] + r[3] && l[1] + l[3] > r[1]) throw new Error('左右虹膜不能共用同一裁切。');
}

/** Elliptical travel limit; neither blink nor expression strength scales the iris. */
export function gazeOffset(input = {}, limits = {x: 10, up: 6, down: 5}) {
  const clamp = v => typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  let x = clamp(input?.x), y = clamp(input?.y);
  const length = Math.max(1, Math.hypot(x, y));
  x /= length; y /= length;
  return {x: x * limits.x, y: y * (y < 0 ? limits.up : limits.down)};
}

function path(c, points) {
  c.beginPath(); points.forEach(([x, y], i) => c[i ? 'lineTo' : 'moveTo'](x, y)); c.closePath();
}

function clearIris(c, points) {
  path(c, points);
  c.lineWidth = 7; c.lineJoin = 'round'; c.fill(); c.stroke();
}

export function compileGazeLayers(manifest, images) {
  if (manifest.extensions?.gaze !== true) return null;
  const g = manifest.gaze;
  return Object.fromEntries(EYES.map(eye => [eye, Object.fromEntries(STATES.map(state => {
    const e = g.eyes[eye], frame = e.frames[state];
    const bounds = eye === 'eyeLeft' ? [606, 448, 155, 116] : [347, 448, 167, 116];
    const canvas = document.createElement('canvas'); canvas.width = bounds[2]; canvas.height = bounds[3];
    const c = canvas.getContext('2d'); c.translate(-bounds[0], -bounds[1]);
    // One eyeball per eye, shared by every eyelid state. Retain only the
    // original iris interior, excluding fixed eyelid/limbal boundary pixels.
    // The complete painting supplies its edge and originally hidden arc.
    c.drawImage(images[g.irisSource], ...e.irisRect, ...e.irisDestination);
    const core = document.createElement('canvas'); core.width = bounds[2]; core.height = bounds[3];
    const kc = core.getContext('2d'); kc.translate(-bounds[0], -bounds[1]);
    kc.filter = 'blur(1px)'; path(kc, e.core); kc.fill(); kc.filter = 'none';
    kc.globalCompositeOperation = 'source-in'; kc.drawImage(images[manifest.reference], 0, 0);
    c.drawImage(core, bounds[0], bounds[1]);
    const clean = document.createElement('canvas'); clean.width = bounds[2]; clean.height = bounds[3];
    const cc = clean.getContext('2d'); cc.translate(-bounds[0], -bounds[1]); clearIris(cc, frame.fragment);
    cc.globalCompositeOperation = 'source-in'; cc.drawImage(images[g.whiteSource], 0, 0);
    return [state, {canvas, clean, bounds}];
  }))]));
}

export function drawGaze(c, assets, state, gaze) {
  const {manifest, images, gazeLayers} = assets;
  if (!gazeLayers) return;
  const g = manifest.gaze;
  for (const eye of EYES) {
    const eyeState = state?.[eye] || 'open', layer = gazeLayers[eye][eyeState];
    if (!layer) continue; // Closed eyelids have no aperture and never leak color.
    const offset = gazeOffset(gaze?.[eye], g.maxShift);
    const frame = g.eyes[eye].frames[eyeState];
    c.save(); path(c, frame.aperture); c.clip();
    // Keep existing sclera and foreground marks. Only clear the old iris.
    // The painted limbal edge is antialiased and extends beyond the visible
    // colored fragment. A small fixed dilation clears that dark edge too;
    // the outer aperture clip still protects all lids and lashes.
    c.drawImage(layer.clean, layer.bounds[0], layer.bounds[1]);
    c.drawImage(layer.canvas, layer.bounds[0] + offset.x, layer.bounds[1] + offset.y);
    c.restore();
  }
}
