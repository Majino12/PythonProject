import { SIDE_CHANNELS, sanitizeSideChannels, selectSideExpression, SIDE_DEMO, sampleSideDemo } from './side-expression-model.js';
import { loadSideExpressionAssets, drawSideExpression } from './side-expression-renderer.js';
import { SIDE_GAZE_CHANNELS, sanitizeSideGazeChannels, selectSideGaze } from './side-gaze.js';
import { SIDE_MOUTH_CHANNELS, sanitizeSideMouthChannels } from './side-mouth-model.js';
import { SIDE_BROW_CHANNELS, sanitizeSideBrowChannels, selectSideBrowExpression } from './side-brow-model.js';

const EXPRESSION_PRESETS = Object.freeze([
  { id: 'neutral', label: '中性', channels: {} },
  { id: 'halfBlink', label: '半闭眼', channels: { eyeBlinkLeft: .5, eyeBlinkRight: .5 } },
  { id: 'blink', label: '闭眼', channels: { eyeBlinkLeft: 1, eyeBlinkRight: 1 } },
  { id: 'winkLeft', label: '角色左眼眨眼', detail: '画面右眼', channels: { eyeBlinkLeft: 1 } },
  { id: 'winkRight', label: '角色右眼眨眼', detail: '画面左眼', channels: { eyeBlinkRight: 1 } },
  { id: 'openSmall', label: '小幅张嘴', channels: { jawOpen: .4 } },
  { id: 'openWide', label: '大幅张嘴', channels: { jawOpen: .95 } },
  { id: 'combination', label: '半闭眼、小幅张嘴', channels: { eyeBlinkLeft: .5, eyeBlinkRight: .5, jawOpen: .4 } },
].map(preset => Object.freeze({ ...preset, group: 'expression', channels: Object.freeze(sanitizeSideChannels(preset.channels)) })));
const GAZE_PRESETS = Object.freeze([
  { id: 'gazeLeft', label: '看画面左', channels: { eyeLookInLeft: .75, eyeLookOutRight: .75 } },
  { id: 'gazeRight', label: '看画面右', channels: { eyeLookOutLeft: .75, eyeLookInRight: .75 } },
  { id: 'gazeUp', label: '看上方', channels: { eyeLookUpLeft: .75, eyeLookUpRight: .75 } },
  { id: 'gazeDown', label: '看下方', channels: { eyeLookDownLeft: .75, eyeLookDownRight: .75 } },
  { id: 'gazeUpLeft', label: '看左上方', channels: { eyeLookInLeft: .7, eyeLookOutRight: .7, eyeLookUpLeft: .7, eyeLookUpRight: .7 } },
  { id: 'gazeUpRight', label: '看右上方', channels: { eyeLookOutLeft: .7, eyeLookInRight: .7, eyeLookUpLeft: .7, eyeLookUpRight: .7 } },
  { id: 'gazeDownLeft', label: '看左下方', channels: { eyeLookInLeft: .7, eyeLookOutRight: .7, eyeLookDownLeft: .7, eyeLookDownRight: .7 } },
  { id: 'gazeDownRight', label: '看右下方', channels: { eyeLookOutLeft: .7, eyeLookInRight: .7, eyeLookDownLeft: .7, eyeLookDownRight: .7 } },
  { id: 'halfGazeLeft', label: '半闭眼看画面左', channels: { eyeBlinkLeft: .5, eyeBlinkRight: .5, eyeLookInLeft: .75, eyeLookOutRight: .75 } },
  { id: 'closedGazeRight', label: '闭眼、视线向画面右', detail: '闭眼时不显示虹膜', channels: { eyeBlinkLeft: 1, eyeBlinkRight: 1, eyeLookOutLeft: .75, eyeLookInRight: .75 } },
].map(preset => Object.freeze({ ...preset, group: 'gaze', channels: Object.freeze(sanitizeReviewChannels(preset.channels, true, false, false)) })));
const MOUTH_PRESETS = Object.freeze([
  { id: 'pucker', label: '噘嘴', channels: { mouthPucker: 1 } },
  { id: 'press', label: '抿嘴', channels: { mouthPressLeft: 1, mouthPressRight: 1 } },
  { id: 'shiftLeft', label: '角色左移嘴', detail: '画面右', channels: { mouthLeft: 1 } },
  { id: 'shiftRight', label: '角色右移嘴', detail: '画面左', channels: { mouthRight: 1 } },
  { id: 'pressHalf', label: '半闭眼抿嘴', channels: { eyeBlinkLeft: .5, eyeBlinkRight: .5, mouthPressLeft: 1, mouthPressRight: 1 } },
  { id: 'puckerGaze', label: '噘嘴看画面左', channels: { mouthPucker: 1, eyeLookInLeft: .75, eyeLookOutRight: .75 } },
].map(preset => Object.freeze({ ...preset, group: 'mouth', channels: Object.freeze(sanitizeReviewChannels(preset.channels, true, true, false)) })));
const BROW_PRESETS = Object.freeze([
  { id: 'browsInnerUp', label: '双眉眉头抬起', channels: { browInnerUp: 1 } },
  { id: 'browsOuterUp', label: '双眉眉尾抬起', channels: { browOuterUpLeft: 1, browOuterUpRight: 1 } },
  { id: 'browsDown', label: '双眉压低', channels: { browDownLeft: 1, browDownRight: 1 } },
  { id: 'browOuterLeft', label: '角色左眉尾抬起', detail: '画面右眉', channels: { browOuterUpLeft: 1 } },
  { id: 'browOuterRight', label: '角色右眉尾抬起', detail: '画面左眉', channels: { browOuterUpRight: 1 } },
  { id: 'browDownLeft', label: '角色左眉压低', detail: '画面右眉', channels: { browDownLeft: 1 } },
  { id: 'browDownRight', label: '角色右眉压低', detail: '画面左眉', channels: { browDownRight: 1 } },
  { id: 'browAsymLeft', label: '左眉尾抬、右眉压低', detail: '左右按角色自身', channels: { browOuterUpLeft: 1, browDownRight: 1 } },
  { id: 'browAsymRight', label: '右眉尾抬、左眉压低', detail: '左右按角色自身', channels: { browOuterUpRight: 1, browDownLeft: 1 } },
  { id: 'browCombination', label: '眉头抬、半闭眼噘嘴', detail: '视线看画面左', channels: { browInnerUp: 1, eyeBlinkLeft: .5, eyeBlinkRight: .5, mouthPucker: 1, eyeLookInLeft: .75, eyeLookOutRight: .75 } },
].map(preset => Object.freeze({ ...preset, group: 'brows', channels: Object.freeze(sanitizeReviewChannels(preset.channels, true, true, true)) })));
const PRESETS = Object.freeze([...EXPRESSION_PRESETS, ...GAZE_PRESETS, ...MOUTH_PRESETS, ...BROW_PRESETS]);
const VARIANTS = Object.freeze({
  pitchBrows: { label: '俯仰眉毛小样', status: 'candidate', scope: '嘴型与视线已确认 · 新增眉毛待验收' },
  pitchMouth: { label: '已确认俯仰嘴型', status: 'approved', scope: '三个固定姿态的嘴型与组合表情已获确认' },
  pitchGaze: { label: '已确认俯仰视线', status: 'approved', scope: '三个固定姿态的基础表情与独立视线已获确认' },
  pitch: { label: '已确认俯仰基础表情', status: 'approved', scope: '三个固定姿态的基础表情已获确认' },
});
const STATUS_LABELS = Object.freeze({ undecided: '未判断', pass: '通过', revise: '需修改' });
const FRAME_LABELS = Object.freeze({ open: '睁眼', half: '半闭', closed: '闭眼', neutral: '中性', openSmall: '小张', openWide: '大张', pucker: '噘嘴', press: '抿嘴', shiftLeft: '角色左移（画面右）', shiftRight: '角色右移（画面左）' });
const BROW_LABELS = Object.freeze({ neutral: '中性', innerUp: '眉头抬', outerUp: '眉尾抬', down: '压低' });
const presetById = new Map(PRESETS.map(preset => [preset.id, preset]));
const MOUTH_DEMO = Object.freeze({
  duration: 12,
  steps: Object.freeze([
    { start: 0, end: 1, id: 'neutral', label: '中性' },
    { start: 1, end: 3, id: 'pucker', label: '噘嘴' },
    { start: 3, end: 3.5, id: 'neutral', label: '回到中性' },
    { start: 3.5, end: 5.5, id: 'press', label: '抿嘴' },
    { start: 5.5, end: 6, id: 'neutral', label: '回到中性' },
    { start: 6, end: 8, id: 'shiftLeft', label: '角色左移嘴（画面右）' },
    { start: 8, end: 8.5, id: 'neutral', label: '回到中性' },
    { start: 8.5, end: 10.5, id: 'shiftRight', label: '角色右移嘴（画面左）' },
    { start: 10.5, end: 12, id: 'neutral', label: '回到中性' },
  ].map(step => Object.freeze({ ...step, channels: presetById.get(step.id).channels }))),
});
const BROW_DEMO = Object.freeze({
  duration: 12,
  steps: Object.freeze([
    { start: 0, end: 1, id: 'neutral', label: '中性' },
    { start: 1, end: 3, id: 'browsInnerUp', label: '双眉眉头抬起' },
    { start: 3, end: 3.5, id: 'neutral', label: '回到中性' },
    { start: 3.5, end: 5.5, id: 'browsOuterUp', label: '双眉眉尾抬起' },
    { start: 5.5, end: 6, id: 'neutral', label: '回到中性' },
    { start: 6, end: 8, id: 'browsDown', label: '双眉压低' },
    { start: 8, end: 8.5, id: 'neutral', label: '回到中性' },
    { start: 8.5, end: 10.5, id: 'browAsymLeft', label: '左眉尾抬、右眉压低' },
    { start: 10.5, end: 12, id: 'neutral', label: '回到中性' },
  ].map(step => Object.freeze({ ...step, channels: presetById.get(step.id).channels }))),
});
const $ = selector => document.querySelector(selector);
const feedbackCache = new Map();
const storageWarnings = new Map();
let assets;
let ready = false;
let variant = 'pitchBrows';
let selectedGroup = 'brows';
let poseId = 'view-left-up';
let coefficients = sanitizeSideChannels({});
let renderedState = selectSideExpression(coefficients);
let activePresetId = 'neutral';
let renderMode = 'static';
let faceOnly = true;
let playing = false;
let animationFrame = 0;
let demoStartedAt = 0;
let lastDemoStep = null;
let activeDemo = SIDE_DEMO;
let loadSequence = 0;

