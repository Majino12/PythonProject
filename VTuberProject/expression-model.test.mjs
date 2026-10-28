import test from "node:test";
import assert from "node:assert/strict";
import { CHANNELS, sanitizeChannels, selectExpression, selectGaze, channelSupport, DEMO, sampleDemo } from "./expression-model.js";

const NEUTRAL = { eyeLeft: "open", eyeRight: "open", browLeft: "neutral", browRight: "neutral", mouth: "neutral" };
const SHIFTS = { shiftLeft: true, shiftRight: true };
const GAZE = { gaze: true };
const CENTERED_GAZE = { eyeLeft: { x: 0, y: 0 }, eyeRight: { x: 0, y: 0 } };

test("only declared sample channels are sanitized; null, nonfinite, inherited and unknown values are safe", () => {
  const empty = sanitizeChannels();
  assert.equal(Object.keys(empty).length, CHANNELS.length);
  assert.equal(CHANNELS.length, 22);
  for (const input of [null, undefined, 0, false, "1", [], { eyeBlinkLeft: NaN, jawOpen: Infinity, mouthPucker: "1" }]) {
    assert.deepEqual(sanitizeChannels(input), empty);
    assert.deepEqual(selectExpression(input, null, null), NEUTRAL);
  }
  const input = Object.assign(Object.create({ mouthPucker: 1 }), { eyeBlinkLeft: 9, jawOpen: -3, unknown: 1 });
  const result = sanitizeChannels(input);
  assert.equal(result.eyeBlinkLeft, 1);
  assert.equal(result.jawOpen, 0);
  assert.equal(result.mouthPucker, 0);
  assert.equal(Object.hasOwn(result, "unknown"), false);
  assert.equal(input.eyeBlinkLeft, 9);
});

test("channel metadata covers only the actual sample and states whole-mouth/whole-brow approximations", () => {
  const support = channelSupport();
  assert.equal(Object.keys(support).length, 22);
  assert.equal(Object.hasOwn(support, "tongueOut"), false);
  for (const channel of CHANNELS) {
    assert.ok(channel.label && channel.groupLabel);
    assert.ok(["eyes", "gaze", "mouth", "brows"].includes(channel.group));
    assert.ok(Object.isFrozen(channel));
  }
  for (const key of ["mouthPressLeft", "mouthPressRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight"]) {
    assert.equal(support[key], "approximate");
  }
  assert.equal(support.mouthLeft, "unsupported");
  assert.equal(support.mouthRight, "unsupported");
  assert.equal(channelSupport(SHIFTS).mouthLeft, "frame");
  assert.equal(channelSupport(SHIFTS).mouthRight, "frame");
  assert.equal(channelSupport({ shiftLeft: true }).mouthRight, "unsupported");
  assert.equal(channelSupport({ shiftLeft: "true", shiftRight: 1 }).mouthLeft, "unsupported");
  assert.equal(channelSupport(null).mouthRight, "unsupported");
  assert.ok(Object.isFrozen(support));
  assert.ok(Object.isFrozen(CHANNELS));
});

test("gaze directions follow anatomical left/right while coordinates follow the canvas", () => {
  const directions = [
    ["eyeLookInLeft", "eyeLeft", "x", -1],
    ["eyeLookOutLeft", "eyeLeft", "x", 1],
    ["eyeLookUpLeft", "eyeLeft", "y", -1],
    ["eyeLookDownLeft", "eyeLeft", "y", 1],
    ["eyeLookInRight", "eyeRight", "x", 1],
    ["eyeLookOutRight", "eyeRight", "x", -1],
    ["eyeLookUpRight", "eyeRight", "y", -1],
    ["eyeLookDownRight", "eyeRight", "y", 1],
  ];
  for (const [channel, eye, axis, sign] of directions) {
    const expected = structuredClone(CENTERED_GAZE);
    expected[eye][axis] = sign * .7;
    assert.deepEqual(selectGaze({ [channel]: .7 }, GAZE), expected, channel);
  }
  assert.deepEqual(selectGaze({ eyeLookInLeft: 1, eyeLookOutRight: 1 }, GAZE), {
    eyeLeft: { x: -1, y: 0 }, eyeRight: { x: -1, y: 0 },
  });
  assert.deepEqual(selectGaze({ eyeLookOutLeft: 1, eyeLookInRight: 1 }, GAZE), {
    eyeLeft: { x: 1, y: 0 }, eyeRight: { x: 1, y: 0 },
  });
});

