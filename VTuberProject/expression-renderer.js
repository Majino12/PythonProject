import {validateGazeManifest, compileGazeLayers, drawGaze} from './expression-gaze.js';
const ASSET_URLS = Object.freeze({approved: './assets/short-hair-expressions-v1/manifest.json', motion: './assets/short-hair-expressions-v2/manifest.json', candidate: './assets/short-hair-gaze-v1/manifest.json'});
const GROUPS = ['eyeLeft', 'eyeRight', 'browLeft', 'browRight', 'mouth'];
const REQUIRED = {eyeLeft: ['half', 'closed'], eyeRight: ['half', 'closed'], browLeft: ['up', 'down'], browRight: ['up', 'down'], mouth: ['openSmall', 'openWide', 'pucker', 'press']};
const localImage = /^\.\/assets\/[a-zA-Z0-9_./-]+\.png$/;
const finiteRect = (r, w, h) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
  && r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= w && r[1] + r[3] <= h;

/** Geometry checks protect the source artwork, but cannot establish visual quality. */
export function validateExpressionManifest(manifest) {
  if (!manifest || manifest.version !== 1 || typeof manifest.id !== 'string'
    || manifest.width !== 1122 || manifest.height !== 1402 || !manifest.sources || !manifest.patches) throw new Error('表情画稿清单无效。');
  for (const source of Object.values(manifest.sources)) {
    if (!localImage.test(source.src) || source.src.split('/').includes('..') || source.width !== manifest.width || source.height !== manifest.height) throw new Error('表情源图路径或尺寸无效。');
  }
  if (!manifest.sources[manifest.reference] || !finiteRect(manifest.faceView, manifest.width, manifest.height)) throw new Error('缺少原画或脸部查看区域。');
  for (const group of GROUPS) {
    if (!manifest.patches[group] || REQUIRED[group].some(state => !manifest.patches[group][state])) throw new Error(`缺少 ${group} 画稿。`);
    for (const p of Object.values(manifest.patches[group])) {
      if (!manifest.sources[p.source] || !finiteRect(p.rect, manifest.width, manifest.height)
        || !finiteRect(p.destination, manifest.width, manifest.height)
        || p.rect[2] !== p.destination[2] || p.rect[3] !== p.destination[3]
        || p.transform !== 'translation-only' || !Number.isFinite(p.feather) || p.feather < 0
        || p.feather * 2 >= Math.min(p.rect[2], p.rect[3])) throw new Error(`${group} 裁切或锚点配置无效。`);
      if (p.anchor) {
        for (const point of [p.anchor.source, p.anchor.destination]) {
          if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) throw new Error('锚点不是有限二维坐标。');
        }
        if (p.anchor.source.some((v, i) => v + p.destination[i] - p.rect[i] !== p.anchor.destination[i])) throw new Error('锚点与画稿登记不一致。');
      }
      if (p.clip && (!Array.isArray(p.clip) || p.clip.length < 3 || p.clip.some(pt => !Array.isArray(pt) || pt.length !== 2 || !pt.every(Number.isFinite)
        || pt[0] < p.destination[0] || pt[0] > p.destination[0] + p.destination[2] || pt[1] < p.destination[1] || pt[1] > p.destination[1] + p.destination[3]))) throw new Error('局部遮罩超出裁切区域。');
    }
  }
  if (manifest.extensions?.eyes === true && ['eyeLeft', 'eyeRight'].some(group => ['quarter', 'threeQuarter'].some(state => !manifest.patches[group][state]))) throw new Error('五档眼睑缺少实际中间画稿。');
  if (manifest.extensions?.jaw === true && ['parted', 'openMedium'].some(state => !manifest.patches.mouth[state])) throw new Error('五档张嘴缺少实际中间画稿。');
  validateGazeManifest(manifest);
  return manifest;
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.naturalWidth === source.width && image.naturalHeight === source.height
      ? resolve(image) : reject(new Error(`画稿尺寸不匹配：${source.src}`));
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
  // The source and destination rectangles have identical dimensions. Expressions
  // select distinct paintings; opacity at the fixed boundary blends only skin.
  c.drawImage(image, x, y, w, h, 0, 0, w, h);
  if (patch.feather) {
    c.globalCompositeOperation = 'destination-in';
    for (const [x0, y0, x1, y1, extent] of [[0, 0, w, 0, w], [0, 0, 0, h, h]]) {
      const g = c.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(patch.feather / extent, '#000');
      g.addColorStop(1 - patch.feather / extent, '#000');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    }
  }
  return canvas;
}

