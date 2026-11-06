/** Optional, small secondary motion. This module owns no clocks or rendering.
 * The studio advances it once and publishes the resulting frame to every output.
 * Values are unit controls, not pixels: renderers choose conservative amplitudes.
 * This does not claim to separate the original hair and face paintings. */
const finite = value => typeof value === 'number' && Number.isFinite(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, low = -1, high = 1) => Math.max(low, Math.min(high, value));
const channels = ['breath', 'sway', 'hair'];
const zero = () => ({breath:0, sway:0, hair:0});
export const SECONDARY_MOTION_DEFAULTS = Object.freeze({enabled:false, intensity:.6});

export function normalizeSecondarySettings(value = {}) {
  return {enabled:value?.enabled === true,
    intensity:finite(value?.intensity) ? clamp(value.intensity, 0, 1) : SECONDARY_MOTION_DEFAULTS.intensity};
}

/** Strict boundary for clips and output messages; never silently repairs data. */
export function validateSecondaryFrame(value) {
  if (!object(value) || Object.keys(value).length !== channels.length || channels.some(key =>
    !Object.hasOwn(value, key) || !finite(value[key]) || Math.abs(value[key]) > 1)) {
    throw new TypeError('自然微动需要且仅需要 -1–1 的 breath、sway、hair。');
  }
  return {breath:value.breath, sway:value.sway, hair:value.hair};
}

function head(value) {
  if (!object(value) || !finite(value.yaw) || !finite(value.pitch)
    || Math.abs(value.yaw) > 1 || Math.abs(value.pitch) > 1) {
    throw new TypeError('自然微动需要有效的连续头部坐标。');
  }
  return {yaw:value.yaw, pitch:value.pitch};
}

function state(headPose, elapsed = 0, hairPosition = 0, hairVelocity = 0, current = zero(), active = false, rebase = null) {
  return Object.freeze({headPose:Object.freeze(head(headPose)), elapsed, hairPosition, hairVelocity,
    current:Object.freeze(validateSecondaryFrame(current)), active,
    rebase:rebase ? Object.freeze({elapsed:rebase.elapsed, frame:Object.freeze(validateSecondaryFrame(rebase.frame))}) : null});
}
function validateMotion(motion) {
  if (!object(motion) || !finite(motion.elapsed) || motion.elapsed < 0 || motion.elapsed > 134.4
    || !finite(motion.hairPosition) || Math.abs(motion.hairPosition) > 1
    || !finite(motion.hairVelocity) || typeof motion.active !== 'boolean') {
    throw new TypeError('自然微动时序状态无效。');
  }
  head(motion.headPose);validateSecondaryFrame(motion.current);
  if(motion.rebase!==null&&motion.rebase!==undefined){
    if(!object(motion.rebase)||!finite(motion.rebase.elapsed)||motion.rebase.elapsed<0)
      throw new TypeError('自然微动恢复状态无效。');
    validateSecondaryFrame(motion.rebase.frame);
  }
}

export function createSecondaryMotion(headPose = {yaw:0, pitch:0}) {
  return state(headPose);
}

/** Restore a recorded display frame without pretending it contains oscillator
 * phase or spring velocity. Its first frame is exact; future advances smoothly
 * blend toward a fresh deterministic cycle. Convex blending stays bounded. */
export function rebaseSecondaryMotion(headPose, current) {
  const frame=validateSecondaryFrame(current);
  return state(headPose,0,0,0,frame,false,{elapsed:0,frame});
}

/** Preserve the displayed frame and phase while discarding residual inertia.
 * Paused callers must not advance; resuming is an ordinary advance call.
 * Pass a changed head pose when changing sources to avoid a stale-head impulse. */
export function freezeSecondaryMotion(motion, headPose = motion?.headPose) {
  validateMotion(motion);
  return state(headPose, motion.elapsed, motion.hairPosition, 0, motion.current, motion.active,motion.rebase);
}

/** Analytic damped spring, driven by the displayed head's velocity. A failed
 * draw can retry an identical proposal without mutating the committed state. */
export function advanceSecondaryMotion(motion, headPose, dtMs, settings = SECONDARY_MOTION_DEFAULTS) {
  validateMotion(motion);
  const nextHead = head(headPose), options = normalizeSecondarySettings(settings);
  if (!finite(dtMs) || dtMs < 0) throw new TypeError('自然微动间隔需要非负有限毫秒数。');
  const active = options.enabled && options.intensity > 0;
  if (!active) {
    const reset = state(nextHead);
    return {motion:reset, secondary:{...reset.current}, moving:false};
  }
  if (dtMs === 0) return {motion, secondary:{...motion.current}, moving:true};
  const dt = Math.min(dtMs, 100) / 1000;
  // The shared period keeps long-running streams numerically stable without
  // breaking either oscillator at the wrap: 134.4 / 4.2 = 32; / 6.4 = 21.
  const elapsed = (motion.elapsed + dt) % 134.4;
  const yawRate = motion.active ? (nextHead.yaw - motion.headPose.yaw) / dt : 0;
  const pitchRate = motion.active ? (nextHead.pitch - motion.headPose.pitch) / dt : 0;
  const target = clamp(-.12 * yawRate + .035 * pitchRate, -.75, .75);
  const omega = 9, damping = .65, decayRate = omega * damping;
  const frequency = omega * Math.sqrt(1 - damping * damping);
  const difference = motion.hairPosition - target;
  const coefficient = (motion.hairVelocity + decayRate * difference) / frequency;
  const cosine = Math.cos(frequency * dt), sine = Math.sin(frequency * dt), decay = Math.exp(-decayRate * dt);
  let hairPosition = target + decay * (difference * cosine + coefficient * sine);
  let hairVelocity = decay * (motion.hairVelocity * cosine
    - (decayRate * coefficient + frequency * difference) * sine);
  if (Math.abs(hairPosition) > 1) {hairPosition = clamp(hairPosition);hairVelocity = 0;}
  if (target === 0 && Math.abs(hairPosition) < 1e-7 && Math.abs(hairVelocity) < 1e-7) {
    hairPosition = 0;hairVelocity = 0;
  }
  const secondary = {
    breath:Math.sin(2 * Math.PI * elapsed / 4.2) * options.intensity,
    sway:Math.sin(2 * Math.PI * elapsed / 6.4) * .35 * options.intensity,
    hair:clamp(hairPosition * options.intensity),
  };
  let rebase=null;
  if(motion.rebase){
    const age=motion.rebase.elapsed+dt,retained=Math.exp(-age/.35);
    if(retained>1e-7){
      for(const key of channels)secondary[key]=secondary[key]*(1-retained)+motion.rebase.frame[key]*retained;
      rebase={elapsed:age,frame:motion.rebase.frame};
    }
  }
  const result = state(nextHead, elapsed, hairPosition, hairVelocity, secondary, true,rebase);
  return {motion:result, secondary:{...result.current}, moving:true};
}
