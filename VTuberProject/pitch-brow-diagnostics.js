import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const host = document.querySelector('#comparisons'), output = document.querySelector('#result'), summary = document.querySelector('#summary');
const loadOrder = new URLSearchParams(location.search).get('load') === 'brows-first' ? 'brows-first' : 'parallel';
document.querySelector('#loadOrder').textContent = loadOrder === 'brows-first'
  ? '加载顺序：先完整载入眉毛候选，再载入已确认嘴型；模拟默认眉毛页首次加载。'
  : '加载顺序：眉毛候选与已确认嘴型并行载入。';
const POSES = ['view-left-up', 'view-right-up', 'view-left-down'];
const BROWS = ['neutral', 'innerUp', 'outerUp', 'down'];
const MOUTHS = ['neutral', 'openSmall', 'openWide', 'pucker', 'press', 'shiftLeft', 'shiftRight'];
const EYES = [
  {id: 'open', eyeLeft: 'open', eyeRight: 'open'}, {id: 'half', eyeLeft: 'half', eyeRight: 'half'},
  {id: 'closed', eyeLeft: 'closed', eyeRight: 'closed'}, {id: 'winkLeft', eyeLeft: 'closed', eyeRight: 'open'},
  {id: 'winkRight', eyeLeft: 'open', eyeRight: 'closed'},
];
const DIRECTIONS = [{id: 'center', x: 0, y: 0}, {id: 'up-left', x: -1, y: -1}, {id: 'down-right', x: 1, y: 1}];
// Every brow pair is exercised with all seven mouths; the seven contexts also
// cover all eyelid states and both extreme diagonal gaze directions.
const CONTEXTS = MOUTHS.map((mouth, i) => ({mouth, eyes: EYES[i % EYES.length], direction: DIRECTIONS[i % DIRECTIONS.length]}));
const PAIRS = BROWS.flatMap(browLeft => BROWS.map(browRight => ({browLeft, browRight})));
const neutral = {eyeLeft: 'open', eyeRight: 'open', mouth: 'neutral', browLeft: 'neutral', browRight: 'neutral'};
const REQUIRED_PROTECTION = ['eyes', 'mouth', 'nose', 'hair'];
// Diagnostic-only native crops surround the thin forehead strand where brow
// patch boundaries were visually inspected. Every state uses the same pixels;
// enlargement is presentation-only and never enters the character renderer.
const HAIR_JUNCTIONS = {
  'view-left-up': [532, 334, 52, 48],
  'view-left-down': [532, 477, 52, 48],
};
const nativeCanvas = document.createElement('canvas');
const nativeContext = nativeCanvas.getContext('2d', {willReadFrequently: true});
const gaze = ({x, y}) => ({eyeLeft: {x, y}, eyeRight: {x, y}});
const inside = ([left, top, width, height], x, y) => x >= left && x < left + width && y >= top && y < top + height;

