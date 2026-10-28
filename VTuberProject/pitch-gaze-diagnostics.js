import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const host = document.querySelector('#comparisons');
const faceHost = document.querySelector('#faces');
const output = document.querySelector('#result');
const summary = document.querySelector('#summary');
const zoomHost = document.querySelector('#zoomComparisons');
const zoomPose = document.querySelector('#zoomPose');
const zoomEyelid = document.querySelector('#zoomEyelid');
const zoomLabel = document.querySelector('#zoomLabel');
const POSES = ['view-left-up', 'view-right-up', 'view-left-down'];
const EYES = ['eyeLeft', 'eyeRight'];
const neutral = {eyeLeft: 'open', eyeRight: 'open', mouth: 'neutral'};
const directions = [
  {id: 'center', label: '中心', x: 0, y: 0},
  {id: 'left', label: '画面左', x: -1, y: 0},
  {id: 'right', label: '画面右', x: 1, y: 0},
  {id: 'up', label: '上', x: 0, y: -1},
  {id: 'down', label: '下', x: 0, y: 1},
  {id: 'up-left', label: '左上', x: -1, y: -1},
  {id: 'up-right', label: '右上', x: 1, y: -1},
  {id: 'down-left', label: '左下', x: -1, y: 1},
  {id: 'down-right', label: '右下', x: 1, y: 1},
];
const EPSILON = 1e-6;
const NEAR_ZERO_MAX_DELTA = 1;
const gaze = (x = 0, y = 0) => ({eyeLeft: {x, y}, eyeRight: {x, y}});
const inside = ([left, top, width, height], x, y) => x >= left && x < left + width && y >= top && y < top + height;
const nativeCanvas = document.createElement('canvas');

function render(assets, pose, state, input, options = {}, canvas = document.createElement('canvas')) {
  drawSideExpression(canvas, assets, pose, state, {gaze: input, ...options});
  return canvas;
}

function nativePixels(assets, pose, state, input) {
  const canvas = render(assets, pose, state, input, {faceOnly: false}, nativeCanvas);
  if (canvas.width !== assets.manifest.width || canvas.height !== assets.manifest.height) {
    throw new Error('像素检查必须使用完整源图的原生分辨率。');
  }
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Exact RGBA comparisons; protected rectangles may cover the entire closed-eye patch. */
function difference(a, b, width, allowed, protectedRegions = {}) {
  if (a.length !== b.length || a.length % (width * 4)) throw new Error('待比较画布的原生尺寸不一致。');
  let changed = 0, outside = 0, maxDelta = 0, large = 0, absoluteDelta = 0;
  const protectedChanged = Object.fromEntries(Object.keys(protectedRegions).map(key => [key, 0]));
  for (let i = 0; i < a.length; i += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) {
      const value = Math.abs(a[i + channel] - b[i + channel]);
      delta = Math.max(delta, value); absoluteDelta += value;
    }
    if (!delta) continue;
    changed++; maxDelta = Math.max(maxDelta, delta); if (delta > 20) large++;
    const pixel = i / 4, x = pixel % width, y = Math.floor(pixel / width);
    if (!allowed.some(rect => inside(rect, x, y))) outside++;
    for (const [key, regions] of Object.entries(protectedRegions)) {
      if (regions.some(rect => inside(rect, x, y))) protectedChanged[key]++;
    }
  }
  return {changed, outside, maxDelta, large, absoluteDelta, protectedChanged};
}

function card(parent, canvas, label) {
  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption');
  caption.textContent = label; canvas.setAttribute('aria-label', label);
  figure.append(canvas, caption); parent.append(figure);
}

function assetMetadata(assets, variant) {
  const {id, version, status} = assets.manifest;
  return {variant, id, version, status};
}

