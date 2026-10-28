import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';
import {compilePitchGazeLayers} from './pitch-gaze.js';

const host = document.querySelector('#comparisons');
const output = document.querySelector('#result');
const summary = document.querySelector('#summary');
const loadOrder = new URLSearchParams(location.search).get('load') === 'mouth-first' ? 'mouth-first' : 'parallel';
document.querySelector('#loadOrder').textContent = loadOrder === 'mouth-first'
  ? '加载顺序：先完整载入新嘴型，再载入已确认视线；模拟默认嘴型页首次加载。'
  : '加载顺序：新嘴型与已确认视线并行载入。';
const POSES = ['view-left-up', 'view-right-up', 'view-left-down'];
const MOUTHS = ['neutral', 'openSmall', 'openWide', 'pucker', 'press', 'shiftLeft', 'shiftRight'];
const LABELS = {neutral: '已确认中性', openSmall: '已确认小张嘴', openWide: '已确认大张嘴', pucker: '噘嘴', press: '抿嘴', shiftLeft: '角色左移嘴 · 画面右', shiftRight: '角色右移嘴 · 画面左'};
const EYE_STATES = [
  {id: 'open', eyeLeft: 'open', eyeRight: 'open'},
  {id: 'half', eyeLeft: 'half', eyeRight: 'half'},
  {id: 'closed', eyeLeft: 'closed', eyeRight: 'closed'},
  {id: 'winkLeft', eyeLeft: 'closed', eyeRight: 'open'},
  {id: 'winkRight', eyeLeft: 'open', eyeRight: 'closed'},
];
const DIRECTIONS = [{id: 'center', x: 0, y: 0}, {id: 'up-left', x: -1, y: -1}, {id: 'down-right', x: 1, y: 1}];
const REQUIRED_PROTECTION = ['eyes', 'brows', 'nose', 'chin'];
const nativeCanvas = document.createElement('canvas');
// Request a readback-oriented measuring surface before its very first draw.
// The actual renderer and its compiled source/gaze canvases stay unchanged.
const nativeContext = nativeCanvas.getContext('2d', {willReadFrequently: true});
const neutral = {eyeLeft: 'open', eyeRight: 'open', mouth: 'neutral'};
const gaze = ({x = 0, y = 0} = {}) => ({eyeLeft: {x, y}, eyeRight: {x, y}});
const inside = ([left, top, width, height], x, y) => x >= left && x < left + width && y >= top && y < top + height;

function render(assets, pose, state, direction, options = {}, canvas = document.createElement('canvas')) {
  drawSideExpression(canvas, assets, pose, state, {gaze: gaze(direction), ...options});
  return canvas;
}

function nativePixels(assets, pose, state, direction, options = {}) {
  const canvas = render(assets, pose, state, direction, {...options, faceOnly: false}, nativeCanvas);
  if (canvas.width !== assets.manifest.width || canvas.height !== assets.manifest.height) throw new Error('像素检查需要完整源图的原生尺寸。');
  return nativeContext.getImageData(0, 0, canvas.width, canvas.height).data;
}

function card(parent, canvas, label) {
  const figure = document.createElement('figure'), caption = document.createElement('figcaption');
  caption.textContent = label; canvas.setAttribute('aria-label', label); figure.append(canvas, caption); parent.append(figure);
}

function mouthDetail(assets, pose, state, direction, view) {
  // Both versions use the candidate's viewing rectangle. The approved version
  // has a different detail crop; using it would change the apparent mouth scale.
  const full = render(assets, pose, state, direction, {faceOnly: false}, nativeCanvas);
  const canvas = document.createElement('canvas'); canvas.width = view[2]; canvas.height = view[3];
  canvas.getContext('2d').drawImage(full, ...view, 0, 0, view[2], view[3]);
  return canvas;
}

function path(c, polygon) {
  c.beginPath(); polygon.forEach(([x, y], i) => c[i ? 'lineTo' : 'moveTo'](x, y)); c.closePath();
}

