import test from "node:test";
import assert from "node:assert/strict";
import {
  ARKIT_CHANNELS,
  CHANNEL_DEFINITIONS,
  DEFAULT_CHANNEL_SETTINGS,
  BlendshapeFilter,
  legacyMotionToBlendshapes,
  mapBlendshapeValue,
  normalizeBlendshapeFrame,
  normalizeBlendshapeSettings,
  readMediaPipeBlendshapes,
} from "./arkit-blendshapes.js";

const EXPECTED_CHANNELS = [
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
  "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
  "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight",
  "jawForward", "jawLeft", "jawOpen", "jawRight",
  "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight",
  "mouthFunnel", "mouthLeft", "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight", "mouthRollLower", "mouthRollUpper",
  "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft", "mouthSmileRight",
  "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight",
  "noseSneerLeft", "noseSneerRight", "tongueOut",
];

function assertFrame(frame) {
  assert.deepEqual(Object.keys(frame), ARKIT_CHANNELS);
  for (const value of Object.values(frame)) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
}

test("exports the 52 canonical Apple ARKit channels with complete Chinese metadata", () => {
  assert.deepEqual(ARKIT_CHANNELS, EXPECTED_CHANNELS);
  assert.equal(new Set(ARKIT_CHANNELS).size, 52);
  assert.equal(Object.isFrozen(ARKIT_CHANNELS), true);
  assert.deepEqual(CHANNEL_DEFINITIONS.map(({ key }) => key), ARKIT_CHANNELS);
  for (const definition of CHANNEL_DEFINITIONS) {
    assert.equal(typeof definition.label, "string");
    assert.equal(typeof definition.group, "string");
    assert.equal(Object.isFrozen(definition), true);
  }
  assert.equal(CHANNEL_DEFINITIONS.filter(({ mediapipe }) => mediapipe).length, 51);
  assert.equal(CHANNEL_DEFINITIONS.find(({ key }) => key === "tongueOut").mediapipe, false);
});

test("frame normalization returns all channels while rejecting unknown, inherited and non-finite data", () => {
  const raw = Object.assign(Object.create({ eyeBlinkRight: .8, jawOpen: .9 }), {
    eyeBlinkLeft: 1.7,
    jawOpen: "0.42",
    mouthSmileLeft: -2,
    mouthSmileRight: Infinity,
    unknown: .9,
  });
  const frame = normalizeBlendshapeFrame(raw);
  assertFrame(frame);
  assert.equal(frame.eyeBlinkLeft, 1);
  assert.equal(frame.eyeBlinkRight, 0);
  assert.equal(frame.jawOpen, .42);
  assert.equal(frame.mouthSmileLeft, 0);
  assert.equal(frame.mouthSmileRight, 0);
  assert.equal(Object.hasOwn(frame, "unknown"), false);
  assertFrame(normalizeBlendshapeFrame(null));
});

test("MediaPipe 51 plus neutral becomes canonical ARKit 52 without inventing tongue data", () => {
  const frame = readMediaPipeBlendshapes({ faceBlendshapes: [{ categories: [
    { categoryName: "_neutral", score: .99 },
    { categoryName: "eyeBlinkLeft", score: .3 },
    { categoryName: "eyeBlinkLeft", score: .72 },
    { categoryName: "mouthSmileRight", score: 3 },
    { categoryName: "tongueOut", score: .88 },
    { categoryName: "constructor", score: 1 },
    { categoryName: "jawOpen", score: NaN },
  ] }] });
  assertFrame(frame);
  assert.equal(frame.eyeBlinkLeft, .72);
  assert.equal(frame.mouthSmileRight, 1);
  assert.equal(frame.jawOpen, 0);
  assert.equal(frame.tongueOut, 0);
  assert.equal(Object.hasOwn(frame, "_neutral"), false);
});

test("legacy compact motion maps independent eyes, brows, gaze and mouth into ARKit channels", () => {
  const frame = legacyMotionToBlendshapes({
    blinkL: .2, blinkR: .8, eyeWideL: .6, eyeWideR: .1,
    lookX: -.7, lookY: .35,
    browUp: .5, browDownL: .3, browDownR: .1,
    mouth: .65, mouthX: .4, smile: .7, frown: .2, pucker: .5, cheek: .25,
  });
  assertFrame(frame);
  assert.equal(frame.eyeBlinkLeft, .2);
  assert.equal(frame.eyeBlinkRight, .8);
  assert.equal(frame.eyeLookInLeft, .7);
  assert.equal(frame.eyeLookOutRight, .7);
  assert.equal(frame.eyeLookOutLeft, 0);
  assert.equal(frame.eyeLookUpLeft, .35);
  assert.equal(frame.browInnerUp, .5);
  assert.equal(frame.browDownLeft, .3);
  assert.equal(frame.jawOpen, .65);
  assert.equal(frame.mouthRight, .4);
  assert.equal(frame.mouthLeft, 0);
  assert.equal(frame.mouthSmileLeft, .7);
  assert.equal(frame.mouthFrownRight, .2);
  assert.equal(frame.mouthPucker, .5);
  assert.equal(frame.tongueOut, 0);
});

