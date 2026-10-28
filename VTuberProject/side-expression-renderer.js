import {validateSideGazeManifest, compileSideGazeLayers, drawSideGaze} from './side-gaze.js';
import {validatePitchGazeManifest} from './pitch-gaze.js';
import {preparePitchGazeLayers} from './pitch-gaze-snapshot.js';
import {COMPLETE_POSE_IDS, validateCompletePoseGazeManifest} from './complete-pose-gaze.js';
import {prepareCompletePoseGazeLayers} from './complete-pose-gaze-snapshot.js';
import {SIDE_MOUTH_STATES} from './side-mouth-model.js';
import {SIDE_BROW_STATES} from './side-brow-model.js';
import {validateBrowExclusion, rasterizeBrowExclusion} from './side-brow-exclusion.js';

const MANIFEST_URLS = Object.freeze({
  approved: './assets/short-hair-side-expressions-v1/manifest.json',
  gaze: './assets/short-hair-side-gaze-v1/manifest.json',
  mouth: './assets/short-hair-side-mouth-v1/manifest.json',
  brows: './assets/short-hair-side-brows-v1/manifest.json',
  pitch: './assets/short-hair-pitch-expressions-v1/manifest.json',
  pitchGaze: './assets/short-hair-pitch-gaze-v1/manifest.json',
  pitchMouth: './assets/short-hair-pitch-mouth-v1/manifest.json',
  pitchBrows: './assets/short-hair-pitch-brows-v1/manifest.json',
  completePitch: './assets/short-hair-complete-poses-v1/manifest.json',
});
const POSES = ['view-left', 'view-right'];
const PITCH_POSES = ['view-left-up', 'view-right-up', 'view-left-down'];
const GROUPS = ['eyeLeft', 'eyeRight', 'mouth'];
const BROW_GROUPS = ['browLeft', 'browRight'];
const groupsFor = manifest => manifest.browArt === undefined ? GROUPS : [...GROUPS, ...BROW_GROUPS];
const REQUIRED = {eyeLeft: ['half', 'closed'], eyeRight: ['half', 'closed'], mouth: ['openSmall', 'openWide']};
const localImage = /^\.\/assets\/[a-zA-Z0-9_./-]+\.png$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const samePoint = (a, b) => point(a) && point(b) && a.every((value, i) => value === b[i]);
const rect = (r, w, h) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
  && r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= w && r[1] + r[3] <= h;
const inside = (p, r) => p[0] >= r[0] && p[0] <= r[0] + r[2] && p[1] >= r[1] && p[1] <= r[1] + r[3];
const own = (o, key) => object(o) && Object.hasOwn(o, key);
const overlaps = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];

/** Checks registration and distinct pose resources, never artistic quality.
 * All local patches retain their source scale. Each pose has its own anatomy,
 * source ownership, clipping, and upper-lip anchor; there is no shared eye axis. */