function polygonMask(width, height, polygons, boundary = 0) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const c = canvas.getContext('2d');
  for (const polygon of polygons) {
    path(c, polygon); c.fill();
    if (boundary) { c.lineWidth = boundary * 2; c.lineJoin = 'round'; c.stroke(); }
  }
  const pixels = c.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3] ? 1 : 0;
  return mask;
}

function protectionMask(width, height, regions) {
  for (const name of REQUIRED_PROTECTION) {
    if (!Array.isArray(regions?.[name]) || !regions[name].length) throw new Error(`缺少 ${name} 保护区，不能跳过此项检查。`);
  }
  const entries = Object.entries(regions);
  if (entries.length > 8) throw new Error('保护区类别超出诊断位图范围。');
  const mask = new Uint8Array(width * height);
  entries.forEach(([name, polygons], index) => {
    if (!Array.isArray(polygons) || polygons.some(p => !Array.isArray(p) || p.length < 3
      || p.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)))) throw new Error(`${name} 保护多边形无效。`);
    const local = polygonMask(width, height, polygons);
    for (let i = 0; i < mask.length; i++) if (local[i]) mask[i] |= 1 << index;
  });
  return {mask, names: entries.map(([name]) => name)};
}

function difference(a, b, width, allowedRect, clipMask, protection) {
  if (a.length !== b.length || a.length % (width * 4)) throw new Error('待比较原生画布尺寸不一致。');
  let changed = 0, outsideRect = 0, outsideClip = 0, maxDelta = 0;
  const protectedChanged = Object.fromEntries(protection.names.map(name => [name, 0]));
  for (let i = 0; i < a.length; i += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(a[i + channel] - b[i + channel]));
    if (!delta) continue;
    changed++; maxDelta = Math.max(maxDelta, delta);
    const pixel = i / 4, x = pixel % width, y = Math.floor(pixel / width);
    if (!allowedRect || !inside(allowedRect, x, y)) outsideRect++;
    if (clipMask && !clipMask[pixel]) outsideClip++;
    const flags = protection.mask[pixel];
    if (flags) protection.names.forEach((name, index) => { if (flags & (1 << index)) protectedChanged[name]++; });
  }
  return {changed, outsideRect, outsideClip, maxDelta, protectedChanged};
}

