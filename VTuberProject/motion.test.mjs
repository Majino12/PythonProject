import test from "node:test";
import assert from "node:assert/strict";
import { extractFaceMotion, extractPoseMotion, normalizeExpressions } from "./motion.js";

function faceResult(noseX, categories = []) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: .5, y: .5, z: 0 }));
  landmarks[33] = { x: .4, y: .43, z: 0 };
  landmarks[263] = { x: .6, y: .43, z: 0 };
  landmarks[1] = { x: noseX, y: .52, z: -.05 };
  landmarks[234] = { x: .3, y: .51, z: 0 };
  landmarks[454] = { x: .7, y: .51, z: 0 };
  return {
    faceLandmarks: [landmarks],
    faceBlendshapes: [{ categories: categories.map(([categoryName, score]) => ({ categoryName, score })) }],
  };
}

function poseResult({ raised = false, lowVisibility = false } = {}) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: .5, y: .7, z: 0, visibility: 1, presence: 1 }));
  landmarks[11] = { x: .6, y: .3, z: 0, visibility: lowVisibility ? .1 : 1, presence: 1 };
  landmarks[12] = { x: .4, y: .3, z: 0, visibility: 1, presence: 1 };
  landmarks[13] = { x: .68, y: raised ? .24 : .5, z: -.05, visibility: 1, presence: 1 };
  landmarks[14] = { x: .32, y: raised ? .24 : .5, z: -.05, visibility: 1, presence: 1 };
  landmarks[15] = { x: .58, y: raised ? .12 : .7, z: -.16, visibility: 1, presence: 1 };
  landmarks[16] = { x: .42, y: raised ? .12 : .7, z: -.16, visibility: 1, presence: 1 };
  landmarks[23] = { x: .56, y: .58, z: .01, visibility: 1, presence: 1 };
  landmarks[24] = { x: .44, y: .58, z: -.01, visibility: 1, presence: 1 };
  landmarks[25] = { x: .56, y: .82, z: 0, visibility: 1, presence: 1 };
  landmarks[26] = { x: .44, y: .82, z: 0, visibility: 1, presence: 1 };
  return { landmarks: [landmarks], worldLandmarks: [landmarks.map((point) => ({ ...point }))] };
}

function poseWithLeftArmAngle(angle) {
  const result = poseResult();
  const shoulder = result.landmarks[0][11];
  const elbow = {
    ...result.landmarks[0][13],
    x: shoulder.x + Math.sin(angle) * .2,
    y: shoulder.y + Math.cos(angle) * .2,
  };
  const wrist = {
    ...result.landmarks[0][15],
    x: elbow.x + Math.sin(angle) * .18,
    y: elbow.y + Math.cos(angle) * .18,
  };
  result.landmarks[0][13] = elbow;
  result.landmarks[0][15] = wrist;
  result.worldLandmarks = [result.landmarks[0].map((point) => ({ ...point }))];
  return result;
}

test("face mapping returns null when no face is present", () => {
  assert.equal(extractFaceMotion({}), null);
  assert.equal(extractFaceMotion(undefined), null);
});

test("fallback landmark yaw stays monotonic from front to side", () => {
  const values = [.5, .55, .6, .65].map((noseX) => extractFaceMotion(faceResult(noseX)).pose.x);
  assert.ok(values.every(Number.isFinite));
  for (let index = 1; index < values.length; index += 1) assert.ok(values[index] > values[index - 1]);
  assert.ok(values.at(-1) <= 1);
});

test("facial transformation matrix expands the usable side-view range", () => {
  const angle = .9;
  const result = faceResult(.61);
  result.facialTransformationMatrixes = [{ data: [
    Math.cos(angle), 0, -Math.sin(angle), 0,
    0, 1, 0, 0,
    Math.sin(angle), 0, Math.cos(angle), 0,
    0, 0, 0, 1,
  ] }];
  const mapped = extractFaceMotion(result);
  assert.ok(mapped.pose.x > .7);
  assert.ok(mapped.pose.x <= 1);
  assert.ok(Object.values(mapped.pose).every(Number.isFinite));
});

test("invalid face matrix safely falls back to finite landmarks", () => {
  const result = faceResult(.59);
  result.facialTransformationMatrixes = [{ data: Array.from({ length: 16 }, (_, index) => index === 8 ? Infinity : index % 5 === 0 ? 1 : 0) }];
  const mapped = extractFaceMotion(result);
  assert.ok(Object.values(mapped.pose).every(Number.isFinite));
  assert.ok(mapped.pose.x > 0);
});

