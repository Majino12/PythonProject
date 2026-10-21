const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const amount = (value) => clamp(finite(value), 0, 1);
const MOUTH_TONE = Object.freeze({
  skinRose: [.72, .45, .49], upperShade: [.69, .62, .65], lowerLight: [.88, .60, .64], lipMix: .22, bounceMix: .24,
});
const MOUTH_SHAPE = Object.freeze({ width: .39, puckerNarrow: .13, funnelNarrow: .20, funnelUpper: .38, funnelLower: .52, maxHeight: .9 });

/** Reference for the shader's sampled, warm cavity shading (no dental detail). */
export function portraitCavityColor(originalLip, nearbySkin, depth = .5) {
  const blend = (a, b, weight) => a + (b - a) * weight;
  const t = clamp((finite(depth, .5) - .06) / .90, 0, 1);
  const vertical = t * t * (3 - 2 * t);
  return [0, 1, 2].map((index) => {
    const lip = amount(originalLip?.[index]), skin = amount(nearbySkin?.[index]);
    const tint = blend(skin * MOUTH_TONE.skinRose[index], lip, MOUTH_TONE.lipMix);
    const upper = tint * MOUTH_TONE.upperShade[index];
    const lower = blend(tint, skin * MOUTH_TONE.lowerLight[index], MOUTH_TONE.bounceMix);
    return blend(upper, lower, vertical);
  });
}

