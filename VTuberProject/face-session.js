import {
  ARKIT_CHANNELS, BlendshapeFilter, normalizeBlendshapeFrame,
  normalizeBlendshapeSettings, readMediaPipeBlendshapes, legacyMotionToBlendshapes,
} from "./arkit-blendshapes.js";

export function parseBlendshapeFrame(text) {
  if (typeof text !== "string" || text.length > 65536) throw new Error("请选择 64 KB 以内的 JSON 单帧文件。");
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("文件不是有效的 JSON。"); }
  if (data && Object.hasOwn(data, "blendshapes")) data = data.blendshapes;
  if (!data || typeof data !== "object" || Array.isArray(data)
    || !ARKIT_CHANNELS.some((key) => Object.hasOwn(data, key) && typeof data[key] === "number" && Number.isFinite(data[key]))) {
    throw new Error("文件需要 ARKit 命名的系数，例如 {\"jawOpen\":0.7}。");
  }
  return normalizeBlendshapeFrame(data);
}

export function normalizeHeadPose(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const finite = (key) => Object.hasOwn(source, key) && Number.isFinite(source[key]) ? source[key] : 0;
  return {
    yaw: Math.max(-1, Math.min(1, finite("yaw"))),
    pitch: Math.max(-1, Math.min(1, finite("pitch"))),
  };
}

/** Gentle deterministic 2D-only demo motion. The compact demo bus tops out
 * below the first painted brow stage, so amplify only its explicit activity
 * cue while retaining a sparse, smooth idle lift. */
export function demoBrowLift(rawBrowUp, nowMs) {
  const source = Number.isFinite(rawBrowUp) ? Math.max(0, Math.min(1, rawBrowUp)) : 0;
  const time = Number.isFinite(nowMs) ? nowMs / 1000 : 0;
  const idlePulse = ((1 + Math.cos(Math.PI * 2 * (time - 2.4) / 8.6)) / 2) ** 8;
  const idle = .02 + idlePulse * .18;
  const activity = Math.max(0, Math.min(1, (source - .02) / .055));
  return Math.min(.48, Math.max(idle, .02 + activity * .46));
}

/** A local-only repeatable preview; it never enters saved project settings. */
export function transitionPreviewFrame(elapsedMs) {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const time = elapsed % 6400;
  const pulse = (start, duration) => {
    if (time < start || time > start + duration) return 0;
    return Math.sin(Math.PI * (time - start) / duration) ** 2;
  };
  const blink = pulse(350, 650);
  const jaw = pulse(1450, 1050);
  const pucker = pulse(2850, 1200);
  const press = pulse(4450, 1050);
  const browUp = pulse(50, 800);
  const browDown = pulse(1150, 900);
  const browWorried = pulse(2600, 1000);
  const browOuterUp = pulse(4000, 1000);
  return normalizeBlendshapeFrame({
    eyeBlinkLeft: blink,
    eyeBlinkRight: blink,
    jawOpen: jaw * .92,
    mouthPucker: pucker * .94,
    mouthPressLeft: press * .92,
    mouthPressRight: press * .92,
    browInnerUp: Math.max(browUp, browWorried) * .88,
    browDownLeft: browDown * .88,
    browDownRight: browDown * .88,
    browOuterUpLeft: browOuterUp * .88,
    // A sub-emotion-threshold frown cue selects the worried brow painting
    // without replacing the existing jaw/pucker/press mouth sequence.
    mouthFrownLeft: browWorried * .24,
  });
}

/** Ephemeral tracking/test state is intentionally separate from saved settings. */
export class FaceSession {
  constructor() {
    this.settings = normalizeBlendshapeSettings();
    this.filter = new BlendshapeFilter();
    this.raw = normalizeBlendshapeFrame();
    this.output = normalizeBlendshapeFrame();
    this.cameraFrame = normalizeBlendshapeFrame();
    this.cameraTime = -Infinity;
    this.neutral = normalizeBlendshapeFrame();
    this.samples = [];
    this.manual = false;
    this.manualFrame = normalizeBlendshapeFrame();
    this.poseManual = false;
    this.manualPose = normalizeHeadPose();
    this.transitionPreview = false;
    this.transitionStartedAt = 0;
    this.focus = false;
    this.revision = 0;
  }