const emptyFeedback = () => ({ status: 'undecided', note: '', updatedAt: null });
const poseMeta = () => assets.manifest.poses[poseId];
const hasGaze = () => Boolean(assets?.manifest.gaze);
const hasMouthArt = () => Boolean(assets?.manifest.mouthArt);
const hasBrowArt = () => Boolean(assets?.manifest.browArt);
const visiblePresets = () => [...EXPRESSION_PRESETS, ...(hasGaze() ? GAZE_PRESETS : []), ...(hasMouthArt() ? MOUTH_PRESETS : []), ...(hasBrowArt() ? BROW_PRESETS : [])];
const visibleChannels = () => [...(hasBrowArt() ? SIDE_BROW_CHANNELS : hasMouthArt() ? SIDE_MOUTH_CHANNELS : SIDE_CHANNELS), ...(hasGaze() ? SIDE_GAZE_CHANNELS : [])];
const selectReviewExpression = (channels, previous = {}) => selectSideBrowExpression(channels, previous, { mouthArt: hasMouthArt(), browArt: hasBrowArt() });
const currentGaze = () => selectSideGaze(coefficients, { gaze: hasGaze() });
const selectedDemo = () => hasBrowArt() && selectedGroup === 'brows' ? BROW_DEMO : hasMouthArt() && selectedGroup === 'mouth' ? MOUTH_DEMO : SIDE_DEMO;
const demoButtonLabel = () => selectedDemo() === BROW_DEMO ? '播放眉毛演示' : selectedDemo() === MOUTH_DEMO ? '播放嘴型演示' : '播放逐稿演示';
const feedbackKey = (pose, preset) => `vtuber-pitch-expression-review:${[assets.manifest.id, assets.manifest.version, pose, preset].map(value => encodeURIComponent(String(value))).join(':')}`;
const feedbackFor = (pose, preset) => feedbackCache.get(feedbackKey(pose, preset));
const frameSummary = state => `角色左眼 ${FRAME_LABELS[state.eyeLeft]} / 角色右眼 ${FRAME_LABELS[state.eyeRight]} · 嘴 ${FRAME_LABELS[state.mouth]}${state.browLeft ? ` · 左眉 ${BROW_LABELS[state.browLeft]} / 右眉 ${BROW_LABELS[state.browRight]}` : ''}`;