// “deform” means an independently driven image deformation, not an assertion
// that a single photograph contains a production 52-shape facial rig.
export const PORTRAIT_CHANNEL_SUPPORT = Object.freeze(Object.fromEntries([
  ...["browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "mouthClose", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight", "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight"].map((key) => [key, "deform"]),
  ...["cheekPuff", "cheekSquintLeft", "cheekSquintRight", "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight", "jawForward", "jawLeft", "jawOpen", "jawRight", "mouthDimpleLeft", "mouthDimpleRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "noseSneerLeft", "noseSneerRight"].map((key) => [key, "approximate"]),
  ["tongueOut", "unsupported"],
]));

/** Public: normalize source-pixel rig geometry and limit all shader inputs. */
export function portraitWarpState(width, height, rig = {}, motion = {}, intensity = {}, blendshapes = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || rig?.patchesEnabled === false) return null;
  rig ||= {};
  motion ||= {};
  intensity ||= {};
  blendshapes ||= {};
  const gain = (key) => clamp(finite(intensity[key], 1), 0, 1.5);
  const channel = (key, fallback = 0, group = "expression") => amount(finite(blendshapes[key], fallback) * gain(group));
  const box = (value) => {
    if (!value || ![value.x, value.y, value.w, value.h].every(Number.isFinite)
      || value.x < 0 || value.x >= width || value.y < 0 || value.y >= height
      || value.w < 1 || value.h < 1 || value.w > width * .55 || value.h > height * .4) return [0, 0, 0, 0];
    return [value.x / width, value.y / height, value.w / width, value.h / height];
  };
  const browBox = (brow, eye) => brow ? box(brow) : box(eye && { x: eye.x, y: eye.y - eye.h * .7, w: eye.w * 1.05, h: eye.h * .48 });
  const gaze = [clamp(finite(motion.lookX) * gain("expression"), -1, 1), clamp(finite(motion.lookY) * gain("expression"), -1, 1)];
  const eyeLook = (side) => {
    const names = [`eyeLookIn${side}`, `eyeLookOut${side}`, `eyeLookUp${side}`, `eyeLookDown${side}`];
    if (!names.some((key) => Number.isFinite(blendshapes[key]))) return gaze;
    return [(channel(`eyeLookOut${side}`) - channel(`eyeLookIn${side}`)) * (side === "Left" ? 1 : -1), channel(`eyeLookUp${side}`) - channel(`eyeLookDown${side}`)];
  };
  const innerUp = channel("browInnerUp", finite(motion.browUp));
  const mouthX = ["mouthLeft", "mouthRight"].some((key) => Number.isFinite(blendshapes[key]))
    ? channel("mouthRight") - channel("mouthLeft") : clamp(finite(motion.mouthX) * gain("expression"), -1, 1);
  const brow = (side, suffix) => {
    const down = channel(`browDown${side}`, finite(motion[`browDown${suffix}`]));
    return [clamp(innerUp - down * .72, -1, 1), clamp(channel(`browOuterUp${side}`, finite(motion.browUp)) - down * .8, -1, 1)];
  };
  return {
    face: box(rig.face), leftEye: box(rig.leftEye), rightEye: box(rig.rightEye), mouth: box(rig.mouth),
    leftBrow: browBox(rig.leftBrow, rig.leftEye), rightBrow: browBox(rig.rightBrow, rig.rightEye),
    eye: [amount(channel("eyeBlinkLeft", finite(motion.blinkL), "blink") + channel("eyeSquintLeft") * .38 + channel("cheekSquintLeft") * .10),
      amount(channel("eyeBlinkRight", finite(motion.blinkR), "blink") + channel("eyeSquintRight") * .38 + channel("cheekSquintRight") * .10),
      channel("eyeWideLeft", finite(motion.eyeWideL)), channel("eyeWideRight", finite(motion.eyeWideR))],
    gaze, look: [...eyeLook("Left"), ...eyeLook("Right")], brow: [...brow("Left", "L"), ...brow("Right", "R")],
    jaw: [channel("jawOpen", finite(motion.mouth), "mouth"), channel("mouthClose", 0, "mouth"), channel("jawRight") - channel("jawLeft"), channel("jawForward")],
    lips: [amount(channel("mouthUpperUpLeft") + channel("mouthShrugUpper") * .28 + channel("noseSneerLeft") * .18),
      amount(channel("mouthUpperUpRight") + channel("mouthShrugUpper") * .28 + channel("noseSneerRight") * .18),
      amount(channel("mouthLowerDownLeft") + channel("mouthShrugLower") * .28), amount(channel("mouthLowerDownRight") + channel("mouthShrugLower") * .28)],
    corners: [amount(channel("mouthSmileLeft", finite(motion.smile)) + channel("mouthDimpleLeft") * .16),
      amount(channel("mouthSmileRight", finite(motion.smile)) + channel("mouthDimpleRight") * .16), channel("mouthFrownLeft", finite(motion.frown)), channel("mouthFrownRight", finite(motion.frown))],
    mouthShape: [channel("mouthFunnel", 0, "mouth"), channel("mouthPucker", finite(motion.pucker), "mouth"), channel("mouthStretchLeft"), channel("mouthStretchRight")],
    mouthDetail: [channel("mouthRollUpper"), channel("mouthRollLower"), channel("mouthPressLeft"), channel("mouthPressRight")],
    faceMotion: [clamp(finite(motion.x) * gain("head"), -.65, .65), clamp(finite(motion.y) * gain("head"), -1, 1),
      mouthX, channel("cheekPuff")],
    // Retained for old callers inspecting the original normalized state.
    expression: [amount(finite(motion.mouth) * gain("mouth")), amount(finite(motion.smile) * gain("expression")),
      amount(finite(motion.frown) * gain("expression")), amount(finite(motion.pucker) * gain("expression"))],
    mouthX,
  };
}

/** Compact-support inverse eyelid map; a full blink leaves a subpixel slit. */
export function eyelidWarpCoordinate(value, blink = 0, wide = 0, core = .36) {
  value = finite(value);
  if (Math.abs(value) >= 1) return value;
  core = clamp(finite(core, .36), .08, .48);
  const target = core * (1 - amount(blink) * .995) + amount(wide) * .075;
  const distance = Math.abs(value);
  if (distance <= target) return value * core / target;
  const t = (distance - target) / (1 - target);
  const curvature = (core - target) / (1 - core);
  return Math.sign(value) * (core + (1 - core) * (t + curvature * t * (t - 1)));
}

/** Opening is distinct from jaw travel: mouthClose can seal an open jaw. */
export function portraitMouthOpening(state, side = 0) {
  const mixSide = (left, right) => right + (left - right) * clamp(side * .5 + .5, 0, 1);
  const pressed = mixSide(state.mouthDetail[2], state.mouthDetail[3]);
  const upper = mixSide(state.lips[0], state.lips[1]), lower = mixSide(state.lips[2], state.lips[3]);
  return amount((state.jaw[0] * .78 + state.mouthShape[0] * .26 + (upper + lower) * .14) * (1 - state.jaw[1]) * (1 - pressed * .82));
}

