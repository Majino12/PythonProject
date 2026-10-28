import { sanitizeChannels } from "./expression-model.js";

const EYES = Object.freeze(["open", "half", "closed"]);
const EXTENDED_EYES = Object.freeze(["open", "quarter", "half", "threeQuarter", "closed"]);
const JAW = Object.freeze(["neutral", "openSmall", "openWide"]);
const EXTENDED_JAW = Object.freeze(["neutral", "parted", "openSmall", "openMedium", "openWide"]);
const MOUTHS = Object.freeze([...EXTENDED_JAW, "pucker", "press", "shiftLeft", "shiftRight"]);
const BROWS = Object.freeze(["neutral", "up", "down"]);
const LANES = Object.freeze(["eyeLeft", "eyeRight", "mouth"]);
const NEUTRAL = Object.freeze({ eyeLeft: "open", eyeRight: "open", browLeft: "neutral", browRight: "neutral", mouth: "neutral" });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const freshTiming = () => Object.fromEntries(LANES.map((lane) => [lane, { remainderMs: 0, direction: 0 }]));

function normalizeState(input, available) {
  const state = object(input);
  const result = {
    eyeLeft: EXTENDED_EYES.includes(state.eyeLeft) ? state.eyeLeft : "open",
    eyeRight: EXTENDED_EYES.includes(state.eyeRight) ? state.eyeRight : "open",
    browLeft: BROWS.includes(state.browLeft) ? state.browLeft : "neutral",
    browRight: BROWS.includes(state.browRight) ? state.browRight : "neutral",
    mouth: MOUTHS.includes(state.mouth) ? state.mouth : "neutral",
  };
  // Reverting to a three-stage pack cannot leave an unavailable image selected.
  // These fallbacks match the original model at .25/.75 and .18/.68 inputs.
  if (available && available.extendedEyes !== true) {
    for (const lane of ["eyeLeft", "eyeRight"]) {
      if (result[lane] === "quarter") result[lane] = "open";
      if (result[lane] === "threeQuarter") result[lane] = "half";
    }
  }
  if (available && available.extendedJaw !== true) {
    if (result.mouth === "parted") result.mouth = "openSmall";
    if (result.mouth === "openMedium") result.mouth = "openWide";
  }
  return result;
}

/** Create detached animation state. Only .frameState is intended for rendering;
 * timing is fractional elapsed time, never a queue of old target expressions. */
export function createMotionState(initial = NEUTRAL) {
  return { frameState: normalizeState(initial), timing: freshTiming() };
}

function advanceLane(current, target, priorTiming, dtMs, sequence, stepMs) {
  const from = sequence.indexOf(current), to = sequence.indexOf(target);
  if (from < 0 || to < 0 || from === to) return { frame: target, timing: { remainderMs: 0, direction: 0 } };
  const direction = Math.sign(to - from);
  const previous = object(priorTiming);
  // Discard partial progress when motion reverses. The newest target wins;
  // no previous closure or reopening can remain queued behind the current one.
  const carried = previous.direction === direction && Number.isFinite(previous.remainderMs)
    && previous.remainderMs >= 0 && previous.remainderMs < stepMs ? previous.remainderMs : 0;
  const elapsed = carried + dtMs;
  const steps = Math.min(Math.abs(to - from), Math.floor((elapsed + 1e-8) / stepMs));
  const index = from + direction * steps;
  const reached = index === to;
  return {
    frame: sequence[index],
    timing: { remainderMs: reached ? 0 : Math.max(0, elapsed - steps * stepMs), direction: reached ? 0 : direction },
  };
}

/**
 * Pure front-view timing. target is the object returned by selectExpression.
 * Each independent eye advances one existing drawing every 24 ms; jaw-family
 * drawings advance every 38 ms. Only elapsed-time credit is retained. Larger
 * valid dt can traverse multiple adjacent steps; no image blending is done.
 * Pucker/press/shift and eyebrows change immediately. Negative, nonfinite or
 * >200 ms gaps snap safely to the latest target instead of replaying stale work.
 */
