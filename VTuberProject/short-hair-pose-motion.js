/** Continuous two-dimensional head control. No painting selection, DOM, clocks
 * or model inference lives here. A proposed frame is committed by the caller
 * only after its renderer succeeds. Coordinates describe the prepared grid,
 * not a measured physical angle in degrees. */
export const STUDIO_HEAD_POSES = Object.freeze([
  ['view-left-up', -1, 1], ['view-up', 0, 1], ['view-right-up', 1, 1],
  ['view-left', -1, 0], ['front', 0, 0], ['view-right', 1, 0],
  ['view-left-down', -1, -1], ['view-down', 0, -1], ['view-right-down', 1, -1],
].map(([id, yaw, pitch]) => Object.freeze({id, yaw, pitch})));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clamp = number => Math.max(-1, Math.min(1, number));
const axes = ['yaw','pitch'];
const finite = number => typeof number === 'number' && Number.isFinite(number);

export function poseHeadCoordinates(poseId = 'front') {
  const found = STUDIO_HEAD_POSES.find(pose => pose.id === poseId);
  if (!found) throw new Error('未知的短发角色方向。');
  return {yaw:found.yaw,pitch:found.pitch};
}

/** Strict boundary for projects, clips and the live-output protocol. */
export function validateHeadPose(value) {
  if (!object(value) || Object.keys(value).length !== 2 || axes.some(key =>
    !Object.hasOwn(value,key) || !finite(value[key]) || Math.abs(value[key]) > 1)) {
    throw new Error('连续头部坐标需要且仅需要 -1–1 的 yaw、pitch。');
  }
  return {yaw:value.yaw,pitch:value.pitch};
}

/** Friendly input normalization is separate from strict imported-data checks. */
export function normalizeHeadPose(value, fallback = {yaw:0,pitch:0}) {
  const safeFallback = validateHeadPose(fallback);
  return Object.fromEntries(axes.map(key => [key,finite(value?.[key]) ? clamp(value[key]) : safeFallback[key]]));
}

/** The former discrete selector entered a side at ±.42. Retain that useful
 * camera range while mapping every value between neutral and side continuously.
 * The small center deadzone has no discontinuity at its boundary. */
export function normalizeCameraHeadPose(value, {fullScale = .42, deadzone = .02} = {}) {
  if (!finite(fullScale) || fullScale <= 0 || fullScale > 1 || !finite(deadzone)
    || deadzone < 0 || deadzone >= fullScale) throw new RangeError('头部跟踪量程或中心死区无效。');
  const head = normalizeHeadPose(value);
  return Object.fromEntries(axes.map(key => [key, Math.sign(head[key]) *
    Math.min(1,Math.max(0,Math.abs(head[key]) - deadzone) / (fullScale - deadzone))]));
}

/** Labels and legacy metadata only; never use this result as a render target. */
export function nearestStudioPoseId(value) {
  const head = validateHeadPose(value);
  const axis = number => number >= .5 ? 1 : number <= -.5 ? -1 : 0;
  return STUDIO_HEAD_POSES.find(pose => pose.yaw === axis(head.yaw) && pose.pitch === axis(head.pitch)).id;
}

function state(current, target, velocity = {yaw:0,pitch:0}) {
  return Object.freeze({current:Object.freeze(validateHeadPose(current)),
    target:Object.freeze(validateHeadPose(target)),velocity:Object.freeze({...velocity})});
}
function validateMotion(motion) {
  if (!object(motion) || !object(motion.velocity) || axes.some(key => !finite(motion.velocity[key])))
    throw new TypeError('连续转头时序状态无效。');
  validateHeadPose(motion.current);validateHeadPose(motion.target);
}
export function createStudioPoseMotion(initial = {yaw:0,pitch:0}) {
  const head = typeof initial === 'string' ? poseHeadCoordinates(initial) : validateHeadPose(initial);
  return state(head,head);
}
export const resetStudioPoseMotion = createStudioPoseMotion;

export function targetStudioPoseMotion(motion, target) {
  validateMotion(motion);
  return state(motion.current,typeof target === 'string' ? poseHeadCoordinates(target) : validateHeadPose(target),motion.velocity);
}

export function freezeStudioPoseMotion(motion) {
  validateMotion(motion);
  return state(motion.current,motion.current);
}

export const STUDIO_POSE_SMOOTHING_MS = Object.freeze({responsive:75,balanced:110,stable:160});

/** Analytic critically damped integration avoids frame-rate-dependent easing.
 * A long scheduling stall cannot replay missed movement or teleport the model.
 * Velocity survives target reversals but never crosses the requested endpoint.
 * Callers retain the old motion on failed draws, then retry the same proposal. */
export function advanceStudioPoseMotion(motion, dtMs, {preset = 'balanced'} = {}) {
  validateMotion(motion);
  if (!finite(dtMs) || dtMs < 0) throw new TypeError('连续转头间隔需要非负有限毫秒数。');
  if (!Object.hasOwn(STUDIO_POSE_SMOOTHING_MS,preset)) throw new RangeError('连续转头速度预设无效。');
  if (dtMs === 0) return {motion,headPose:{...motion.current},moving:axes.some(key =>
    motion.current[key] !== motion.target[key] || motion.velocity[key] !== 0)};
  const dt = Math.min(100,dtMs) / 1000, omega = 2 / (STUDIO_POSE_SMOOTHING_MS[preset] / 1000);
  const decay = Math.exp(-omega * dt), current = {}, velocity = {};
  for (const key of axes) {
    const old = motion.current[key], goal = motion.target[key], difference = old - goal;
    const intermediate = motion.velocity[key] + omega * difference;
    let next = goal + (difference + intermediate * dt) * decay;
    let speed = (motion.velocity[key] - omega * intermediate * dt) * decay;
    if (goal === old || (goal - old) * (next - goal) > 0 || Math.abs(next - goal) < .0001 && Math.abs(speed) < .001) {
      next = goal;speed = 0;
    }
    if (next < -1 || next > 1) speed = 0;
    current[key] = clamp(next);velocity[key] = speed;
  }
  const result = state(current,motion.target,velocity);
  return {motion:result,headPose:{...result.current},moving:axes.some(key =>
    result.current[key] !== result.target[key] || result.velocity[key] !== 0)};
}