/** Source-UV aperture dimensions, shared with the shader's round-mouth model. */
export function portraitMouthGeometry(state, side = 0) {
  const weight = clamp(side * .5 + .5, 0, 1);
  const mixSide = (left, right) => right + (left - right) * weight;
  const opening = portraitMouthOpening(state, side), funnel = state.mouthShape[0];
  const upper = opening * (.12 + mixSide(state.lips[0], state.lips[1]) * .055 + funnel * MOUTH_SHAPE.funnelUpper);
  const lower = opening * (.38 + mixSide(state.lips[2], state.lips[3]) * .065 + funnel * MOUTH_SHAPE.funnelLower);
  const scale = Math.min(1, MOUTH_SHAPE.maxHeight / Math.max(.00001, upper + lower));
  return { halfWidth: state.mouth[2] * (MOUTH_SHAPE.width - state.mouthShape[1] * MOUTH_SHAPE.puckerNarrow - funnel * MOUTH_SHAPE.funnelNarrow),
    upperHeight: state.mouth[3] * upper * scale, lowerHeight: state.mouth[3] * lower * scale };
}

/** Public: the shader's monotonic, compact-support inverse compression curve. */
export function compactWarpCoordinate(value, strength) {
  value = finite(value);
  strength = clamp(finite(strength), -.3, 2.35);
  if (Math.abs(value) >= 1) return value;
  return value + strength * value * (1 - Math.abs(value)) ** 2;
}

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  // Top-origin coordinates agree with HTML images and the source-pixel rig.
  v_uv = a_position * vec2(0.5, -0.5) + vec2(0.5);
}`;

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_image;
uniform vec4 u_face;
uniform vec4 u_leftEye;
uniform vec4 u_rightEye;
uniform vec4 u_leftBrow;
uniform vec4 u_rightBrow;
uniform vec4 u_mouth;
uniform vec4 u_eye;
uniform vec4 u_look;
uniform vec4 u_brow;
uniform vec4 u_jaw;
uniform vec4 u_lips;
uniform vec4 u_corners;
uniform vec4 u_mouthShape;
uniform vec4 u_mouthDetail;
uniform vec4 u_faceMotion;

float bell(float x) {
  float inner = max(0.0, 1.0 - x * x);
  return inner * inner;
}
float compress(float x, float strength) {
  float edge = max(0.0, 1.0 - abs(x));
  // For strength <=2.35 the derivative stays positive: no fold or extra eye.
  return x + strength * x * edge * edge;
}
float eyelidMap(float x, float blink, float wide, float core) {
  if (abs(x) >= 1.0) return x;
  float target = core * (1.0 - blink * 0.995) + wide * 0.075;
  float distance = abs(x);
  if (distance <= target) return x * core / target;
  float t = (distance - target) / (1.0 - target);
  float curvature = (core - target) / (1.0 - core);
  return sign(x) * (core + (1.0 - core) * (t + curvature * t * (t - 1.0)));
}
vec2 faceWarp(vec2 uv) {
  if (u_face.z <= 0.0 || u_face.w <= 0.0) return uv;
  vec2 radius = u_face.zw * vec2(0.7, 0.67);
  vec2 local = (uv - u_face.xy) / radius;
  if (abs(local.x) >= 1.0 || abs(local.y) >= 1.0) return uv;
  float influence = bell(local.x) * bell(local.y);
  float lowerFace = smoothstep(-0.02, 0.48, local.y) * influence;
  // Small, local 2.5D changes only: a single front image cannot reveal a profile.
  uv.x += u_faceMotion.x * u_face.z * 0.07 * influence * (1.0 - local.x * 0.3);
  uv.y += u_faceMotion.y * u_face.w * 0.019 * influence;
  uv.y -= u_jaw.x * u_face.w * 0.045 * lowerFace;
  uv.x -= u_jaw.z * u_face.z * 0.025 * lowerFace;
  uv.x -= local.x * u_face.z * (u_jaw.w * 0.012 * lowerFace + u_faceMotion.w * 0.022 * influence);
  return uv;
}
vec2 browWarp(vec2 uv, vec4 box, vec2 movement) {
  if (box.z <= 0.0 || box.w <= 0.0) return uv;
  vec2 radius = box.zw * vec2(0.7, 1.55);
  vec2 local = (uv - box.xy) / radius;
  if (abs(local.x) >= 1.0 || abs(local.y) >= 1.0) return uv;
  float innerSide = u_face.z > 0.0 ? sign(u_face.x - box.x) : (box.x > 0.5 ? -1.0 : 1.0);
  float innerWeight = clamp(0.5 + local.x * innerSide * 0.5, 0.0, 1.0);
  float lift = mix(movement.y, movement.x, innerWeight);
  uv.y += lift * box.w * 0.52 * bell(local.x) * bell(local.y);
  return uv;
}
vec2 eyeWarp(vec2 uv, vec4 box, float blink, float wide, vec2 gaze) {
  if (box.z <= 0.0 || box.w <= 0.0) return uv;
  vec2 radius = box.zw * vec2(0.66, 0.9);
  vec2 local = (uv - box.xy) / radius;
  if (abs(local.x) >= 1.0 || abs(local.y) >= 1.0) return uv;
  float horizontal = 1.0 - smoothstep(0.62, 1.0, abs(local.x));
  float influence = horizontal * bell(local.y);
  float core = 0.12 + 0.24 * sqrt(max(0.0, 1.0 - local.x * local.x));
  float closingCenter = blink * 0.075 * influence;
  uv.y = box.y + eyelidMap(local.y - closingCenter, blink * horizontal, wide * horizontal, core) * radius.y;
  // Move existing pixels a little; no replacement irises or pasted eye art.
  uv -= gaze * box.zw * vec2(0.026, -0.028) * influence * (1.0 - blink);
  return uv;
}
float mouthSide(float x) { return clamp(x * 0.5 + 0.5, 0.0, 1.0); }
float mouthOpening(float side) {
  float pressed = mix(u_mouthDetail.w, u_mouthDetail.z, side);
  float upper = mix(u_lips.y, u_lips.x, side);
  float lower = mix(u_lips.w, u_lips.z, side);
  return clamp((u_jaw.x * 0.78 + u_mouthShape.x * 0.26 + (upper + lower) * 0.14) * (1.0 - u_jaw.y) * (1.0 - pressed * 0.82), 0.0, 1.0);
}
vec3 mouthDimensions(float side) {
  float opening = mouthOpening(side), funnel = u_mouthShape.x;
  float upper = opening * (0.12 + mix(u_lips.y, u_lips.x, side) * 0.055 + funnel * ${MOUTH_SHAPE.funnelUpper});
  float lower = opening * (0.38 + mix(u_lips.w, u_lips.z, side) * 0.065 + funnel * ${MOUTH_SHAPE.funnelLower});
  float scale = min(1.0, ${MOUTH_SHAPE.maxHeight} / max(0.00001, upper + lower));
  return vec3(u_mouth.z * (${MOUTH_SHAPE.width} - u_mouthShape.y * ${MOUTH_SHAPE.puckerNarrow} - funnel * ${MOUTH_SHAPE.funnelNarrow}), u_mouth.w * upper * scale, u_mouth.w * lower * scale);
}
float sourceLipLine(float sourceX) {
  float weightedY = 0.0, totalWeight = 0.0;
  // Locate the existing drawn lip contour instead of leaving a second smile
  // above a newly opened mouth. Nine local samples never replace skin texture.
  for (int index = 0; index < 9; index++) {
    float y = u_mouth.y + (float(index) - 4.0) * u_mouth.w * 0.06;
    vec4 pixel = texture2D(u_image, vec2(sourceX, y));
    float luminance = dot(pixel.rgb, vec3(0.2126, 0.7152, 0.0722));
    float weight = pow(max(0.02, 1.0 - luminance), 6.0) * pixel.a;
    weightedY += y * weight;
    totalWeight += weight;
  }
  return totalWeight > 0.0000001 ? weightedY / totalWeight : u_mouth.y;
}
vec2 mouthWarp(vec2 uv) {
  if (u_mouth.z <= 0.0 || u_mouth.w <= 0.0) return uv;
  vec2 radius = u_mouth.zw * vec2(1.05, 1.55);
  vec2 local = (uv - u_mouth.xy) / radius;
  if (abs(local.x) >= 1.0 || abs(local.y) >= 1.0) return uv;
  float influence = bell(local.x) * bell(local.y);
  vec2 outputUV = uv;
  float side = mouthSide(local.x * 2.0);
  float smile = mix(u_corners.y, u_corners.x, side);
  float frown = mix(u_corners.w, u_corners.z, side);
  float upper = mix(u_lips.y, u_lips.x, side), lower = mix(u_lips.w, u_lips.z, side);
  float stretch = mix(u_mouthShape.w, u_mouthShape.z, side);
  float widthChange = clamp(u_mouthShape.y * 0.9 + u_mouthShape.x * 1.35 - smile * 0.14 - stretch * 0.22, -0.3, 2.35);
  uv.x = u_mouth.x + compress(local.x, widthChange * bell(local.y)) * radius.x;
  uv.x -= u_faceMotion.z * u_mouth.z * 0.06 * influence;
  float opening = mouthOpening(side);
  float lipLift = local.y < 0.0 ? upper * 0.16 : -lower * 0.2;
  float rolled = local.y < 0.0 ? u_mouthDetail.x : u_mouthDetail.y;
  uv.y = u_mouth.y + compress(local.y, (-opening * 0.28 + rolled * 0.22) * bell(local.x)) * radius.y;
  uv.y += lipLift * u_mouth.w * influence;
  uv.y += (smile - frown) * u_mouth.w * 0.38 * min(1.0, abs(local.x) * 2.2) * influence;
  vec2 center = u_mouth.xy + vec2(u_faceMotion.z * u_mouth.z * 0.06, 0.0);
  float apertureX = (outputUV.x - center.x) / max(mouthDimensions(0.5).x, 0.00001);
  float apertureSide = mouthSide(apertureX);
  float apertureOpen = mouthOpening(apertureSide);
  if (apertureOpen > 0.045 && abs(apertureX) < 1.45) {
    vec3 dimensions = mouthDimensions(apertureSide);
    float arch = pow(max(0.0, 1.0 - apertureX * apertureX), mix(0.64, 0.5, u_mouthShape.x));
    float cornerLift = mix(u_corners.y - u_corners.w, u_corners.x - u_corners.z, apertureSide);
    float upperEdge = center.y - cornerLift * u_mouth.w * 0.16 * min(1.0, apertureX * apertureX) - dimensions.y * arch;
    float edgeWeight = (1.0 - smoothstep(0.92, 1.45, abs(apertureX)))
      * (1.0 - smoothstep(0.55, 1.5, abs((outputUV.y - center.y) / u_mouth.w)))
      * smoothstep(0.045, 0.15, apertureOpen);
    uv.y = mix(uv.y, outputUV.y + sourceLipLine(uv.x) - upperEdge, edgeWeight);
  }
  return uv;
}
vec4 mouthInterior(vec4 source, vec2 uv) {
  if (u_mouth.z <= 0.0 || u_mouth.w <= 0.0) return source;
  float width = mouthDimensions(0.5).x;
  vec2 center = u_mouth.xy + vec2(u_faceMotion.z * u_mouth.z * 0.06, 0.0);
  float x = (uv.x - center.x) / max(width, 0.00001);
  if (abs(x) >= 1.0) return source;
  float side = mouthSide(x);
  float opening = mouthOpening(side);
  float smile = mix(u_corners.y, u_corners.x, side), frown = mix(u_corners.w, u_corners.z, side);
  vec3 dimensions = mouthDimensions(side);
  float arch = pow(max(0.0, 1.0 - x * x), mix(0.64, 0.5, u_mouthShape.x));
  float upperHeight = dimensions.y * arch;
  float lowerHeight = dimensions.z * arch;
  float centerY = center.y - (smile - frown) * u_mouth.w * 0.16 * x * x;
  float y = uv.y - centerY;
  float edge = min(y + upperHeight, lowerHeight - y);
  float feather = max(u_mouth.w * 0.055, 0.00015);
  float mask = smoothstep(-feather, feather, edge) * smoothstep(0.045, 0.15, opening) * (1.0 - smoothstep(0.88, 1.0, abs(x)));
  // A restrained cavity hint, coloured from the ORIGINAL lip line. Hidden
  // teeth/tongue cannot be recovered from one closed-mouth image: none are
  // fabricated, and this is not a reconstructed anatomical mouth interior.
  vec3 originalLip = texture2D(u_image, u_mouth.xy).rgb;
  vec3 nearbySkin = texture2D(u_image, u_mouth.xy + vec2(0.0, u_mouth.w * 0.57)).rgb;
  // Do not darken the already-dark drawn lip line into a black cut-out. Keep
  // its hue at low weight, with a warm skin-derived tint and soft lower bounce.
  vec3 lipTint = mix(nearbySkin * vec3(${MOUTH_TONE.skinRose.join(", ")}), originalLip, ${MOUTH_TONE.lipMix});
  vec3 upperShade = lipTint * vec3(${MOUTH_TONE.upperShade.join(", ")});
  vec3 lowerBounce = mix(lipTint, nearbySkin * vec3(${MOUTH_TONE.lowerLight.join(", ")}), ${MOUTH_TONE.bounceMix});
  float depth = clamp((y + upperHeight) / max(upperHeight + lowerHeight, 0.00001), 0.0, 1.0);
  vec3 cavity = mix(upperShade, lowerBounce, smoothstep(0.06, 0.96, depth));
  cavity *= 0.93 + 0.07 * arch;
  float innerRim = 1.0 - smoothstep(0.0, feather * 1.5, max(0.0, edge));
  cavity = mix(cavity, lipTint * 0.9, innerRim * 0.38);
  source.rgb = mix(source.rgb, cavity * source.a, mask);
  return source;
}
void main() {
  vec2 faceUV = faceWarp(v_uv);
  vec2 uv = browWarp(faceUV, u_leftBrow, u_brow.xy);
  uv = browWarp(uv, u_rightBrow, u_brow.zw);
  uv = eyeWarp(uv, u_leftEye, u_eye.x, u_eye.z, u_look.xy);
  uv = eyeWarp(uv, u_rightEye, u_eye.y, u_eye.w, u_look.zw);
  uv = mouthWarp(uv);
  gl_FragColor = mouthInterior(texture2D(u_image, clamp(uv, vec2(0.0), vec2(1.0))), faceUV);
}`;