function setUpZoomInspector(assets, approved) {
  for (const pose of POSES) {
    const option = document.createElement('option');
    option.value = pose; option.textContent = assets.manifest.poses[pose].label;
    zoomPose.append(option);
  }
  const update = () => {
    const pose = zoomPose.value, eyelid = zoomEyelid.value;
    if (!POSES.includes(pose) || !['open', 'half'].includes(eyelid)) return;
    const state = {...neutral, eyeLeft: eyelid, eyeRight: eyelid};
    zoomHost.replaceChildren();
    zoomHost.dataset.pose = pose; zoomHost.dataset.eyelid = eyelid;
    zoomLabel.textContent = `${assets.manifest.poses[pose].label} · ${eyelid === 'open' ? '睁眼' : '半闭眼'}`;
    card(zoomHost, render(approved, pose, state, gaze(), {detail: 'eyes'}), '已确认基础表情');
    for (const {label, x, y} of directions) {
      card(zoomHost, render(assets, pose, state, gaze(x, y), {detail: 'eyes'}), `视线：${label}`);
    }
  };
  zoomPose.addEventListener('change', update);
  zoomEyelid.addEventListener('change', update);
  zoomPose.value = POSES[0]; zoomEyelid.value = 'open';
  document.querySelector('#zoomControls').disabled = false;
  update();
}

function requireCompatibleAssets(candidate, approved) {
  for (const assets of [candidate, approved]) {
    const manifest = assets.manifest;
    if (manifest.poseFamily !== 'pitch' || Object.keys(manifest.poses).length !== POSES.length
      || POSES.some(pose => !manifest.poses[pose])) throw new Error('诊断仅适用于已登记的三个俯仰姿态。');
  }
  if (!candidate.manifest.gaze || approved.manifest.gaze
    || approved.manifest.status !== 'approved'
    || candidate.manifest.width !== approved.manifest.width
    || candidate.manifest.height !== approved.manifest.height) throw new Error('需要同尺寸的俯仰视线候选与已确认基础版。');
}