export function validateSideExpressionManifest(manifest) {
  const pitch = object(manifest) && manifest.poseFamily === 'pitch';
  const completion = object(manifest) && manifest.poseFamily === 'completePitch';
  const poses = completion ? COMPLETE_POSE_IDS : pitch ? PITCH_POSES : POSES;
  if (!object(manifest) || manifest.version !== 1 || typeof manifest.id !== 'string' || !manifest.id
    || (manifest.poseFamily !== undefined && !pitch && !completion)
    || manifest.width !== 1122 || manifest.height !== 1402 || !object(manifest.sources) || !object(manifest.poses)
    || Object.keys(manifest.poses).length !== poses.length || poses.some(id => !own(manifest.poses, id))) throw new Error('侧转表情画稿清单无效。');
  if (completion && (manifest.gaze === undefined || manifest.mouthArt === undefined || manifest.browArt === undefined)) throw new Error('补全姿态需要完整的视线、嘴型和眉毛登记。');
  // Each pitch extension retains its accepted predecessors. The gaze compiler
  // remains unchanged; brow sources are separate pose-owned local paintings.
  if (pitch && manifest.browArt !== undefined && (manifest.gaze === undefined || manifest.mouthArt === undefined)) throw new Error('斜向眉毛需要保留已登记的视线与嘴型素材。');
  if (pitch && manifest.mouthArt !== undefined && manifest.gaze === undefined) throw new Error('斜向嘴型需要保留已登记的视线素材。');
  const mouthArt = manifest.mouthArt;
  if (mouthArt !== undefined && (!object(mouthArt) || Object.keys(mouthArt).length !== 2 || !own(mouthArt, 'version') || !own(mouthArt, 'states')
    || mouthArt.version !== 1 || !Array.isArray(mouthArt.states) || mouthArt.states.length !== SIDE_MOUTH_STATES.length
    || new Set(mouthArt.states).size !== SIDE_MOUTH_STATES.length || SIDE_MOUTH_STATES.some(state => !mouthArt.states.includes(state)))) throw new Error('侧转嘴型扩展需要完整、明确的四种独立画稿。');
  const browArt = manifest.browArt;
  if (browArt !== undefined && (!object(browArt) || Object.keys(browArt).length !== 2 || !own(browArt, 'version') || !own(browArt, 'states')
    || browArt.version !== 1 || !Array.isArray(browArt.states) || browArt.states.length !== SIDE_BROW_STATES.length
    || new Set(browArt.states).size !== SIDE_BROW_STATES.length || SIDE_BROW_STATES.some(state => !browArt.states.includes(state)))) throw new Error('侧转眉毛扩展需要完整、明确的三种独立画稿。');
  const groups = groupsFor(manifest);
  for (const source of Object.values(manifest.sources)) {
    if (!object(source) || !localImage.test(source.src) || source.src.split('/').includes('..')
      || source.width !== manifest.width || source.height !== manifest.height || !poses.includes(source.pose)) throw new Error('侧转源图路径、尺寸或所属角度无效。');
  }
  const claimedPaths = new Map();
  for (const [poseId, pose] of Object.entries(manifest.poses)) {
    if (!object(pose) || typeof pose.label !== 'string' || !pose.label || typeof pose.directionNote !== 'string'
      || !own(manifest.sources, pose.reference) || manifest.sources[pose.reference].pose !== poseId
      || !rect(pose.faceView, manifest.width, manifest.height) || !point(pose.mouthReference)
      || !inside(pose.mouthReference, pose.faceView) || !object(pose.patches)) throw new Error(`${poseId} 缺少独立底图、查看范围或口部锚点。`);
    if (pose.detailViews !== undefined && (!object(pose.detailViews) || Object.entries(pose.detailViews).some(([name, r]) => !['eyes', 'mouth', 'brows'].includes(name) || !rect(r, manifest.width, manifest.height)))) throw new Error('侧转局部查看范围无效。');
    if (Object.keys(pose.patches).length !== groups.length || groups.some(group => !own(pose.patches, group))) throw new Error('侧转局部画稿组与已声明的扩展不一致。');
    const usedSources = new Set([pose.reference]);
    for (const group of groups) {
      const states = pose.patches[group];
      const required = BROW_GROUPS.includes(group) ? SIDE_BROW_STATES
        : group === 'mouth' && mouthArt !== undefined ? [...REQUIRED.mouth, ...SIDE_MOUTH_STATES] : REQUIRED[group];
      if (!object(states) || Object.keys(states).length !== required.length || required.some(state => !own(states, state))) throw new Error(`${poseId} 缺少 ${group} 实际画稿。`);
      for (const [state, p] of Object.entries(states)) {
        if (!object(p) || !own(manifest.sources, p.source) || manifest.sources[p.source].pose !== poseId || p.source === pose.reference
          || !rect(p.rect, manifest.width, manifest.height) || !rect(p.destination, manifest.width, manifest.height)
          || p.rect[2] !== p.destination[2] || p.rect[3] !== p.destination[3] || p.transform !== 'translation-only'
          || !Number.isFinite(p.feather) || p.feather < 0 || p.feather * 2 >= Math.min(p.rect[2], p.rect[3])) throw new Error(`${poseId} ${group} 裁切或画稿登记无效。`);
        usedSources.add(p.source);
        if (p.anchor !== undefined && (!object(p.anchor) || !point(p.anchor.source) || !point(p.anchor.destination)
          || !inside(p.anchor.source, p.rect) || !inside(p.anchor.destination, p.destination)
          || !p.anchor.source.every((value, i) => value + p.destination[i] - p.rect[i] === p.anchor.destination[i]))) throw new Error('锚点与侧转画稿登记不一致。');
        if (group === 'mouth') {
          if (p.anchor?.kind !== 'upper-lip') throw new Error('侧转嘴型需要上唇锚点。');
          if (state === 'shiftLeft' || state === 'shiftRight') {
            const dx = p.anchor.destination[0] - pose.mouthReference[0];
            if (p.anchor.destination[1] !== pose.mouthReference[1] || Math.abs(dx) > 24
              || (state === 'shiftLeft' ? dx <= 0 : dx >= 0)) throw new Error('移嘴画稿需要方向正确、有限且高度稳定的独立上唇登记。');
          } else if (!samePoint(p.anchor.destination, pose.mouthReference)) throw new Error('同角度非移嘴画稿需要共用上唇锚点。');
        }
        if (p.clip !== undefined && (!Array.isArray(p.clip) || p.clip.length < 3 || p.clip.some(pt => !point(pt) || !inside(pt, p.destination)))) throw new Error('侧转局部遮罩超出裁切区域。');
        validateBrowExclusion(p, group);
      }
      const sourcePaths = Object.values(states).map(p => manifest.sources[p.source].src);
      if (new Set(sourcePaths).size !== sourcePaths.length || sourcePaths.includes(manifest.sources[pose.reference].src)) throw new Error('各表情需要独立于中性及其他状态的源画稿。');
    }
    if (browArt !== undefined) {
      for (const state of SIDE_BROW_STATES) {
        const left = pose.patches.browLeft[state], right = pose.patches.browRight[state];
        if (left.source !== right.source || overlaps(left.rect, right.rect)) throw new Error('同角度同状态的左右眉需要从独立双眉源稿分别裁切。');
      }
      for (const left of Object.values(pose.patches.browLeft)) for (const right of Object.values(pose.patches.browRight)) {
        if (left.destination[0] < right.destination[0] + right.destination[2]) throw new Error('角色左眉应位于画面右侧，左右眉区域不可交叠。');
      }
      for (const group of BROW_GROUPS) for (const brow of Object.values(pose.patches[group])) for (const mouth of Object.values(pose.patches.mouth)) {
        if (overlaps(brow.destination, mouth.destination)) throw new Error('眉部局部画稿不可覆盖口部。');
      }
    }
    for (const sourceId of usedSources) {
      const path = manifest.sources[sourceId].src;
      if (claimedPaths.has(path) && claimedPaths.get(path) !== poseId) throw new Error('左右角度不能复用或镜像同一张画稿。');
      claimedPaths.set(path, poseId);
    }
  }
  if (completion) validateCompletePoseGazeManifest(manifest);
  else if (pitch) validatePitchGazeManifest(manifest);
  else validateSideGazeManifest(manifest);
  return manifest;
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = async () => {
      if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) {
        reject(new Error(`画稿尺寸不匹配：${source.src}`)); return;
      }
      try {
        // onload makes the image available; wait for decoding before the first
        // fixed iris resample and local canvas compilation. Older image hosts
        // without decode retain the existing load behavior.
        if (typeof image.decode === 'function') await image.decode();
        resolve(image);
      } catch { reject(new Error(`画稿无法解码：${source.src}`)); }
    };
    image.onerror = () => reject(new Error(`画稿无法加载：${source.src}`));
    image.src = source.src;
  });
}

