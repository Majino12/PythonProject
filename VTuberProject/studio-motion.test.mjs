import test from "node:test";
import assert from "node:assert/strict";
import { solveStudioMotion } from "./studio-motion.js";

function inspectFinite(value, path = "result") {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} is finite`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) inspectFinite(child, `${path}.${key}`);
}

test("neutral studio pose lowers T-pose arms and keeps feet pinned", () => {
  const result = solveStudioMotion({ armCosL: 1, armCosR: 1 }, { body: .75 });
  assert.equal(result.bones.leftUpperArm[2], -1.38);
  assert.equal(result.bones.rightUpperArm[2], 1.38);
  assert.equal("position" in result, false);
  assert.deepEqual(result.bones.hips, [0, 0, 0]);
  assert.equal(result.expressions.aa, 0);
  assert.equal(result.expressions.blinkLeft, 0);
  assert.ok(result.expressions.happy > 0 && result.expressions.happy < .1);
});

test("head, torso and gaze respect motion direction", () => {
  const result = solveStudioMotion({
    x: .8, y: -.6, roll: .5, bodyTurn: .7, bodyLean: -.4, lookX: -.9, lookY: .35,
    armCosL: 1, armCosR: 1,
  }, { head: 1, body: 1 });
  assert.ok(result.bones.head[0] > 0);
  assert.ok(result.bones.head[1] > 0);
  assert.ok(result.bones.head[2] < 0);
  assert.ok(result.bones.chest[1] > 0);
  assert.ok(result.bones.chest[2] > 0);
  assert.deepEqual(result.look, { x: -.9, y: .35 });
});

test("arm raise and elbow bend retain anatomical mirror symmetry", () => {
  const result = solveStudioMotion({
    armSinL: 1, armCosL: 0, elbowL: .8, elbowSideL: 1,
    armSinR: 1, armCosR: 0, elbowR: .8, elbowSideR: 1,
  }, { body: .85 });
  assert.ok(result.bones.leftUpperArm[2] > -1.38);
  assert.ok(result.bones.rightUpperArm[2] < 1.38);
  assert.equal(result.bones.leftLowerArm[2], -result.bones.rightLowerArm[2]);
  assert.ok(Math.abs(result.bones.leftLowerArm[2]) > .8);
});

test("emotion override budget leaves room for blink and vowel morphs", () => {
  const result = solveStudioMotion({
    blinkL: 1, blinkR: .8, mouth: 1, smile: 1, frown: 1, pucker: .65,
    eyeWideL: 1, browUp: 1, browDownL: 1, armCosL: 1, armCosR: 1,
  }, { blink: 1, mouth: 1, expression: 1 });
  const mood = result.expressions.happy + result.expressions.sad
    + result.expressions.surprised + result.expressions.angry;
  assert.ok(mood <= .720001);
  assert.equal(result.expressions.blinkLeft, 1);
  assert.ok(result.expressions.aa > 0);
  assert.ok(result.expressions.ou > 0);
});

test("invalid and extreme input cannot produce non-finite transforms", () => {
  const result = solveStudioMotion({
    x: Infinity, y: NaN, roll: "bad", armSinL: Infinity, armCosL: NaN,
    elbowL: 999, elbowSideL: -999, bodyLean: 999, mouth: Infinity,
  }, { head: Infinity, body: -8, expression: NaN });
  inspectFinite(result);
  assert.ok(Math.abs(result.bones.head[1]) <= .93);
  assert.equal(result.bones.leftUpperArm[2], -1.38);
});

