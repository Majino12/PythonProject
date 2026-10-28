import test from "node:test";
import assert from "node:assert/strict";
import { CHANNELS, selectExpression, sanitizeChannels } from "./expression-model.js";
import { createMotionState, advanceMotion, NATURAL_DEMO, sampleNaturalDemo } from "./expression-motion.js";

const NEUTRAL = { eyeLeft: "open", eyeRight: "open", browLeft: "neutral", browRight: "neutral", mouth: "neutral" };
const EXTENDED = { extendedEyes: true, extendedJaw: true };
const target = (changes) => ({ ...NEUTRAL, ...changes });

test("motion creation is detached and starts neutral without allocating timers or requiring a renderer", () => {
  assert.deepEqual(createMotionState().frameState, NEUTRAL);
  for (const input of [null, 0, [], "closed", { eyeLeft: "unknown", mouth: NaN }]) assert.deepEqual(createMotionState(input).frameState, NEUTRAL);
  const initial = target({ eyeLeft: "quarter", browRight: "up", mouth: "parted" });
  const motion = createMotionState(initial);
  assert.deepEqual(motion.frameState, initial);
  motion.frameState.mouth = "pucker";
  assert.equal(initial.mouth, "parted");
  assert.notEqual(motion.timing.eyeLeft, motion.timing.eyeRight);
});

test("extended eyes visit adjacent drawings at 24 ms per step and hold their independent targets", () => {
  const closedLeft = target({ eyeLeft: "closed", eyeRight: "half" });
  let motion = advanceMotion(createMotionState(), closedLeft, 23, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "open");
  assert.equal(motion.frameState.eyeRight, "open");
  motion = advanceMotion(motion, closedLeft, 1, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "quarter");
  assert.equal(motion.frameState.eyeRight, "quarter");
  for (const state of ["half", "threeQuarter", "closed"]) {
    motion = advanceMotion(motion, closedLeft, 24, EXTENDED);
    assert.equal(motion.frameState.eyeLeft, state);
    assert.equal(motion.frameState.eyeRight, "half");
  }
  assert.deepEqual(motion.timing.eyeLeft, { remainderMs: 0, direction: 0 });
});

test("three-stage defaults and strict opt-in never select unavailable intermediate eye or jaw artwork", () => {
  for (const available of [undefined, null, {}, { extendedEyes: 1, extendedJaw: "true" }]) {
    const next = target({ eyeLeft: "closed", mouth: "openWide" });
    let motion = advanceMotion(createMotionState(), next, 24, available);
    assert.equal(motion.frameState.eyeLeft, "half");
    assert.equal(motion.frameState.mouth, "neutral");
    motion = advanceMotion(motion, next, 14, available);
    assert.equal(motion.frameState.mouth, "openSmall");
    motion = advanceMotion(motion, next, 38, available);
    assert.equal(motion.frameState.eyeLeft, "closed");
    assert.equal(motion.frameState.mouth, "openWide");
  }
});

test("jaw progresses through five actual paintings at 38 ms, without crossing unrelated mouth families", () => {
  const wide = target({ mouth: "openWide" });
  let motion = advanceMotion(createMotionState(), wide, 37, EXTENDED);
  assert.equal(motion.frameState.mouth, "neutral");
  motion = advanceMotion(motion, wide, 1, EXTENDED);
  assert.equal(motion.frameState.mouth, "parted");
  for (const state of ["openSmall", "openMedium", "openWide"]) {
    motion = advanceMotion(motion, wide, 38, EXTENDED);
    assert.equal(motion.frameState.mouth, state);
  }
  for (const state of ["openMedium", "openSmall", "parted", "neutral"]) {
    motion = advanceMotion(motion, NEUTRAL, 38, EXTENDED);
    assert.equal(motion.frameState.mouth, state);
  }
});

