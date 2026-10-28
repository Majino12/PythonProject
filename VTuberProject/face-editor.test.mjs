import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const galleryHtml = readFileSync(new URL("./painted-gallery.html", import.meta.url), "utf8");
const gallerySource = readFileSync(new URL("./painted-gallery.js", import.meta.url), "utf8");

function galleryChannels(browMode, brow = .6) {
  const sliders = Object.fromEntries(Object.entries({
    blink: .4, jaw: .3, pucker: .2, press: .1, gaze: .5, brow, browMode,
  }).map(([key, value]) => [key, { value: String(value) }]));
  const direction = { value: "left" };
  const start = gallerySource.indexOf("function channelsFromControls()");
  const end = gallerySource.indexOf("\nfunction redraw()", start);
  assert.ok(start >= 0 && end > start, "gallery must retain a testable control-to-ARKit mapping");
  const channelsFromControls = runInNewContext(`(${gallerySource.slice(start, end)})`, { sliders, direction });
  return { ...channelsFromControls() };
}

test("the QA gallery exposes every requested brow action and one bounded strength", () => {
  assert.match(galleryHtml, /data-gallery-channel="brow"[^>]+min="0"[^>]+max="1"[^>]+value="\.6"/);
  for (const action of ["neutral", "raise", "frown", "worried", "outerLeft", "outerRight"]) {
    assert.equal((galleryHtml.match(new RegExp(`data-gallery-brow="${action}"`, "g")) || []).length, 1,
      `${action} must have one visible shortcut`);
    assert.match(galleryHtml, new RegExp(`<option value="${action}">`), `${action} must remain keyboard-selectable`);
  }
});

test("gallery brow controls emit natural symmetric and one-sided ARKit frames", () => {
  const neutral = galleryChannels("neutral");
  for (const key of ["browInnerUp", "browDownLeft", "browDownRight", "browOuterUpLeft", "browOuterUpRight"]) {
    assert.equal(neutral[key], 0);
  }

  const raise = galleryChannels("raise");
  assert.equal(raise.browInnerUp, .6);
  assert.equal(raise.browDownLeft, 0);
  assert.equal(raise.browOuterUpLeft, 0);

  const frown = galleryChannels("frown");
  assert.equal(frown.browDownLeft, .6);
  assert.equal(frown.browDownRight, .6);
  assert.equal(frown.browInnerUp, 0);

  const worried = galleryChannels("worried");
  assert.equal(worried.browInnerUp, .6);
  assert.equal(worried.mouthFrownLeft, .6);
  assert.equal(worried.mouthFrownRight, .6);
  assert.equal(worried.browDownLeft, 0);

  const left = galleryChannels("outerLeft"), right = galleryChannels("outerRight");
  assert.deepEqual([left.browOuterUpLeft, left.browOuterUpRight], [.6, 0]);
  assert.deepEqual([right.browOuterUpLeft, right.browOuterUpRight], [0, .6]);
  assert.equal(left.browInnerUp, 0, "one-sided raise must not accidentally raise both brows");
  assert.equal(right.browInnerUp, 0, "one-sided raise must not accidentally raise both brows");
});

test("brow comparisons preserve the accepted eyes, gaze and mouth inputs", () => {
  const keys = [
    "eyeBlinkLeft", "eyeBlinkRight", "eyeLookUpLeft", "eyeLookUpRight",
    "jawOpen", "mouthPucker", "mouthPressLeft", "mouthPressRight", "mouthLeft", "mouthRight",
  ];
  const baseline = galleryChannels("neutral");
  for (const mode of ["raise", "frown", "worried", "outerLeft", "outerRight"]) {
    const frame = galleryChannels(mode);
    for (const key of keys) assert.equal(frame[key], baseline[key], `${mode} must preserve ${key}`);
  }
  assert.ok(Object.values(galleryChannels("raise", 99)).every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
    "hostile brow slider values must still emit bounded coefficients");

  const applyStart = gallerySource.indexOf("function applyPreset(name)");
  const applyEnd = gallerySource.indexOf("\nfunction buildCards()", applyStart);
  const applyPresetSource = gallerySource.slice(applyStart, applyEnd);
  assert.match(applyPresetSource, /\["blink", "jaw", "pucker", "press"\]/);
  assert.doesNotMatch(applyPresetSource, /sliders\.brow/,
    "mouth and blink presets must not silently clear the selected brow comparison");
});