/**
 * Public: local, optional WebGL portrait deformation. No main-canvas access,
 * network requests, flat-skin patches, copied expression sheets or hidden teeth.
 */
export class PortraitWarp {
  /** Public: create an isolated renderer; actual GPU allocation is lazy. */
  constructor() {
    this.canvas = typeof document === "undefined" ? null : document.createElement("canvas");
    this._source = null;
    this._gl = null;
    this._program = null;
    this._buffer = null;
    this._texture = null;
    this._image = null;
    this._failedImage = null;
    this._lost = false;
    this._disposed = false;
    this._unavailable = false;
    this._onLost = (event) => { event.preventDefault(); this._lost = true; this._image = null; };
    this._onRestored = () => {
      this._lost = false;
      this._unavailable = false;
      this._program = this._buffer = this._texture = this._image = this._failedImage = null;
    };
    this.canvas?.addEventListener("webglcontextlost", this._onLost);
    this.canvas?.addEventListener("webglcontextrestored", this._onRestored);
  }

  _initialize() {
    if (this._program) return true;
    const gl = this._gl || this.canvas.getContext("webgl", {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true,
    });
    if (!gl) return false;
    this._gl = gl;
    const shaders = [];
    let program = null;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]]) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Portrait shader unavailable");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Portrait shader unsupported");
      }
      program = gl.createProgram();
      if (!program) throw new Error("Portrait program unavailable");
      shaders.forEach((shader) => gl.attachShader(program, shader));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Portrait program unsupported");
      this._program = program;
      this._buffer = gl.createBuffer();
      this._texture = gl.createTexture();
      if (!this._buffer || !this._texture) throw new Error("Portrait GPU resources unavailable");
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      // Premultiplied interpolation keeps transparent hair edges free of halos.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      this._uniforms = Object.fromEntries(["image", "face", "leftEye", "rightEye", "leftBrow", "rightBrow", "mouth", "eye", "look", "brow", "jaw", "lips", "corners", "mouthShape", "mouthDetail", "faceMotion"]
        .map((name) => [name, gl.getUniformLocation(program, `u_${name}`)]));
      gl.uniform1i(this._uniforms.image, 0);
      return true;
    } catch {
      if (this._buffer) gl.deleteBuffer(this._buffer);
      if (this._texture) gl.deleteTexture(this._texture);
      if (program) {
        shaders.forEach((shader) => gl.detachShader(program, shader));
        gl.deleteProgram(program);
        program = null;
      }
      this._program = this._buffer = this._texture = null;
      return false;
    } finally {
      shaders.forEach((shader) => { if (program) gl.detachShader(program, shader); gl.deleteShader(shader); });
    }
  }

  /**
   * Public: return an at-most-2048px canvas, or null to draw the original image.
   * Rig boxes are ORIGINAL image pixels. Intensity contains blink/mouth/expression
   * multipliers. Only a new image identity/dimensions causes a texture upload.
   */
  render(image, rig, motion, intensity, blendshapes = {}) {
    if (!this.canvas || this._disposed || this._unavailable || this._lost || !image || this._failedImage === image) return null;
    const width = typeof image.naturalWidth === "number" ? image.naturalWidth : image.width;
    const height = typeof image.naturalHeight === "number" ? image.naturalHeight : image.height;
    const state = portraitWarpState(width, height, rig, motion, intensity, blendshapes);
    if (!state || (!state.leftEye[2] && !state.rightEye[2] && !state.mouth[2])) return null;
    try {
      if (!this._initialize()) { this._unavailable = true; return null; }
      const gl = this._gl;
      if (gl.isContextLost()) return null;
      if (image !== this._image || width !== this._width || height !== this._height) {
        const edge = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
        const scale = Math.min(1, edge / Math.max(width, height));
        this.canvas.width = Math.max(1, Math.round(width * scale));
        this.canvas.height = Math.max(1, Math.round(height * scale));
        this._source ||= document.createElement("canvas");
        this._source.width = this.canvas.width;
        this._source.height = this.canvas.height;
        const sourceContext = this._source.getContext("2d");
        if (!sourceContext) return null;
        sourceContext.clearRect(0, 0, this._source.width, this._source.height);
        sourceContext.drawImage(image, 0, 0, this._source.width, this._source.height);
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._source);
        if (gl.getError() !== gl.NO_ERROR) { this._failedImage = image; return null; }
        this._image = image;
        this._width = width;
        this._height = height;
      }
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this._program);
      for (const name of ["face", "leftEye", "rightEye", "leftBrow", "rightBrow", "mouth", "eye", "look", "brow", "jaw", "lips", "corners", "mouthShape", "mouthDetail", "faceMotion"]) gl.uniform4fv(this._uniforms[name], state[name]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return this.canvas;
    } catch {
      // Unsupported images, cross-origin taint or a lost context keep 2D usable.
      this._failedImage = image;
      return null;
    }
  }

  /** Public: release all GPU objects, canvases and listeners; safe to call twice. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.canvas?.removeEventListener("webglcontextlost", this._onLost);
    this.canvas?.removeEventListener("webglcontextrestored", this._onRestored);
    const gl = this._gl;
    if (gl) {
      if (this._texture) gl.deleteTexture(this._texture);
      if (this._buffer) gl.deleteBuffer(this._buffer);
      if (this._program) gl.deleteProgram(this._program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    if (this.canvas) this.canvas.width = this.canvas.height = 1;
    if (this._source) this._source.width = this._source.height = 1;
    this._gl = this._program = this._buffer = this._texture = this._source = this._image = this._failedImage = null;
    this._uniforms = null;
  }
}