function render(assets, pose, state, direction, options = {}, canvas = document.createElement('canvas')) {
  drawSideExpression(canvas, assets, pose, state, {gaze: gaze(direction), ...options}); return canvas;
}
function pixels(assets, pose, state, direction, options = {}) {
  render(assets, pose, state, direction, {...options, faceOnly: false}, nativeCanvas);
  if (nativeCanvas.width !== assets.manifest.width || nativeCanvas.height !== assets.manifest.height) throw new Error('原生像素检查不可缩放。');
  return nativeContext.getImageData(0, 0, nativeCanvas.width, nativeCanvas.height).data;
}
function card(parent, canvas, label) {
  const figure = document.createElement('figure'), caption = document.createElement('figcaption');
  canvas.setAttribute('aria-label', label); caption.textContent = label; figure.append(canvas, caption); parent.append(figure);
}
function detail(assets, pose, state, view) {
  const full = render(assets, pose, state, DIRECTIONS[0], {faceOnly: false}, nativeCanvas);
  const canvas = document.createElement('canvas'); canvas.width = view[2]; canvas.height = view[3];
  canvas.getContext('2d').drawImage(full, ...view, 0, 0, view[2], view[3]); return canvas;
}
function hairJunctions(assets, pose, meta) {
  const view = HAIR_JUNCTIONS[pose];
  if (!view) return null;
  const section = document.createElement('details'); section.id = `junction-${pose}`;
  const title = document.createElement('summary'); title.textContent = `${meta.label} · 刘海细发交界（原生像素放大 4 倍）`;
  const note = document.createElement('p');
  note.textContent = `固定裁切 x=${view[0]}、y=${view[1]}、宽 ${view[2]}、高 ${view[3]}。四种状态共用同一区域，以最近邻放大 4 倍显示；可检查发丝是否连续、边缘是否跳动。`;
  const row = document.createElement('div'); row.className = 'junctions';
  for (const [state, label] of [['neutral', '中性'], ['innerUp', '眉头抬起'], ['outerUp', '眉尾抬起'], ['down', '压眉']]) {
    const canvas = detail(assets, pose, {...neutral, browLeft: state, browRight: state}, view);
    canvas.dataset.pose = pose; canvas.dataset.browState = state; canvas.dataset.sourceRect = JSON.stringify(view);
    canvas.style.width = `${view[2] * 4}px`; canvas.style.height = `${view[3] * 4}px`;
    card(row, canvas, `${label} · 4×`);
  }
  section.append(title, note, row); host.append(section);
  return {sourceRect: view, canvasSize: view.slice(2), displayScale: 4, interpolation: 'nearest-neighbor CSS pixelated',
    states: BROWS, selector: `#${section.id}`};
}
function path(context, polygon) {
  context.beginPath(); polygon.forEach(([x, y], i) => context[i ? 'lineTo' : 'moveTo'](x, y)); context.closePath();
}
function polygonMask(width, height, polygons, boundary = 0) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  for (const polygon of polygons) {
    path(context, polygon); context.fill();
    if (boundary) {context.lineWidth = boundary * 2; context.lineJoin = 'round'; context.stroke();}
  }
  const data = context.getImageData(0, 0, width, height).data, mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] ? 1 : 0;
  return mask;
}
function protectionMask(width, height, regions) {
  for (const name of REQUIRED_PROTECTION) if (!Array.isArray(regions?.[name]) || !regions[name].length) throw new Error(`缺少 ${name} 保护区，不能跳过此项检查。`);
  const entries = Object.entries(regions);
  if (entries.length > 8) throw new Error('保护区类别超出诊断位图范围。');
  const mask = new Uint8Array(width * height);
  entries.forEach(([name, polygons], index) => {
    if (!Array.isArray(polygons) || polygons.some(p => !Array.isArray(p) || p.length < 3 || p.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)))) throw new Error(`${name} 保护多边形无效。`);
    const local = polygonMask(width, height, polygons);
    for (let i = 0; i < mask.length; i++) if (local[i]) mask[i] |= 1 << index;
  });
  return {mask, names: entries.map(([name]) => name)};
}
function difference(a, b, width, allowedRects, clipMask, protection) {
  if (a.length !== b.length || a.length % (width * 4)) throw new Error('待比较原生画布尺寸不一致。');
  let changed = 0, outsideRect = 0, outsideClip = 0, maxDelta = 0;
  const protectedChanged = Object.fromEntries(protection.names.map(name => [name, 0]));
  for (let i = 0; i < a.length; i += 4) {
    const delta = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (!delta) continue;
    changed++; maxDelta = Math.max(maxDelta, delta);
    const pixel = i / 4, x = pixel % width, y = Math.floor(pixel / width);
    if (!allowedRects?.some(rect => inside(rect, x, y))) outsideRect++;
    if (clipMask && !clipMask[pixel]) outsideClip++;
    const flags = protection.mask[pixel];
    if (flags) protection.names.forEach((name, index) => {if (flags & (1 << index)) protectedChanged[name]++;});
  }
  return {changed, outsideRect, outsideClip, maxDelta, protectedChanged};
}
function inspectInheritedLayers(candidate, approved) {
  const result = {note: 'Immutable gaze snapshots may intentionally share source identity. Every source is copied at native scale into a private readback target; this checks inherited content, not independent re-compilation.', comparisons: 0, changedPixels: 0, layers: []};
  const sample = image => {
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d', {willReadFrequently: true}); context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  for (const pose of POSES) {
    const pairs = [];
    for (const eye of ['eyeLeft', 'eyeRight']) {
      const a = candidate.gazeLayers[pose][eye], b = approved.gazeLayers[pose][eye];
      pairs.push([`${eye}/iris`, a.canvas, b.canvas]);
      for (const frame of ['open', 'half']) pairs.push([`${eye}/${frame}/clean`, a.frames[frame].clean, b.frames[frame].clean]);
    }
    for (const group of ['eyeLeft', 'eyeRight', 'mouth']) for (const state of Object.keys(approved.compiled[pose][group])) pairs.push([`${group}/${state}/patch`, candidate.compiled[pose][group][state], approved.compiled[pose][group][state]]);
    for (const [layer, a, b] of pairs) {
      if (a.width !== b.width || a.height !== b.height) throw new Error('继承图层尺寸改变。');
      const empty = {names: [], mask: new Uint8Array(a.width * a.height)};
      const delta = difference(sample(a), sample(b), a.width, null, null, empty);
      result.comparisons++; result.changedPixels += delta.changed;
      result.layers.push({pose, layer, size: [a.width, a.height], sameSourceObject: a === b, sourceType: a.constructor?.name || 'image source', changed: delta.changed, maxDelta: delta.maxDelta});
    }
  }
  return result;
}
async function geometry() {
  const response = await fetch('./assets/short-hair-pitch-brows-v1/validation/registration.json', {cache: 'no-store'});
  if (!response.ok) throw new Error('无法读取本轮眉毛保护区登记。'); return response.json();
}