test("gaze needs a strict resource flag and unsupported channels never fabricate movement", () => {
  const keys = CHANNELS.filter(({ group }) => group === "gaze").map(({ key }) => key);
  assert.equal(keys.length, 8);
  const input = { eyeLookOutLeft: 1, eyeLookDownLeft: 1, eyeLookInRight: 1, eyeLookUpRight: 1 };
  for (const available of [undefined, null, {}, { gaze: false }, { gaze: 1 }, { gaze: "true" }, SHIFTS]) {
    assert.deepEqual(selectGaze(input, available), CENTERED_GAZE);
    for (const key of keys) assert.equal(channelSupport(available)[key], "unsupported");
  }
  for (const key of keys) assert.equal(channelSupport(GAZE)[key], "gaze");
});

test("opposing gaze inputs cancel after per-channel saturation without coupling the eyes", () => {
  const allDirections = Object.fromEntries(CHANNELS.filter(({ group }) => group === "gaze").map(({ key }) => [key, 1]));
  assert.deepEqual(selectGaze(allDirections, GAZE), CENTERED_GAZE);
  const mixed = selectGaze({
    eyeLookOutLeft: .9, eyeLookInLeft: .3,
    eyeLookDownLeft: .8, eyeLookUpLeft: .2,
    eyeLookInRight: .2, eyeLookOutRight: .7,
    eyeLookDownRight: .1, eyeLookUpRight: .9,
  }, GAZE);
  assert.ok(Math.abs(mixed.eyeLeft.x - .6) < 1e-12);
  assert.ok(Math.abs(mixed.eyeLeft.y - .6) < 1e-12);
  assert.ok(Math.abs(mixed.eyeRight.x + .5) < 1e-12);
  assert.ok(Math.abs(mixed.eyeRight.y + .8) < 1e-12);
  assert.deepEqual(selectGaze({ eyeLookOutLeft: 8, eyeLookInLeft: 4, eyeLookUpRight: -5, eyeLookDownRight: 7 }, GAZE), {
    eyeLeft: { x: 0, y: 0 }, eyeRight: { x: 0, y: 1 },
  });
});

test("gaze rejects nonfinite, inherited, coerced and malformed input", () => {
  for (const input of [undefined, null, [], "1", false, 1, { eyeLookOutLeft: NaN, eyeLookDownLeft: Infinity, eyeLookUpRight: -Infinity, eyeLookInRight: "1" }]) {
    assert.deepEqual(selectGaze(input, GAZE), CENTERED_GAZE);
  }
  const input = Object.assign(Object.create({ eyeLookOutLeft: 1 }), { eyeLookUpRight: .5, gaze: 1 });
  assert.deepEqual(selectGaze(input, GAZE), {
    eyeLeft: { x: 0, y: 0 }, eyeRight: { x: 0, y: -.5 },
  });
});

test("gaze and expression selection remain separate and do not mutate input or share output", () => {
  const input = Object.freeze({ eyeLookOutLeft: .7, eyeLookUpLeft: .4, eyeBlinkLeft: 1, browDownRight: 1, jawOpen: .4 });
  const available = Object.freeze({ ...SHIFTS, ...GAZE, extendedEyes: true, extendedJaw: true });
  const expression = selectExpression(input, {}, available);
  assert.deepEqual(expression, { ...NEUTRAL, eyeLeft: "closed", browRight: "down", mouth: "openSmall" });
  assert.deepEqual(expression, selectExpression({ eyeBlinkLeft: 1, browDownRight: 1, jawOpen: .4 }, {}, available));
  const gaze = selectGaze(input, available);
  assert.deepEqual(gaze, { eyeLeft: { x: .7, y: -.4 }, eyeRight: { x: 0, y: 0 } });
  gaze.eyeLeft.x = 0;
  gaze.eyeRight.y = 1;
  assert.deepEqual(selectGaze(input, available), { eyeLeft: { x: .7, y: -.4 }, eyeRight: { x: 0, y: 0 } });
  assert.deepEqual(selectGaze({ eyeBlinkLeft: 1, jawOpen: 1 }, available), CENTERED_GAZE);
});