function layerDifference(a, b, width, origin) {
  if (a.length !== b.length) return {sizeMismatch: true, firstLength: a.length, secondLength: b.length};
  let changed = 0, alphaChanged = 0, rgbChanged = 0, maxDelta = 0, maxAlphaDelta = 0;
  let left = Infinity, top = Infinity, right = -1, bottom = -1;
  for (let i = 0; i < a.length; i += 4) {
    const rgb = Math.max(...[0, 1, 2].map(channel => Math.abs(a[i + channel] - b[i + channel])));
    const alpha = Math.abs(a[i + 3] - b[i + 3]);
    if (!rgb && !alpha) continue;
    changed++; if (rgb) rgbChanged++; if (alpha) alphaChanged++;
    maxDelta = Math.max(maxDelta, rgb, alpha); maxAlphaDelta = Math.max(maxAlphaDelta, alpha);
    const pixel = i / 4, x = pixel % width, y = Math.floor(pixel / width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  const localBounds = changed ? [left, top, right - left + 1, bottom - top + 1] : null;
  return {changed, rgbChanged, alphaChanged, maxDelta, maxAlphaDelta, localBounds,
    sourceBounds: localBounds ? [left + origin[0], top + origin[1], localBounds[2], localBounds[3]] : null};
}

function inspectCompiledLayers(candidate, approved) {
  const inspection = {note: 'Read-only RGBA snapshots before combination checks. Canvas sources are read directly; immutable ImageBitmap sources are copied 1:1 into private readback-oriented targets. Shared source identity is reported explicitly. The private temporary iris core canvas is not retained by the renderer.', comparisons: 0, poses: {}};
  for (const pose of POSES) {
    const result = {core: 'not exposed by runtime; included in the fixed iris composite', eyes: {}};
    inspection.poses[pose] = result;
    for (const eye of ['eyeLeft', 'eyeRight']) {
      const candidateLayer = candidate.gazeLayers[pose][eye], approvedLayer = approved.gazeLayers[pose][eye];
      const layers = [
        ['irisComposite', candidateLayer.canvas, approvedLayer.canvas, candidateLayer.bounds],
        ...['open', 'half'].map(state => [`${state}Clean`, candidateLayer.frames[state].clean, approvedLayer.frames[state].clean, candidateLayer.bounds]),
        ...['half', 'closed'].map(state => [`${state}EyePatch`, candidate.compiled[pose][eye][state], approved.compiled[pose][eye][state], candidate.manifest.poses[pose].patches[eye][state].destination]),
      ];
      const eyeResult = {}; result.eyes[eye] = eyeResult;
      for (const [name, a, b, bounds] of layers) {
        const snapshots = [];
        for (const source of [a, b]) {
          const directCanvas = typeof source.getContext === 'function';
          const canvas = directCanvas ? source : document.createElement('canvas');
          let context;
          if (directCanvas) context = canvas.getContext('2d');
          else {
            canvas.width = source.width; canvas.height = source.height;
            context = canvas.getContext('2d', {willReadFrequently: true});
            context.drawImage(source, 0, 0);
          }
          const samples = Array.from({length: 3}, () => context.getImageData(0, 0, canvas.width, canvas.height).data);
          const repeat = samples.slice(1).map((pixels, index) => {
            inspection.comparisons++;
            return {sample: index + 2, ...layerDifference(samples[0], pixels, canvas.width, bounds)};
          });
          snapshots.push({first: samples[0], last: samples[2], repeat, sourceType: source.constructor?.name || 'image source',
            readMethod: directCanvas ? 'direct-canvas' : 'one-to-one-readback-copy', context: context.getContextAttributes?.() || null, size: [canvas.width, canvas.height]});
        }
        inspection.comparisons += 2;
        eyeResult[name] = {bounds, sameSourceObject: a === b,
          candidate: {size: snapshots[0].size, sourceType: snapshots[0].sourceType, readMethod: snapshots[0].readMethod, context: snapshots[0].context, repeats: snapshots[0].repeat},
          approved: {size: snapshots[1].size, sourceType: snapshots[1].sourceType, readMethod: snapshots[1].readMethod, context: snapshots[1].context, repeats: snapshots[1].repeat},
          firstCrossPack: layerDifference(snapshots[0].first, snapshots[1].first, a.width, bounds),
          lastCrossPack: layerDifference(snapshots[0].last, snapshots[1].last, a.width, bounds)};
      }
    }
  }
  return inspection;
}

function controlledCompilation(candidate, approved) {
  const pose = 'view-left-down', eye = 'eyeLeft';
  const p = candidate.manifest.gaze.poses[pose], e = p.eyes[eye];
  const snapshot = canvas => ({pixels: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
    size: [canvas.width, canvas.height], context: canvas.getContext('2d').getContextAttributes?.() || null});
  const diff = (a, b, origin = e.bounds) => layerDifference(a.pixels, b.pixels, a.size[0], origin);
  const buildStages = (assets, readback) => {
    const meta = assets.manifest.gaze.poses[pose], registration = meta.eyes[eye];
    const make = (width, height, translated = false) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', readback ? {willReadFrequently: true} : undefined);
      if (translated) context.translate(-registration.bounds[0], -registration.bounds[1]);
      return {canvas, context};
    };
    const fill = () => {
      const surface = make(registration.bounds[2], registration.bounds[3], true);
      surface.context.drawImage(assets.images[meta.irisSource], ...registration.irisRect, ...registration.irisDestination);
      return surface;
    };
    const core = () => {
      const surface = make(registration.bounds[2], registration.bounds[3], true), c = surface.context;
      c.filter = 'blur(1px)'; path(c, registration.core); c.fill(); c.filter = 'none';
      c.globalCompositeOperation = 'source-in'; c.drawImage(assets.images[assets.manifest.poses[pose].reference], 0, 0);
      return surface;
    };
    const raw = make(registration.irisRect[2], registration.irisRect[3]);
    raw.context.drawImage(assets.images[meta.irisSource], ...registration.irisRect, 0, 0, registration.irisRect[2], registration.irisRect[3]);
    const scaled = fill(), coloredCore = core(), final = fill(), finalCore = core();
    final.context.drawImage(finalCore.canvas, registration.bounds[0], registration.bounds[1]);
    return {rawCrop: snapshot(raw.canvas), scaledFill: snapshot(scaled.canvas), blurredCore: snapshot(coloredCore.canvas), composite: snapshot(final.canvas)};
  };
  const result = {pose, eye, bounds: e.bounds, irisRect: e.irisRect, irisDestination: e.irisDestination,
    note: 'Diagnostic-only canvases. Four stages use private factories; actual frozen compiler is additionally rerun under a synchronous factory override restored in finally. Existing renderer assets are never replaced.', stages: {}};
  for (const [mode, readback] of [['default', false], ['readback', true]]) {
    const a = [buildStages(candidate, readback), buildStages(candidate, readback)];
    const b = [buildStages(approved, readback), buildStages(approved, readback)];
    result.stages[mode] = Object.fromEntries(Object.keys(a[0]).map(stage => {
      const origin = stage === 'rawCrop' ? e.irisRect : e.bounds;
      return [stage, {candidateContext: a[0][stage].context, approvedContext: b[0][stage].context,
        crossPack: [0, 1].map(i => diff(a[i][stage], b[i][stage], origin)),
        candidateRebuild: diff(a[0][stage], a[1][stage], origin), approvedRebuild: diff(b[0][stage], b[1][stage], origin)}];
    }));
  }
  const original = document.createElement;
  const descriptor = Object.getOwnPropertyDescriptor(document, 'createElement');
  let a, b;
  try {
    Object.defineProperty(document, 'createElement', {configurable: true, writable: true, value: function (...args) {
      const element = original.apply(this, args);
      if (String(args[0]).toLowerCase() === 'canvas') element.getContext('2d', {willReadFrequently: true});
      return element;
    }});
    // This compiler is the actual frozen production function, called synchronously.
    a = [0, 1].map(() => snapshot(compilePitchGazeLayers(candidate.manifest, candidate.images)[pose][eye].canvas));
    b = [0, 1].map(() => snapshot(compilePitchGazeLayers(approved.manifest, approved.images)[pose][eye].canvas));
  } finally {
    if (descriptor) Object.defineProperty(document, 'createElement', descriptor);
    else delete document.createElement;
  }
  result.factoryRestored = document.createElement === original;
  result.frozenCompilerReadback = {candidateContext: a[0].context, approvedContext: b[0].context,
    crossPack: [0, 1].map(i => diff(a[i], b[i])), candidateRebuild: diff(a[0], a[1]), approvedRebuild: diff(b[0], b[1])};
  const manual = buildStages(candidate, true).composite;
  result.privateStagesMatchFrozenCompiler = diff(manual, a[0]);
  return result;
}

async function loadGeometry() {
  const response = await fetch('./assets/short-hair-pitch-mouth-v1/validation/registration.json', {cache: 'no-store'});
  if (!response.ok) throw new Error('无法读取本轮嘴型保护区登记。');
  return response.json();
}

try {
  const loadAssets = async () => {
    if (loadOrder === 'mouth-first') {
      const candidate = await loadSideExpressionAssets('pitchMouth');
      const approved = await loadSideExpressionAssets('pitchGaze');
      return [candidate, approved];
    }
    return Promise.all([loadSideExpressionAssets('pitchMouth'), loadSideExpressionAssets('pitchGaze')]);
  };
  const [[assets, approved], geometry] = await Promise.all([loadAssets(), loadGeometry()]);
  const {width, height} = assets.manifest;
  if (!assets.manifest.mouthArt || !assets.manifest.gaze || approved.manifest.mouthArt
    || !approved.manifest.gaze || approved.manifest.status !== 'approved'
    || width !== approved.manifest.width || height !== approved.manifest.height
    || [assets, approved].some(a => a.manifest.poseFamily !== 'pitch' || Object.keys(a.manifest.poses).length !== POSES.length
      || POSES.some(pose => !a.manifest.poses[pose]))) throw new Error('诊断需要三个同尺寸俯仰姿态的嘴型候选和已确认视线版。');
  const metadata = (a, variant) => ({variant, id: a.manifest.id, version: a.manifest.version, status: a.manifest.status});
  const report = {
    schemaVersion: 1, status: 'running', generatedAt: new Date().toISOString(), loadOrder, nativeSize: [width, height],
    measuringContext: nativeContext.getContextAttributes?.() || null,
    assets: {candidate: metadata(assets, 'pitchMouth'), approved: metadata(approved, 'pitchGaze')},
    geometrySource: './assets/short-hair-pitch-mouth-v1/validation/registration.json',
    criteria: {
      channels: 'Exact RGBA pixel differences at native resolution',
      mouthOnly: 'Compare each mouth against neutral with exactly the same eyelid and gaze inputs; zero changed pixels outside the current mouth destination',
      clip: 'Zero changed pixels outside the current clip polygon, allowing one source pixel for clip antialiasing; destination remains a strict boundary',
      protection: 'Zero changed pixels in independently registered eyes, brows, nose, chin and any additional protection polygons',
      legacy: 'Neutral/openSmall/openWide must reproduce the approved pitchGaze version exactly with matching eyelid and gaze inputs',
      original: 'Original mode must equal the approved original regardless of mouth, eyelid or gaze targets',
      repeatability: 'Three identical renders per probe before and after each pose suite, plus before/after equality; all pixel differences must be exactly zero',
    },
    eyeStates: EYE_STATES, gazeDirections: DIRECTIONS, poses: {},
    summary: {passed: null, combinations: 0, comparisons: 0, assertions: 0, failedAssertions: 0, failures: []},
  };
  report.compiledInspection = inspectCompiledLayers(assets, approved);
  const check = (pass, pose, name, details) => {
    report.summary.assertions++;
    if (!pass) { report.summary.failedAssertions++; report.summary.failures.push({pose, check: name, ...details}); }
  };
  const compare = (...args) => { report.summary.comparisons++; return difference(...args); };
  for (const [poseIndex, pose] of POSES.entries()) {
    const meta = assets.manifest.poses[pose];
    const regions = geometry.poses?.[pose]?.protection || geometry.protection?.[pose];
    const protection = protectionMask(width, height, regions);
    const clips = Object.fromEntries(MOUTHS.map(mouth => {
      const patch = meta.patches.mouth[mouth];
      return [mouth, patch?.clip ? polygonMask(width, height, [patch.clip], 1) : null];
    }));
    const result = {label: meta.label, protection: regions, combinations: [], original: [], repeatability: []}; report.poses[pose] = result;
    const probes = [
      {id: 'open-center', state: neutral, direction: DIRECTIONS[0]},
      {id: 'winkLeft-up-left', state: {...neutral, eyeLeft: 'closed'}, direction: DIRECTIONS[1]},
      {id: 'half-down-right', state: {...neutral, eyeLeft: 'half', eyeRight: 'half'}, direction: DIRECTIONS[2]},
    ];
    const probePixels = new Map();
    const repeatability = stage => {
      for (const probe of probes) {
        const first = nativePixels(assets, pose, probe.state, probe.direction);
        const item = {stage, probe: probe.id, context: nativeContext.getContextAttributes?.() || null, repetitions: []};
        for (let sample = 2; sample <= 3; sample++) {
          const delta = compare(first, nativePixels(assets, pose, probe.state, probe.direction), width, null, null, protection);
          item.repetitions.push({sample, ...delta});
          check(delta.changed === 0, pose, 'same-input-repeatability', {stage, probe: probe.id, sample, changed: delta.changed, maxDelta: delta.maxDelta});
        }
        if (stage === 'before') probePixels.set(probe.id, first);
        else {
          item.beforeAfter = compare(probePixels.get(probe.id), first, width, null, null, protection);
          check(item.beforeAfter.changed === 0, pose, 'before-after-repeatability', {probe: probe.id, changed: item.beforeAfter.changed, maxDelta: item.beforeAfter.maxDelta});
        }
        result.repeatability.push(item);
      }
    };
    repeatability('before');
    summary.textContent = `正在检查 ${poseIndex + 1} / ${POSES.length}：${meta.label}…`;
    const heading = document.createElement('h2'); heading.textContent = meta.label;
    const row = document.createElement('div'); row.className = 'mouths'; host.append(heading, row);
    for (const mouth of ['neutral', 'pucker', 'press', 'shiftLeft', 'shiftRight']) {
      card(row, mouthDetail(mouth === 'neutral' ? approved : assets, pose, {...neutral, mouth}, DIRECTIONS[0], meta.detailViews.mouth), LABELS[mouth]);
    }
    const full = document.createElement('details'), title = document.createElement('summary'); title.textContent = '查看本姿态的脸部组合';
    const faces = document.createElement('div'); faces.className = 'faces'; full.append(title, faces); host.append(full);
    card(faces, render(assets, pose, {...neutral, mouth: 'pucker'}, DIRECTIONS[1]), '噘嘴 · 视线左上');
    card(faces, render(assets, pose, {eyeLeft: 'half', eyeRight: 'half', mouth: 'press'}, DIRECTIONS[2]), '半闭眼抿嘴 · 视线右下');

    for (const eyes of EYE_STATES) for (const direction of DIRECTIONS) {
      const state = {eyeLeft: eyes.eyeLeft, eyeRight: eyes.eyeRight, mouth: 'neutral'};
      const baseline = nativePixels(assets, pose, state, direction);
      for (const mouth of MOUTHS) {
        report.summary.combinations++;
        const actualState = {...state, mouth}, patch = meta.patches.mouth[mouth];
        const actual = nativePixels(assets, pose, actualState, direction);
        const delta = compare(baseline, actual, width, patch?.destination, clips[mouth], protection);
        const item = {eyelid: eyes.id, gaze: direction.id, mouth, mouthDifference: delta};
        result.combinations.push(item);
        const key = {eyelid: eyes.id, gaze: direction.id, mouth};
        check(delta.outsideRect === 0, pose, 'outside-mouth-destination', {...key, changed: delta.outsideRect});
        check(delta.outsideClip === 0, pose, 'outside-mouth-clip', {...key, changed: delta.outsideClip});
        check(Object.values(delta.protectedChanged).every(value => value === 0), pose, 'protected-anatomy', {...key, changed: delta.protectedChanged});
        if (['neutral', 'openSmall', 'openWide'].includes(mouth)) {
          item.approvedDifference = compare(nativePixels(approved, pose, actualState, direction), actual, width, null, null, protection);
          check(item.approvedDifference.changed === 0, pose, 'legacy-state-equals-approved', {...key, changed: item.approvedDifference.changed});
        }
      }
    }
    const original = nativePixels(approved, pose, neutral, DIRECTIONS[0], {original: true});
    for (const mouth of MOUTHS) {
      const delta = compare(original, nativePixels(assets, pose, {eyeLeft: 'closed', eyeRight: 'half', mouth}, DIRECTIONS[2], {original: true}), width, null, null, protection);
      result.original.push({mouth, ...delta}); check(delta.changed === 0, pose, 'original-equals-approved', {mouth, changed: delta.changed});
    }
    repeatability('after');
    output.textContent = JSON.stringify(report, null, 2);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  report.controlledCompilation = controlledCompilation(assets, approved);
  report.status = 'complete'; report.summary.passed = report.summary.failedAssertions === 0;
  output.textContent = JSON.stringify(report, null, 2);
  summary.dataset.state = report.summary.passed ? 'passed' : 'failed';
  summary.textContent = `${report.nativeSize.join(' × ')} 原生像素；${report.summary.combinations} 组嘴型组合、${report.summary.comparisons} 次比较、${report.summary.assertions} 项边界断言，${report.summary.failedAssertions} 项未通过。视觉效果请查看上方五稿对照。`;
} catch (error) {
  output.textContent = JSON.stringify({schemaVersion: 1, status: 'error', loadOrder, error: error.message, stack: error.stack}, null, 2);
  summary.dataset.state = 'failed'; summary.textContent = `检查未完成：${error.message}`;
}