try {
  const load = async () => {
    if (loadOrder === 'brows-first') {
      const candidate = await loadSideExpressionAssets('pitchBrows'); return [candidate, await loadSideExpressionAssets('pitchMouth')];
    }
    return Promise.all([loadSideExpressionAssets('pitchBrows'), loadSideExpressionAssets('pitchMouth')]);
  };
  const [[assets, approved], registration] = await Promise.all([load(), geometry()]);
  const {width, height} = assets.manifest;
  if (!assets.manifest.browArt || !assets.manifest.mouthArt || !assets.manifest.gaze || approved.manifest.browArt || !approved.manifest.mouthArt || !approved.manifest.gaze
    || approved.manifest.status !== 'approved' || width !== approved.manifest.width || height !== approved.manifest.height) throw new Error('诊断需要同尺寸的完整眉毛候选与已确认俯仰嘴型。');
  const metadata = (a, variant) => ({variant, id: a.manifest.id, version: a.manifest.version, status: a.manifest.status});
  const report = {
    schemaVersion: 1, status: 'running', generatedAt: new Date().toISOString(), loadOrder, nativeSize: [width, height],
    measuringContext: nativeContext.getContextAttributes?.() || null,
    assets: {candidate: metadata(assets, 'pitchBrows'), approved: metadata(approved, 'pitchMouth')},
    geometrySource: './assets/short-hair-pitch-brows-v1/validation/registration.json',
    criteria: {
      channels: 'Exact native RGBA differences; zero tolerance for changed protected pixels',
      legacy: 'All 5 eyelid × 3 gaze × 7 mouth states exactly match the accepted mouth pack with neutral brows',
      brows: 'All 16 brow pairs × 7 contexts compare against identical eye/mouth/gaze inputs with neutral brows',
      clip: 'Changes stay within the union of active brow destinations and clips; clips allow one source pixel of antialiasing, destinations have no tolerance',
      protection: 'Zero changes in independently traced visible eye/crease, mouth, nose, hair and other registered polygons; these sampled regions do not prove all hair is correct',
      active: 'Every selected brow yields some changed native pixels; this alone does not establish its intended shape or aesthetic quality',
      original: 'Original mode equals the approved original regardless of brow, mouth, eye or gaze targets',
      repeatability: 'Identical probe renders are compared before and after the complete pose suite',
    },
    browPairs: PAIRS, contexts: CONTEXTS, poses: {},
    summary: {passed: null, legacyCombinations: 0, browCombinations: 0, comparisons: 0, assertions: 0, failedAssertions: 0, failures: []},
  };
  const check = (pass, pose, name, details = {}) => {
    report.summary.assertions++;
    if (!pass) {report.summary.failedAssertions++; report.summary.failures.push({pose, check: name, ...details});}
  };
  const compare = (...args) => {report.summary.comparisons++; return difference(...args);};
  report.inheritedLayers = inspectInheritedLayers(assets, approved);
  check(report.inheritedLayers.changedPixels === 0, 'all', 'inherited-layers-equal-approved', {changed: report.inheritedLayers.changedPixels});
  for (const [poseIndex, pose] of POSES.entries()) {
    const meta = assets.manifest.poses[pose], regions = registration.poses?.[pose]?.protection;
    const protection = protectionMask(width, height, regions);
    const pairMasks = new Map(PAIRS.map(pair => {
      const patches = ['browLeft', 'browRight'].map(group => meta.patches[group][pair[group]]).filter(Boolean);
      if (patches.some(patch => !patch.clip)) throw new Error('眉毛诊断需要明确的外侧裁切多边形。');
      return [JSON.stringify(pair), {rects: patches.map(patch => patch.destination), mask: polygonMask(width, height, patches.map(patch => patch.clip), 1)}];
    }));
    const result = {label: meta.label, protection: regions, legacy: [], combinations: [], original: [], repeatability: []}; report.poses[pose] = result;
    const probe = {...neutral, eyeRight: 'half', mouth: 'press', browLeft: 'innerUp', browRight: 'down'};
    const before = pixels(assets, pose, probe, DIRECTIONS[2]);
    const firstRepeat = compare(before, pixels(assets, pose, probe, DIRECTIONS[2]), width, null, null, protection);
    result.repeatability.push({stage: 'before', ...firstRepeat}); check(firstRepeat.changed === 0, pose, 'repeat-before', {changed: firstRepeat.changed});
    summary.textContent = `正在检查 ${poseIndex + 1} / ${POSES.length}：${meta.label}…`;
    const heading = document.createElement('h2'); heading.textContent = meta.label;
    const row = document.createElement('div'); row.className = 'brows'; host.append(heading, row);
    for (const [browLeft, browRight, label] of [
      ['neutral', 'neutral', '已确认中性'], ['innerUp', 'innerUp', '眉头抬起'], ['outerUp', 'outerUp', '眉尾抬起'], ['down', 'down', '双眉压低'],
      ['outerUp', 'neutral', '角色左眉挑起 · 画面右'], ['neutral', 'down', '角色右眉压低 · 画面左'],
    ]) card(row, detail(assets, pose, {...neutral, browLeft, browRight}, meta.detailViews.brows), label);
    const facesSection = document.createElement('details'), title = document.createElement('summary'); title.textContent = '查看眉眼嘴组合与刘海保护区';
    const faces = document.createElement('div'); faces.className = 'faces'; facesSection.append(title, faces); host.append(facesSection);
    card(faces, render(assets, pose, {...neutral, mouth: 'pucker', browLeft: 'innerUp', browRight: 'innerUp'}, DIRECTIONS[1]), '眉头抬起 · 噘嘴 · 视线左上');
    card(faces, render(assets, pose, {...neutral, eyeRight: 'closed', mouth: 'press', browLeft: 'outerUp', browRight: 'down'}, DIRECTIONS[2]), '左右独立眉 · 单眼闭合 · 抿嘴');
    const overlay = render(assets, pose, neutral, DIRECTIONS[0], {faceOnly: false});
    const oc = overlay.getContext('2d'); oc.lineWidth = 1; oc.fillStyle = 'rgba(7,140,175,.18)'; oc.strokeStyle = '#078caf';
    for (const polygons of Object.values(regions)) for (const polygon of polygons) {path(oc, polygon); oc.fill(); oc.stroke();}
    const overlayCrop = document.createElement('canvas'); overlayCrop.width = meta.faceView[2]; overlayCrop.height = meta.faceView[3];
    overlayCrop.getContext('2d').drawImage(overlay, ...meta.faceView, 0, 0, ...meta.faceView.slice(2));
    card(faces, overlayCrop, '像素保护区示意（仅诊断叠层）');
    const junction = hairJunctions(assets, pose, meta);
    if (junction) result.hairJunctionView = junction;
    for (const eyes of EYES) for (const direction of DIRECTIONS) for (const mouth of MOUTHS) {
      const state = {...neutral, eyeLeft: eyes.eyeLeft, eyeRight: eyes.eyeRight, mouth};
      const delta = compare(pixels(approved, pose, state, direction), pixels(assets, pose, state, direction), width, null, null, protection);
      const key = {eyelid: eyes.id, gaze: direction.id, mouth};
      result.legacy.push({...key, ...delta}); report.summary.legacyCombinations++;
      check(delta.changed === 0, pose, 'legacy-equals-approved', {...key, changed: delta.changed, maxDelta: delta.maxDelta});
    }
    for (const {mouth, eyes, direction} of CONTEXTS) {
      const state = {...neutral, eyeLeft: eyes.eyeLeft, eyeRight: eyes.eyeRight, mouth};
      const baseline = pixels(assets, pose, state, direction);
      for (const pair of PAIRS) {
        const {rects, mask} = pairMasks.get(JSON.stringify(pair));
        const actualState = {...state, ...pair}, actual = pixels(assets, pose, actualState, direction);
        const delta = compare(baseline, actual, width, rects, mask, protection);
        const key = {eyelid: eyes.id, gaze: direction.id, mouth, ...pair};
        const item = {...key, browDifference: delta}; result.combinations.push(item); report.summary.browCombinations++;
        check(delta.outsideRect === 0, pose, 'outside-selected-brow-destinations', {...key, changed: delta.outsideRect});
        check(delta.outsideClip === 0, pose, 'outside-selected-brow-clips', {...key, changed: delta.outsideClip});
        check(Object.values(delta.protectedChanged).every(value => value === 0), pose, 'protected-anatomy', {...key, changed: delta.protectedChanged});
        check(rects.length ? delta.changed > 0 : delta.changed === 0, pose, 'active-brows-visible-neutral-identical', {...key, changed: delta.changed});
        // Removing one active brow must affect only that anatomical side. This
        // measures asymmetric composition as well as double-neutral baselines.
        for (const group of ['browLeft', 'browRight']) if (pair[group] !== 'neutral') {
          const patch = meta.patches[group][pair[group]];
          const singleMask = pairMasks.get(JSON.stringify({browLeft: group === 'browLeft' ? pair[group] : 'neutral', browRight: group === 'browRight' ? pair[group] : 'neutral'})).mask;
          const local = compare(pixels(assets, pose, {...actualState, [group]: 'neutral'}, direction), actual, width, [patch.destination], singleMask, protection);
          (item.independentBrows ||= {})[group] = local;
          check(local.changed > 0 && local.outsideRect === 0 && local.outsideClip === 0, pose, 'independent-anatomical-brow', {...key, group, changed: local.changed, outsideRect: local.outsideRect, outsideClip: local.outsideClip});
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const approvedOriginal = pixels(approved, pose, neutral, DIRECTIONS[0], {original: true});
    for (const [index, pair] of PAIRS.entries()) {
      const context = CONTEXTS[index % CONTEXTS.length], state = {...neutral, ...context.eyes, mouth: context.mouth, ...pair};
      const delta = compare(approvedOriginal, pixels(assets, pose, state, context.direction, {original: true}), width, null, null, protection);
      result.original.push({...pair, ...delta}); check(delta.changed === 0, pose, 'original-equals-approved', {...pair, changed: delta.changed});
    }
    const after = pixels(assets, pose, probe, DIRECTIONS[2]);
    for (const [stage, reference] of [['before-after', before], ['after', pixels(assets, pose, probe, DIRECTIONS[2])]]) {
      const delta = compare(reference, after, width, null, null, protection);
      result.repeatability.push({stage, ...delta}); check(delta.changed === 0, pose, `repeat-${stage}`, {changed: delta.changed});
    }
    output.textContent = JSON.stringify(report, null, 2); await new Promise(resolve => setTimeout(resolve, 0));
  }
  report.status = 'complete'; report.summary.passed = report.summary.failedAssertions === 0;
  output.textContent = JSON.stringify(report, null, 2); summary.dataset.state = report.summary.passed ? 'passed' : 'failed';
  summary.textContent = `${width} × ${height} 原生像素；${report.summary.legacyCombinations} 组已确认表情、${report.summary.browCombinations} 组眉毛组合、${report.summary.comparisons} 次比较、${report.summary.assertions} 项断言，${report.summary.failedAssertions} 项未通过。视觉效果请查看上方对照。`;
} catch (error) {
  output.textContent = JSON.stringify({schemaVersion: 1, status: 'error', loadOrder, error: error.message, stack: error.stack}, null, 2);
  summary.dataset.state = 'failed'; summary.textContent = `检查未完成：${error.message}`;
}