test("eyes independently select open/half/closed in character anatomy", () => {
  for (const side of ["Left", "Right"]) {
    for (const [value, state] of [[0, "open"], [.5, "half"], [1, "closed"]]) {
      const chosen = selectExpression({ [`eyeBlink${side}`]: value });
      assert.equal(chosen[`eye${side}`], state);
      assert.equal(chosen[`eye${side === "Left" ? "Right" : "Left"}`], "open");
    }
  }
  assert.deepEqual(selectExpression({ eyeBlinkLeft: 1, eyeBlinkRight: .5 }), { ...NEUTRAL, eyeLeft: "closed", eyeRight: "half" });
  assert.deepEqual(selectExpression({}, { eyeLeft: "closed", eyeRight: "half" }), NEUTRAL);
});

test("eye hysteresis resists boundary noise but allows immediate full close and open", () => {
  assert.equal(selectExpression({ eyeBlinkLeft: .32 }, { eyeLeft: "open" }).eyeLeft, "open");
  assert.equal(selectExpression({ eyeBlinkLeft: .35 }, { eyeLeft: "open" }).eyeLeft, "half");
  assert.equal(selectExpression({ eyeBlinkLeft: .28 }, { eyeLeft: "half" }).eyeLeft, "half");
  assert.equal(selectExpression({ eyeBlinkLeft: .25 }, { eyeLeft: "half" }).eyeLeft, "open");
  assert.equal(selectExpression({ eyeBlinkLeft: .82 }, { eyeLeft: "half" }).eyeLeft, "half");
  assert.equal(selectExpression({ eyeBlinkLeft: .85 }, { eyeLeft: "half" }).eyeLeft, "closed");
  assert.equal(selectExpression({ eyeBlinkLeft: .78 }, { eyeLeft: "closed" }).eyeLeft, "closed");
  assert.equal(selectExpression({ eyeBlinkLeft: .75 }, { eyeLeft: "closed" }).eyeLeft, "half");
  assert.equal(selectExpression({ eyeBlinkLeft: 1 }, { eyeLeft: "open" }).eyeLeft, "closed");
  assert.equal(selectExpression({ eyeBlinkLeft: 0 }, { eyeLeft: "closed" }).eyeLeft, "open");
  assert.equal(selectExpression({ eyeBlinkLeft: .5 }, { eyeLeft: "missing-art" }).eyeLeft, "half");
});

test("jaw has only three painted choices and a neutral release, without fabricated in-between states", () => {
  for (const [value, state] of [[0, "neutral"], [.4, "openSmall"], [1, "openWide"]]) assert.equal(selectExpression({ jawOpen: value }).mouth, state);
  assert.equal(selectExpression({ jawOpen: .16 }, { mouth: "neutral" }).mouth, "neutral");
  assert.equal(selectExpression({ jawOpen: .19 }, { mouth: "neutral" }).mouth, "openSmall");
  assert.equal(selectExpression({ jawOpen: .13 }, { mouth: "openSmall" }).mouth, "openSmall");
  assert.equal(selectExpression({ jawOpen: .11 }, { mouth: "openSmall" }).mouth, "neutral");
  assert.equal(selectExpression({ jawOpen: .66 }, { mouth: "openSmall" }).mouth, "openSmall");
  assert.equal(selectExpression({ jawOpen: .69 }, { mouth: "openSmall" }).mouth, "openWide");
  assert.equal(selectExpression({ jawOpen: .63 }, { mouth: "openWide" }).mouth, "openWide");
  assert.equal(selectExpression({ jawOpen: .61 }, { mouth: "openWide" }).mouth, "openSmall");
  assert.equal(selectExpression({}, { mouth: "openWide" }).mouth, "neutral");
});

test("mouth precedence is press, closure, pucker, supported shift, then jaw", () => {
  for (const [name, shift] of [["mouthLeft", "shiftLeft"], ["mouthRight", "shiftRight"]]) {
    const input = { mouthPressLeft: 1, mouthClose: 1, mouthPucker: 1, [name]: 1, jawOpen: 1 };
    assert.equal(selectExpression(input, {}, SHIFTS).mouth, "press");
    delete input.mouthPressLeft; assert.equal(selectExpression(input, {}, SHIFTS).mouth, "neutral");
    delete input.mouthClose; assert.equal(selectExpression(input, {}, SHIFTS).mouth, "pucker");
    delete input.mouthPucker; assert.equal(selectExpression(input, {}, SHIFTS).mouth, shift);
    delete input[name]; assert.equal(selectExpression(input, {}, SHIFTS).mouth, "openWide");
  }
  assert.equal(selectExpression({ mouthPressRight: 1 }).mouth, "press");
  assert.equal(selectExpression({ jawOpen: 1, mouthClose: .6 }).mouth, "neutral");
  assert.equal(selectExpression({ jawOpen: 1, mouthClose: .59 }).mouth, "openWide");
});