test("settings retain only own canonical channels and produce complete bounded configurations", () => {
  const channels = Object.assign(Object.create({ jawOpen: { smoothing: 0 } }), {
    eyeBlinkLeft: Object.assign(Object.create({ outputMax: 0 }), {
      inputMin: .8, inputMax: .2, outputMin: 1, outputMax: 0,
      smoothing: 999, curve: "easeOut", secret: "discard",
    }),
    mouthSmileLeft: { inputMin: .5, inputMax: .5, smoothing: -2, curve: "bad" },
    unknown: { smoothing: 0 },
    tongueOut: null,
  });
  const normalized = normalizeBlendshapeSettings({ channels, rawFrame: { secret: true } });
  assert.deepEqual(Object.keys(normalized.channels), ["eyeBlinkLeft", "mouthSmileLeft"]);
  assert.deepEqual(normalized.channels.eyeBlinkLeft, {
    inputMin: .2, inputMax: .8, outputMin: 1, outputMax: 0, smoothing: 400, curve: "easeOut",
  });
  assert.deepEqual(normalized.channels.mouthSmileLeft, {
    ...DEFAULT_CHANNEL_SETTINGS, smoothing: 0,
  });
  assert.equal(Object.hasOwn(normalized.channels.eyeBlinkLeft, "secret"), false);
  assert.deepEqual(normalizeBlendshapeSettings(Object.create({ channels })), { channels: {} });
  assert.equal(Object.isFrozen(DEFAULT_CHANNEL_SETTINGS), true);
});

test("all 52 explicit settings normalize without exceeding the canonical channel set", () => {
  const channels = Object.fromEntries(ARKIT_CHANNELS.map((key, index) => [key, {
    smoothing: index * 20,
    curve: index % 2 ? "smooth" : "linear",
  }]));
  channels.extra = { smoothing: 1 };
  const normalized = normalizeBlendshapeSettings({ channels });
  assert.deepEqual(Object.keys(normalized.channels), ARKIT_CHANNELS);
  assert.equal(Object.keys(normalized.channels).length, 52);
  for (const config of Object.values(normalized.channels)) {
    assert.ok(config.inputMin < config.inputMax);
    assert.ok(config.smoothing >= 0 && config.smoothing <= 400);
  }
});

test("value mapping supports all curves, clipping and reversed output", () => {
  const base = { ...DEFAULT_CHANNEL_SETTINGS, smoothing: 0, inputMin: .2, inputMax: .8 };
  assert.equal(mapBlendshapeValue(-2, base), 0);
  assert.equal(mapBlendshapeValue(2, base), 1);
  assert.ok(Math.abs(mapBlendshapeValue(.35, base) - .25) < 1e-12);
  assert.ok(Math.abs(mapBlendshapeValue(.35, { ...base, curve: "smooth" }) - .15625) < 1e-12);
  assert.ok(Math.abs(mapBlendshapeValue(.35, { ...base, curve: "easeIn" }) - .0625) < 1e-12);
  assert.ok(Math.abs(mapBlendshapeValue(.35, { ...base, curve: "easeOut" }) - .4375) < 1e-12);
  assert.ok(Math.abs(mapBlendshapeValue(.35, { ...base, outputMin: 1, outputMax: 0 }) - .75) < 1e-12);
  assert.equal(mapBlendshapeValue(NaN, base), 0);
});

test("filter smoothing is frame-rate independent and zero smoothing is immediate", () => {
  const settings = { channels: {
    jawOpen: { smoothing: 120 },
    eyeBlinkLeft: { smoothing: 0 },
  } };
  const run = (steps, dt) => {
    const filter = new BlendshapeFilter();
    filter.update({}, settings, dt);
    let output;
    for (let index = 0; index < steps; index += 1) {
      output = filter.update({ jawOpen: 1, eyeBlinkLeft: 1 }, settings, dt);
    }
    return output;
  };
  const at60 = run(60, 1 / 60);
  const at30 = run(30, 1 / 30);
  assertFrame(at60);
  assert.ok(Math.abs(at60.jawOpen - at30.jawOpen) < 1e-12);
  assert.equal(at60.eyeBlinkLeft, 1);
  assert.ok(at60.jawOpen > .99 && at60.jawOpen < 1);
});

test("filter reset and hostile timing or frame values never leak non-finite output", () => {
  const filter = new BlendshapeFilter();
  const initial = filter.update({ jawOpen: .8 }, {}, 1 / 60);
  assert.equal(initial.jawOpen, .8);
  const held = filter.update({ jawOpen: Infinity, eyeBlinkLeft: NaN }, {
    channels: { jawOpen: { smoothing: 60 }, eyeBlinkLeft: { smoothing: 0 } },
  }, Infinity);
  assertFrame(held);
  assert.equal(held.jawOpen, .8);
  assert.equal(held.eyeBlinkLeft, 0);
  filter.reset();
  const reset = filter.update({ jawOpen: .2 }, {}, -10);
  assertFrame(reset);
  assert.equal(reset.jawOpen, .2);
});