function sanitizeReviewChannels(input, gaze = hasGaze(), mouthArt = hasMouthArt(), browArt = hasBrowArt()) {
  return { ...(browArt ? sanitizeSideBrowChannels(input) : mouthArt ? sanitizeSideMouthChannels(input) : sanitizeSideChannels(input)), ...(gaze ? sanitizeSideGazeChannels(input) : {}) };
}

function restoreFeedback() {
  for (const pose of Object.keys(assets.manifest.poses)) for (const preset of visiblePresets()) {
    const key = feedbackKey(pose, preset.id);
    if (feedbackCache.has(key)) continue;
    let item = emptyFeedback();
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.schemaVersion !== 1 || saved.assetId !== assets.manifest.id || saved.assetVersion !== assets.manifest.version
          || saved.poseId !== pose || saved.presetId !== preset.id || !saved.feedback || !Object.hasOwn(STATUS_LABELS, saved.feedback.status)) throw new Error('反馈版本不匹配');
        item = { status: saved.feedback.status, note: typeof saved.feedback.note === 'string' ? saved.feedback.note.slice(0, 4000) : '',
          updatedAt: typeof saved.feedback.updatedAt === 'string' && Number.isFinite(Date.parse(saved.feedback.updatedAt)) ? saved.feedback.updatedAt : null };
      }
    } catch { storageWarnings.set(key, '未能读取此项旧反馈；本次仍可记录并导出 JSON。'); }
    feedbackCache.set(key, item);
  }
}

function updateProgress() {
  const presets = visiblePresets();
  const values = Object.keys(assets.manifest.poses).flatMap(pose => presets.map(preset => feedbackFor(pose, preset.id)));
  const current = presets.map(preset => feedbackFor(poseId, preset.id));
  $('#reviewProgress').textContent = `当前版本 · 当前姿态 ${current.filter(item => item.status !== 'undecided').length} / ${presets.length} 项已评价 · 全部姿态 ${values.filter(item => item.status !== 'undecided').length} / ${values.length} 项 · ${values.filter(item => item.status === 'revise').length} 项需修改`;
}

