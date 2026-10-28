/**
 * Front-view painted-expression selector. The renderer supplies local artwork
 * for the returned state names; this module never moves, scales, interpolates,
 * or generates image pixels. Left / Right always mean the character's own
 * anatomy: eyeLeft and browLeft appear on the viewer's right in the front view.
 */
export const CHANNELS = Object.freeze([
  { key: "eyeBlinkLeft", group: "eyes", groupLabel: "眼睛", label: "角色左眼闭合", mode: "frame" },
  { key: "eyeBlinkRight", group: "eyes", groupLabel: "眼睛", label: "角色右眼闭合", mode: "frame" },
  { key: "eyeLookInLeft", group: "gaze", groupLabel: "视线", label: "角色左眼向内看", mode: "gaze", asset: "gaze" },
  { key: "eyeLookOutLeft", group: "gaze", groupLabel: "视线", label: "角色左眼向外看", mode: "gaze", asset: "gaze" },
  { key: "eyeLookUpLeft", group: "gaze", groupLabel: "视线", label: "角色左眼向上看", mode: "gaze", asset: "gaze" },
  { key: "eyeLookDownLeft", group: "gaze", groupLabel: "视线", label: "角色左眼向下看", mode: "gaze", asset: "gaze" },
  { key: "eyeLookInRight", group: "gaze", groupLabel: "视线", label: "角色右眼向内看", mode: "gaze", asset: "gaze" },
  { key: "eyeLookOutRight", group: "gaze", groupLabel: "视线", label: "角色右眼向外看", mode: "gaze", asset: "gaze" },
  { key: "eyeLookUpRight", group: "gaze", groupLabel: "视线", label: "角色右眼向上看", mode: "gaze", asset: "gaze" },
  { key: "eyeLookDownRight", group: "gaze", groupLabel: "视线", label: "角色右眼向下看", mode: "gaze", asset: "gaze" },
  { key: "jawOpen", group: "mouth", groupLabel: "嘴部", label: "张嘴", mode: "frame" },
  { key: "mouthClose", group: "mouth", groupLabel: "嘴部", label: "闭合嘴巴", mode: "frame" },
  { key: "mouthPucker", group: "mouth", groupLabel: "嘴部", label: "噘嘴", mode: "frame" },
  { key: "mouthPressLeft", group: "mouth", groupLabel: "嘴部", label: "角色左抿嘴（整嘴近似）", mode: "approximate" },
  { key: "mouthPressRight", group: "mouth", groupLabel: "嘴部", label: "角色右抿嘴（整嘴近似）", mode: "approximate" },
  { key: "mouthLeft", group: "mouth", groupLabel: "嘴部", label: "角色左移嘴", mode: "optional", asset: "shiftLeft" },
  { key: "mouthRight", group: "mouth", groupLabel: "嘴部", label: "角色右移嘴", mode: "optional", asset: "shiftRight" },
  { key: "browInnerUp", group: "brows", groupLabel: "眉毛", label: "眉头抬起（整眉近似）", mode: "approximate" },
  { key: "browOuterUpLeft", group: "brows", groupLabel: "眉毛", label: "角色左眉尾抬起（整眉近似）", mode: "approximate" },
  { key: "browOuterUpRight", group: "brows", groupLabel: "眉毛", label: "角色右眉尾抬起（整眉近似）", mode: "approximate" },
  { key: "browDownLeft", group: "brows", groupLabel: "眉毛", label: "角色左眉压低", mode: "frame" },
  { key: "browDownRight", group: "brows", groupLabel: "眉毛", label: "角色右眉压低", mode: "frame" },
].map(Object.freeze));

const bounded = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Keep only this front-view sample's declared ARKit coefficients; no coercion. */
export function sanitizeChannels(input) {
  const source = isObject(input) ? input : {};
  return Object.fromEntries(CHANNELS.map(({ key }) => [key, Object.hasOwn(source, key) ? bounded(source[key]) : 0]));
}