function compilePatch(image, patch) {
  const canvas = document.createElement('canvas');
  const [x, y, w, h] = patch.rect;
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d');
  if (patch.clip) {
    c.beginPath();
    patch.clip.forEach(([px, py], i) => c[i === 0 ? 'moveTo' : 'lineTo'](px - patch.destination[0], py - patch.destination[1]));
    c.closePath(); c.clip();
  }
  // Fixed-size, opaque interior. Only the skin boundary feathers into the base;
  // there is no image-scale change or crossfade between expression states.
  c.drawImage(image, x, y, w, h, 0, 0, w, h);
  if (patch.feather) {
    c.globalCompositeOperation = 'destination-in';
    for (const [x0, y0, x1, y1, extent] of [[0, 0, w, 0, w], [0, 0, 0, h, h]]) {
      const g = c.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(patch.feather / extent, '#000');
      g.addColorStop(1 - patch.feather / extent, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    }
  }
  if (patch.exclude !== undefined) {
    // Fixed, inward-only alpha reduction restores the already rendered layer
    // underneath a local hair junction. It never paints new pixels or expands
    // the outer clip, and is compiled once rather than animated with signals.
    const mask = document.createElement('canvas'); mask.width = canvas.width; mask.height = canvas.height;
    const mc = mask.getContext('2d'), pixels = mc.createImageData(mask.width, mask.height);
    const alpha = rasterizeBrowExclusion(mask.width, mask.height, patch.destination, patch.exclude, patch.excludeFeather);
    for (let i = 0; i < alpha.length; i++) pixels.data[i * 4 + 3] = alpha[i];
    mc.putImageData(pixels, 0, 0);
    c.save(); c.globalCompositeOperation = 'destination-in'; c.drawImage(mask, 0, 0); c.restore();
  }
  return canvas;
}

export async function loadSideExpressionAssets(variant = 'approved') {
  if (!own(MANIFEST_URLS, variant)) throw new Error('未知的侧转画稿版本。');
  const response = await fetch(MANIFEST_URLS[variant], {cache: 'no-store'});
  if (!response.ok) throw new Error('无法读取侧转表情画稿清单。');
  const manifest = validateSideExpressionManifest(await response.json());
  const pitch = manifest.poseFamily === 'pitch';
  const completion = manifest.poseFamily === 'completePitch';
  if ((variant === 'completePitch') !== completion) throw new Error('画稿姿态系列与请求版本不一致。');
  if (['pitch', 'pitchGaze', 'pitchMouth', 'pitchBrows'].includes(variant) !== pitch) throw new Error('画稿姿态系列与请求版本不一致。');
  if (pitch && (((variant !== 'pitch') !== (manifest.gaze !== undefined))
    || (['pitchMouth', 'pitchBrows'].includes(variant) !== (manifest.mouthArt !== undefined))
    || ((variant === 'pitchBrows') !== (manifest.browArt !== undefined)))) throw new Error('斜向基础、视线、嘴型与眉毛版本的能力不一致。');
  const entries = await Promise.all(Object.entries(manifest.sources).map(async ([key, source]) => [key, await loadImage(source)]));
  const images = Object.fromEntries(entries);
  // Materialize inherited pitch eyes before adding new mouth/brow canvases, so
  // extra expression patches cannot alter their first rasterization order.
  const pitchGazeLayers = pitch ? await preparePitchGazeLayers(manifest, images)
    : completion ? await prepareCompletePoseGazeLayers(manifest, images) : null;
  const compiled = Object.fromEntries(Object.entries(manifest.poses).map(([poseId, pose]) => [poseId,
    Object.fromEntries(groupsFor(manifest).map(group => [group, Object.fromEntries(Object.entries(pose.patches[group]).map(([state, patch]) => [state, compilePatch(images[patch.source], patch)]))])),
  ]));
  return {manifest, images, compiled, gazeLayers: pitch || completion ? pitchGazeLayers : compileSideGazeLayers(manifest, images)};
}

export function drawSideExpression(canvas, assets, poseId, state, options = {}) {
  const {manifest, images, compiled} = assets;
  if (!own(manifest.poses, poseId)) throw new Error('未知的侧转画稿角度。');
  const pose = manifest.poses[poseId];
  const detail = own(pose.detailViews, options.detail) ? pose.detailViews[options.detail] : null;
  const view = detail || (options.faceOnly === false ? [0, 0, manifest.width, manifest.height] : pose.faceView);
  if (canvas.width !== view[2]) canvas.width = view[2];
  if (canvas.height !== view[3]) canvas.height = view[3];
  const c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, canvas.width, canvas.height);
  c.save(); c.translate(-view[0], -view[1]);
  c.drawImage(images[pose.reference], 0, 0);
  if (!options.original) {
    // Eye crops include some forehead skin. Apply brows after those crops so
    // they cannot paint the old brow back over a registered lowered brow.
    // The brow's own fixed clip protects visible eyelids and foreground hair.
    for (const group of groupsFor(manifest)) {
      const key = state?.[group];
      if (!own(pose.patches[group], key)) continue;
      const patch = pose.patches[group][key];
      c.drawImage(compiled[poseId][group][key], patch.destination[0], patch.destination[1]);
    }
    drawSideGaze(c, assets, poseId, state, options.gaze);
  }
  if (options.guides) {
    const [x, y] = pose.mouthReference;
    c.strokeStyle = '#117e97'; c.lineWidth = 1.5; c.setLineDash([5, 4]);
    c.beginPath(); c.moveTo(x - 80, y); c.lineTo(x + 80, y); c.stroke();
    c.setLineDash([]); c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.stroke();
    c.font = '13px system-ui'; c.fillStyle = '#11647b'; c.fillText('此角度上唇参考', x + 85, y - 8);
    c.globalAlpha = .6; c.setLineDash([3, 5]);
    for (const group of groupsFor(manifest)) {
      const key = state?.[group];
      if (own(pose.patches[group], key) && !options.original) c.strokeRect(...pose.patches[group][key].destination);
    }
  }
  c.restore();
}