function updateFeedbackPanel() {
  if (!ready) return;
  const preset = presetById.get(activePresetId);
  const item = preset ? feedbackFor(poseId, preset.id) : null;
  const warning = preset ? storageWarnings.get(feedbackKey(poseId, preset.id)) : null;
  $('#feedbackHeading').textContent = preset ? `${preset.label} · 可选反馈` : '自定义参数';
  $('#feedbackControls').disabled = playing || !preset || $('#originalToggle').checked;
  $('#feedbackHint').textContent = playing ? '暂停后可以评价当前预设；演示不会写入反馈。'
    : $('#originalToggle').checked ? '当前显示原画，关闭对照后可以评价表情。'
      : preset ? `${poseMeta().label} · 按版本、姿态分别保存，默认未判断。` : '选择预设后可以评价；导出会保留当前参数。';
  for (const radio of document.querySelectorAll('[name="feedbackStatus"]')) radio.checked = radio.value === (item?.status || 'undecided');
  $('#feedbackNote').value = item?.note || '';
  $('#saveStatus').textContent = warning || (item?.updatedAt ? '已恢复此姿态、此预设的反馈。' : '尚未记录此预设的评价。');
  $('#saveStatus').className = `save-status${warning ? ' warning' : ''}`;
  updateProgress();
}

function updateSelection() {
  for (const button of document.querySelectorAll('[data-preset]')) button.setAttribute('aria-pressed', String(button.dataset.preset === activePresetId));
  for (const button of document.querySelectorAll('[data-pose]')) button.setAttribute('aria-pressed', String(button.dataset.pose === poseId));
  for (const button of document.querySelectorAll('[data-group]')) button.setAttribute('aria-pressed', String(button.dataset.group === selectedGroup));
}

function syncSliders() {
  for (const slider of document.querySelectorAll('[data-channel]')) {
    slider.value = String(coefficients[slider.dataset.channel]);
    slider.closest('label').querySelector('output').textContent = coefficients[slider.dataset.channel].toFixed(2);
  }
}

function fail(error) {
  ready = false; stopDemo();
  $('#workspaceControls').disabled = true;
  $('#loadStatus').hidden = false; $('#loadStatus').className = 'load-status error';
  $('#loadStatus').textContent = `俯仰表情未能完整载入或绘制：${error?.message || '未知错误'}。可重新载入，或切换到已确认俯仰基础表情。`;
  $('#scopeSummary').textContent = '此版本未能载入';
  $('#retryLoad').hidden = false;
  $('#expressionCanvas').hidden = true; $('#referenceCanvas').hidden = true;
  $('#canvasPlaceholder').hidden = false; $('#canvasPlaceholder').textContent = '画稿载入失败'; $('#canvasPlaceholder').className = 'error';
  for (const button of document.querySelectorAll('[data-pose]')) button.disabled = true;
}

function paint() {
  if (!ready) return;
  try {
    const original = $('#originalToggle').checked, guides = $('#guidesToggle').checked, gaze = currentGaze();
    drawSideExpression($('#expressionCanvas'), assets, poseId, renderedState, { faceOnly, original, guides, gaze });
    $('#previewBadge').textContent = original ? '已确认原画' : playing ? '逐稿演示中' : renderMode === 'frames' ? '已暂停当前画稿' : '静止预览';
    $('#guidesCaption').hidden = !guides;
    const gazeNote = hasGaze() ? `；视线以画面右、下为正，角色左眼 ${gaze.eyeLeft.x.toFixed(2)}, ${gaze.eyeLeft.y.toFixed(2)}，角色右眼 ${gaze.eyeRight.x.toFixed(2)}, ${gaze.eyeRight.y.toFixed(2)}` : '';
    $('#expressionCanvas').setAttribute('aria-label', `${poseMeta().label}，${original ? '已确认原画' : frameSummary(renderedState) + gazeNote}`);
    $('#stateReadout').textContent = original
      ? `当前显示：${poseMeta().label}的已确认原画。\n暂存表情：${frameSummary(renderedState)}${gazeNote}\n关闭原画对照后恢复表情与视线。`
      : `${poseMeta().label}\n${frameSummary(renderedState)}${gazeNote}`;
  } catch (error) { fail(error); }
}

function stopDemo(message = '演示已暂停，保留当前画稿。') {
  const wasPlaying = playing;
  playing = false; cancelAnimationFrame(animationFrame); animationFrame = 0;
  $('#demoToggle').setAttribute('aria-pressed', 'false'); $('#demoToggle').textContent = demoButtonLabel();
  if (wasPlaying) $('#motionStatus').textContent = message;
  if (ready && wasPlaying) { updateFeedbackPanel(); paint(); }
}