test("pucker and whole-mouth press have hysteresis and release to remaining inputs", () => {
  for (const [key, state] of [["mouthPucker", "pucker"], ["mouthPressLeft", "press"], ["mouthPressRight", "press"]]) {
    assert.equal(selectExpression({ [key]: .5 }).mouth, "neutral");
    assert.equal(selectExpression({ [key]: .56 }).mouth, state);
    assert.equal(selectExpression({ [key]: .45 }, { mouth: state }).mouth, state);
    assert.equal(selectExpression({ [key]: .39, jawOpen: 1 }, { mouth: state }).mouth, "openWide");
  }
});

test("pure shifts require their own strict availability flag and never substitute pucker", () => {
  for (const [key, state, opposite] of [["mouthLeft", "shiftLeft", "shiftRight"], ["mouthRight", "shiftRight", "shiftLeft"]]) {
    for (const available of [undefined, null, {}, { [opposite]: true }, { [state]: 1 }, { [state]: "true" }]) {
      assert.equal(selectExpression({ [key]: 1 }, {}, available).mouth, "neutral");
      assert.equal(selectExpression({ [key]: 1, jawOpen: 1 }, {}, available).mouth, "openWide");
    }
    assert.equal(selectExpression({ [key]: 1 }, {}, { [state]: true }).mouth, state);
    assert.equal(selectExpression({ [key]: 1, mouthPucker: 1 }, {}, SHIFTS).mouth, "pucker");
    assert.equal(selectExpression({ [key]: 1, jawOpen: .4 }, { mouth: "pucker" }, {}).mouth, "openSmall");
  }
});

test("signed shifts cancel equal coefficients and retain direction through hysteresis", () => {
  assert.equal(selectExpression({ mouthLeft: .9, mouthRight: .4 }, {}, SHIFTS).mouth, "shiftLeft");
  assert.equal(selectExpression({ mouthLeft: .4, mouthRight: .9 }, {}, SHIFTS).mouth, "shiftRight");
  assert.equal(selectExpression({ mouthLeft: .3 }, {}, SHIFTS).mouth, "neutral");
  assert.equal(selectExpression({ mouthLeft: .3 }, { mouth: "shiftLeft" }, SHIFTS).mouth, "shiftLeft");
  assert.equal(selectExpression({ mouthLeft: .19 }, { mouth: "shiftLeft" }, SHIFTS).mouth, "neutral");
  assert.equal(selectExpression({ mouthRight: 1 }, { mouth: "shiftLeft" }, SHIFTS).mouth, "shiftRight");
  for (const previous of [{}, { mouth: "shiftLeft" }, { mouth: "shiftRight" }]) {
    assert.equal(selectExpression({ mouthLeft: 1, mouthRight: 1 }, previous, SHIFTS).mouth, "neutral");
    assert.equal(selectExpression({}, previous, SHIFTS).mouth, "neutral");
  }
});

test("brows keep anatomical independence and use only neutral/up/down paintings", () => {
  assert.deepEqual(selectExpression({ browInnerUp: 1 }), { ...NEUTRAL, browLeft: "up", browRight: "up" });
  assert.deepEqual(selectExpression({ browOuterUpLeft: 1 }), { ...NEUTRAL, browLeft: "up" });
  assert.deepEqual(selectExpression({ browOuterUpRight: 1 }), { ...NEUTRAL, browRight: "up" });
  assert.deepEqual(selectExpression({ browDownLeft: 1 }), { ...NEUTRAL, browLeft: "down" });
  assert.deepEqual(selectExpression({ browDownRight: 1 }), { ...NEUTRAL, browRight: "down" });
  assert.deepEqual(selectExpression({ browOuterUpLeft: 1, browDownRight: 1 }), { ...NEUTRAL, browLeft: "up", browRight: "down" });
  assert.deepEqual(selectExpression({}, { browLeft: "down", browRight: "up" }), NEUTRAL);
});

