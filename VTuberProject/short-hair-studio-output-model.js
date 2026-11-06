import {STUDIO_CHANNELS, STUDIO_POSES} from './short-hair-studio-model.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const poses = new Set(STUDIO_POSES.map(pose => pose.id));
const eyes = new Set(['open','quarter','half','threeQuarter','closed']);
const mouths = new Set(['neutral','parted','openSmall','openMedium','openWide','pucker','press','shiftLeft','shiftRight']);
const brows = new Set(['neutral','up','innerUp','outerUp','down']);
export const STUDIO_OUTPUT_SIZE = Object.freeze({width:1280,height:720});

/** Only bounded character state travels through the local relay, never media. */
export function validateOutputFrame(value) {
  if (!object(value) || !poses.has(value.poseId) || !object(value.coefficients) || !object(value.state)
    || typeof value.faceOnly !== 'boolean' || typeof value.original !== 'boolean') throw new Error('直播画面状态无效。');
  const coefficients = {};
  for (const {key} of STUDIO_CHANNELS) {
    const number = value.coefficients[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) throw new Error(`直播通道 ${key} 无效。`);
    coefficients[key] = number;
  }
  const state = {};
  for (const [key, states] of [['eyeLeft',eyes],['eyeRight',eyes],['mouth',mouths],['browLeft',brows],['browRight',brows]]) {
    if (!states.has(value.state[key])) throw new Error(`直播画稿 ${key} 无效。`);
    state[key] = value.state[key];
  }
  if (Object.keys(value.coefficients).length !== STUDIO_CHANNELS.length || Object.keys(value.state).length !== 5) throw new Error('直播状态包含未知通道。');
  return {poseId:value.poseId, coefficients, state, faceOnly:value.faceOnly, original:value.original};
}

export function validateOutputEnvelope(value) {
  if (!object(value) || typeof value.senderId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value.senderId)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error('直播发送标识无效。');
  return {senderId:value.senderId, sequence:value.sequence, frame:validateOutputFrame(value.frame)};
}

/** Fit each native pose into one fixed OBS canvas without stretching it. */
export function drawOutputFrame(target, source) {
  const context = target.getContext('2d');
  const scale = Math.min(target.width/source.width, target.height/source.height);
  const width = source.width*scale, height = source.height*scale;
  context.fillStyle = '#bfc6d3'; context.fillRect(0,0,target.width,target.height);
  context.drawImage(source,(target.width-width)/2,(target.height-height)/2,width,height);
}
