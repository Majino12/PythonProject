import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APPEARANCE, extractAppearance } from "./appearance.js";

const rig = {
  face: { x: 100, y: 75, w: 80, h: 80 },
  leftEye: { x: 118, y: 69, w: 22, h: 14 },
  rightEye: { x: 82, y: 69, w: 22, h: 14 },
};
function fixture(background = [0, 0, 0, 0], longHair = false) {
  const image = { width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4) };
  const rect = (x0, y0, x1, y1, rgba) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) image.data.set(rgba, (y * image.width + x) * 4);
  };
  rect(0, 0, 200, 200, background);
  rect(45, 23, 155, longHair ? 172 : 105, [12, 16, 24, 255]);
  rect(62, 47, 138, 115, [239, 193, 168, 255]);
  rect(62, 133, 138, 200, [73, 80, 174, 255]);
  for (const eye of [rig.leftEye, rig.rightEye]) {
    rect(eye.x - 10, 63, eye.x + 10, 75, [255, 255, 255, 255]);
    rect(eye.x - 4, 63, eye.x + 4, 75, [124, 66, 207, 255]);
    rect(eye.x - 1, 65, eye.x + 1, 73, [8, 7, 12, 255]);
  }
  return image;
}

test("transparent regions do not become black hair or clothes", () => {
  const image = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) };
  assert.deepEqual(extractAppearance(image), DEFAULT_APPEARANCE);
  assert.equal(extractAppearance(fixture(), rig).palette.outfit, "#4950ae");
});

test("uniform white and chroma-green borders do not contaminate the palette", () => {
  const transparent = extractAppearance(fixture(), rig);
  for (const background of [[255, 255, 255, 255], [0, 177, 64, 255]]) {
    assert.deepEqual(extractAppearance(fixture(background), rig).palette, transparent.palette);
  }
});

test("true black hair is retained while white sclera and dark pupils are ignored", () => {
  const appearance = extractAppearance(fixture([255, 255, 255, 255]), rig);
  assert.equal(appearance.palette.hair, "#0c1018");
  assert.equal(appearance.palette.skin, "#efc1a8");
  assert.equal(appearance.palette.eyes, "#7c42cf");
  assert.equal(appearance.confidence, 1);
});

test("uniform blank opaque images fall back instead of sampling the background", () => {
  for (const color of [0, 128, 255]) {
    const data = new Uint8ClampedArray(16 * 16 * 4).fill(color);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    assert.deepEqual(extractAppearance({ data, width: 16, height: 16 }), DEFAULT_APPEARANCE);
  }
});

test("deep skin tones and completely black hair remain valid source colours", () => {
  const image = fixture([255, 255, 255, 255]);
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] === 239 && image.data[i + 1] === 193 && image.data[i + 2] === 168) image.data.set([82, 44, 30, 255], i);
    else if (image.data[i] === 12 && image.data[i + 1] === 16 && image.data[i + 2] === 24) image.data.set([0, 0, 0, 255], i);
  }
  const appearance = extractAppearance(image, rig);
  assert.equal(appearance.palette.skin, "#522c1e");
  assert.equal(appearance.palette.hair, "#000000");
});

test("extraction is deterministic and does not mutate pixels or rig", () => {
  const image = fixture();
  const original = image.data.slice();
  const originalRig = structuredClone(rig);
  assert.deepEqual(extractAppearance(image, rig), extractAppearance(image, rig));
  assert.deepEqual(image.data, original);
  assert.deepEqual(rig, originalRig);
});

test("degenerate images and unsafe geometry return finite bounded values", () => {
  for (const image of [null, {}, { data: [], width: 0, height: 0 }, { data: new Uint8Array(16), width: 3, height: 3 },
    { data: [], width: Infinity, height: 1 }, { data: [], width: 100_000, height: 100_000 }]) {
    assert.deepEqual(extractAppearance(image), DEFAULT_APPEARANCE);
  }
  const result = extractAppearance(fixture(), { face: { x: NaN, y: 2, w: Infinity, h: -2 }, leftEye: { x: 0, y: 0, w: -5, h: 0 } });
  assert.equal(result.faceWidth, 1);
  assert.equal(result.eyeScale, 1);
  assert.ok(Object.values(result.palette).every((color) => /^#[0-9a-f]{6}$/.test(color)));
});

test("connected background removal preserves enclosed matching white clothing", () => {
  const image = fixture([255, 255, 255, 255]);
  for (let y = 135; y < 198; y += 1) for (let x = 64; x < 136; x += 1) image.data.set([255, 255, 255, 255], (y * 200 + x) * 4);
  assert.equal(extractAppearance(image, rig).palette.outfit, "#ffffff");
});

test("long hair is only inferred with side silhouette evidence", () => {
  assert.equal(extractAppearance(fixture([0, 0, 0, 0], true), rig).hairStyle, "long");
  assert.notEqual(extractAppearance(fixture(), rig).hairStyle, "long");
});

test("default objects and palettes cannot be accidentally shared between imports", () => {
  const first = extractAppearance(null);
  first.palette.hair = "#ffffff";
  assert.equal(extractAppearance(null).palette.hair, DEFAULT_APPEARANCE.palette.hair);
});

test("non-finite pixel values do not leak into palette output", () => {
  const data = new Float32Array(16 * 16 * 4).fill(NaN);
  assert.deepEqual(extractAppearance({ data, width: 16, height: 16 }), DEFAULT_APPEARANCE);
});