function updateDemoChoice() {
  if (playing) return;
  $('#demoToggle').textContent = demoButtonLabel();
  $('#motionStatus').textContent = selectedDemo() === BROW_DEMO
    ? '12 秒眉毛观察；逐稿演示眉头抬、眉尾抬、压眉与不对称组合，演示时姿态固定、视线居中。'
    : selectedDemo() === MOUTH_DEMO
    ? '12 秒嘴型观察；逐稿演示噘嘴、抿嘴与左右移嘴，演示时姿态固定、视线居中。'
    : '10 秒逐稿观察；演示时姿态固定、视线居中。';
}

function setChannels(next, { presetId = null, reset = false, label, mode = 'manual' } = {}) {
  coefficients = sanitizeReviewChannels(next);
  renderedState = selectReviewExpression(coefficients, reset ? {} : renderedState);
  activePresetId = presetId; renderMode = mode;
  $('#previewHeading').textContent = label || presetById.get(presetId)?.label || '自定义参数';
  updateSelection(); syncSliders(); paint();
}

function selectPreset(preset) {
  if (!ready) return;
  stopDemo(); $('#originalToggle').checked = false;
  if (preset.group !== selectedGroup) { selectedGroup = preset.group; buildPresetButtons(); }
  setChannels(preset.channels, { presetId: preset.id, reset: true, mode: 'static' });
  updateDemoChoice();
  updateFeedbackPanel();
}

function buildSequenceReview() {
  const rows = [
    { title: '眼睛 · 从睁到闭', detail: 'eyes', neutral: '睁眼', ids: ['neutral', 'halfBlink', 'blink'] },
    { title: '嘴部 · 从闭到开', detail: 'mouth', neutral: '闭合', ids: ['neutral', 'openSmall', 'openWide'] },
  ];
  if (hasMouthArt()) rows.push({ title: '嘴型 · 中性与独立画稿', detail: 'mouth', neutral: '中性', ids: ['neutral', 'pucker', 'press', 'shiftLeft', 'shiftRight'] });
  if (hasBrowArt()) rows.push({ title: '眉毛 · 中性与三种画稿', detail: 'brows', neutral: '中性', ids: ['neutral', 'browsInnerUp', 'browsOuterUp', 'browsDown'] });
  $('#sequenceScope').textContent = hasBrowArt() ? '眼睛 · 张嘴 · 嘴型 · 眉毛并排' : hasMouthArt() ? '眼睛三档 · 张嘴三档 · 四种嘴型' : '眼睛三档 · 嘴型三档';
  $('#sequenceRows').replaceChildren(...rows.map(row => {
    const section = document.createElement('section'); section.className = 'sequence-row';
    const heading = document.createElement('h3'); heading.textContent = `${poseMeta().label} · ${row.title}`;
    const strip = document.createElement('div'); strip.className = `sequence-strip${row.ids.length === 5 ? ' mouth-sequence-strip' : row.ids.length === 4 ? ' brow-sequence-strip' : ''}`;
    strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', row.title);
    for (const id of row.ids) {
      const preset = presetById.get(id), label = id === 'neutral' ? row.neutral : preset.label;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'sequence-card'; button.dataset.preset = id;
      button.setAttribute('aria-label', `${label}，选择此预设`);
      const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true');
      drawSideExpression(canvas, assets, poseId, selectReviewExpression(preset.channels), { detail: row.detail, original: false, guides: false });
      const caption = document.createElement('span'); caption.className = 'sequence-caption'; caption.textContent = label;
      button.append(canvas, caption); button.addEventListener('click', () => selectPreset(preset)); strip.append(button);
    }
    section.append(heading, strip); return section;
  }));
  updateSelection();
}

function selectPose(nextPose) {
  if (!ready || !Object.hasOwn(assets.manifest.poses, nextPose)) return;
  stopDemo();
  const group = selectedGroup;
  poseId = nextPose;
  $('#poseCaption').textContent = poseMeta().label; $('#directionNote').textContent = poseMeta().directionNote;
  $('#referenceHeading').textContent = `${poseMeta().label}原画`;
  try {
    selectPreset(presetById.get('neutral'));
    if (!ready) return;
    selectedGroup = hasGaze() ? group : 'expression';
    buildPresetButtons();
    updateDemoChoice();
    drawSideExpression($('#referenceCanvas'), assets, poseId, selectSideExpression({}), { faceOnly: false, original: true, guides: false });
    $('#referenceCanvas').setAttribute('aria-label', `${poseMeta().label}的已确认原画`);
    buildSequenceReview();
  } catch (error) { fail(error); }
}

function buildPresetButtons() {
  $('#gazeDirectionHint').hidden = !hasGaze() || selectedGroup !== 'gaze';
  $('#mouthDirectionHint').hidden = !hasMouthArt() || selectedGroup !== 'mouth';
  $('#browDirectionHint').hidden = !hasBrowArt() || selectedGroup !== 'brows';
  $('#presetButtons').replaceChildren(...visiblePresets().filter(preset => preset.group === selectedGroup).map(preset => {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.preset = preset.id; button.textContent = preset.label;
    if (preset.detail) { const detail = document.createElement('small'); detail.textContent = preset.detail; button.append(detail); }
    button.addEventListener('click', () => selectPreset(preset)); return button;
  }));
  updateSelection();
}