/**
 * Describes this sample's declared channels, never all 52 ARKit channels. Any channel
 * absent from this map is unsupported. `frame` means a finite painting is
 * selected, not that each coefficient has a separate drawing or passed QA.
 * `gaze` is a separate signed eye-direction signal, not a painted blink state.
 * Asset flags may be set only after the corresponding local resources exist.
 */
export function channelSupport(available = {}) {
  return Object.freeze(Object.fromEntries(CHANNELS.map(({ key, mode, asset }) => [key,
    asset && available?.[asset] !== true ? "unsupported" : mode === "optional" ? "frame" : mode,
  ])));
}

/**
 * Independent front-view gaze, with canvas-right / canvas-down positive.
 * Anatomical left is on the viewer's right, so looking inward has the opposite
 * horizontal sign for each eye. Opposing coefficients cancel after each input
 * is clamped to 0…1. Missing resources return neutral; no simulated gaze is
 * introduced into the expression or motion state.
 */
export function selectGaze(channels, available = {}) {
  const c = available?.gaze === true ? sanitizeChannels(channels) : sanitizeChannels();
  return {
    eyeLeft: {
      x: c.eyeLookOutLeft - c.eyeLookInLeft,
      y: c.eyeLookDownLeft - c.eyeLookUpLeft,
    },
    eyeRight: {
      x: c.eyeLookInRight - c.eyeLookOutRight,
      y: c.eyeLookDownRight - c.eyeLookUpRight,
    },
  };
}

const EYES = Object.freeze(["open", "half", "closed"]);
const JAW = Object.freeze(["neutral", "openSmall", "openWide"]);
const EXTENDED_EYES = Object.freeze(["open", "quarter", "half", "threeQuarter", "closed"]);
const EXTENDED_JAW = Object.freeze(["neutral", "parted", "openSmall", "openMedium", "openWide"]);
const threshold = (previous, state, enter, leave) => previous === state ? leave : enter;

function staged(value, previous, states, boundaries, margin) {
  let index = states.indexOf(previous);
  if (index < 0) return states[boundaries.filter((boundary) => value >= boundary).length];
  while (index < boundaries.length && value > boundaries[index] + margin) index += 1;
  while (index > 0 && value < boundaries[index - 1] - margin) index -= 1;
  return states[index];
}

function selectBrow(raised, down, previous) {
  const hasUp = raised >= threshold(previous, "up", .5, .35);
  const hasDown = down >= threshold(previous, "down", .5, .35);
  if (hasUp && hasDown) {
    // Small contrary noise does not flicker between two unrelated paintings.
    const difference = down - raised;
    if (previous === "down" && difference >= -.08) return "down";
    if (previous === "up" && difference <= .08) return "up";
    return difference >= 0 ? "down" : "up";
  }
  return hasDown ? "down" : hasUp ? "up" : "neutral";
}

/**
 * Pure discrete selection. Pass the previous returned object for hysteresis.
 * Mouth priority: press > mouthClose > pucker > supported signed shift > jaw.
 * mouthClose at .6 closes an open jaw, but intentional pressing stays pressed.
 * Missing shift artwork leaves other mouth inputs effective, including jaw.
 * Five-stage eye/jaw sequences require an explicit complete-artwork opt-in;
 * without it the original three drawings and their thresholds are unchanged.
 */