test("rich blendshapes map without missing-value NaN", () => {
  const result = extractFaceMotion(faceResult(.5, [
    ["eyeBlinkLeft", .8], ["eyeBlinkRight", .1], ["eyeWideRight", .4], ["browInnerUp", .6],
    ["jawOpen", .5], ["mouthSmileLeft", .7], ["mouthSmileRight", .5],
    ["mouthPucker", .55], ["cheekPuff", .35],
  ]));
  assert.ok(result.expressions.blinkL > .5);
  assert.ok(result.expressions.blinkL > result.expressions.blinkR);
  assert.ok(result.expressions.browUp > .5);
  assert.ok(result.expressions.smile > .5);
  assert.ok(result.expressions.pucker > .5);
  assert.ok(Object.values(result.expressions).every(Number.isFinite));
});

test("invalid blendshape values are ignored instead of saturating", () => {
  const result = extractFaceMotion(faceResult(.5, [["eyeBlinkLeft", Infinity], ["jawOpen", NaN]]));
  assert.equal(result.expressions.blinkL, 0);
  assert.equal(result.expressions.mouth, 0);
});

test("expression neutral calibration removes resting bias", () => {
  const normalized = normalizeExpressions({ blinkL: .12, smile: .2, lookX: -.1 }, { blinkL: .1, smile: .18, lookX: -.08 });
  assert.ok(normalized.blinkL < .05);
  assert.ok(normalized.smile < .05);
  assert.ok(normalized.lookX < 0 && normalized.lookX > -.05);
});

test("pose mapping produces finite arm, elbow, depth and torso channels", () => {
  const result = extractPoseMotion(poseResult({ raised: true }), { shoulderY: .3, lean: 0, bodyTurn: 0, hipSway: 0, armL: 0, armR: 0 });
  assert.ok(result.motion.armL > 0);
  assert.ok(result.motion.armR > 0);
  assert.ok(result.motion.elbowL >= 0);
  assert.ok(result.motion.armDepthL > 0);
  assert.ok(Object.values(result.motion).every(Number.isFinite));
});

test("arm elevation remains progressive from rest through overhead", () => {
  const down = poseResult();
  const horizontal = poseResult();
  horizontal.landmarks[0][13] = { ...horizontal.landmarks[0][13], x: .82, y: .3 };
  horizontal.landmarks[0][15] = { ...horizontal.landmarks[0][15], x: .98, y: .3 };
  horizontal.worldLandmarks = [horizontal.landmarks[0].map((point) => ({ ...point }))];
  const overhead = poseResult();
  overhead.landmarks[0][13] = { ...overhead.landmarks[0][13], x: .7, y: .14 };
  overhead.landmarks[0][15] = { ...overhead.landmarks[0][15], x: .58, y: .02 };
  overhead.worldLandmarks = [overhead.landmarks[0].map((point) => ({ ...point }))];
  const history = {};
  const rest = extractPoseMotion(down, {}, history);
  const neutral = { ...rest.raw };
  const side = extractPoseMotion(horizontal, neutral, history).motion.armL;
  const up = extractPoseMotion(overhead, neutral, history).motion.armL;
  assert.ok(side > .25 && side < .75);
  assert.ok(up > side + .2);
  assert.ok(up <= 1.08);
});

test("arm motion comes back down after crossing over the head", () => {
  const neutral = { armL: 0 };
  const samples = [2.5, Math.PI, -2.5, -Math.PI / 2, -.1]
    .map((angle) => extractPoseMotion(poseWithLeftArmAngle(angle), neutral, {}).motion);
  assert.ok(samples[1].armL > .99);
  assert.ok(samples[2].armL < samples[1].armL);
  assert.ok(samples[3].armL < samples[2].armL);
  assert.ok(samples[4].armL < .05);
  assert.ok(samples.every((motion) => Number.isFinite(motion.armSinL) && Number.isFinite(motion.armCosL)));
});

test("elbow direction distinguishes inward and outward bends", () => {
  const inward = poseResult();
  inward.landmarks[0][15] = { ...inward.landmarks[0][15], x: .54, y: .61 };
  inward.worldLandmarks = [inward.landmarks[0].map((point) => ({ ...point }))];
  const outward = poseResult();
  outward.landmarks[0][15] = { ...outward.landmarks[0][15], x: .86, y: .61 };
  outward.worldLandmarks = [outward.landmarks[0].map((point) => ({ ...point }))];
  assert.equal(extractPoseMotion(inward, {}, {}).motion.elbowSideL, 1);
  assert.equal(extractPoseMotion(outward, {}, {}).motion.elbowSideL, -1);
});

test("low-confidence shoulders do not emit unstable body motion", () => {
  assert.equal(extractPoseMotion(poseResult({ lowVisibility: true })), null);
});
