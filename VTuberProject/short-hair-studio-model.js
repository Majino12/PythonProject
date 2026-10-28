import {CHANNELS, sanitizeChannels} from './expression-model.js';

export const STUDIO_CHANNELS = CHANNELS;
export const STUDIO_STORAGE_KEY = 'moemotion:short-hair-studio:project:v1';
export const STUDIO_POSES = Object.freeze([
  ['view-left-up', -1, 1], ['view-up', 0, 1], ['view-right-up', 1, 1],
  ['view-left', -1, 0], ['front', 0, 0], ['view-right', 1, 0],
  ['view-left-down', -1, -1], ['view-down', 0, -1], ['view-right-down', 1, -1],
].map(([id, yaw, pitch]) => Object.freeze({id, yaw, pitch})));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const poseIds = new Set(STUDIO_POSES.map(pose => pose.id));
const channelKeys = new Set(CHANNELS.map(channel => channel.key));
const signed = value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;

export function selectStudioPose(input, previousPoseId = 'front') {
  const old = STUDIO_POSES.find(pose => pose.id === previousPoseId) || STUDIO_POSES[4];
  const axis = (value, previous) => value >= .42 ? 1 : value <= -.42 ? -1
    : previous === 1 && value > .28 ? 1 : previous === -1 && value < -.28 ? -1 : 0;
  const yaw = axis(signed(input?.yaw), old.yaw), pitch = axis(signed(input?.pitch), old.pitch);
  return STUDIO_POSES.find(pose => pose.yaw === yaw && pose.pitch === pitch).id;
}

export function gazeChannels(x, y) {
  x = signed(x); y = signed(y);
  return {
    eyeLookOutLeft: Math.max(0, x), eyeLookInLeft: Math.max(0, -x),
    eyeLookInRight: Math.max(0, x), eyeLookOutRight: Math.max(0, -x),
    eyeLookUpLeft: Math.max(0, -y), eyeLookUpRight: Math.max(0, -y),
    eyeLookDownLeft: Math.max(0, y), eyeLookDownRight: Math.max(0, y),
  };
}

export const STUDIO_PRESETS = Object.freeze([
  {id: 'neutral', label: '睁眼', group: 'eyes', channels: {}},
  {id: 'half', label: '半闭眼', group: 'eyes', channels: {eyeBlinkLeft: .5, eyeBlinkRight: .5}},
  {id: 'blink', label: '闭眼', group: 'eyes', channels: {eyeBlinkLeft: 1, eyeBlinkRight: 1}},
  {id: 'winkLeft', label: '左眼眨眼', group: 'eyes', channels: {eyeBlinkLeft: 1}},
  {id: 'winkRight', label: '右眼眨眼', group: 'eyes', channels: {eyeBlinkRight: 1}},
  {id: 'mouthNeutral', label: '闭嘴', group: 'mouth', channels: {}},
  {id: 'openSmall', label: '轻轻张嘴', group: 'mouth', channels: {jawOpen: .4}},
  {id: 'openWide', label: '张大嘴', group: 'mouth', channels: {jawOpen: .95}},
  {id: 'pucker', label: '噘嘴', group: 'mouth', channels: {mouthPucker: 1}},
  {id: 'press', label: '抿嘴', group: 'mouth', channels: {mouthPressLeft: 1, mouthPressRight: 1}},
  {id: 'shiftLeft', label: '嘴向左', group: 'mouth', channels: {mouthLeft: 1}},
  {id: 'shiftRight', label: '嘴向右', group: 'mouth', channels: {mouthRight: 1}},
  {id: 'browNeutral', label: '放松眉毛', group: 'brows', channels: {}},
  {id: 'innerUp', label: '抬眉头', group: 'brows', channels: {browInnerUp: 1}},
  {id: 'outerUp', label: '抬眉尾', group: 'brows', channels: {browOuterUpLeft: 1, browOuterUpRight: 1}},
  {id: 'down', label: '压眉', group: 'brows', channels: {browDownLeft: 1, browDownRight: 1}},
  {id: 'asymmetric', label: '挑起左眉', group: 'brows', channels: {browOuterUpLeft: 1, browDownRight: 1}},
].map(preset => Object.freeze({...preset, channels: Object.freeze({...preset.channels})})));