function buildControls() {
  $('#poseButtons').replaceChildren(...Object.entries(assets.manifest.poses).map(([id, meta]) => {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.pose = id; button.textContent = meta.label;
    const detail = document.createElement('span'); detail.textContent = hasBrowArt() ? '固定姿态 · 新眉毛待验收' : hasMouthArt() ? '固定姿态 · 嘴型已确认' : hasGaze() ? '固定姿态 · 表情与视线已确认' : '固定姿态 · 基础表情已确认';
    button.append(detail); button.addEventListener('click', () => selectPose(id)); return button;
  }));
  $('#presetGroups').hidden = !hasGaze();
  $('#mouthGroupButton').hidden = !hasMouthArt();
  $('#browGroupButton').hidden = !hasBrowArt();
  $('#presetGroups').classList.toggle('has-mouth', hasMouthArt());
  $('#presetGroups').classList.toggle('has-brows', hasBrowArt());
  if (!hasGaze()) selectedGroup = 'expression';
  buildPresetButtons();
  $('#channelCount').textContent = `${visibleChannels().length} 个 ARKit 通道 · JSON 导入`;
  $('#capabilityIntro').textContent = hasBrowArt()
    ? '画面左上、画面右上、画面左下三个固定姿态的表情、嘴型与视线已获确认。本轮新增眉头抬起、眉尾抬起与压眉，每姿态 34 个预设，共 102 项可选反馈；新增眉毛仍待视觉验收。'
    : hasMouthArt()
    ? '画面左上、画面右上、画面左下三个固定姿态的表情、嘴型与独立视线已获确认。此版本保留原画眉毛，每姿态 24 个预设，共 72 项可选反馈。'
    : hasGaze() ? '画面左上、画面右上、画面左下三个固定姿态的基础表情与独立视线已获确认。此版本每姿态 18 个预设，共 54 项可选反馈。'
    : '画面左上、画面右上、画面左下三个固定姿态的基础表情已获确认。此版本保留原画视线，每姿态 8 个预设，共 24 项可选反馈。';
  $('#gazeCapability').hidden = !hasGaze();
  $('#gazeDifferenceNote').hidden = !hasGaze();
  $('#mouthCapability').hidden = !hasMouthArt();
  $('#browCapability').hidden = !hasBrowArt();
  $('#channelHelp').textContent = hasBrowArt()
    ? '眉头抬起同时作用于双眉；眉尾抬起与压眉按角色左右独立选择。每侧冲突优先级：压低 → 眉头抬 → 眉尾抬。每种眉形只有一张强度稿，系数跨阈值换稿。'
    : hasMouthArt()
    ? '嘴型冲突优先级：闭合 → 抿嘴 → 噘嘴 → 左右移嘴 → 张嘴。单侧抿嘴近似整嘴动作；没有噘嘴加移嘴的独立组合稿。'
    : hasGaze() ? '左右眼可以独立闭合，也可以独立控制视线；方向名称以角色自身为准。'
    : '左右眼可以独立闭合；张嘴与闭合嘴巴共同决定开口档位。此版本保留原画视线。';
  $('#channelSliders').replaceChildren(...visibleChannels().map(channel => {
    const label = document.createElement('label'); label.className = 'channel-control';
    const title = document.createElement('span'); title.className = 'channel-title'; title.textContent = channel.label;
    const output = document.createElement('output'); output.textContent = '0.00';
    const code = document.createElement('code'); code.textContent = channel.key;
    const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '1'; slider.step = '.01'; slider.value = '0';
    slider.dataset.channel = channel.key; slider.id = `channel-${channel.key}`; output.htmlFor = slider.id;
    title.append(output); label.append(title, code, slider);
    slider.addEventListener('input', () => {
      stopDemo(); $('#originalToggle').checked = false;
      setChannels({ ...coefficients, [channel.key]: Number(slider.value) }); updateFeedbackPanel();
    }); return label;
  }));
}

function demoTick(now) {
  if (!playing || !ready) return;
  const seconds = (now - demoStartedAt) / 1000, phase = seconds % activeDemo.duration;
  const step = activeDemo.steps.find(item => phase >= item.start && phase < item.end);
  if (!step) { fail(new Error('逐稿演示时间表不完整')); return; }
  if (lastDemoStep !== step) {
    lastDemoStep = step;
    const id = step.id === 'rest' ? 'neutral' : presetById.has(step.id) ? step.id : null;
    const channels = activeDemo === SIDE_DEMO ? sampleSideDemo(seconds) : step.channels;
    setChannels(channels, { presetId: id, label: step.label, reset: true, mode: 'frames' });
    $('#motionStatus').textContent = `${activeDemo.duration} 秒循环 · ${step.label} · 姿态固定，视线居中`;
    updateFeedbackPanel();
  }
  if (playing && ready) animationFrame = requestAnimationFrame(demoTick);
}