try {
  const [assets, approved] = await Promise.all([
    loadSideExpressionAssets('pitchGaze'), loadSideExpressionAssets('pitch'),
  ]);
  requireCompatibleAssets(assets, approved);
  setUpZoomInspector(assets, approved);
  const width = assets.manifest.width;
  const report = {
    schemaVersion: 1,
    status: 'running',
    generatedAt: new Date().toISOString(),
    assets: {candidate: assetMetadata(assets, 'pitchGaze'), approved: assetMetadata(approved, 'pitch')},
    nativeSize: [width, assets.manifest.height],
    directions,
    criteria: {
      channels: 'RGBA; exact pixel equality, no image resizing in comparisons',
      outside: 'Zero changed pixels outside the union of both registered eye bounds',
      doubleClosed: 'Exact full-image equality to the approved matching closed-eye state at center and all eight extrema',
      singleClosed: 'Zero changed pixels in the closed eye bounds plus its entire expression patch, against both approved state and candidate center',
      nearZero: {epsilon: EPSILON, maximumChannelDelta: NEAR_ZERO_MAX_DELTA,
        note: 'Eight directions approaching zero for open and half states. Larger .001/.01 samples are measurements only; no artistic-quality assertion.'},
    },
    poses: {},
    summary: {passed: null, comparisons: 0, assertions: 0, failedAssertions: 0, failures: []},
  };
  const check = (pass, pose, name, detail) => {
    report.summary.assertions++;
    if (!pass) {
      report.summary.failedAssertions++;
      report.summary.failures.push({pose, check: name, ...detail});
    }
  };
  const compare = (...args) => { report.summary.comparisons++; return difference(...args); };

  for (const [poseIndex, pose] of POSES.entries()) {
    const meta = assets.manifest.poses[pose];
    const eyeMeta = assets.manifest.gaze.poses[pose].eyes;
    const bounds = EYES.map(eye => eyeMeta[eye].bounds);
    const poseReport = {label: meta.label, eyeBounds: Object.fromEntries(EYES.map(eye => [eye, eyeMeta[eye].bounds])),
      visibleStates: [], doubleClosed: [], singleClosed: [], nearZero: []};
    report.poses[pose] = poseReport;
    summary.textContent = `正在检查 ${poseIndex + 1} / ${POSES.length}：${meta.label}…`;

    for (const eyelid of ['open', 'half']) {
      const state = {...neutral, eyeLeft: eyelid, eyeRight: eyelid};
      const section = document.createElement('section'); section.className = 'eyelid-group';
      const heading = document.createElement('h2');
      heading.textContent = `${meta.label} · ${eyelid === 'open' ? '睁眼' : '半闭眼'}`;
      const row = document.createElement('div'); row.className = 'row';
      section.append(heading, row); host.append(section);
      card(row, render(approved, pose, state, gaze(), {detail: 'eyes'}), '已确认基础表情');
      const base = nativePixels(approved, pose, state, gaze());
      const center = nativePixels(assets, pose, state, gaze());
      for (const direction of directions) {
        const {id, label, x, y} = direction;
        card(row, render(assets, pose, state, gaze(x, y), {detail: 'eyes'}), `视线：${label}`);
        const delta = compare(base, nativePixels(assets, pose, state, gaze(x, y)), width, bounds);
        poseReport.visibleStates.push({eyelid, direction: id, ...delta});
        check(delta.outside === 0, pose, 'visible-state-outside-eyes', {eyelid, direction: id, outside: delta.outside});
      }
      for (const amount of [EPSILON, .001, .01]) for (const {id, x, y} of directions.slice(1)) {
        const delta = compare(center, nativePixels(assets, pose, state, gaze(x * amount, y * amount)), width, bounds);
        const item = {eyelid, direction: id, amount, ...delta};
        poseReport.nearZero.push(item);
        check(delta.outside === 0, pose, 'near-zero-outside-eyes', {eyelid, direction: id, amount, outside: delta.outside});
        if (amount === EPSILON) {
          check(delta.maxDelta <= NEAR_ZERO_MAX_DELTA, pose, 'near-zero-path-continuity',
            {eyelid, direction: id, amount, maxDelta: delta.maxDelta, limit: NEAR_ZERO_MAX_DELTA});
        }
      }
    }

    const closed = {...neutral, eyeLeft: 'closed', eyeRight: 'closed'};
    const closedBase = nativePixels(approved, pose, closed, gaze());
    for (const {id, x, y} of directions) {
      const delta = compare(closedBase, nativePixels(assets, pose, closed, gaze(x, y)), width, bounds);
      poseReport.doubleClosed.push({direction: id, ...delta});
      check(delta.changed === 0, pose, 'double-closed-equals-approved', {direction: id, changed: delta.changed});
    }

    for (const closedEye of EYES) for (const otherState of ['open', 'half']) {
      const otherEye = EYES.find(eye => eye !== closedEye);
      const state = {...neutral, [closedEye]: 'closed', [otherEye]: otherState};
      const protectedRegions = {[closedEye]: [eyeMeta[closedEye].bounds, meta.patches[closedEye].closed.destination]};
      const base = nativePixels(approved, pose, state, gaze());
      const center = nativePixels(assets, pose, state, gaze());
      for (const {id, x, y} of directions) {
        const actual = nativePixels(assets, pose, state, gaze(x, y));
        const toApproved = compare(base, actual, width, bounds, protectedRegions);
        const toCenter = compare(center, actual, width, bounds, protectedRegions);
        poseReport.singleClosed.push({closedEye, otherState, direction: id, protectedRegions, toApproved, toCenter});
        for (const [comparison, delta] of Object.entries({toApproved, toCenter})) {
          check(delta.outside === 0 && delta.protectedChanged[closedEye] === 0, pose, 'single-closed-region-unchanged',
            {closedEye, otherState, direction: id, comparison, outside: delta.outside, closedEyeChanged: delta.protectedChanged[closedEye]});
        }
      }
    }

    const heading = document.createElement('h3'); heading.textContent = meta.label;
    const row = document.createElement('div'); row.className = 'row faces'; faceHost.append(heading, row);
    card(row, render(approved, pose, neutral, gaze()), '已确认基础表情');
    for (const direction of [directions[0], directions[1], directions[2], directions[5], directions[8]]) {
      card(row, render(assets, pose, neutral, gaze(direction.x, direction.y)), `视线：${direction.label}`);
    }
    output.textContent = JSON.stringify(report, null, 2);
    // Give the browser a chance to present the completed pose while the next is checked.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  report.status = 'complete'; report.summary.passed = report.summary.failedAssertions === 0;
  output.textContent = JSON.stringify(report, null, 2);
  summary.dataset.state = report.summary.passed ? 'passed' : 'failed';
  summary.textContent = `原生 ${report.nativeSize.join(' × ')} 像素；${report.summary.comparisons} 次比较、${report.summary.assertions} 项边界断言，${report.summary.failedAssertions} 项未通过。视觉效果仍需查看上方画面。`;
} catch (error) {
  output.textContent = JSON.stringify({schemaVersion: 1, status: 'error', error: error.message, stack: error.stack}, null, 2);
  summary.dataset.state = 'failed'; summary.textContent = `检查未完成：${error.message}`;
}
