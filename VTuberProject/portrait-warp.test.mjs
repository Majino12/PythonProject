import test from "node:test";
import assert from "node:assert/strict";
import { PortraitWarp, portraitWarpState, compactWarpCoordinate, eyelidWarpCoordinate, portraitMouthOpening, portraitMouthGeometry, portraitCavityColor, PORTRAIT_CHANNEL_SUPPORT } from "./portrait-warp.js";

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

test("full eyelid closure compresses the iris below one source pixel without folds", () => {
  for (const blink of [0, .25, .65, .95, 1]) {
    let previous = -2;
    for (let i = -2000; i <= 2000; i += 1) {
      const value = eyelidWarpCoordinate(i / 2000, blink);
      assert.ok(value > previous, `eyelid fold at ${i}, blink ${blink}`);
      previous = value;
    }
  }
  assert.ok(eyelidWarpCoordinate(.002, 1) > .36);
  assert.equal(eyelidWarpCoordinate(1, 1), 1);
  assert.equal(eyelidWarpCoordinate(-1, 1), -1);
  for (const position of [-.9, -.2, 0, .2, .9]) assert.ok(Math.abs(eyelidWarpCoordinate(position, 0) - position) < 1e-12);
});

test("canonical independent eye and brow channels override legacy merged values", () => {
  const state = portraitWarpState(1000, 1200, rig, { blinkL: 1, blinkR: 1, browUp: 1 }, {}, {
    eyeBlinkLeft: 0, eyeBlinkRight: .8, browInnerUp: 0, browOuterUpLeft: .7, browOuterUpRight: 0, browDownRight: .6,
  });
  assert.deepEqual(state.eye, [0, .8, 0, 0]);
  assert.deepEqual(state.brow, [0, .7, -.432, -.48]);
  assert.ok(state.leftBrow[1] < state.leftEye[1]);
  assert.ok(state.rightBrow[1] < state.rightEye[1]);
});

test("canonical mouth direction replaces rather than doubles the legacy signal", () => {
  const canonical = portraitWarpState(1000, 1200, rig, { mouthX: .6 }, {}, { mouthRight: .6, mouthLeft: 0 });
  const oldCall = portraitWarpState(1000, 1200, rig, { mouthX: .6 });
  assert.equal(canonical.faceMotion[2], .6);
  assert.equal(oldCall.faceMotion[2], .6);
  assert.equal(portraitWarpState(1000, 1200, rig, { mouthX: .6 }, {}, { mouthRight: 0, mouthLeft: 0 }).faceMotion[2], 0);
});

test("closing lips does not erase jaw travel and funnel is different from pucker", () => {
  const open = portraitWarpState(1000, 1200, rig, {}, {}, { jawOpen: 1 });
  const sealed = portraitWarpState(1000, 1200, rig, {}, {}, { jawOpen: 1, mouthClose: 1 });
  assert.equal(open.jaw[0], sealed.jaw[0]);
  assert.ok(portraitMouthOpening(open) > .7);
  assert.equal(portraitMouthOpening(sealed), 0);
  const funnel = portraitWarpState(1000, 1200, rig, {}, {}, { mouthFunnel: 1 });
  const pucker = portraitWarpState(1000, 1200, rig, {}, {}, { mouthPucker: 1 });
  assert.ok(portraitMouthOpening(funnel) > 0);
  assert.equal(portraitMouthOpening(pucker), 0);
  assert.notDeepEqual(funnel.mouthShape, pucker.mouthShape);
});

test("funnel produces a distinctly rounder aperture than ordinary jaw opening", () => {
  const jaw = portraitMouthGeometry(portraitWarpState(1000, 1200, rig, {}, {}, { jawOpen: .8 }));
  const funnel = portraitMouthGeometry(portraitWarpState(1000, 1200, rig, {}, {}, { mouthFunnel: .8, jawOpen: .3 }));
  const aspect = (shape) => 2 * shape.halfWidth / (shape.upperHeight + shape.lowerHeight);
  assert.ok(funnel.halfWidth < jaw.halfWidth * .65);
  assert.ok(funnel.upperHeight + funnel.lowerHeight > jaw.upperHeight + jaw.lowerHeight);
  assert.ok(aspect(funnel) < aspect(jaw) * .45);
  const pucker = portraitMouthGeometry(portraitWarpState(1000, 1200, rig, {}, {}, { mouthPucker: 1 }));
  assert.equal(pucker.upperHeight + pucker.lowerHeight, 0);
  const strongest = portraitMouthGeometry(portraitWarpState(1000, 1200, rig, {}, {}, { mouthFunnel: 1, jawOpen: 1 }));
  assert.ok(strongest.upperHeight + strongest.lowerHeight <= .05 * .90001);
});