/** Quick actions replace one facial group, retaining independently chosen groups. */
export function applyStudioPreset(channels, presetId) {
  const preset = STUDIO_PRESETS.find(item => item.id === presetId);
  if (!preset) throw new Error('没有这个表情动作。');
  const next = sanitizeChannels(channels);
  for (const channel of CHANNELS) if (channel.group === preset.group) next[channel.key] = 0;
  return sanitizeChannels({...next, ...preset.channels});
}

export function parseStudioFrame(text) {
  if (typeof text !== 'string' || text.length > 65536) throw new Error('JSON 不能超过 64 KB。');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('JSON 格式不正确。'); }
  const raw = object(parsed) && Object.hasOwn(parsed, 'coefficients') ? parsed.coefficients
    : object(parsed) && Object.hasOwn(parsed, 'blendshapes') ? parsed.blendshapes : parsed;
  if (!object(raw)) throw new Error('需要 ARKit 通道对象，例如 {"jawOpen":0.7}。');
  const supported = Object.keys(raw).filter(key => channelKeys.has(key));
  if (!supported.length) throw new Error('没有本角色支持的通道，当前状态保持不变。');
  for (const key of supported) if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0 || raw[key] > 1) {
    throw new Error(`${key} 需要 0–1 之间的数字。`);
  }
  return {coefficients: sanitizeChannels(raw), ignored: Object.keys(raw).filter(key => !channelKeys.has(key))};
}

export function createStudioProject(input = {}) {
  const value = object(input) ? input : {};
  return {
    schemaVersion: 1, kind: 'moemotion-short-hair-project', characterId: 'short-hair-v1',
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 60) : '我的短发角色',
    poseId: poseIds.has(value.poseId) ? value.poseId : 'front', coefficients: sanitizeChannels(value.coefficients),
    faceOnly: value.faceOnly !== false, followHead: value.followHead === true, tourPoses: value.tourPoses === true,
  };
}

export function parseStudioProject(text) {
  if (typeof text !== 'string' || text.length > 65536) throw new Error('项目文件不能超过 64 KB。');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('项目文件不是有效 JSON。'); }
  if (!object(parsed) || parsed.schemaVersion !== 1 || parsed.kind !== 'moemotion-short-hair-project' || parsed.characterId !== 'short-hair-v1') {
    throw new Error('这不是当前短发角色的项目文件。');
  }
  if (!poseIds.has(parsed.poseId)) throw new Error('项目使用了未知姿态。');
  const {coefficients} = parseStudioFrame(JSON.stringify({coefficients: parsed.coefficients}));
  return createStudioProject({...parsed, coefficients});
}

export const STUDIO_DEMO_DURATION = 18000;
const DEMO_ACTIONS = ['neutral', 'blink', 'openSmall', 'openWide', 'pucker', 'press', 'shiftLeft', 'shiftRight', 'innerUp'];
export function sampleStudioDemo(elapsedMs, poseId = 'front', tourPoses = false) {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const phase = elapsed % STUDIO_DEMO_DURATION;
  const index = Math.floor(phase / 2000), preset = STUDIO_PRESETS.find(item => item.id === DEMO_ACTIONS[index]);
  const angle = phase / STUDIO_DEMO_DURATION * Math.PI * 2;
  const gaze = preset.id === 'blink' ? gazeChannels(0, 0) : gazeChannels(Math.sin(angle) * .55, Math.sin(angle * 2) * .25);
  return {poseId: tourPoses ? STUDIO_POSES[index].id : poseIds.has(poseId) ? poseId : 'front',
    coefficients: sanitizeChannels({...preset.channels, ...gaze}), label: preset.label};
}
