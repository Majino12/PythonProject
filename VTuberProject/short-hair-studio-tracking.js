import {STUDIO_CHANNELS, STUDIO_POSES, selectStudioPose} from './short-hair-studio-model.js';
import {poseHeadCoordinates, validateHeadPose, nearestStudioPoseId} from './short-hair-pose-motion.js';
import {validateSecondaryFrame} from './short-hair-secondary-motion.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const keys = STUDIO_CHANNELS.map(channel => channel.key);
const poseIds = new Set(STUDIO_POSES.map(pose => pose.id));

/** Short-hair-only settings. No changes to legacy/3D FaceSession defaults. */
export const TRACKING_PRESETS = Object.freeze([
  Object.freeze({id:'balanced', label:'平衡', blinkMs:24, mouthMs:45, otherMs:65, poseHoldMs:80, deadzone:.02}),
  Object.freeze({id:'responsive', label:'灵敏', blinkMs:12, mouthMs:24, otherMs:35, poseHoldMs:40, deadzone:.01}),
  Object.freeze({id:'stable', label:'稳定', blinkMs:42, mouthMs:75, otherMs:100, poseHoldMs:140, deadzone:.035}),
]);

export function normalizeTrackingSettings(raw = {}) {
  const value = object(raw) ? raw : {};
  const sensitivity = key => typeof value[key] === 'number' && Number.isFinite(value[key]) ? clamp(value[key], .7, 1.4) : 1;
  return {preset:TRACKING_PRESETS.some(item => item.id === value.preset) ? value.preset : 'balanced',
    eyeSensitivity:sensitivity('eyeSensitivity'), mouthSensitivity:sensitivity('mouthSensitivity')};
}

/** Feed this to FaceSession.setSettings. Its existing filter is the only filter. */
export function createFaceSessionSettings(raw) {
  const settings = normalizeTrackingSettings(raw), preset = TRACKING_PRESETS.find(item => item.id === settings.preset);
  return {channels:Object.fromEntries(STUDIO_CHANNELS.map(({key, group}) => {
    const blink = key === 'eyeBlinkLeft' || key === 'eyeBlinkRight', mouth = group === 'mouth';
    const sensitivity = blink ? settings.eyeSensitivity : mouth ? settings.mouthSensitivity : 1;
    return [key, {inputMin:preset.deadzone, inputMax:blink || mouth ? Math.min(1, .85 / sensitivity) : 1,
      outputMin:0, outputMax:1, curve:'linear', smoothing:blink ? preset.blinkMs : mouth ? preset.mouthMs : preset.otherMs}];
  }))};
}

/** Nine painted directions with temporal confirmation; never continuous rotation. */
export class StudioPoseStabilizer {
  constructor(settings) {this.setSettings(settings); this.reset();}
  setSettings(settings) {
    this.settings = normalizeTrackingSettings(settings);
    this.holdMs = TRACKING_PRESETS.find(item => item.id === this.settings.preset).poseHoldMs;
    this.reset();
  }
  reset() {this.candidate = null; this.candidateSince = 0; this.lastAt = -Infinity; this.lastSampleAt = -Infinity;}
  update(pose, now, currentPoseId = 'front', {fresh = true, sampleTime = now} = {}) {
    const current = poseIds.has(currentPoseId) ? currentPoseId : 'front';
    if (!Number.isFinite(now) || !Number.isFinite(sampleTime) || sampleTime > now || !fresh) {this.reset(); return fresh ? current : 'front';}
    if (now < this.lastAt || now - this.lastAt > 240 || sampleTime < this.lastSampleAt) this.reset();
    this.lastAt = now;
    if (sampleTime === this.lastSampleAt) return current;
    this.lastSampleAt = sampleTime;
    const next = selectStudioPose(pose, current);
    if (next === current) {this.candidate = null; return current;}
    if (next !== this.candidate) {this.candidate = next; this.candidateSince = sampleTime;}
    if (sampleTime - this.candidateSince < this.holdMs) return current;
    this.candidate = null;
    return next;
  }
}

