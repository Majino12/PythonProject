import test from "node:test";
import assert from "node:assert/strict";
import { createDemoMotion } from "./demo-motion.js";

const CHANNELS = [
  "x", "y", "roll", "blinkL", "blinkR", "eyeWideL", "eyeWideR", "lookX", "lookY",
  "mouth", "mouthX", "smile", "frown", "pucker", "browUp", "browDownL", "browDownR", "cheek",
  "bodyLean", "bodyBob", "bodyTurn", "hipSway", "armL", "armR", "elbowL", "elbowR",
  "elbowSideL", "elbowSideR", "armSinL", "armSinR", "armCosL", "armCosR",
  "armDepthL", "armDepthR", "legL", "legR",
].sort();
const MODES = ["idle", "greeting", "speaking"];

test("demo motion returns every finite normalized channel for every mode", () => {
  for (const mode of MODES) {
    for (let now = -1000; now <= 120000; now += 73) {
      const motion = createDemoMotion(now, mode);
      assert.deepEqual(Object.keys(motion).sort(), CHANNELS);
      for (const [key, value] of Object.entries(motion)) {
        assert.ok(Number.isFinite(value), `${mode} ${key} is finite`);
        assert.ok(value >= -1 && value <= 1, `${mode} ${key} is normalized`);
      }
    }
  }
});

test("idle stays closed-mouth, gently breathing and at rest", () => {
  let breathMin = 1;
  let breathMax = -1;
  for (let now = 0; now <= 60000; now += 17) {
    const motion = createDemoMotion(now);
    assert.equal(motion.mouth, 0);
    assert.equal(motion.pucker, 0);
    assert.ok(Math.abs(motion.x) < .17);
    assert.ok(Math.abs(motion.roll) < .03);
    assert.ok(motion.armL < .04 && motion.armR < .04);
    assert.ok(motion.elbowL < .1 && motion.elbowR < .1);
    breathMin = Math.min(breathMin, motion.bodyBob);
    breathMax = Math.max(breathMax, motion.bodyBob);
  }
  assert.ok(breathMin < -.017 && breathMax > .017);
});

test("greeting raises one arm moderately and returns it to rest", () => {
  let peak = 0;
  let minimum = 1;
  for (let now = 0; now <= 27000; now += 13) {
    const motion = createDemoMotion(now, "greeting");
    const angle = motion.armL * Math.PI;
    peak = Math.max(peak, angle);
    minimum = Math.min(minimum, angle);
    assert.ok(angle < 1, "arm stays below about 57 degrees");
    assert.ok(motion.armR * Math.PI < .12, "other arm stays at rest");
    assert.ok(motion.elbowL < .66, "elbow avoids an extreme fold");
    assert.equal(motion.mouth, 0);
  }
  assert.ok(peak > .8 && minimum < .12);
});

test("arm direction is coherent with arm amount and elbows never flip", () => {
  for (const mode of MODES) {
    for (let now = 0; now <= 40000; now += 37) {
      const motion = createDemoMotion(now, mode);
      for (const side of ["L", "R"]) {
        const sin = motion[`armSin${side}`];
        const cos = motion[`armCos${side}`];
        assert.ok(Math.abs(sin ** 2 + cos ** 2 - 1) < 1e-12);
        assert.ok(Math.abs(Math.atan2(sin, cos) / Math.PI - motion[`arm${side}`]) < 1e-12);
        assert.equal(motion[`elbowSide${side}`], mode === "greeting" && side === "L" ? -1 : 1);
      }
    }
  }
});

test("greeting forearm points upward at the first wave peak", () => {
  const motion = createDemoMotion(2600, "greeting");
  // Match Avatar3D's composed shoulder/elbow z rotations, at both its default
  // body strength and full strength. The forearm's rest vector points down.
  for (const strength of [.75 / .85, 1]) {
    const upperAngle = Math.atan2(motion.armSinL, motion.armCosL) * strength;
    const bend = motion.elbowL * strength;
    const shoulderZ = .07 + upperAngle;
    const elbowZ = -(.07 + bend * motion.elbowSideL * 1.72);
    const forearmY = -Math.cos(shoulderZ + elbowZ);
    assert.ok(forearmY > 0, "hand must rise above its elbow instead of folding downward");
  }
});

test("blinks have a small duty cycle, a short duration and slight eyelid offset", () => {
  let active = 0;
  let peaks = 0;
  let inBlink = false;
  for (let now = 0; now < 16000; now += 1) {
    const { blinkL } = createDemoMotion(now);
    if (blinkL > .05) active += 1;
    if (blinkL > .5 && !inBlink) peaks += 1;
    inBlink = blinkL > .5;
  }
  assert.equal(peaks, 4);
  assert.ok(active / 16000 < .04);
  assert.ok(active / peaks > 130 && active / peaks < 170);
  assert.equal(createDemoMotion(1300).blinkL, 1);
  assert.ok(createDemoMotion(1300).blinkR < 1);
  assert.equal(createDemoMotion(1311).blinkR, 1);
});

test("speaking uses bounded mouth pulses with closed-mouth pauses", () => {
  let active = 0;
  let closed = 0;
  let peak = 0;
  for (let now = 0; now < 66000; now += 11) {
    const motion = createDemoMotion(now, "speaking");
    if (motion.mouth > .12) active += 1;
    if (motion.mouth === 0) closed += 1;
    peak = Math.max(peak, motion.mouth);
    assert.ok(motion.smile >= .15 && motion.smile <= .4);
    assert.ok(motion.mouth <= .57);
  }
  assert.ok(active > 400 && closed > 2000);
  assert.ok(peak > .4);
});

test("all trajectories are continuous at adjacent frames and loop boundaries", () => {
  for (const mode of MODES) {
    for (let now = 0; now < 32000; now += 16) {
      const previous = createDemoMotion(now, mode);
      const next = createDemoMotion(now + 16, mode);
      for (const key of CHANNELS) {
        const limit = key.startsWith("blink") ? .34 : .16;
        assert.ok(Math.abs(next[key] - previous[key]) < limit, `${mode} ${key} frame ${now}`);
      }
    }
    for (const boundary of [0, 6600, 9000, 13200, 16000, 18000, 27000, 32000]) {
      const before = createDemoMotion(boundary - .001, mode);
      const after = createDemoMotion(boundary + .001, mode);
      for (const key of CHANNELS) {
        assert.ok(Math.abs(after[key] - before[key]) < .0001, `${mode} ${key} seam ${boundary}`);
      }
    }
  }
});

test("invalid input is safe, unknown mode falls back to idle, and calls are deterministic", () => {
  const first = createDemoMotion(1234, "greeting");
  createDemoMotion(5678, "speaking");
  assert.deepEqual(createDemoMotion(1234, "greeting"), first);
  assert.deepEqual(createDemoMotion(1234, "unknown"), createDemoMotion(1234, "idle"));
  for (const input of [undefined, null, NaN, Infinity, -Infinity, "1000", {}, 10n]) {
    assert.deepEqual(createDemoMotion(input), createDemoMotion(0));
  }
});