export function selectExpression(channels, previous = {}, available = { shiftLeft: false, shiftRight: false }) {
  const c = sanitizeChannels(channels);
  const old = isObject(previous) ? previous : {};
  const extendedEyes = available?.extendedEyes === true;
  const extendedJaw = available?.extendedJaw === true;
  const mouth = () => {
    if (Math.max(c.mouthPressLeft, c.mouthPressRight) >= threshold(old.mouth, "press", .55, .4)) return "press";
    if (c.mouthClose >= .6) return "neutral";
    if (c.mouthPucker >= threshold(old.mouth, "pucker", .55, .4)) return "pucker";
    const direction = c.mouthLeft - c.mouthRight;
    const shift = direction > 0 ? "shiftLeft" : "shiftRight";
    if (available?.[shift] === true && Math.abs(direction) >= threshold(old.mouth, shift, .35, .2)) return shift;
    return extendedJaw
      ? staged(c.jawOpen, old.mouth, EXTENDED_JAW, [.09, .29, .54, .815], .025)
      : staged(c.jawOpen, old.mouth, JAW, [.15, .65], .03);
  };
  const eye = (side) => extendedEyes
    ? staged(c[`eyeBlink${side}`], old[`eye${side}`], EXTENDED_EYES, [.125, .375, .625, .875], .025)
    : staged(c[`eyeBlink${side}`], old[`eye${side}`], EYES, [.3, .8], .04);
  return {
    eyeLeft: eye("Left"),
    eyeRight: eye("Right"),
    browLeft: selectBrow(Math.max(c.browInnerUp, c.browOuterUpLeft), c.browDownLeft, old.browLeft),
    browRight: selectBrow(Math.max(c.browInnerUp, c.browOuterUpRight), c.browDownRight, old.browRight),
    mouth: mouth(),
  };
}

/** Fixed 10-second front-view sequence. It contains only input coefficients;
 * optional shift steps deliberately remain neutral when their art is absent. */
export const DEMO = Object.freeze({
  duration: 10,
  steps: Object.freeze([
    { start: 0, end: .75, id: "neutral", label: "中性", channels: {} },
    { start: .75, end: 1.25, id: "halfBlink", label: "半闭眼", channels: { eyeBlinkLeft: .5, eyeBlinkRight: .5 } },
    { start: 1.25, end: 1.75, id: "blink", label: "闭眼", channels: { eyeBlinkLeft: 1, eyeBlinkRight: 1 } },
    { start: 1.75, end: 2.5, id: "openSmall", label: "小幅张嘴", channels: { jawOpen: .4 } },
    { start: 2.5, end: 3.25, id: "openWide", label: "张嘴", channels: { jawOpen: .95 } },
    { start: 3.25, end: 4, id: "pucker", label: "噘嘴", channels: { mouthPucker: .9 } },
    { start: 4, end: 4.75, id: "press", label: "抿嘴（整嘴）", channels: { mouthPressLeft: .9, mouthPressRight: .9 } },
    { start: 4.75, end: 5.5, id: "browsUp", label: "抬眉（整眉）", channels: { browInnerUp: .9 } },
    { start: 5.5, end: 6.25, id: "browsDown", label: "压眉", channels: { browDownLeft: .9, browDownRight: .9 } },
    { start: 6.25, end: 7, id: "shiftLeft", label: "左移嘴（需独立画稿）", channels: { mouthLeft: .9 } },
    { start: 7, end: 7.75, id: "shiftRight", label: "右移嘴（需独立画稿）", channels: { mouthRight: .9 } },
    { start: 7.75, end: 9.25, id: "combination", label: "组合：左眼闭合、右眉抬起、小幅张嘴", channels: { eyeBlinkLeft: 1, browOuterUpRight: .9, jawOpen: .4 } },
    { start: 9.25, end: 10, id: "rest", label: "回到中性", channels: {} },
  ].map((step) => Object.freeze({ ...step, channels: Object.freeze(sanitizeChannels(step.channels)) }))),
});

/** Pure timeline sampling. Invalid/negative time starts at neutral; no timers,
 * camera access, tracking, clocks, DOM, imports, or background work. */
export function sampleDemo(seconds) {
  const phase = (Number.isFinite(seconds) ? Math.max(0, seconds) : 0) % DEMO.duration;
  const step = DEMO.steps.find(({ start, end }) => phase >= start && phase < end);
  return { ...step.channels };
}