export const TRACKING_CLIP_LIMITS = Object.freeze({maxDurationMs:60000, maxSamples:1801, maxBytes:2 * 1024 * 1024, sampleIntervalMs:1000 / 30});
const clipKeys = ['schemaVersion','kind','characterId','durationMs','samples'];
const sampleKeys = ['t','poseId','coefficients'];
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
function exactKeys(value, expected, label) {
  if (!object(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value,key))) {
    throw new Error(`${label}含缺失或未知字段。`);
  }
}
function checkedFrame(frame, {withHeadPose = false, requireHeadPose = false, withSecondary = false, requireSecondary = false} = {}) {
  const hasHeadPose = object(frame) && Object.hasOwn(frame,'headPose');
  const hasSecondary = object(frame) && Object.hasOwn(frame,'secondary');
  exactKeys(frame, ['poseId','coefficients',...(hasHeadPose?['headPose']:[]),...(hasSecondary?['secondary']:[])], '动作帧');
  if (requireHeadPose && !hasHeadPose) throw new Error('连续动作帧缺少头部坐标。');
  if (requireSecondary && !hasSecondary) throw new Error('自然微动作帧缺少已显示的微动数据。');
  if (!poseIds.has(frame.poseId)) throw new Error('动作片段含未知方向。');
  exactKeys(frame.coefficients, keys, '系数');
  for (const key of keys) if (!finite(frame.coefficients[key],0,1)) throw new Error(`${key}需要0–1之间的数字。`);
  const headPose = hasHeadPose ? validateHeadPose(frame.headPose) : poseHeadCoordinates(frame.poseId);
  const secondary = validateSecondaryFrame(hasSecondary ? frame.secondary : {breath:0,sway:0,hair:0});
  return {poseId:frame.poseId, coefficients:Object.fromEntries(keys.map(key => [key,frame.coefficients[key]])),
    ...(withHeadPose ? {headPose} : {}),...(withSecondary ? {secondary:{...secondary}} : {})};
}

/** A numeric-only, exact schema. No camera frames, paths, model blobs or settings. */
export function validateTrackingClip(value) {
  exactKeys(value,clipKeys,'动作片段');
  if (![1,2,3].includes(value.schemaVersion) || value.kind !== 'moemotion-short-hair-tracking-clip' || value.characterId !== 'short-hair-v1') {
    throw new Error('这不是短发角色的动作片段。');
  }
  if (!finite(value.durationMs,0,TRACKING_CLIP_LIMITS.maxDurationMs)) throw new Error('动作片段最长60秒。');
  if (!Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > TRACKING_CLIP_LIMITS.maxSamples) {
    throw new Error('动作片段需要1–1801帧系数。');
  }
  let previous = -1;
  const withHeadPose = value.schemaVersion >= 2,withSecondary=value.schemaVersion===3;
  const samples = value.samples.map((sample,index) => {
    exactKeys(sample,[...sampleKeys,...(withHeadPose?['headPose']:[]),...(withSecondary?['secondary']:[])],'片段帧');
    if (!finite(sample.t,0,value.durationMs) || sample.t <= previous || index === 0 && sample.t !== 0) {
      throw new Error('时间戳必须从0开始、严格递增且不超过片段时长。');
    }
    previous = sample.t;
    return {t:sample.t,...checkedFrame({poseId:sample.poseId,coefficients:sample.coefficients,
      ...(withHeadPose?{headPose:sample.headPose}:{}),...(withSecondary?{secondary:sample.secondary}:{})},
      {withHeadPose,requireHeadPose:withHeadPose,withSecondary,requireSecondary:withSecondary})};
  });
  return {schemaVersion:value.schemaVersion,kind:'moemotion-short-hair-tracking-clip',characterId:'short-hair-v1',durationMs:value.durationMs,samples};
}

export function parseTrackingClip(text) {
  if (typeof text !== 'string' || text.length > TRACKING_CLIP_LIMITS.maxBytes
    || new TextEncoder().encode(text).length > TRACKING_CLIP_LIMITS.maxBytes) throw new Error('动作片段JSON不能超过2 MB。');
  let data;
  try {data = JSON.parse(text);} catch {throw new Error('动作片段不是有效JSON。');}
  return validateTrackingClip(data);
}

export class TrackingClipRecorder {
  constructor() {this.recording = false; this.samples = []; this.durationMs = 0; this.stopReason = null;}
  get active() {return this.recording;}
  start(now) {
    if (!finite(now,0,Number.MAX_SAFE_INTEGER)) throw new Error('录制开始时间无效。');
    this.startedAt = now; this.samples = []; this.durationMs = 0; this.stopReason = null; this.recording = true;
  }
  capture(frame, now) {
    if (!this.recording) return false;
    if (!finite(now,this.startedAt,Number.MAX_SAFE_INTEGER)) throw new Error('录制时间必须单调递增。');
    const t = now - this.startedAt, previous = this.samples.at(-1);
    if (previous && t < previous.t) throw new Error('录制时间必须单调递增。');
    if (t > TRACKING_CLIP_LIMITS.maxDurationMs || this.samples.length >= TRACKING_CLIP_LIMITS.maxSamples) {
      this.stop(this.startedAt + TRACKING_CLIP_LIMITS.maxDurationMs); this.stopReason = 'limit'; return false;
    }
    if (previous && t - previous.t < TRACKING_CLIP_LIMITS.sampleIntervalMs - .001) return false;
    const copy = checkedFrame(frame,{withHeadPose:true,withSecondary:true});
    if (!previous) this.startedAt = now;
    this.samples.push({t:previous ? t : 0,...copy}); this.durationMs = previous ? t : 0;
    return true;
  }
  stop(now) {
    if (this.recording && now !== undefined) {
      if (!finite(now,this.startedAt + this.durationMs,Number.MAX_SAFE_INTEGER)) throw new Error('录制结束时间无效。');
      this.durationMs = Math.min(TRACKING_CLIP_LIMITS.maxDurationMs,now - this.startedAt);
    }
    this.recording = false;
    if (!this.samples.length) return null;
    return validateTrackingClip({schemaVersion:3,kind:'moemotion-short-hair-tracking-clip',characterId:'short-hair-v1',
      durationMs:this.durationMs,samples:this.samples});
  }
}