test("eye reversal discards old partial progress and never continues a queued closure", () => {
  const closed = target({ eyeLeft: "closed" });
  let motion = advanceMotion(createMotionState(), closed, 84, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "threeQuarter");
  assert.equal(motion.timing.eyeLeft.remainderMs, 12);
  motion = advanceMotion(motion, NEUTRAL, 12, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "threeQuarter", "old closing remainder must not be spent on a reversed target");
  motion = advanceMotion(motion, NEUTRAL, 12, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "half");
  motion = advanceMotion(motion, NEUTRAL, 24, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "quarter");
  motion = advanceMotion(motion, NEUTRAL, 24, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "open");
});

test("a nearer replacement target stops exactly there and idle time is never banked", () => {
  let motion = advanceMotion(createMotionState(), target({ eyeLeft: "closed" }), 32, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "quarter");
  motion = advanceMotion(motion, target({ eyeLeft: "quarter" }), 200, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "quarter");
  assert.deepEqual(motion.timing.eyeLeft, { remainderMs: 0, direction: 0 });
  motion = advanceMotion(motion, target({ eyeLeft: "closed" }), 1, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "quarter");
  assert.equal(motion.timing.eyeLeft.remainderMs, 1);
  motion = advanceMotion(motion, target({ eyeLeft: "closed" }), 23, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "half");
});

test("left and right eyes retain separate timing when their targets start at different instants", () => {
  let motion = advanceMotion(createMotionState(), target({ eyeLeft: "closed" }), 12, EXTENDED);
  const both = target({ eyeLeft: "closed", eyeRight: "closed" });
  motion = advanceMotion(motion, both, 12, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "quarter");
  assert.equal(motion.frameState.eyeRight, "open");
  motion = advanceMotion(motion, both, 12, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "quarter");
  assert.equal(motion.frameState.eyeRight, "quarter");
  motion = advanceMotion(motion, both, 12, EXTENDED);
  assert.equal(motion.frameState.eyeLeft, "half");
  assert.equal(motion.frameState.eyeRight, "quarter");
});

test("pucker, press and pure shifts switch instantly both into and out of the jaw family", () => {
  for (const special of ["pucker", "press", "shiftLeft", "shiftRight"]) {
    const fromJaw = createMotionState(target({ mouth: "openMedium" }));
    const specialMotion = advanceMotion(fromJaw, target({ mouth: special }), 0, EXTENDED);
    assert.equal(specialMotion.frameState.mouth, special);
    assert.deepEqual(specialMotion.timing.mouth, { remainderMs: 0, direction: 0 });
    const jawMotion = advanceMotion(specialMotion, target({ mouth: "openWide" }), 0, EXTENDED);
    assert.equal(jawMotion.frameState.mouth, "openWide");
    const alternate = special === "pucker" ? "press" : "pucker";
    assert.equal(advanceMotion(specialMotion, target({ mouth: alternate }), 0, EXTENDED).frameState.mouth, alternate);
  }
});

test("brows update immediately without spending or altering eye/jaw timing", () => {
  const next = target({ eyeLeft: "closed", mouth: "openWide", browLeft: "up", browRight: "down" });
  const motion = advanceMotion(createMotionState(), next, 0, EXTENDED);
  assert.deepEqual(motion.frameState, { ...NEUTRAL, browLeft: "up", browRight: "down" });
  assert.equal(motion.timing.eyeLeft.remainderMs, 0);
  assert.equal(motion.timing.mouth.remainderMs, 0);
});

test("normal elapsed-time partitions agree and larger valid steps follow their bounded elapsed budget", () => {
  const next = target({ eyeLeft: "closed", eyeRight: "closed", mouth: "openWide" });
  const whole = advanceMotion(createMotionState(), next, 96, EXTENDED);
  let parts = createMotionState();
  for (let count = 0; count < 6; count += 1) parts = advanceMotion(parts, next, 16, EXTENDED);
  assert.deepEqual(parts, whole);
  assert.equal(whole.frameState.eyeLeft, "closed");
  assert.equal(whole.frameState.mouth, "openSmall");
  assert.equal(whole.timing.mouth.remainderMs, 20);
  assert.deepEqual(advanceMotion(createMotionState(), next, 200, EXTENDED).frameState, next);
});