test("brow dominance and hysteresis keep small contrary noise from changing families", () => {
  assert.equal(selectExpression({ browInnerUp: .45 }).browLeft, "neutral");
  assert.equal(selectExpression({ browInnerUp: .45 }, { browLeft: "up" }).browLeft, "up");
  assert.equal(selectExpression({ browInnerUp: .34 }, { browLeft: "up" }).browLeft, "neutral");
  assert.equal(selectExpression({ browDownLeft: .7, browInnerUp: .7 }).browLeft, "down");
  assert.equal(selectExpression({ browDownLeft: .7, browInnerUp: .75 }, { browLeft: "down" }).browLeft, "down");
  assert.equal(selectExpression({ browDownLeft: .7, browInnerUp: .8 }, { browLeft: "down" }).browLeft, "up");
  assert.equal(selectExpression({ browDownLeft: .75, browInnerUp: .7 }, { browLeft: "up" }).browLeft, "up");
  assert.equal(selectExpression({ browDownLeft: .8, browInnerUp: .7 }, { browLeft: "up" }).browLeft, "down");
});

test("combined input keeps all five parts independent, without mutating caller data", () => {
  const input = Object.freeze({ eyeBlinkLeft: 1, eyeBlinkRight: .5, browOuterUpLeft: 1, browDownRight: 1, jawOpen: .4 });
  const previous = Object.freeze({ ...NEUTRAL });
  const chosen = selectExpression(input, previous, Object.freeze({ ...SHIFTS }));
  assert.deepEqual(chosen, { eyeLeft: "closed", eyeRight: "half", browLeft: "up", browRight: "down", mouth: "openSmall" });
  assert.deepEqual(previous, NEUTRAL);
  chosen.mouth = "changed";
  assert.equal(selectExpression(input, previous).mouth, "openSmall");
});

test("ten-second demo has gap-free intervals, each expression group and one sustained combination", () => {
  assert.equal(DEMO.duration, 10);
  assert.equal(DEMO.steps[0].start, 0);
  assert.equal(DEMO.steps.at(-1).end, 10);
  const states = new Set();
  let previous = {};
  for (let index = 0; index < DEMO.steps.length; index += 1) {
    const step = DEMO.steps[index];
    if (index) assert.equal(step.start, DEMO.steps[index - 1].end);
    assert.ok(step.end > step.start);
    assert.ok(step.end - step.start >= .5);
    const coefficients = sampleDemo((step.start + step.end) / 2);
    assert.deepEqual(coefficients, step.channels);
    previous = selectExpression(coefficients, previous, SHIFTS);
    states.add(previous.eyeLeft); states.add(previous.browLeft); states.add(previous.mouth);
    assert.ok(Object.isFrozen(step) && Object.isFrozen(step.channels));
  }
  for (const state of ["open", "half", "closed", "neutral", "up", "down", "openSmall", "openWide", "pucker", "press", "shiftLeft", "shiftRight"]) assert.ok(states.has(state), state);
  const combo = DEMO.steps.filter(({ id }) => id === "combination");
  assert.equal(combo.length, 1);
  assert.ok(combo[0].end - combo[0].start >= 1);
  assert.deepEqual(selectExpression(sampleDemo(combo[0].start)), { ...NEUTRAL, eyeLeft: "closed", browRight: "up", mouth: "openSmall" });
  assert.ok(Object.isFrozen(DEMO) && Object.isFrozen(DEMO.steps));
});

test("demo is deterministic, wraps at ten seconds, and missing shift art stays unsupported", () => {
  for (const invalid of [NaN, Infinity, -Infinity, null, undefined, "4", -1]) assert.deepEqual(sampleDemo(invalid), sanitizeChannels({}));
  assert.deepEqual(sampleDemo(0), sampleDemo(10));
  assert.deepEqual(sampleDemo(2.5), sampleDemo(12.5));
  assert.equal(selectExpression(sampleDemo(6.5)).mouth, "neutral");
  assert.equal(selectExpression(sampleDemo(7.5)).mouth, "neutral");
  assert.equal(selectExpression(sampleDemo(6.5), {}, SHIFTS).mouth, "shiftLeft");
  assert.equal(selectExpression(sampleDemo(7.5), {}, SHIFTS).mouth, "shiftRight");
  const mutable = sampleDemo(3.5); mutable.mouthPucker = 0;
  assert.equal(sampleDemo(3.5).mouthPucker, .9);
});