/** Painted coefficients keep their recorded samples. V2+ head coordinates and
 * V3 secondary motion interpolate timestamps; V1 retains its discrete timing.
 * V1/V2 have zero secondary motion. Returned values are displayed values, so
 * replay must not run camera damping or secondary simulation a second time. */
export class TrackingClipPlayer {
  constructor() {this.playing = false; this.clip = null; this.index = 0;}
  get active() {return this.playing;}
  start(clip, now) {
    const valid = validateTrackingClip(clip);
    if (!finite(now,0,Number.MAX_SAFE_INTEGER)) throw new Error('重放开始时间无效。');
    this.clip = valid; this.startedAt = now; this.lastAt = now; this.index = 0; this.playing = true;
  }
  sample(now) {
    if (!this.playing) return null;
    if (!finite(now,this.lastAt,Number.MAX_SAFE_INTEGER)) throw new Error('重放时间必须单调递增。');
    this.lastAt = now;
    const elapsed = Math.min(this.clip.durationMs,now - this.startedAt);
    while (this.index + 1 < this.clip.samples.length && this.clip.samples[this.index + 1].t <= elapsed) this.index++;
    const frame = this.clip.samples[this.index], done = now - this.startedAt >= this.clip.durationMs;
    if (done) this.playing = false;
    const result = checkedFrame({poseId:frame.poseId,coefficients:frame.coefficients,
      ...(this.clip.schemaVersion>=2?{headPose:frame.headPose}:{}),
      ...(this.clip.schemaVersion===3?{secondary:frame.secondary}:{})},{withHeadPose:true,withSecondary:true});
    const next = this.clip.samples[this.index + 1];
    if (this.clip.schemaVersion >= 2 && next) {
      const amount = (elapsed - frame.t) / (next.t - frame.t);
      result.headPose = Object.fromEntries(['yaw','pitch'].map(key =>
        [key,frame.headPose[key] + (next.headPose[key] - frame.headPose[key]) * amount]));
      if(this.clip.schemaVersion===3)result.secondary=Object.fromEntries(['breath','sway','hair'].map(key=>
        [key,frame.secondary[key]+(next.secondary[key]-frame.secondary[key])*amount]));
    }
    if (this.clip.schemaVersion >= 2) result.poseId = nearestStudioPoseId(result.headPose);
    return {...result,elapsedMs:elapsed,durationMs:this.clip.durationMs,done};
  }
  stop() {this.playing = false; this.clip = null; this.index = 0;}
}

/** These samples count completed detector calls, never RAF or painted frames. */
export class TrackingInferenceMetrics {
  constructor() {this.reset();}
  reset() {this.samples = []; this.sampleCount = 0; this.failedCount = 0; this.lastSignalAt = -Infinity;}
  record(now, durationMs, hasFace = false, failed = false) {
    if (!finite(now,0,Number.MAX_SAFE_INTEGER) || !finite(durationMs,0,Number.MAX_SAFE_INTEGER)) return;
    if (failed) {this.failedCount++; return;}
    this.sampleCount++; this.samples.push({now,durationMs});
    this.samples = this.samples.filter(sample => now - sample.now <= 2000).slice(-120);
    if (hasFace) this.lastSignalAt = now;
  }
  snapshot(now) {
    const time = Number.isFinite(now) ? now : Infinity;
    const recent = this.samples.filter(sample => time >= sample.now && time - sample.now <= 2000);
    const last = recent.at(-1), span = last ? last.now - recent[0].now : 0;
    const signalAgeMs = Number.isFinite(this.lastSignalAt) && time >= this.lastSignalAt ? time - this.lastSignalAt : null;
    return {inferenceFps:recent.length >= 3 && span >= 200 && time - last.now <= 240 ? (recent.length - 1) * 1000 / span : null,
      meanInferenceMs:recent.length ? recent.reduce((sum,sample) => sum + sample.durationMs,0) / recent.length : null,
      lastInferenceMs:last?.durationMs ?? null,signalAgeMs,signalStale:signalAgeMs === null || signalAgeMs > 240,
      sampleCount:this.sampleCount,windowSampleCount:recent.length,failedCount:this.failedCount};
  }
}