test("stale, negative or nonfinite time snaps to latest safe target instead of replaying old transitions", () => {
  const targetFrame = target({ eyeLeft: "closed", mouth: "openWide", browRight: "up" });
  const partial = advanceMotion(createMotionState(), targetFrame, 16, EXTENDED);
  for (const gap of [201, 1000, -1, NaN, Infinity, -Infinity, undefined, null, "16"]) {
    const next = advanceMotion(partial, targetFrame, gap, EXTENDED);
    assert.deepEqual(next.frameState, targetFrame);
    for (const lane of ["eyeLeft", "eyeRight", "mouth"]) assert.deepEqual(next.timing[lane], { remainderMs: 0, direction: 0 });
  }
  assert.deepEqual(advanceMotion(partial, { eyeLeft: "bad", mouth: "bad" }, 500, EXTENDED).frameState, NEUTRAL);
});

test("dropping extended availability never renders removed states, including after a suspended tab", () => {
  const expanded = target({ eyeLeft: "quarter", eyeRight: "threeQuarter", mouth: "parted" });
  const state = createMotionState(expanded);
  assert.deepEqual(advanceMotion(state, expanded, 0, {}).frameState, { ...NEUTRAL, eyeRight: "half", mouth: "openSmall" });
  const medium = target({ mouth: "openMedium" });
  assert.equal(advanceMotion(createMotionState(medium), medium, 300, {}).frameState.mouth, "openWide");
});

test("motion functions do not mutate targets, prior state, timing or availability, and reject corrupted time credit", () => {
  const next = Object.freeze(target({ eyeLeft: "closed", mouth: "openWide" }));
  const initial = createMotionState();
  for (const timing of Object.values(initial.timing)) Object.freeze(timing);
  Object.freeze(initial.timing); Object.freeze(initial.frameState); Object.freeze(initial);
  const motion = advanceMotion(initial, next, 24, Object.freeze({ ...EXTENDED }));
  assert.equal(initial.frameState.eyeLeft, "open");
  assert.equal(initial.timing.eyeLeft.remainderMs, 0);
  assert.notEqual(motion.frameState, next);
  const corrupt = { frameState: { ...NEUTRAL }, timing: { eyeLeft: { direction: 1, remainderMs: 999 } } };
  assert.equal(advanceMotion(corrupt, next, 0, EXTENDED).frameState.eyeLeft, "open");
  assert.deepEqual(advanceMotion(null, null, 0).frameState, NEUTRAL);
});

