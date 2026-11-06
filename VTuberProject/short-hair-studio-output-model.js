import {validateSecondaryFrame} from './short-hair-secondary-motion.js';
import {validateOutputComposition,layoutOutputComposition} from './short-hair-composition.js';
export {validateOutputComposition,normalizeOutputComposition} from './short-hair-composition.js';
import {validateHeadPose} from './short-hair-pose-motion.js';
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
  if (value.transparent !== undefined && typeof value.transparent !== 'boolean') throw new Error('直播透明设置无效。');
  const extra = {};
  if (value.headPose !== undefined) extra.headPose = validateHeadPose(value.headPose);
  if (value.transparent !== undefined) extra.transparent = value.transparent;
  if (value.composition !== undefined) extra.composition = validateOutputComposition(value.composition);
  if (value.secondary !== undefined) extra.secondary = validateSecondaryFrame(value.secondary);
  return {poseId:value.poseId, coefficients, state, faceOnly:value.faceOnly, original:value.original, ...extra};
}

export function validateOutputEnvelope(value) {
  if (!object(value) || typeof value.senderId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value.senderId)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error('直播发送标识无效。');
  return {senderId:value.senderId, sequence:value.sequence, frame:validateOutputFrame(value.frame)};
}

/** Fit each native pose, then apply user framing without baking a background into alpha. */
export function drawOutputFrame(target, source, {transparent=false,composition}={}) {
  const context = target.getContext('2d');
  const {width,height,centerX,centerY,mirror}=layoutOutputComposition(target,source,composition);
  context.clearRect?.(0,0,target.width,target.height);
  if (!transparent) {context.fillStyle = '#bfc6d3'; context.fillRect(0,0,target.width,target.height);}
  if(mirror) {
    context.save();
    try {context.translate(centerX,centerY);context.scale(-1,1);context.drawImage(source,-width/2,-height/2,width,height);}
    finally {context.restore();}
  } else context.drawImage(source,centerX-width/2,centerY-height/2,width,height);
}