  setSettings(settings) {
    this.settings = normalizeBlendshapeSettings(settings);
    this.clearTest();
  }

  beginCalibration() {
    this.clearTest();
    this.neutral = normalizeBlendshapeFrame();
    this.samples = [];
    this.cameraTime = -Infinity;
    this.filter.reset();
  }

  receive(result, now, calibrating = false) {
    if (!Number.isFinite(now)) return;
    this.cameraFrame = readMediaPipeBlendshapes(result);
    this.cameraTime = now;
    if (calibrating) {
      this.samples.push(this.cameraFrame);
      if (this.samples.length > 120) this.samples.shift();
    }
  }

  finishCalibration() {
    if (this.samples.length < 5) return;
    this.neutral = Object.fromEntries(ARKIT_CHANNELS.map((key) => {
      const values = this.samples.map((sample) => sample[key]).sort((a, b) => a - b);
      return [key, values[Math.floor(values.length / 2)]];
    }));
    this.samples = [];
    this.filter.reset();
  }

  test(frame) {
    this.revision += 1;
    this.manualFrame = normalizeBlendshapeFrame(frame);
    this.manual = true;
    this.transitionPreview = false;
    this.filter.reset();
  }

  testPose(pose) {
    this.revision += 1;
    this.manualPose = normalizeHeadPose(pose);
    this.poseManual = true;
  }

  clearPoseTest() {
    this.revision += 1;
    this.poseManual = false;
    this.manualPose = normalizeHeadPose();
  }

  startTransitionPreview(now = globalThis.performance?.now?.() ?? 0) {
    this.revision += 1;
    this.manual = true;
    this.manualFrame = normalizeBlendshapeFrame();
    this.transitionPreview = true;
    this.transitionStartedAt = Number.isFinite(now) ? now : 0;
    this.filter.reset();
  }

  stopTransitionPreview() {
    this.revision += 1;
    this.manual = false;
    this.manualFrame = normalizeBlendshapeFrame();
    this.transitionPreview = false;
    this.transitionStartedAt = 0;
    this.filter.reset();
  }

  clearExpressionTest() {
    this.revision += 1;
    this.manual = false;
    this.manualFrame = normalizeBlendshapeFrame();
    this.transitionPreview = false;
    this.transitionStartedAt = 0;
    this.filter.reset();
  }

  clearTest() {
    this.revision += 1;
    this.manual = false;
    // Presets temporarily zoom into the face. Leaving the test must restore
    // normal framing, including via the quick bar, demo mode or project load.
    this.focus = false;
    this.manualFrame = normalizeBlendshapeFrame();
    this.poseManual = false;
    this.manualPose = normalizeHeadPose();
    this.transitionPreview = false;
    this.transitionStartedAt = 0;
    this.filter.reset();
  }

  update(motion, mode, now, dt) {
    if (this.transitionPreview) this.raw = transitionPreviewFrame(now - this.transitionStartedAt);
    else if (this.manual) this.raw = this.manualFrame;
    else if (mode === "camera") {
      const fresh = now >= this.cameraTime && now - this.cameraTime <= 240;
      this.raw = fresh ? Object.fromEntries(ARKIT_CHANNELS.map((key) => [
        key, Math.max(0, Math.min(1, (this.cameraFrame[key] - this.neutral[key]) / Math.max(.1, 1 - this.neutral[key]))),
      ])) : normalizeBlendshapeFrame();
    } else {
      this.raw = legacyMotionToBlendshapes(motion);
      if (mode === "demo") {
        const brow = demoBrowLift(this.raw.browInnerUp, now);
        this.raw.browInnerUp = brow;
        this.raw.browOuterUpLeft = this.raw.browOuterUpRight = brow * .72;
      }
    }
    this.output = this.filter.update(this.raw, this.settings, dt);
    return this.output;
  }
}