function toggleDemo() {
  if (playing) { stopDemo(); return; }
  if (!ready) return;
  activeDemo = selectedDemo();
  $('#originalToggle').checked = false; playing = true; lastDemoStep = null; demoStartedAt = performance.now();
  $('#demoToggle').setAttribute('aria-pressed', 'true'); $('#demoToggle').textContent = '暂停演示';
  updateFeedbackPanel(); demoTick(demoStartedAt);
}

function saveFeedback() {
  if (!ready || playing || !presetById.has(activePresetId) || $('#originalToggle').checked) return;
  const key = feedbackKey(poseId, activePresetId);
  const status = document.querySelector('[name="feedbackStatus"]:checked')?.value || 'undecided';
  const feedback = { status, note: $('#feedbackNote').value.slice(0, 4000), updatedAt: new Date().toISOString() };
  feedbackCache.set(key, feedback);
  try {
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, assetId: assets.manifest.id, assetVersion: assets.manifest.version, poseId, presetId: activePresetId, feedback }));
    storageWarnings.delete(key); $('#saveStatus').textContent = '已自动保存此姿态、此预设的反馈。'; $('#saveStatus').className = 'save-status';
  } catch {
    const warning = '浏览器未能保存此项反馈，请离开前导出 JSON。';
    storageWarnings.set(key, warning); $('#saveStatus').textContent = warning; $('#saveStatus').className = 'save-status warning';
  }
  updateProgress();
}

function applyJson() {
  if (!ready) return;
  stopDemo(); const status = $('#importStatus');
  try {
    const parsed = JSON.parse($('#channelJson').value);
    const input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'coefficients') ? parsed.coefficients : parsed;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请提供 JSON 通道对象。');
    const keys = new Set(visibleChannels().map(channel => channel.key));
    const supported = Object.keys(input).filter(key => keys.has(key)), unknown = Object.keys(input).filter(key => !keys.has(key));
    const ignored = unknown.length ? `已忽略未支持通道：${unknown.join('、')}。` : '';
    if (!supported.length) { status.textContent = `${ignored}没有本页支持的通道，当前参数保持不变。`; status.className = 'warning'; return; }
    for (const key of supported) if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1) throw new Error(`${key} 必须是 0–1 之间的有限数字。`);
    const next = sanitizeReviewChannels(Object.fromEntries(supported.map(key => [key, input[key]])));
    $('#originalToggle').checked = false; setChannels(next, { reset: true }); updateFeedbackPanel();
    status.textContent = `已应用 ${supported.length} 个通道；未提供的通道设为 0。${ignored}导入不会切换姿态或写入评价。`;
    status.className = unknown.length ? 'warning' : '';
  } catch (error) { status.textContent = `未应用：${error.message} 当前参数保持不变。`; status.className = 'warning'; }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFeedback() {
  stopDemo(); paint(); if (!ready) return;
  const original = $('#originalToggle').checked, exportedAt = new Date().toISOString();
  const payload = {
    schemaVersion: 1, scope: hasBrowArt() ? '三个固定俯仰姿态的新增眉毛小样；表情、嘴型与视线已确认，画面右下未接入。' : hasMouthArt() ? '三个固定俯仰姿态的已确认表情、嘴型与独立视线；画面右下未接入。' : hasGaze() ? '三个固定俯仰姿态的已确认基础表情与独立视线；画面右下未接入。' : '三个固定俯仰姿态的已确认基础表情；画面右下未接入，不代表连续俯仰模型。',
    assetId: assets.manifest.id, assetVersion: assets.manifest.version, assetStatus: assets.manifest.status, variant, exportedAt,
    currentPose: poseId, poseLabel: poseMeta().label, directionNote: poseMeta().directionNote,
    coefficients: { ...coefficients }, renderedState: original ? selectReviewExpression({}) : { ...renderedState }, targetState: { ...renderedState },
    renderedGaze: original ? selectSideGaze({}) : currentGaze(), targetGaze: currentGaze(),
    supportedChannels: visibleChannels().map(channel => channel.key), mode: original ? 'original' : renderMode, playing,
    currentPreset: activePresetId, visibleContent: original ? 'approved-original' : 'renderedState',
    preview: { faceOnly, guides: $('#guidesToggle').checked, original }, sources: assets.manifest.sources,
    feedback: Object.entries(assets.manifest.poses).flatMap(([pose, meta]) => visiblePresets().map(preset => ({ poseId: pose, poseLabel: meta.label, id: preset.id, label: preset.label, coefficients: sanitizeReviewChannels(preset.channels), ...feedbackFor(pose, preset.id) }))),
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), `pitch-expression-feedback-${variant}-${exportedAt.replace(/[:.]/g, '-')}.json`);
  $('#saveStatus').textContent = '已准备反馈 JSON，包含当前表情与全部姿态的预设评价。';
}