test("natural demo labels cover exactly eight seconds and sampling is bounded, deterministic and fresh", () => {
  assert.equal(NATURAL_DEMO.duration, 8);
  assert.equal(NATURAL_DEMO.steps[0].start, 0);
  assert.equal(NATURAL_DEMO.steps.at(-1).end, 8);
  for (let index = 0; index < NATURAL_DEMO.steps.length; index += 1) {
    const step = NATURAL_DEMO.steps[index];
    assert.ok(Object.isFrozen(step));
    assert.ok(step.label && step.end > step.start);
    if (index) assert.equal(step.start, NATURAL_DEMO.steps[index - 1].end);
  }
  for (let tick = 0; tick < 800; tick += 1) {
    const coefficients = sampleNaturalDemo(tick / 100);
    assert.equal(Object.keys(coefficients).length, CHANNELS.length);
    assert.ok(Object.values(coefficients).every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
  }
  assert.deepEqual(sampleNaturalDemo(8), sampleNaturalDemo(0));
  assert.deepEqual(sampleNaturalDemo(8.5), sampleNaturalDemo(.5));
  for (const invalid of [NaN, Infinity, null, undefined, -1, "2"]) assert.deepEqual(sampleNaturalDemo(invalid), sanitizeChannels({}));
  const sampled = sampleNaturalDemo(.85); sampled.eyeBlinkLeft = 0;
  assert.equal(sampleNaturalDemo(.85).eyeBlinkLeft, 1);
});

test("natural blink/wink each last 420 ms with a closure hold longer than the full five-frame travel", () => {
  for (const id of ["blink", "wink"]) {
    const step = NATURAL_DEMO.steps.find((candidate) => candidate.id === id);
    assert.ok(Math.abs(step.end - step.start - .42) < 1e-9);
    for (const offset of [.08, .12, .2, .259]) assert.equal(sampleNaturalDemo(step.start + offset).eyeBlinkLeft, 1);
    assert.equal(sampleNaturalDemo(step.start).eyeBlinkLeft, 0);
    assert.ok(sampleNaturalDemo(step.end).eyeBlinkLeft < 1e-10);
  }
  assert.equal(sampleNaturalDemo(3.99).eyeBlinkRight, 0, "wink must affect only the character's left eye");
});

function simulate(dtMs, offsetMs = 0) {
  const frames = [];
  let motion = createMotionState(), previousTarget = {};
  for (let elapsed = offsetMs; elapsed < 8000; elapsed += dtMs) {
    const time = elapsed / 1000;
    const selected = selectExpression(sampleNaturalDemo(time), previousTarget, EXTENDED);
    motion = advanceMotion(motion, selected, dtMs, EXTENDED);
    previousTarget = selected;
    frames.push({ time, ...motion.frameState });
  }
  return frames;
}

test("real natural demo sampling reaches closed at ordinary display rates and reopening does not retain stale closure", () => {
  for (const dtMs of [8, 16, 1000 / 60, 1000 / 30, 50, 100]) {
    for (const offset of [0, 7, 19]) {
      const frames = simulate(dtMs, offset);
      const blink = frames.filter(({ time }) => time >= .7 && time < 1.2);
      assert.ok(blink.some(({ eyeLeft, eyeRight }) => eyeLeft === "closed" && eyeRight === "closed"), `blink closes at dt=${dtMs}, offset=${offset}`);
      const wink = frames.filter(({ time }) => time >= 3.85 && time < 4.4);
      assert.ok(wink.some(({ eyeLeft }) => eyeLeft === "closed"), `wink closes at dt=${dtMs}, offset=${offset}`);
      assert.ok(wink.every(({ eyeRight }) => eyeRight === "open"));
      assert.ok(frames.filter(({ time }) => time >= 1.2 && time < 1.35).every(({ eyeLeft, eyeRight }) => eyeLeft === "open" && eyeRight === "open"));
    }
  }
  const blink = simulate(16).filter(({ time, eyeLeft }) => time >= .7 && time < 1.2 && eyeLeft !== "open");
  const displayedMs = (blink.at(-1).time - blink[0].time) * 1000 + 16;
  assert.ok(displayedMs >= 360 && displayedMs <= 450, `rendered blink duration ${displayedMs} ms`);
});

test("natural talking uses smooth coefficients and visits every registered jaw drawing", () => {
  let previous = sampleNaturalDemo(1.35).jawOpen;
  let rising = false, peaks = 0;
  for (let tick = 1351; tick <= 3850; tick += 1) {
    const current = sampleNaturalDemo(tick / 1000).jawOpen;
    assert.ok(Math.abs(current - previous) < .01, "speech coefficients must not abruptly jump between jaw values");
    if (current > previous + 1e-8) rising = true;
    if (rising && current < previous - 1e-8) { peaks += 1; rising = false; }
    previous = current;
  }
  assert.equal(peaks, 3);
  const speech = simulate(16).filter(({ time }) => time >= 1.35 && time < 3.85);
  const states = new Set(speech.map(({ mouth }) => mouth));
  for (const state of ["neutral", "parted", "openSmall", "openMedium", "openWide"]) assert.ok(states.has(state), state);
});

test("natural timeline exercises eyebrow, pucker and whole-mouth press without implying optional shift support", () => {
  const frames = simulate(16);
  assert.ok(frames.some(({ browLeft, browRight }) => browLeft === "up" && browRight === "up"));
  assert.ok(frames.some(({ browLeft, browRight }) => browLeft === "down" && browRight === "down"));
  assert.ok(frames.some(({ mouth }) => mouth === "pucker"));
  assert.ok(frames.some(({ mouth }) => mouth === "press"));
  assert.ok(frames.every(({ mouth }) => mouth !== "shiftLeft" && mouth !== "shiftRight"));
  assert.deepEqual(sampleNaturalDemo(7.9), sanitizeChannels({}));
});