export function advanceMotion(motion, target, dtMs, available = {}) {
  const options = object(available);
  const old = object(motion);
  const current = normalizeState(old.frameState, options);
  const next = normalizeState(target, options);
  if (!Number.isFinite(dtMs) || dtMs < 0 || dtMs > 200) return createMotionState(next);
  const frameState = { ...next };
  const timing = freshTiming();
  const eyes = options.extendedEyes === true ? EXTENDED_EYES : EYES;
  const jaw = options.extendedJaw === true ? EXTENDED_JAW : JAW;
  for (const lane of LANES) {
    const selected = advanceLane(current[lane], next[lane], old.timing?.[lane], dtMs, lane === "mouth" ? jaw : eyes, lane === "mouth" ? 38 : 24);
    frameState[lane] = selected.frame;
    timing[lane] = selected.timing;
  }
  return { frameState, timing };
}

/** Labels for UI explanation; coefficient values come from sampleNaturalDemo. */
export const NATURAL_DEMO = Object.freeze({
  duration: 8,
  steps: Object.freeze([
    { start: 0, end: .7, id: "neutral", label: "中性" },
    { start: .7, end: 1.12, id: "blink", label: "自然眨眼 · 420ms" },
    { start: 1.12, end: 1.35, id: "restAfterBlink", label: "放松" },
    { start: 1.35, end: 3.85, id: "speech", label: "说话 · 三次开合" },
    { start: 3.85, end: 4.27, id: "wink", label: "角色左眼眨眼 · 420ms" },
    { start: 4.27, end: 4.5, id: "restAfterWink", label: "放松" },
    { start: 4.5, end: 5.1, id: "browsUp", label: "轻抬眉（整眉）" },
    { start: 5.1, end: 5.7, id: "pucker", label: "噘嘴" },
    { start: 5.7, end: 6.3, id: "press", label: "抿嘴（整嘴）" },
    { start: 6.3, end: 6.9, id: "browsDown", label: "眉毛压低" },
    { start: 6.9, end: 8, id: "rest", label: "回到中性" },
  ].map(Object.freeze)),
});

const smooth = (value) => {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
};

function heldPulse(time, start, closeMs, holdMs, openMs) {
  const elapsed = (time - start) * 1000;
  if (elapsed <= 0 || elapsed >= closeMs + holdMs + openMs) return 0;
  if (elapsed < closeMs) return smooth(elapsed / closeMs);
  if (elapsed < closeMs + holdMs) return 1;
  return 1 - smooth((elapsed - closeMs - holdMs) / openMs);
}

function speechPulse(time, start, end, peak) {
  if (time <= start || time >= end) return 0;
  return peak * Math.sin(Math.PI * (time - start) / (end - start)) ** 2;
}

/** Eight-second pure coefficient timeline. Blink/wink each last 420 ms:
 * 80 ms closing, 180 ms held closed, 160 ms opening. The full-closure hold
 * exceeds the 96 ms needed to traverse all five eye drawings, including at
 * ordinary low frame rates. Smooth coefficients still select discrete art.
 * No timer, clock, camera, pixel interpolation, opacity or scaling is used. */
export function sampleNaturalDemo(seconds) {
  const time = (Number.isFinite(seconds) ? Math.max(0, seconds) : 0) % NATURAL_DEMO.duration;
  const blink = heldPulse(time, .7, 80, 180, 160);
  const wink = heldPulse(time, 3.85, 80, 180, 160);
  const jawOpen = Math.max(speechPulse(time, 1.35, 2.05, .45), speechPulse(time, 2.1, 2.95, .98), speechPulse(time, 3.05, 3.75, .72));
  const browUp = .9 * heldPulse(time, 4.5, 120, 360, 120);
  const browDown = .9 * heldPulse(time, 6.3, 120, 360, 120);
  const press = .9 * heldPulse(time, 5.7, 120, 360, 120);
  return sanitizeChannels({
    eyeBlinkLeft: Math.max(blink, wink), eyeBlinkRight: blink,
    jawOpen,
    browInnerUp: browUp, browDownLeft: browDown, browDownRight: browDown,
    mouthPucker: .9 * heldPulse(time, 5.1, 120, 360, 120),
    mouthPressLeft: press, mouthPressRight: press,
  });
}