function exportPng() {
  stopDemo(); paint(); if (!ready) return;
  try {
    const frameLabel = $('#originalToggle').checked ? 'original' : activePresetId || 'custom';
    const filename = `pitch-expression-${variant}-${poseId}-${frameLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    $('#expressionCanvas').toBlob(blob => {
      if (!blob) { $('#saveStatus').textContent = 'PNG 导出失败，请重新尝试。'; return; }
      download(blob, filename); $('#saveStatus').textContent = '已准备当前预览的 PNG 下载。';
    }, 'image/png');
  } catch (error) { $('#saveStatus').textContent = `PNG 导出失败：${error.message}`; }
}

async function loadAssets(nextVariant = variant) {
  if (!Object.hasOwn(VARIANTS, nextVariant)) return;
  const request = ++loadSequence;
  variant = nextVariant;
  const meta = VARIANTS[nextVariant];
  stopDemo(); ready = false; $('#workspaceControls').disabled = true; $('#retryLoad').hidden = true;
  $('#loadStatus').hidden = false; $('#loadStatus').className = 'load-status'; $('#loadStatus').textContent = `正在完整载入${meta.label}…`;
  $('#variantStatus').textContent = meta.label; $('#scopeSummary').textContent = '正在载入，请稍候';
  for (const button of document.querySelectorAll('[data-variant]')) button.setAttribute('aria-pressed', String(button.dataset.variant === nextVariant));
  $('#expressionCanvas').hidden = true; $('#referenceCanvas').hidden = true;
  $('#canvasPlaceholder').hidden = false; $('#canvasPlaceholder').className = ''; $('#canvasPlaceholder').textContent = '正在载入画稿…';
  for (const button of document.querySelectorAll('[data-pose]')) button.disabled = true;
  $('#sequenceRows').replaceChildren();
  try {
    const loaded = await loadSideExpressionAssets(nextVariant);
    if (request !== loadSequence) return;
    if (!loaded?.manifest?.id || loaded.manifest.version == null || !loaded.manifest.poses || !Object.keys(loaded.manifest.poses).length
      || loaded.manifest.poseFamily !== 'pitch' || loaded.manifest.status !== meta.status
      || Boolean(loaded.manifest.gaze) !== ['pitchGaze', 'pitchMouth', 'pitchBrows'].includes(nextVariant)
      || Boolean(loaded.manifest.mouthArt) !== ['pitchMouth', 'pitchBrows'].includes(nextVariant)
      || Boolean(loaded.manifest.browArt) !== (nextVariant === 'pitchBrows')) throw new Error('素材版本与功能范围不匹配');
    assets = loaded;
    selectedGroup = hasBrowArt() ? 'brows' : hasMouthArt() ? 'mouth' : hasGaze() ? 'gaze' : 'expression';
    if (!Object.hasOwn(assets.manifest.poses, poseId)) poseId = Object.keys(assets.manifest.poses)[0];
    restoreFeedback(); buildControls(); ready = true; selectPose(poseId); if (!ready) return;
    $('#workspaceControls').disabled = false; $('#loadStatus').hidden = true;
    $('#canvasPlaceholder').hidden = true; $('#expressionCanvas').hidden = false; $('#referenceCanvas').hidden = false;
    $('#scopeSummary').textContent = meta.scope;
    $('#importStatus').textContent = `当前版本支持 ${visibleChannels().length} 个通道；可重新应用 JSON。未支持的通道会列出并忽略。`;
    $('#importStatus').className = '';
  } catch (error) { if (request === loadSequence) fail(error); }
}

function init() {
  for (const button of document.querySelectorAll('[data-variant]')) button.addEventListener('click', () => loadAssets(button.dataset.variant));
  for (const button of document.querySelectorAll('[data-group]')) button.addEventListener('click', () => {
    if (!ready || (button.dataset.group === 'gaze' && !hasGaze()) || (button.dataset.group === 'mouth' && !hasMouthArt()) || (button.dataset.group === 'brows' && !hasBrowArt())) return;
    stopDemo(); selectedGroup = button.dataset.group; buildPresetButtons(); updateDemoChoice();
  });
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
    stopDemo(); faceOnly = button.dataset.view === 'face';
    for (const item of document.querySelectorAll('[data-view]')) item.setAttribute('aria-pressed', String(item === button)); paint();
  });
  for (const id of ['#guidesToggle', '#originalToggle']) $(id).addEventListener('change', () => { stopDemo(); updateFeedbackPanel(); paint(); });
  for (const id of ['#advancedControls', '#sequenceReview', '#capabilityPanel']) $(id).addEventListener('toggle', () => { if ($(id).open) stopDemo(); });
  $('#demoToggle').addEventListener('click', toggleDemo);
  for (const radio of document.querySelectorAll('[name="feedbackStatus"]')) radio.addEventListener('change', saveFeedback);
  $('#feedbackNote').addEventListener('input', saveFeedback);
  $('#applyJson').addEventListener('click', applyJson); $('#channelJson').addEventListener('input', () => stopDemo());
  $('#exportFeedback').addEventListener('click', exportFeedback); $('#exportPng').addEventListener('click', exportPng);
  $('#retryLoad').addEventListener('click', () => loadAssets());
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopDemo('页面已隐藏，演示暂停。'); });
  window.addEventListener('pagehide', () => stopDemo('离开页面，演示已暂停。'));
  loadAssets();
}

init();