test("left and right lips, smile corners and lip pressure stay independent", () => {
  const state = portraitWarpState(1000, 1200, rig, {}, {}, {
    jawOpen: .8, mouthUpperUpLeft: .8, mouthLowerDownRight: .6, mouthSmileLeft: .9, mouthFrownRight: .5, mouthPressRight: 1,
  });
  assert.deepEqual(state.lips, [.8, 0, 0, .6]);
  assert.deepEqual(state.corners, [.9, 0, 0, .5]);
  assert.ok(portraitMouthOpening(state, 1) > portraitMouthOpening(state, -1) * 3);
});

test("mouth cavity keeps a warm lip tint and lower bounce instead of a black cutout", () => {
  const lip = [.42, .22, .23], skin = [.96, .85, .80];
  const top = portraitCavityColor(lip, skin, 0), bottom = portraitCavityColor(lip, skin, 1);
  assert.ok(top[0] > .4 && top[1] > .19 && top[2] > .2);
  assert.ok(top[0] > top[1] * 1.5);
  assert.ok(bottom[0] > top[0] + .15 && bottom[1] > top[1] + .1);
  assert.ok(bottom[0] < skin[0] && bottom[1] < skin[1]);
  const invalid = portraitCavityColor([Infinity, NaN, -1], [NaN, 8, 2], Infinity);
  assert.ok(invalid.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
});

test("52 channel metadata is honest and every advertised channel drives renderer state", () => {
  const entries = Object.entries(PORTRAIT_CHANNEL_SUPPORT);
  assert.equal(entries.length, 52);
  assert.equal(PORTRAIT_CHANNEL_SUPPORT.tongueOut, "unsupported");
  assert.equal(PORTRAIT_CHANNEL_SUPPORT.jawOpen, "approximate");
  assert.equal(PORTRAIT_CHANNEL_SUPPORT.eyeLookUpLeft, "approximate");
  const neutral = portraitWarpState(1000, 1200, rig);
  for (const [key, support] of entries) {
    const state = portraitWarpState(1000, 1200, rig, {}, {}, { [key]: 1 });
    if (support === "unsupported") assert.deepEqual(state, neutral);
    else assert.notDeepEqual(state, neutral, `${key} must affect a driven uniform`);
  }
});

test("head yaw stays a local face parameter and invalid canonical coefficients are bounded", () => {
  const faceRig = { ...rig, face: { x: 500, y: 460, w: 360, h: 320 } };
  const state = portraitWarpState(1000, 1200, faceRig, { x: 8, y: -3 }, { head: 5 }, { jawOpen: Infinity, eyeBlinkLeft: NaN, browOuterUpRight: -2, cheekPuff: 9 });
  assert.deepEqual(state.face, [.5, 460 / 1200, .36, 320 / 1200]);
  assert.deepEqual(state.faceMotion, [.65, -1, 0, 1]);
  assert.ok(Object.values(state).flat().every(Number.isFinite));
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
  const uniforms = new Map();
  const gl = new Proxy({
    MAX_TEXTURE_SIZE: 3379, NO_ERROR: 0,
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}), createTexture: () => ({}),
    getShaderParameter: () => true, getProgramParameter: () => true,
    getAttribLocation: () => 0, getUniformLocation: (_program, name) => name,
    uniform4fv: (name, value) => uniforms.set(name, [...value]),
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
    assert.equal(output.width, 1000);
    assert.equal(output.height, 1200);
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
    renderer.render({ naturalWidth: 4096, naturalHeight: 3072 }, rig, {}, {}, { eyeBlinkLeft: 1 });
    assert.equal(output.width, 2048);
    assert.equal(output.height, 1536);
    assert.equal(counts.upload, 4);
    assert.equal(uniforms.get("u_eye")[0], 1);
    assert.equal(uniforms.size, 15);
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
