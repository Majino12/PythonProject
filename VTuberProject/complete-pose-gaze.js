// Independently registered completion poses use the same native gaze layer
// format as the accepted renderer. The accepted pitch compiler is left frozen;
// no completion pose is relabeled as an older view and no eye is mirrored.
export const COMPLETE_POSE_IDS = Object.freeze(['view-up', 'view-down', 'view-right-down']);
const POSES = COMPLETE_POSE_IDS;
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
const localImage = /^\.\/assets\/[a-zA-Z0-9_./-]+\.png$/;

/** Checks only resource and registration integrity, not artistic quality. */
export function validateCompletePoseGazeManifest(manifest) {
  if (!object(manifest) || manifest.poseFamily !== 'completePitch' || manifest.width !== 1122 || manifest.height !== 1402
    || !object(manifest.poses) || Object.keys(manifest.poses).length !== POSES.length
    || POSES.some(id => !own(manifest.poses, id)) || !object(manifest.sources)) throw new Error('补全姿态视线需要三个独立登记的补全姿态。');
  if (manifest.gaze === undefined) return manifest;
  const g = manifest.gaze, w = manifest.width, h = manifest.height;
  if (!object(g) || g.version !== 1 || !object(g.poses) || Object.keys(g.poses).length !== POSES.length
    || POSES.some(id => !own(g.poses, id))) throw new Error('补全姿态视线需要三个角度的独立登记。');
  const expressionPaths = new Set(Object.values(manifest.poses).flatMap(pose => [
    manifest.sources[pose.reference]?.src,
    ...Object.values(pose.patches || {}).flatMap(states => Object.values(states).map(patch => manifest.sources[patch.source]?.src)),
  ]));
  const claimedPaths = new Set();
  for (const poseId of POSES) {
    const p = g.poses[poseId], pose = manifest.poses[poseId];
    if (!object(p) || !object(pose) || !object(p.eyes) || Object.keys(p.eyes).length !== EYES.length) throw new Error('补全姿态视线缺少对应底图或逐眼登记。');
    for (const sourceId of [p.whiteSource, p.irisSource]) {
      const source = own(manifest.sources, sourceId) ? manifest.sources[sourceId] : null;
      if (!source || source.pose !== poseId || source.width !== w || source.height !== h
        || !localImage.test(source.src) || source.src.split('/').includes('..')
        || claimedPaths.has(source.src) || expressionPaths.has(source.src)) throw new Error('补全姿态眼白与虹膜需要本角度独立于底图和表情稿的新源图。');
      claimedPaths.add(source.src);
    }
    for (const eye of EYES) {
      const e = own(p.eyes, eye) ? p.eyes[eye] : null;
      if (!object(e) || !rect(e.bounds, w, h) || !rect(e.irisRect, w, h) || !rect(e.irisDestination, w, h)
        || Math.abs(e.irisRect[2] / e.irisRect[3] - e.irisDestination[2] / e.irisDestination[3]) > 1e-9
        || !inside(e.irisDestination, e.bounds)
        || !inside([e.irisDestination[0] + e.irisDestination[2], e.irisDestination[1] + e.irisDestination[3]], e.bounds)
        || !polygon(e.core, e.bounds)) throw new Error('补全姿态虹膜裁切、固定等比登记或原画核心区域无效。');
      if (!object(e.maxShift) || ['x', 'up', 'down'].some(k => !Number.isFinite(e.maxShift[k]) || e.maxShift[k] <= 0 || e.maxShift[k] > 12)) throw new Error('补全姿态虹膜平移范围无效。');
      if (e.basis !== undefined && (!object(e.basis) || !point(e.basis.horizontal) || !point(e.basis.vertical)
        || e.basis.horizontal[0] !== 1 || Math.abs(e.basis.horizontal[1]) > .5
        || e.basis.vertical[0] !== 0 || e.basis.vertical[1] !== 1)) throw new Error('补全姿态眼轴仅允许有限斜度的平移方向。');
      if (!object(e.frames) || Object.keys(e.frames).length !== STATES.length) throw new Error('补全姿态视线只登记睁眼和半闭眼，闭眼不得显示虹膜。');
      for (const state of STATES) {
        const f = own(e.frames, state) ? e.frames[state] : null;
        const expected = state === 'open' ? pose.reference : pose.patches?.[eye]?.half?.source;
        if (!object(f) || !own(manifest.sources, f.source) || f.source !== expected || manifest.sources[f.source].pose !== poseId
          || !polygon(f.aperture, e.bounds) || !polygon(f.fragment, e.bounds)) throw new Error('补全姿态视线缺少本角度逐眼逐档的眼裂或旧虹膜遮罩。');
      }
    }
    if (overlaps(p.eyes.eyeLeft.irisRect, p.eyes.eyeRight.irisRect)
      || overlaps(p.eyes.eyeLeft.bounds, p.eyes.eyeRight.bounds)) throw new Error('补全姿态左右眼不能共用虹膜裁切或登记区域。');
  }
  return manifest;
}

function path(c, points) {
  c.beginPath(); points.forEach(([x, y], i) => c[i ? 'lineTo' : 'moveTo'](x, y)); c.closePath();
}
function surface(bounds) {
  const canvas = document.createElement('canvas'); canvas.width = bounds[2]; canvas.height = bounds[3];
  const context = canvas.getContext('2d'); context.translate(-bounds[0], -bounds[1]);
  return {canvas, context};
}

/** Same fixed layer construction as the frozen side compiler, with explicit
 * completion-pose ownership validation. One iris serves both visible eyelid states;
 * clean fragments are independent. drawSideGaze applies the aperture at draw. */
export function compileCompletePoseGazeLayers(manifest, images) {
  validateCompletePoseGazeManifest(manifest);
  if (manifest.gaze === undefined) return null;
  return Object.fromEntries(POSES.map(poseId => {
    const p = manifest.gaze.poses[poseId], pose = manifest.poses[poseId];
    return [poseId, Object.fromEntries(EYES.map(eye => {
      const e = p.eyes[eye], {canvas, context: c} = surface(e.bounds);
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