test("extended eye paintings require explicit availability and preserve the old three-stage mapping by default", () => {
  const targets = [[0, "open"], [.25, "quarter"], [.5, "half"], [.75, "threeQuarter"], [1, "closed"]];
  for (const side of ["Left", "Right"]) {
    for (const [value, state] of targets) {
      for (const oldState of ["open", "quarter", "half", "threeQuarter", "closed", "unknown"]) {
        const result = selectExpression({ [`eyeBlink${side}`]: value }, { [`eye${side}`]: oldState }, { extendedEyes: true });
        assert.equal(result[`eye${side}`], state);
        assert.equal(result[`eye${side === "Left" ? "Right" : "Left"}`], "open");
      }
    }
  }
  for (const available of [undefined, null, {}, { extendedEyes: false }, { extendedEyes: 1 }, { extendedEyes: "true" }]) {
    assert.equal(selectExpression({ eyeBlinkLeft: .25 }, {}, available).eyeLeft, "open");
    assert.equal(selectExpression({ eyeBlinkLeft: .75 }, {}, available).eyeLeft, "half");
  }
});

test("extended jaw anchors map to actual five paintings independently from extended eyes", () => {
  const states = ["neutral", "parted", "openSmall", "openMedium", "openWide"];
  for (const [value, state] of [[0, "neutral"], [.18, "parted"], [.4, "openSmall"], [.68, "openMedium"], [.95, "openWide"]]) {
    for (const previous of states) assert.equal(selectExpression({ jawOpen: value }, { mouth: previous }, { extendedJaw: true }).mouth, state);
  }
  assert.equal(selectExpression({ jawOpen: .18, eyeBlinkLeft: .25 }, {}, { extendedJaw: true }).eyeLeft, "open");
  assert.equal(selectExpression({ jawOpen: .18, eyeBlinkLeft: .25 }, {}, { extendedEyes: true }).mouth, "openSmall");
  for (const available of [undefined, null, {}, { extendedJaw: false }, { extendedJaw: 1 }, { extendedJaw: "true" }]) {
    assert.equal(selectExpression({ jawOpen: .18 }, {}, available).mouth, "openSmall");
    assert.equal(selectExpression({ jawOpen: .68 }, {}, available).mouth, "openWide");
  }
});

test("extended eye and jaw threshold noise cannot chatter between adjacent source paintings", () => {
  assert.equal(selectExpression({ eyeBlinkLeft: .14 }, { eyeLeft: "open" }, { extendedEyes: true }).eyeLeft, "open");
  assert.equal(selectExpression({ eyeBlinkLeft: .16 }, { eyeLeft: "open" }, { extendedEyes: true }).eyeLeft, "quarter");
  assert.equal(selectExpression({ eyeBlinkLeft: .11 }, { eyeLeft: "quarter" }, { extendedEyes: true }).eyeLeft, "quarter");
  assert.equal(selectExpression({ eyeBlinkLeft: .09 }, { eyeLeft: "quarter" }, { extendedEyes: true }).eyeLeft, "open");
  assert.equal(selectExpression({ jawOpen: .10 }, { mouth: "neutral" }, { extendedJaw: true }).mouth, "neutral");
  assert.equal(selectExpression({ jawOpen: .12 }, { mouth: "neutral" }, { extendedJaw: true }).mouth, "parted");
  assert.equal(selectExpression({ jawOpen: .07 }, { mouth: "parted" }, { extendedJaw: true }).mouth, "parted");
  assert.equal(selectExpression({ jawOpen: .06 }, { mouth: "parted" }, { extendedJaw: true }).mouth, "neutral");
});

test("extended drawings do not change mouth family priority or the old ten-second observation timeline", () => {
  const available = { ...SHIFTS, extendedEyes: true, extendedJaw: true };
  assert.equal(selectExpression({ jawOpen: .68, mouthPucker: 1 }, {}, available).mouth, "pucker");
  assert.equal(selectExpression({ jawOpen: .68, mouthClose: 1 }, {}, available).mouth, "neutral");
  assert.equal(selectExpression({ jawOpen: .68, mouthPucker: 1, mouthPressRight: 1 }, {}, available).mouth, "press");
  assert.equal(selectExpression({ jawOpen: .68, mouthLeft: 1 }, {}, available).mouth, "shiftLeft");
  assert.equal(DEMO.duration, 10);
  assert.equal(selectExpression(sampleDemo(2), {}, available).mouth, "openSmall");
  assert.equal(selectExpression(sampleDemo(2.75), {}, available).mouth, "openWide");
});
