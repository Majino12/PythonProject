const clamp = (value, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function finiteNumber(value, fallback = 0) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

const definitions = [
  ["browDownLeft", "左眉下压", "眉毛", true],
  ["browDownRight", "右眉下压", "眉毛", true],
  ["browInnerUp", "眉心上抬", "眉毛", true],
  ["browOuterUpLeft", "左眉尾上抬", "眉毛", true],
  ["browOuterUpRight", "右眉尾上抬", "眉毛", true],
  ["cheekPuff", "鼓腮", "面颊", true],
  ["cheekSquintLeft", "左脸颊上提", "面颊", true],
  ["cheekSquintRight", "右脸颊上提", "面颊", true],
  ["eyeBlinkLeft", "左眼闭合", "眼睛", true],
  ["eyeBlinkRight", "右眼闭合", "眼睛", true],
  ["eyeLookDownLeft", "左眼向下看", "眼睛", true],
  ["eyeLookDownRight", "右眼向下看", "眼睛", true],
  ["eyeLookInLeft", "左眼向内看", "眼睛", true],
  ["eyeLookInRight", "右眼向内看", "眼睛", true],
  ["eyeLookOutLeft", "左眼向外看", "眼睛", true],
  ["eyeLookOutRight", "右眼向外看", "眼睛", true],
  ["eyeLookUpLeft", "左眼向上看", "眼睛", true],
  ["eyeLookUpRight", "右眼向上看", "眼睛", true],
  ["eyeSquintLeft", "左眼眯起", "眼睛", true],
  ["eyeSquintRight", "右眼眯起", "眼睛", true],
  ["eyeWideLeft", "左眼睁大", "眼睛", true],
  ["eyeWideRight", "右眼睁大", "眼睛", true],
  ["jawForward", "下颌前伸", "下颌", true],
  ["jawLeft", "下颌左移", "下颌", true],
  ["jawOpen", "张开下颌", "下颌", true],
  ["jawRight", "下颌右移", "下颌", true],
  ["mouthClose", "闭合嘴唇", "嘴部", true],
  ["mouthDimpleLeft", "左嘴角后收", "嘴部", true],
  ["mouthDimpleRight", "右嘴角后收", "嘴部", true],
  ["mouthFrownLeft", "左嘴角下压", "嘴部", true],
  ["mouthFrownRight", "右嘴角下压", "嘴部", true],
  ["mouthFunnel", "嘴唇漏斗", "嘴部", true],
  ["mouthLeft", "嘴部左移", "嘴部", true],
  ["mouthLowerDownLeft", "左下唇下拉", "嘴部", true],
  ["mouthLowerDownRight", "右下唇下拉", "嘴部", true],
  ["mouthPressLeft", "左侧抿唇", "嘴部", true],
  ["mouthPressRight", "右侧抿唇", "嘴部", true],
  ["mouthPucker", "噘嘴", "嘴部", true],
  ["mouthRight", "嘴部右移", "嘴部", true],
  ["mouthRollLower", "下唇内卷", "嘴部", true],
  ["mouthRollUpper", "上唇内卷", "嘴部", true],
  ["mouthShrugLower", "下唇外翻", "嘴部", true],
  ["mouthShrugUpper", "上唇外翻", "嘴部", true],
  ["mouthSmileLeft", "左嘴角微笑", "嘴部", true],
  ["mouthSmileRight", "右嘴角微笑", "嘴部", true],
  ["mouthStretchLeft", "左嘴角外拉", "嘴部", true],
  ["mouthStretchRight", "右嘴角外拉", "嘴部", true],
  ["mouthUpperUpLeft", "左上唇上提", "嘴部", true],
  ["mouthUpperUpRight", "右上唇上提", "嘴部", true],
  ["noseSneerLeft", "左鼻翼上提", "鼻部", true],
  ["noseSneerRight", "右鼻翼上提", "鼻部", true],
  ["tongueOut", "伸舌", "舌头", false],
];

export const CHANNEL_DEFINITIONS = Object.freeze(definitions.map(([key, label, group, mediapipe]) => Object.freeze({
  key, label, group, mediapipe,
})));

export const ARKIT_CHANNELS = Object.freeze(CHANNEL_DEFINITIONS.map(({ key }) => key));

const MEDIAPIPE_CHANNEL_SET = new Set(CHANNEL_DEFINITIONS
  .filter(({ mediapipe }) => mediapipe)
  .map(({ key }) => key));

function emptyFrame() {
  return Object.fromEntries(ARKIT_CHANNELS.map((key) => [key, 0]));
}

function unit(value, fallback = 0) {
  return clamp(finiteNumber(value, fallback));
}

/** Normalize untrusted channel data to one finite 0..1 value for every ARKit key. */
export function normalizeBlendshapeFrame(raw) {
  const frame = emptyFrame();
  if (!isRecord(raw)) return frame;
  for (const key of ARKIT_CHANNELS) {
    if (own(raw, key)) frame[key] = unit(raw[key]);
  }
  return frame;
}

/**
 * MediaPipe Tasks currently exposes `_neutral` plus 51 ARKit-compatible names.
 * Apple ARKit instead exposes 52 action channels including tongueOut. Keep the
 * Apple contract here, ignore `_neutral`, and leave unavailable tongueOut at 0.
 */
export function readMediaPipeBlendshapes(result) {
  const frame = emptyFrame();
  const categories = result?.faceBlendshapes?.[0]?.categories;
  if (!Array.isArray(categories)) return frame;
  for (const category of categories) {
    const key = category?.categoryName;
    if (!MEDIAPIPE_CHANNEL_SET.has(key)) continue;
    frame[key] = Math.max(frame[key], unit(category.score));
  }
  frame.tongueOut = 0;
  return frame;
}

/** Convert the original compact MoeMotion expression bus into ARKit channels. */
export function legacyMotionToBlendshapes(motion) {
  const source = isRecord(motion) ? motion : {};
  const value = (key) => own(source, key) ? unit(source[key]) : 0;
  const signed = (key) => own(source, key) ? clamp(finiteNumber(source[key]), -1, 1) : 0;
  const frame = emptyFrame();

  frame.eyeBlinkLeft = value("blinkL");
  frame.eyeBlinkRight = value("blinkR");
  frame.eyeWideLeft = value("eyeWideL");
  frame.eyeWideRight = value("eyeWideR");
  const lookX = signed("lookX");
  const lookY = signed("lookY");
  frame.eyeLookOutLeft = frame.eyeLookInRight = Math.max(0, lookX);
  frame.eyeLookInLeft = frame.eyeLookOutRight = Math.max(0, -lookX);
  frame.eyeLookUpLeft = frame.eyeLookUpRight = Math.max(0, lookY);
  frame.eyeLookDownLeft = frame.eyeLookDownRight = Math.max(0, -lookY);

  const browUp = value("browUp");
  frame.browInnerUp = browUp;
  frame.browOuterUpLeft = frame.browOuterUpRight = browUp * .72;
  frame.browDownLeft = value("browDownL");
  frame.browDownRight = value("browDownR");

  const mouthOpen = value("mouth");
  const smile = value("smile");
  const frown = value("frown");
  const pucker = value("pucker");
  const mouthX = signed("mouthX");
  frame.jawOpen = mouthOpen;
  frame.mouthSmileLeft = frame.mouthSmileRight = smile;
  frame.mouthFrownLeft = frame.mouthFrownRight = frown;
  frame.mouthDimpleLeft = frame.mouthDimpleRight = smile * .28;
  frame.mouthStretchLeft = frame.mouthStretchRight = smile * .22;
  frame.mouthPucker = pucker;
  frame.mouthFunnel = pucker * (.58 + mouthOpen * .34);
  frame.mouthClose = pucker * (1 - mouthOpen) * .45;
  frame.mouthLeft = Math.max(0, -mouthX);
  frame.mouthRight = Math.max(0, mouthX);

  const cheek = value("cheek");
  frame.cheekPuff = cheek;
  frame.cheekSquintLeft = frame.cheekSquintRight = Math.max(cheek * .38, smile * .18);
  frame.eyeSquintLeft = frame.eyeSquintRight = Math.max(cheek * .18, smile * .12);
  return frame;
}

export const DEFAULT_CHANNEL_SETTINGS = Object.freeze({
  inputMin: 0,
  inputMax: 1,
  outputMin: 0,
  outputMax: 1,
  smoothing: 60,
  curve: "linear",
});

const CURVES = new Set(["linear", "smooth", "easeIn", "easeOut"]);

function numericSetting(source, key, fallback, minimum, maximum) {
  if (!own(source, key)) return fallback;
  return clamp(finiteNumber(source[key], fallback), minimum, maximum);
}

function normalizeChannelConfig(raw) {
  const source = isRecord(raw) ? raw : {};
  const hasInputMin = own(source, "inputMin");
  const hasInputMax = own(source, "inputMax");
  let inputMin = numericSetting(source, "inputMin", DEFAULT_CHANNEL_SETTINGS.inputMin, 0, 1);
  let inputMax = numericSetting(source, "inputMax", DEFAULT_CHANNEL_SETTINGS.inputMax, 0, 1);
  if (inputMin > inputMax) {
    if (hasInputMin && hasInputMax) [inputMin, inputMax] = [inputMax, inputMin];
    else if (hasInputMin) inputMax = 1;
    else inputMin = 0;
  }
  if (inputMin === inputMax) {
    if (inputMin === 0) inputMax = 1;
    else if (inputMax === 1) inputMin = 0;
    else {
      inputMin = 0;
      inputMax = 1;
    }
  }
  const curve = own(source, "curve") && CURVES.has(source.curve)
    ? source.curve
    : DEFAULT_CHANNEL_SETTINGS.curve;
  return {
    inputMin,
    inputMax,
    outputMin: numericSetting(source, "outputMin", DEFAULT_CHANNEL_SETTINGS.outputMin, 0, 1),
    outputMax: numericSetting(source, "outputMax", DEFAULT_CHANNEL_SETTINGS.outputMax, 0, 1),
    smoothing: numericSetting(source, "smoothing", DEFAULT_CHANNEL_SETTINGS.smoothing, 0, 400),
    curve,
  };
}

/** Whitelist and fully normalize explicitly configured ARKit channels. */
export function normalizeBlendshapeSettings(raw) {
  const source = isRecord(raw) ? raw : {};
  const rawChannels = own(source, "channels") && isRecord(source.channels) ? source.channels : {};
  const channels = {};
  for (const key of ARKIT_CHANNELS) {
    if (!own(rawChannels, key) || !isRecord(rawChannels[key])) continue;
    channels[key] = normalizeChannelConfig(rawChannels[key]);
  }
  return { channels };
}

/** Apply input range, response curve, and optionally reversed output range. */
export function mapBlendshapeValue(value, config = DEFAULT_CHANNEL_SETTINGS) {
  const safe = normalizeChannelConfig(config);
  let amount = clamp((finiteNumber(value) - safe.inputMin) / (safe.inputMax - safe.inputMin));
  if (safe.curve === "smooth") amount = amount * amount * (3 - 2 * amount);
  else if (safe.curve === "easeIn") amount *= amount;
  else if (safe.curve === "easeOut") amount = 1 - (1 - amount) ** 2;
  return clamp(safe.outputMin + (safe.outputMax - safe.outputMin) * amount);
}

export class BlendshapeFilter {
  constructor() {
    this.reset();
  }

  reset() {
    this.values = emptyFrame();
    this.initialized = false;
  }

  update(raw, settings, dtSeconds) {
    const frame = normalizeBlendshapeFrame(raw);
    const safeSettings = normalizeBlendshapeSettings(settings);
    const dt = Math.max(0, finiteNumber(dtSeconds));
    const output = emptyFrame();
    for (const key of ARKIT_CHANNELS) {
      const config = safeSettings.channels[key] || DEFAULT_CHANNEL_SETTINGS;
      const target = mapBlendshapeValue(frame[key], config);
      let next = target;
      if (this.initialized && config.smoothing > 0) {
        const alpha = dt > 0 ? -Math.expm1(-dt * 1000 / config.smoothing) : 0;
        next = this.values[key] + (target - this.values[key]) * alpha;
      }
      output[key] = this.values[key] = unit(next);
    }
    this.initialized = true;
    return output;
  }
}
