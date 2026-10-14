import test from "node:test";
import assert from "node:assert/strict";
import { PortraitWarp, portraitWarpState, compactWarpCoordinate } from "./portrait-warp.js";

const rig = { leftEye: { x: 380, y: 420, w: 100, h: 64 }, rightEye: { x: 620, y: 420, w: 100, h: 64 }, mouth: { x: 500, y: 550, w: 120, h: 60 } };

test("portrait rig uses original source dimensions and exact original locations", () => {
  const state = portraitWarpState(1000, 1200, rig);
  assert.deepEqual(state.leftEye, [.38, .35, .1, 64 / 1200]);
  assert.deepEqual(state.mouth, [.5, 550 / 1200, .12, .05]);
});

test("unverified rig opts out without modifying its original geometry", () => {
  const before = structuredClone(rig);
  assert.equal(portraitWarpState(1000, 1200, { ...rig, patchesEnabled: false }), null);
  assert.deepEqual(rig, before);
});

test("invalid geometry and non-finite motion cannot reach uniforms", () => {
  assert.equal(portraitWarpState(Infinity, 1200, rig), null);
  const state = portraitWarpState(1000, 1200, { leftEye: { x: NaN, y: 2, w: 40, h: 12 }, rightEye: { x: 600, y: 2, w: Infinity, h: 12 } },
    { blinkL: NaN, smile: Infinity, mouthX: -Infinity, lookX: -8, blinkR: 20 }, { blink: 5, expression: NaN });
  assert.deepEqual(state.leftEye, [0, 0, 0, 0]);
  assert.deepEqual(state.rightEye, [0, 0, 0, 0]);
  assert.deepEqual(state.eye, [0, 1, 0, 0]);
  assert.equal(state.gaze[0], -1);
  assert.ok(Object.values(state).flat().every(Number.isFinite));
});

test("neutral motion preserves the source sampling coordinates", () => {
  const state = portraitWarpState(1000, 1200, rig, {});
  assert.deepEqual(state.eye, [0, 0, 0, 0]);
  assert.deepEqual(state.expression, [0, 0, 0, 0]);
  for (let i = -20; i <= 20; i += 1) assert.equal(compactWarpCoordinate(i / 10, 0), i / 10);
});

test("blink inverse warp stays strictly monotonic at every supported strength", () => {
  for (const strength of [-.3, 0, .5, 1, 2.35, 999]) {
    let previous = -1.01;
    for (let i = -1000; i <= 1000; i += 1) {
      const value = compactWarpCoordinate(i / 1000, strength);
      assert.ok(value > previous, `fold at ${i / 1000}, strength ${strength}`);
      previous = value;
    }
    assert.equal(compactWarpCoordinate(-1, strength), -1);
    assert.equal(compactWarpCoordinate(1, strength), 1);
  }
});

test("compact support keeps pixels outside facial regions unchanged", () => {
  for (const position of [-100, -2, -1, 0, 1, 2, 100]) assert.equal(compactWarpCoordinate(position, 2.35), position);
  const epsilon = 1e-5;
  const boundarySlope = (compactWarpCoordinate(1, 2.35) - compactWarpCoordinate(1 - epsilon, 2.35)) / epsilon;
  assert.ok(Math.abs(boundarySlope - 1) < .001);
});

test("renderer without browser/WebGL gracefully falls back and disposes safely", () => {
  const renderer = new PortraitWarp();
  assert.equal(renderer.render({ width: 1000, height: 1200 }, rig, {}), null);
  renderer.dispose();
  renderer.dispose();
  assert.equal(renderer.render({ width: 1000, height: 1200 }, rig, {}), null);
});

test("image texture uploads are cached, loss falls back and resources are released", () => {
  const originalDocument = globalThis.document;
  const counts = { upload: 0, draw: 0, deleteTexture: 0, deleteBuffer: 0, deleteProgram: 0 };
  const gl = new Proxy({
    MAX_TEXTURE_SIZE: 3379, NO_ERROR: 0,
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}), createTexture: () => ({}),
    getShaderParameter: () => true, getProgramParameter: () => true,
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    getParameter: () => 4096, getError: () => 0, isContextLost: () => false, getExtension: () => null,
    texImage2D: () => { counts.upload += 1; }, drawArrays: () => { counts.draw += 1; },
    deleteTexture: () => { counts.deleteTexture += 1; }, deleteBuffer: () => { counts.deleteBuffer += 1; },
    deleteProgram: () => { counts.deleteProgram += 1; },
  }, { get(target, name) { return name in target ? target[name] : name === name.toUpperCase() ? 1 : () => {}; } });
  const canvases = [];
  globalThis.document = { createElement() {
    const listeners = new Map();
    const canvas = { width: 0, height: 0, listeners,
      getContext: (kind) => kind === "webgl" ? gl : { clearRect() {}, drawImage() {} },
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name) => listeners.delete(name),
    };
    canvases.push(canvas);
    return canvas;
  } };
  try {
    const renderer = new PortraitWarp();
    const image = { naturalWidth: 1000, naturalHeight: 1200 };
    const output = renderer.render(image, rig, {});
    assert.equal(output.width, 853);
    assert.equal(output.height, 1024);
    renderer.render(image, rig, { blinkL: 1 });
    assert.equal(counts.upload, 1);
    assert.equal(counts.draw, 2);
    output.listeners.get("webglcontextlost")({ preventDefault() {} });
    assert.equal(renderer.render(image, rig, {}), null);
    output.listeners.get("webglcontextrestored")();
    assert.equal(renderer.render(image, rig, {}), output);
    assert.equal(counts.upload, 2);
    renderer.render({ ...image }, rig, {});
    assert.equal(counts.upload, 3);
    renderer.dispose();
    renderer.dispose();
    assert.equal(output.listeners.size, 0);
    assert.equal(counts.deleteTexture, 1);
    assert.equal(counts.deleteBuffer, 1);
    assert.equal(counts.deleteProgram, 1);
    assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