export async function loadExpressionAssets({variant = 'candidate'} = {}) {
  if (!Object.hasOwn(ASSET_URLS, variant)) throw new Error('未知的画稿版本。');
  const response = await fetch(ASSET_URLS[variant], {cache: 'no-store'});
  if (!response.ok) throw new Error('无法读取表情画稿清单。');
  const manifest = validateExpressionManifest(await response.json());
  const entries = await Promise.all(Object.entries(manifest.sources).map(async ([key, source]) => [key, await loadImage(source)]));
  const images = Object.fromEntries(entries);
  const compiled = Object.fromEntries(GROUPS.map(group => [group, Object.fromEntries(
    Object.entries(manifest.patches[group]).map(([state, patch]) => [state, compilePatch(images[patch.source], patch)]))]));
  const left = manifest.patches.mouth.shiftLeft, right = manifest.patches.mouth.shiftRight;
  const independent = left && right && left.source !== right.source
    && manifest.sources[left.source].src !== manifest.sources[right.source].src;
  const gazeLayers = compileGazeLayers(manifest, images);
  return {manifest, images, compiled, gazeLayers, available: {shiftLeft: Boolean(independent), shiftRight: Boolean(independent), extendedEyes: manifest.extensions?.eyes === true, extendedJaw: manifest.extensions?.jaw === true, gaze: Boolean(gazeLayers)}};
}

export function drawExpression(canvas, assets, state, options = {}) {
  const {manifest, images, compiled} = assets;
  const detailViews = {eyes: [330, 440, 450, 125], mouth: [465, 640, 205, 105]};
  const view = detailViews[options.detail] || (options.faceOnly === false ? [0, 0, manifest.width, manifest.height] : manifest.faceView);
  if (canvas.width !== view[2]) canvas.width = view[2];
  if (canvas.height !== view[3]) canvas.height = view[3];
  const c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, canvas.width, canvas.height);
  c.save(); c.translate(-view[0], -view[1]);
  c.drawImage(images[manifest.reference], 0, 0);
  if (!options.original) {
    for (const group of GROUPS) {
      const patch = manifest.patches[group][state?.[group]];
      if (!patch) continue; // Neutral always uses the exact approved illustration.
      c.drawImage(compiled[group][state[group]], patch.destination[0], patch.destination[1]);
    }
    drawGaze(c, assets, state, options.gaze);
  }
  if (options.guides) {
    c.strokeStyle = '#117e97'; c.lineWidth = 1.5; c.setLineDash([5, 4]);
    c.beginPath(); c.moveTo(470, manifest.mouthReference[1]); c.lineTo(654, manifest.mouthReference[1]); c.stroke();
    c.setLineDash([]); c.beginPath(); c.arc(...manifest.mouthReference, 3, 0, Math.PI * 2); c.stroke();
    c.font = '13px system-ui'; c.fillStyle = '#11647b'; c.fillText('上唇参考', 650, manifest.mouthReference[1] - 8);
    c.globalAlpha = .6; c.setLineDash([3, 5]);
    for (const group of GROUPS) {
      const p = manifest.patches[group][state?.[group]];
      if (p && !options.original) c.strokeRect(...p.destination);
    }
  }
  c.restore();
}
