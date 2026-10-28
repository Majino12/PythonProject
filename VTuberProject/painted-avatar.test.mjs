import test from "node:test";
import assert from "node:assert/strict";
import { PaintedAvatar, PAINTED_FRAME_SETS, PAINTED_CHANNEL_SUPPORT, paintedFrameIndex, selectPaintedFrames, selectPaintedPose, selectPaintedGaze, paintedChannelSupport, validatePaintedManifest } from "./painted-avatar.js";
import { LUNA_PAINTED_MANIFEST } from "./painted-luna.js";

const neutral = { leftEye: "open", rightEye: "open", leftBrow: "neutral", rightBrow: "neutral", mouth: "closed" };
const fixture = () => ({
  version: 1, width: 100, height: 150, base: "./assets/base.png",
  atlases: Object.fromEntries(Object.entries(PAINTED_FRAME_SETS).map(([name, frames]) => [name, {
    src: `./assets/${name}.png`, frames: Object.fromEntries(frames.map((frame, index) => [frame, [index * 20, 0, 20, 20]])),
  }])),
  layers: {
    leftEye: { atlas: "eyes", dest: [55, 30, 20, 15] }, rightEye: { atlas: "eyes", dest: [25, 30, 20, 15], flipX: true },
    leftBrow: { atlas: "brows", dest: [55, 20, 20, 8] }, rightBrow: { atlas: "brows", dest: [25, 20, 20, 8], flipX: true },
    mouth: { atlas: "mouth", dest: [40, 60, 20, 15] },
  },
});

function expandedFixture({ poses = false, shifts = false } = {}) {
  const manifest = fixture();
  manifest.sequences = {
    eyes: ["open", ...Array.from({ length: 9 }, (_, i) => `blink${(i + 1) * 10}`), "closed"],
    jaw: ["closed", "jaw10", "jaw25", "jaw45", "jaw65", "openWide"],
    pucker: ["puckerSoft", "puckerMid", "pucker"], press: ["pressSoft", "pressMid", "press"],
    puckerLeft: ["puckerLeftSoft", "puckerLeftMid", "puckerLeft"],
    puckerRight: ["puckerRightSoft", "puckerRightMid", "puckerRight"], funnel: ["funnelSoft", "funnel"],
  };
  if (shifts) Object.assign(manifest.sequences, {
    mouthLeft: ["shiftLeftSoft", "shiftLeftMid", "shiftLeft"],
    mouthRight: ["shiftRightSoft", "shiftRightMid", "shiftRight"],
  });
  for (const [name, frames] of Object.entries(manifest.sequences)) {
    const atlas = manifest.atlases[name === "eyes" ? "eyes" : "mouth"];
    for (const frame of frames) atlas.frames[frame] ||= [Object.keys(atlas.frames).length * 10, 30, 10, 10];
  }
  if (poses) {
    manifest.atlases.eyesAngle = { src: "./assets/eyes-angle.png", frames: structuredClone(manifest.atlases.eyes.frames) };
    manifest.atlases.mouthAngle = { src: "./assets/mouth-angle.png", frames: structuredClone(manifest.atlases.mouth.frames) };
    const angles = [["front", 0, 0], ["left1", .33, 0], ["left2", .66, 0], ["left3", 1, 0], ["right1", -.33, 0], ["right2", -.66, 0], ["right3", -1, 0],
      ["up", 0, 1], ["down", 0, -1], ["upLeft", .66, 1], ["upRight", -.66, 1], ["downLeft", .66, -1], ["downRight", -.66, -1]];
    manifest.poses = angles.map(([id, yaw, pitch]) => ({ id, yaw, pitch, base: id === "front" ? manifest.base : `./assets/${id}.png`, layers: {} }));
    Object.assign(manifest.poses[3].layers, {
      leftEye: { atlas: "eyesAngle", dest: [57, 29, 18, 15], clip: null },
      rightEye: { visible: false }, rightBrow: { visible: false },
      mouth: { atlas: "mouthAngle", dest: [54, 58, 15, 15] },
    });
  }
  return manifest;
}

function gazeFixture() {
  const manifest = fixture(), frames = manifest.atlases.eyes.frames;
  const levels = { open: 0, quarter: .25, half: .5, threeQuarter: .75 };
  manifest.atlases.eyes.gaze = {
    src: "./assets/iris.png", rect: [0, 0, 40, 40], iris: [.35, .3, .2, .4], range: [.15, .1],
    apertures: Object.fromEntries(Object.keys(frames).map((key) => [key, key === "closed" || key === "happyClosed" ? []
      : [[.1, .2 + levels[key] * .6], [.9, .2 + levels[key] * .6], [.9, .8], [.1, .8]]])),
  };
  return manifest;
}

function browFixture(manifest = fixture()) {
  manifest.sequences = { ...manifest.sequences };
  for (const [name, frame] of [["browUp", "up"], ["browDown", "down"], ["browWorried", "worried"], ["browOuterUp", "outerUp"]]) {
    manifest.sequences[name] = ["neutral", `${frame}Soft`, `${frame}Mid`, frame];
    for (const key of manifest.sequences[name]) manifest.atlases.brows.frames[key] ||= [Object.keys(manifest.atlases.brows.frames).length * 20, 30, 20, 20];
  }
  return manifest;
}

function harness({ auto = true, timeoutMs = 1000, fail = new Set(), throwSrc = false, dimensions = {} } = {}) {
  const calls = [], images = [], canvases = [];
  const createCanvas = () => {
    const target = canvases.length, stack = [], record = (entry) => calls.push({ target, ...entry });
    const context = {
      globalAlpha: 1, globalCompositeOperation: "source-over", scaleX: 1, translateX: 0, scaleY: 1, translateY: 0, clips: [], path: [],
      save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.scaleX, this.translateX, this.scaleY, this.translateY, this.clips]); record({ op: "save" }); },
      restore() { [this.globalAlpha, this.globalCompositeOperation, this.scaleX, this.translateX, this.scaleY, this.translateY, this.clips] = stack.pop(); record({ op: "restore" }); },
      setTransform(...args) { this.scaleX = args[0]; this.translateX = args[4]; this.scaleY = args[3]; this.translateY = args[5]; record({ op: "setTransform", args }); },
      clearRect(...args) { record({ op: "clearRect", args }); },
      drawImage(image, ...args) { record({ op: "drawImage", src: image.src ?? `canvas:${image.id}`, args, alpha: this.globalAlpha, composite: this.globalCompositeOperation, scaleX: this.scaleX, translateX: this.translateX, scaleY: this.scaleY, translateY: this.translateY, clips: this.clips }); },
      translate(...args) { this.translateX += this.scaleX * args[0]; this.translateY += this.scaleY * args[1]; record({ op: "translate", args }); },
      scale(...args) { this.scaleX *= args[0]; this.scaleY *= args[1]; record({ op: "scale", args }); },
      beginPath() { this.path = []; record({ op: "beginPath" }); },
      moveTo(...args) { this.path.push([...args]); record({ op: "moveTo", args }); },
      lineTo(...args) { this.path.push([...args]); record({ op: "lineTo", args }); },
      closePath() { record({ op: "closePath" }); }, clip() { this.clips = [...this.clips, this.path]; record({ op: "clip" }); },
    };
    const canvas = { id: target, width: 0, height: 0, getContext: () => context };
    canvases.push(canvas);
    return canvas;
  };
  const createImage = () => {
    const image = {
      naturalWidth: 512, naturalHeight: 512, onload: null, onerror: null, removed: false,
      set src(path) {
        this.path = path;
        if (throwSrc) throw new Error("src setter failed");
        [this.naturalWidth, this.naturalHeight] = dimensions[path] || [512, 512];
        if (auto) queueMicrotask(() => fail.has(path) ? this.onerror?.() : this.onload?.());
      },
      get src() { return this.path; },
      removeAttribute(name) { if (name === "src") this.removed = true; },
    };
    images.push(image);
    return image;
  };
  const renderer = new PaintedAvatar({ createCanvas, createImage, timeoutMs });
  return { renderer, canvas: canvases[0], canvases, calls, images, context: canvases[0].getContext(),
    finish(from = 0) { images.slice(from).forEach((image) => image.onload?.()); },
    drawings() { return calls.filter(({ op, target }) => op === "drawImage" && target === 0); },
    scratchDrawings() { return calls.filter(({ op, target }) => op === "drawImage" && target !== 0); },
  };
}

test("zero coefficients remain genuinely neutral, including null and invalid values", () => {
  assert.deepEqual(selectPaintedFrames(), neutral);
  assert.deepEqual(selectPaintedFrames(null, null, null), neutral);
  assert.deepEqual(selectPaintedFrames({ jawOpen: NaN, eyeBlinkLeft: Infinity, mouthSmileRight: "1" }), neutral);
  assert.deepEqual(selectPaintedFrames(Object.fromEntries(Object.keys(PAINTED_CHANNEL_SUPPORT).map((key) => [key, 1])), { blink: 0, mouth: 0, expression: 0 }), neutral);
});

test("left/right eyes select painted blink stages independently, with a true closed lid at .85 gain", () => {
  for (const [value, frame] of [[0, "open"], [.25, "quarter"], [.5, "half"], [.75, "threeQuarter"], [1, "closed"]]) {
    const selected = selectPaintedFrames({ eyeBlinkLeft: value });
    assert.equal(selected.leftEye, frame);
    assert.equal(selected.rightEye, "open");
  }
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: 1 }, { blink: .85 }, { leftEye: "open" }).leftEye, "closed");
  assert.equal(selectPaintedFrames({ eyeBlinkRight: 1 }, {}, { rightEye: "open" }).rightEye, "closed");
});

test("blink thresholds resist chatter but do not delay a large close/open jump", () => {
  assert.equal(paintedFrameIndex(.39, 1, [.125, .375, .625], .025), 1);
  assert.equal(paintedFrameIndex(.41, 1, [.125, .375, .625], .025), 2);
  assert.equal(paintedFrameIndex(.36, 2, [.125, .375, .625], .025), 2);
  assert.equal(paintedFrameIndex(.34, 2, [.125, .375, .625], .025), 1);
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: 1 }, {}, neutral).leftEye, "closed");
  assert.equal(selectPaintedFrames({}, {}, { leftEye: "closed" }).leftEye, "open");
});

test("happy closed eyes require smile plus closure, not smile alone", () => {
  assert.equal(selectPaintedFrames({ mouthSmileLeft: .8 }).leftEye, "open");
  const happy = selectPaintedFrames({ eyeBlinkLeft: 1, mouthSmileLeft: .8 });
  assert.equal(happy.leftEye, "happyClosed");
  assert.equal(happy.rightEye, "open");
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: .8, mouthSmileLeft: .5 }, {}, happy).leftEye, "happyClosed");
  assert.notEqual(selectPaintedFrames({ eyeBlinkLeft: .7, mouthSmileLeft: .5 }, {}, happy).leftEye, "happyClosed");
});

test("squint/cheek/eye-wide are explicitly approximate and never suppress a full blink", () => {
  assert.notEqual(selectPaintedFrames({ eyeSquintLeft: 1 }).leftEye, "open");
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: .3, eyeWideLeft: 1 }).leftEye, "quarter");
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: 1, eyeWideLeft: 1 }).leftEye, "closed");
  assert.equal(PAINTED_CHANNEL_SUPPORT.cheekSquintLeft, "approximate");
});

test("eyebrows select independently with deterministic pressure/worry/outer-raise priorities", () => {
  assert.equal(selectPaintedFrames({ browDownLeft: .9, browOuterUpRight: .9 }).leftBrow, "down");
  assert.equal(selectPaintedFrames({ browDownLeft: .9, browOuterUpRight: .9 }).rightBrow, "outerUp");
  assert.equal(selectPaintedFrames({ browInnerUp: .7 }).leftBrow, "up");
  assert.equal(selectPaintedFrames({ browInnerUp: .7, mouthFrownLeft: .7 }).leftBrow, "worried");
  assert.equal(selectPaintedFrames({ browInnerUp: .7, mouthFrownLeft: .7 }).rightBrow, "up");
  assert.equal(selectPaintedFrames({ browInnerUp: .7, browDownLeft: .9 }).leftBrow, "down");
  assert.equal(selectPaintedFrames({ browDownLeft: .5 }, {}, { leftBrow: "down" }).leftBrow, "down");
  assert.equal(selectPaintedFrames({ browDownLeft: .5 }).leftBrow, "neutral");
});

test("optional brow sequences expose low, medium and strong hand-painted expressions", () => {
  const { sequences } = browFixture();
  const cases = [
    ["up", (amount) => ({ browInnerUp: amount })],
    ["down", (amount) => ({ browDownLeft: amount })],
    ["worried", (amount) => ({ browInnerUp: amount, mouthFrownLeft: .6 })],
    ["outerUp", (amount) => ({ browOuterUpLeft: amount })],
  ];
  for (const [family, channels] of cases) {
    for (const [amount, suffix] of [[.2, "Soft"], [.55, "Mid"], [.85, ""]]) {
      assert.equal(selectPaintedFrames(channels(amount), {}, neutral, sequences).leftBrow, family + suffix);
    }
  }
  assert.equal(selectPaintedFrames({ browDownRight: .2 }, {}, neutral, sequences).rightBrow, "downSoft");
  assert.equal(selectPaintedFrames({ browOuterUpRight: .55 }, {}, neutral, sequences).rightBrow, "outerUpMid");
  const worry = selectPaintedFrames({ browInnerUp: .55, mouthFrownLeft: .6 }, {}, neutral, sequences);
  assert.equal(worry.leftBrow, "worriedMid");
  assert.equal(worry.rightBrow, "upMid", "worry context is independent for the two sides");
  assert.deepEqual(selectPaintedFrames({}, {}, {}, sequences), neutral);
  assert.deepEqual(selectPaintedFrames({ browInnerUp: 1, browDownRight: 1 }, { expression: 0 }, {}, sequences), neutral);
  assert.equal(selectPaintedFrames({ browInnerUp: .4 }, { expression: .5 }, {}, sequences).leftBrow, "upSoft");
});

test("painted brow thresholds have a short hysteresis band and release fully to neutral", () => {
  const { sequences } = browFixture();
  for (const [amount, previous, expected] of [
    [.13, "neutral", "neutral"], [.14, "neutral", "upSoft"], [.11, "upSoft", "upSoft"], [.10, "upSoft", "neutral"],
    [.42, "upSoft", "upSoft"], [.43, "upSoft", "upMid"], [.40, "upMid", "upMid"], [.39, "upMid", "upSoft"],
    [.71, "upMid", "upMid"], [.72, "upMid", "up"], [.69, "up", "up"], [.68, "up", "upMid"],
    [0, "up", "neutral"], [1, "neutral", "up"],
  ]) assert.equal(selectPaintedFrames({ browInnerUp: amount }, {}, { leftBrow: previous }, sequences).leftBrow, expected);
});

test("staged brow conflicts retain pressure/worry priority without low pressure hiding a strong raise", () => {
  const { sequences } = browFixture();
  assert.equal(selectPaintedFrames({ browDownLeft: .9, browInnerUp: .9, mouthFrownLeft: .9, browOuterUpLeft: .9 }, {}, {}, sequences).leftBrow, "down");
  assert.equal(selectPaintedFrames({ browInnerUp: .55, browDownLeft: .2 }, {}, {}, sequences).leftBrow, "worriedMid");
  assert.equal(selectPaintedFrames({ browInnerUp: .9, browDownLeft: .15 }, {}, {}, sequences).leftBrow, "up");
  assert.equal(selectPaintedFrames({ browDownLeft: .22 }, {}, {}, sequences).leftBrow, "downSoft");
  assert.equal(selectPaintedFrames({ browInnerUp: .22, browOuterUpLeft: .22 }, {}, {}, sequences).leftBrow, "upSoft", "equal inner/outer raise is not mislabeled as a unilateral outer raise");
  const heldWorry = selectPaintedFrames({ browInnerUp: .3, mouthFrownLeft: .15 }, {}, { leftBrow: "worriedSoft" }, sequences);
  assert.equal(heldWorry.leftBrow, "worriedSoft");
  assert.equal(selectPaintedFrames({ browInnerUp: .3, mouthFrownLeft: .1 }, {}, heldWorry, sequences).leftBrow, "upSoft");
});

test("partial brow opt-in preserves legacy thresholds for undeclared families and all eye/mouth choices", () => {
  const sequences = { browUp: ["neutral", "upSoft", "upMid", "up"] };
  assert.equal(selectPaintedFrames({ browInnerUp: .2 }, {}, {}, sequences).leftBrow, "upSoft");
  assert.equal(selectPaintedFrames({ browDownLeft: .5 }, {}, {}, sequences).leftBrow, "neutral");
  assert.equal(selectPaintedFrames({ browDownLeft: .6 }, {}, {}, sequences).leftBrow, "down");
  const full = browFixture(expandedFixture()).sequences;
  for (const channels of [{}, { eyeBlinkLeft: .7, jawOpen: .5 }, { eyeBlinkRight: 1, mouthPucker: .6, mouthLeft: .7 }, { mouthPressLeft: .8, mouthFunnel: .7 }]) {
    const original = selectPaintedFrames(channels, {}, {}, expandedFixture().sequences), upgraded = selectPaintedFrames(channels, {}, {}, full);
    for (const layer of ["leftEye", "rightEye", "mouth"]) assert.equal(upgraded[layer], original[layer]);
  }
});

test("jaw opening has four distinct paintings and mouthClose is independent", () => {
  for (const [value, frame] of [[0, "closed"], [.2, "openSmall"], [.5, "openMedium"], [.9, "openWide"]]) {
    assert.equal(selectPaintedFrames({ jawOpen: value }).mouth, frame);
  }
  assert.equal(selectPaintedFrames({ jawOpen: 1, mouthClose: 1 }).mouth, "closed");
});

test("legacy mouth priority skips unsupported pure shifts and preserves emotion and jaw", () => {
  const all = { mouthPressLeft: 1, mouthClose: 1, mouthPucker: 1, mouthFunnel: 1, mouthRight: 1, mouthSmileLeft: 1, jawOpen: 1 };
  assert.equal(selectPaintedFrames(all).mouth, "press");
  delete all.mouthPressLeft; assert.equal(selectPaintedFrames(all).mouth, "closed");
  delete all.mouthClose; assert.equal(selectPaintedFrames(all).mouth, "pucker");
  delete all.mouthPucker; assert.equal(selectPaintedFrames(all).mouth, "funnel");
  delete all.mouthFunnel; assert.equal(selectPaintedFrames(all).mouth, "smileOpen");
  delete all.mouthRight; assert.equal(selectPaintedFrames(all).mouth, "smileOpen");
  delete all.mouthSmileLeft; assert.equal(selectPaintedFrames(all).mouth, "openWide");
});

test("mouth smile/frown each have open/closed drawings, not fabricated independent corners", () => {
  assert.equal(selectPaintedFrames({ mouthSmileRight: .8 }).mouth, "smileClosed");
  assert.equal(selectPaintedFrames({ mouthSmileRight: .8, jawOpen: .3 }).mouth, "smileOpen");
  assert.equal(selectPaintedFrames({ mouthFrownLeft: .8 }).mouth, "frownClosed");
  assert.equal(selectPaintedFrames({ mouthFrownLeft: .8, jawOpen: .3 }).mouth, "frownOpen");
  assert.equal(selectPaintedFrames({ mouthSmileLeft: .7, mouthFrownLeft: .7 }).mouth, "smileClosed");
  assert.equal(selectPaintedFrames({ mouthSmileLeft: .6, mouthFrownLeft: .9 }).mouth, "frownClosed");
  assert.equal(PAINTED_CHANNEL_SUPPORT.mouthSmileLeft, "approximate");
});

test("pucker/funnel retain a short hysteresis band and release to neutral", () => {
  for (const [key, frame, hold] of [["mouthPucker", "pucker", .48], ["mouthFunnel", "funnel", .42]]) {
    assert.equal(selectPaintedFrames({ [key]: 1 }).mouth, frame);
    assert.equal(selectPaintedFrames({ [key]: hold }, {}, { mouth: frame }).mouth, frame);
    assert.equal(selectPaintedFrames({ [key]: 0 }, {}, { mouth: frame }).mouth, "closed");
  }
  assert.equal(selectPaintedFrames({ mouthLeft: .9, mouthRight: .9 }).mouth, "closed");
});

test("metadata covers canonical 52 honestly, unsupported signals produce no phantom animation", () => {
  assert.equal(Object.keys(PAINTED_CHANNEL_SUPPORT).length, 52);
  assert.equal(PAINTED_CHANNEL_SUPPORT.tongueOut, "unsupported");
  assert.equal(PAINTED_CHANNEL_SUPPORT.eyeLookUpLeft, "unsupported");
  assert.equal(PAINTED_CHANNEL_SUPPORT.jawForward, "unsupported");
  assert.equal(PAINTED_CHANNEL_SUPPORT.mouthFunnel, "frame");
  const unsupported = Object.fromEntries(Object.entries(PAINTED_CHANNEL_SUPPORT).filter(([, kind]) => kind === "unsupported").map(([key]) => [key, 1]));
  assert.deepEqual(selectPaintedFrames(unsupported), neutral);
  assert.ok(Object.isFrozen(PAINTED_CHANNEL_SUPPORT));
});

test("manifest validates built-in Luna and copies arrays without mutating source", () => {
  validatePaintedManifest(LUNA_PAINTED_MANIFEST);
  const input = fixture();
  input.layers.leftEye.clip = [[0, 0], [99, 0], [99, 149]];
  const copy = validatePaintedManifest(input);
  copy.layers.leftEye.dest[0] = 0;
  copy.layers.leftEye.clip[0][0] = 5;
  copy.atlases.eyes.frames.open[0] = 1;
  assert.equal(input.layers.leftEye.dest[0], 55);
  assert.equal(input.layers.leftEye.clip[0][0], 0);
  assert.equal(input.atlases.eyes.frames.open[0], 0);
});

test("manifest only accepts local built-in assets, never remote/traversal/file/data URLs", () => {
  for (const path of ["https://example.com/a.png", "//example.com/a.png", "/assets/a.png", "./assets/../a.png", "./assets//a.png", "./assets/a.png?x=1", "./assets/a.png#x", "./assets/%2e%2e/a.png", "file:///a.png", "data:image/png;base64,a", "./assets\\a.png"]) {
    const manifest = fixture(); manifest.base = path;
    assert.throws(() => validatePaintedManifest(manifest), /本地图片/);
  }
  const manifest = fixture(); manifest.atlases.eyes.src = "https://example.com/a.png";
  assert.throws(() => validatePaintedManifest(manifest), /本地图片/);
});

test("manifest rejects invalid size, missing states, malformed and out-of-bounds rectangles", () => {
  for (const change of [
    (m) => m.width = 4097, (m) => m.height = 1.5, (m) => m.version = 2,
    (m) => delete m.atlases.eyes.frames.closed, (m) => m.layers.mouth.dest[2] = 0,
    (m) => m.layers.leftEye.dest[0] = -1, (m) => m.layers.leftEye.dest[0] = 99,
    (m) => m.atlases.mouth.frames.closed[0] = NaN, (m) => m.layers.leftEye.clip = [[0, 0], [1, 1]],
    (m) => m.layers.leftEye.clip = [[0, 0], [1, 1], [101, 1]],
  ]) {
    const manifest = fixture(); change(manifest);
    assert.throws(() => validatePaintedManifest(manifest));
  }
});

test("manifest never resolves inherited or prototype atlas names", () => {
  for (const name of ["constructor", "prototype", "__proto__", "toString"]) {
    const manifest = fixture(); manifest.layers.leftEye.atlas = name;
    assert.throws(() => validatePaintedManifest(manifest));
  }
});

test("load deduplicates atlases, exposes base/loaded and draws five fixed feature layers", async () => {
  const h = harness(), manifest = fixture();
  assert.equal(h.renderer.loaded, false);
  assert.equal(h.renderer.baseImage, null);
  assert.equal(h.renderer.render(), null);
  assert.equal(await h.renderer.load(manifest), h.renderer);
  assert.equal(h.images.length, 4);
  assert.equal(h.renderer.loaded, true);
  assert.equal(h.renderer.baseImage.src, manifest.base);
  assert.equal(h.canvas.width, manifest.width);
  assert.equal(h.canvas.height, manifest.height);
  assert.equal(h.renderer.render(), h.canvas);
  assert.equal(h.drawings().length, 6);
  assert.deepEqual(h.renderer.frames, neutral);
  assert.deepEqual(h.drawings()[0].args, [0, 0, 100, 150]);
  h.renderer.dispose();
});

test("render never dynamically scales destinations or fades the whole face", async () => {
  const h = harness(); await h.renderer.load(fixture());
  h.renderer.render();
  const initial = h.drawings().map((draw) => draw.args.slice(-4));
  h.calls.length = 0;
  h.renderer.render({ eyeBlinkLeft: 1, eyeBlinkRight: 1, mouthFunnel: 1, browDownLeft: 1, browOuterUpRight: 1 }, {}, .016);
  assert.deepEqual(h.drawings().map((draw) => draw.args.slice(-4)), initial);
  assert.ok(h.drawings().every((draw) => draw.alpha === 1));
  assert.ok(h.calls.filter(({ op }) => op === "scale").every(({ args }) => args[0] === -1 && args[1] === 1));
  assert.equal(h.drawings().length, 6, "large blink jumps do not double-draw open and closed eyes");
  assert.equal(h.drawings()[1].args[0], 80, "closed eye source is the fifth drawing");
  h.renderer.dispose();
});

test("adjacent eye blend uses premultiplied addition, draws one opaque layer, and finishes within 30 ms", async () => {
  const h = harness(); await h.renderer.load(fixture());
  h.renderer.render({}, {}, .016); h.calls.length = 0;
  h.renderer.render({ eyeBlinkLeft: .25 }, {}, .016);
  assert.equal(h.drawings().length, 6);
  assert.equal(h.drawings()[0].alpha, 1, "base never fades");
  assert.ok(h.drawings().every(({ alpha, composite }) => alpha === 1 && composite === "source-over"));
  const faded = h.scratchDrawings();
  assert.equal(faded.length, 2);
  assert.ok(faded.every(({ src }) => src.endsWith("eyes.png")));
  assert.ok(Math.abs(faded[0].alpha + faded[1].alpha - 1) < 1e-12);
  assert.equal(faded[0].composite, "source-over");
  assert.equal(faded[1].composite, "lighter");
  const resultingOpaqueAlpha = Math.min(1, faded[0].alpha + faded[1].alpha);
  assert.equal(resultingOpaqueAlpha, 1, "opaque overlap retains full alpha, not source-over dimming");
  assert.deepEqual(faded[0].args.slice(-4), faded[1].args.slice(-4));
  assert.equal(h.canvases.length, 2);
  assert.deepEqual([h.canvases[1].width, h.canvases[1].height], [20, 15]);
  h.calls.length = 0;
  h.renderer.render({ eyeBlinkLeft: .25 }, {}, .016);
  assert.equal(h.drawings().length, 6);
  assert.ok(h.drawings().every(({ alpha }) => alpha === 1));
  assert.equal(h.scratchDrawings().length, 0);
  h.calls.length = 0;
  h.renderer.render({ eyeBlinkLeft: .25 }, {}, .016);
  assert.equal(h.calls.length, 0, "settled composition is cached");
  h.renderer.dispose();
  assert.deepEqual([h.canvases[1].width, h.canvases[1].height], [1, 1]);
});

test("unchanged selected frames reuse composition while a changed feature redraws", async () => {
  const h = harness(); await h.renderer.load(fixture());
  const canvas = h.renderer.render({}, {}, .016);
  h.calls.length = 0;
  for (let index = 0; index < 60; index++) {
    assert.equal(h.renderer.render({ jawOpen: .02 + index / 10000 }, {}, .016), canvas);
  }
  assert.equal(h.calls.length, 0, "subthreshold coefficient changes do not repaint a full-size canvas");
  h.renderer.render({ jawOpen: .9 }, {}, .016);
  assert.equal(h.drawings().length, 6);
  assert.equal(h.renderer.frames.mouth, "openWide");
  h.calls.length = 0;
  h.renderer.render({ jawOpen: .95 }, {}, .016);
  assert.equal(h.calls.length, 0);
  h.renderer.dispose();
});

test("both eye transitions share one fixed-size buffer across repeated blinks", async () => {
  const h = harness(), manifest = fixture();
  manifest.layers.rightEye.dest[2] = 24;
  await h.renderer.load(manifest);
  h.renderer.render({}, {}, .016);
  for (let index = 0; index < 40; index++) {
    const blink = index % 2 ? 0 : .25;
    h.renderer.render({ eyeBlinkLeft: blink, eyeBlinkRight: blink }, {}, .016);
    h.renderer.render({ eyeBlinkLeft: blink, eyeBlinkRight: blink }, {}, .016);
  }
  assert.equal(h.canvases.length, 2, "no per-frame or per-eye canvas allocations");
  assert.deepEqual([h.canvases[1].width, h.canvases[1].height], [24, 15]);
  assert.equal(h.images.length, 4);
  assert.ok(h.drawings().every(({ alpha }) => alpha === 1));
  h.renderer.dispose();
});

test("adjacent brow frames use a 35 ms premultiplied local blend and then cache the composition", async () => {
  const h = harness(); await h.renderer.load(browFixture());
  h.renderer.render({}, {}, .016); h.calls.length = 0;
  h.renderer.render({ browDownLeft: .2 }, {}, .010);
  assert.equal(h.renderer.frames.leftBrow, "downSoft");
  assert.equal(h.drawings().length, 6);
  const blends = h.scratchDrawings();
  assert.equal(blends.length, 2);
  assert.ok(blends.every(({ src }) => src.endsWith("brows.png")));
  assert.equal(blends[1].composite, "lighter");
  assert.ok(Math.abs(blends[0].alpha + blends[1].alpha - 1) < 1e-12);
  assert.ok(h.drawings().every(({ alpha }) => alpha === 1));
  assert.deepEqual(blends[0].args.slice(-4), [0, 0, 20, 8]);
  h.calls.length = 0;
  h.renderer.render({ browDownLeft: .2 }, {}, .024);
  assert.equal(h.scratchDrawings().length, 2, "still blending at 34 ms");
  h.calls.length = 0;
  h.renderer.render({ browDownLeft: .2 }, {}, .002);
  assert.equal(h.scratchDrawings().length, 0, "settled by 36 ms");
  h.calls.length = 0;
  h.renderer.render({ browDownLeft: .23 }, {}, .016);
  assert.equal(h.calls.length, 0);
  assert.equal(h.canvases.length, 2);
  h.renderer.dispose();
});

test("brow category changes, skipped stages, zero dt and pose changes never leave a ghost frame", async () => {
  const h = harness(), manifest = browFixture();
  manifest.poses = [{ id: "turned", yaw: 1, pitch: 0, base: "./assets/turned.png" }];
  await h.renderer.load(manifest);
  h.renderer.render();
  h.renderer.render({ browInnerUp: .2 }, {}, .010);
  h.calls.length = 0;
  h.renderer.render({ browInnerUp: .2 }, {}, 0);
  assert.equal(h.scratchDrawings().length, 0);
  h.calls.length = 0;
  h.renderer.render({ browDownLeft: .2 }, {}, .010);
  assert.ok(h.scratchDrawings().every(({ args }) => args[0] !== manifest.atlases.brows.frames.downSoft[0]), "upSoft to downSoft is not an adjacent-frame blend");
  h.renderer.render(); h.calls.length = 0;
  h.renderer.render({ browDownLeft: 1 }, {}, .010);
  assert.equal(h.scratchDrawings().length, 0, "neutral to strong pressure skips immediately");
  h.renderer.render();
  h.renderer.render({ browDownLeft: .2 }, {}, .010); h.calls.length = 0;
  h.renderer.render({ browDownLeft: .2 }, {}, .010, { yaw: 1 });
  assert.equal(h.scratchDrawings().length, 0);
  assert.equal(h.drawings()[0].src, "./assets/turned.png");
  h.renderer.dispose();
});

test("both brows share the existing eye/mouth buffer without per-frame canvases or legacy brow fades", async () => {
  const h = harness(), manifest = browFixture();
  manifest.layers.rightBrow.dest[2] = 32;
  await h.renderer.load(manifest); h.renderer.render();
  for (let index = 0; index < 20; index++) {
    const amount = index % 2 ? 0 : .2;
    h.renderer.render({ browDownLeft: amount, browOuterUpRight: amount, eyeBlinkLeft: amount }, {}, .016);
    h.renderer.render({ browDownLeft: amount, browOuterUpRight: amount, eyeBlinkLeft: amount }, {}, .040);
  }
  assert.equal(h.canvases.length, 2);
  assert.deepEqual([h.canvases[1].width, h.canvases[1].height], [32, 15]);
  await h.renderer.load(fixture()); h.renderer.render(); h.calls.length = 0;
  h.renderer.render({ browInnerUp: 1 }, {}, .010);
  assert.equal(h.scratchDrawings().length, 0, "old five-state brow packs retain discrete behavior");
  h.renderer.dispose();
});

test("omitted/invalid dt does not leave an eye crossfade suspended", async () => {
  const h = harness(); await h.renderer.load(fixture());
  h.renderer.render({}, {}, .016);
  h.renderer.render({ eyeBlinkLeft: .25 }, {}, .010);
  h.calls.length = 0;
  h.renderer.render({ eyeBlinkLeft: .25 }, {}, NaN);
  assert.equal(h.drawings().length, 6);
  assert.ok(h.drawings().every(({ alpha }) => alpha === 1));
  h.renderer.dispose();
});

test("static clipping is applied in canvas coordinates before mirroring the sprite", async () => {
  const h = harness(), manifest = fixture();
  manifest.layers.rightEye.clip = [[25, 30], [45, 30], [45, 45]];
  await h.renderer.load(manifest); h.renderer.render();
  const clip = h.calls.findIndex(({ op }) => op === "clip");
  assert.ok(clip >= 0);
  assert.equal(h.calls[clip + 1].op, "translate");
  assert.deepEqual(h.calls[clip + 1].args, [45, 30]);
  assert.equal(h.calls[clip + 2].op, "scale");
  assert.deepEqual(h.calls.find(({ op }) => op === "moveTo").args, [25, 30]);
  h.renderer.dispose();
});

test("render and repeated same-manifest load reuse decoded images", async () => {
  const h = harness(); await h.renderer.load(fixture());
  for (let index = 0; index < 100; index++) h.renderer.render({ jawOpen: (index % 10) / 10 }, {}, .016);
  assert.equal(h.images.length, 4);
  await h.renderer.load(fixture());
  assert.equal(h.images.length, 4);
  const frames = h.renderer.frames; frames.mouth = "invalid";
  assert.notEqual(h.renderer.frames.mouth, "invalid");
  h.renderer.dispose();
});

test("load checks decoded dimensions and actual atlas frame bounds", async () => {
  for (const [dimensions, error] of [
    [{ "./assets/eyes.png": [10, 10] }, /关键帧超出/],
    [{ "./assets/base.png": [0, 100] }, /尺寸无效/],
    [{ "./assets/base.png": [100000, 100000] }, /过大/],
  ]) {
    const h = harness({ dimensions });
    await assert.rejects(h.renderer.load(fixture()), error);
    assert.equal(h.renderer.loaded, false);
    assert.ok(h.images.every((image) => image.onload === null && image.onerror === null));
    h.renderer.dispose();
  }
});

test("failed replacement keeps the previous complete character usable", async () => {
  const h = harness({ fail: new Set(["./assets/broken.png"]) });
  await h.renderer.load(fixture());
  const original = h.renderer.baseImage;
  const next = fixture(); next.base = "./assets/broken.png";
  await assert.rejects(h.renderer.load(next), /载入失败/);
  assert.equal(h.renderer.loaded, true);
  assert.equal(h.renderer.baseImage, original);
  assert.equal(h.renderer.render(), h.canvas);
  h.renderer.dispose();
});

test("already-aborted load performs no image allocation", async () => {
  const h = harness(), controller = new AbortController(); controller.abort();
  await assert.rejects(h.renderer.load(fixture(), { signal: controller.signal }), { name: "AbortError" });
  assert.equal(h.images.length, 0);
  h.renderer.dispose();
});

test("external abort removes image handlers and cancels pending sources", async () => {
  const h = harness({ auto: false }), controller = new AbortController();
  const pending = h.renderer.load(fixture(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.renderer.loaded, false);
  assert.ok(h.images.every((image) => image.removed && image.onload === null && image.onerror === null));
  h.renderer.dispose();
});

test("hanging images time out and release all handlers", async () => {
  const h = harness({ auto: false, timeoutMs: 5 });
  await assert.rejects(h.renderer.load(fixture()), /超时/);
  assert.equal(h.renderer.loaded, false);
  assert.ok(h.images.every((image) => image.removed && image.onload === null && image.onerror === null));
  h.renderer.dispose();
});

test("a newer load cancels the previous load and prevents stale commits", async () => {
  const h = harness({ auto: false });
  const first = assert.rejects(h.renderer.load(fixture()), { name: "AbortError" });
  const next = fixture(); next.base = "./assets/new-base.png";
  const second = h.renderer.load(next);
  h.finish(4);
  await Promise.all([first, second]);
  assert.equal(h.renderer.baseImage.src, next.base);
  assert.ok(h.images.slice(0, 4).every((image) => image.removed));
  h.renderer.dispose();
});

test("invalid replacement does not cancel an already loading valid manifest", async () => {
  const h = harness({ auto: false }), first = h.renderer.load(fixture());
  const invalid = fixture(); invalid.width = -1;
  await assert.rejects(h.renderer.load(invalid), /尺寸/);
  h.finish(); await first;
  assert.equal(h.renderer.loaded, true);
  h.renderer.dispose();
});

test("source setter errors still clean up image handlers", async () => {
  const h = harness({ throwSrc: true });
  await assert.rejects(h.renderer.load(fixture()), /src setter failed/);
  assert.ok(h.images.every((image) => image.onload === null && image.onerror === null));
  h.renderer.dispose();
});

test("dispose is idempotent and aborts pending load without future drawing", async () => {
  const h = harness({ auto: false });
  const pending = h.renderer.load(fixture());
  h.renderer.dispose(); h.renderer.dispose();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.renderer.loaded, false);
  assert.equal(h.renderer.baseImage, null);
  assert.equal(h.renderer.render({ jawOpen: 1 }), null);
  assert.equal(h.canvas.width, 1);
  assert.equal(h.canvas.height, 1);
  assert.equal(h.drawings().length, 0);
  await assert.rejects(h.renderer.load(fixture()), /已销毁/);
});

test("missing canvas context or image loader fails clearly without hidden fallback", async () => {
  const noCanvas = new PaintedAvatar({ createCanvas: () => null });
  await assert.rejects(noCanvas.load(fixture()), /不支持/);
  const noImage = new PaintedAvatar({ createCanvas: () => ({ getContext: () => ({}) }), createImage: () => null });
  await assert.rejects(noImage.load(fixture()), /无法加载/);
  noCanvas.dispose(); noImage.dispose();
});

test("extended blink sequence exposes every one of eleven actual drawings independently", () => {
  const { sequences } = expandedFixture();
  for (let index = 0; index <= 10; index++) {
    const frames = selectPaintedFrames({ eyeBlinkLeft: index / 10 }, {}, {}, sequences);
    assert.equal(frames.leftEye, sequences.eyes[index]);
    assert.equal(frames.rightEye, "open");
  }
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: 1 }, { blink: .85 }, { leftEye: "blink80" }, sequences).leftEye, "closed");
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: 1 }, { blink: 0 }, {}, sequences).leftEye, "open");
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: 1, mouthSmileLeft: 1 }, {}, {}, sequences).leftEye, "happyClosed");
});

test("extended sequence hysteresis prevents adjacent-state chatter without delaying large jumps", () => {
  const { sequences } = expandedFixture();
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: .16 }, {}, { leftEye: "blink10" }, sequences).leftEye, "blink10");
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: .18 }, {}, { leftEye: "blink10" }, sequences).leftEye, "blink20");
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: .14 }, {}, { leftEye: "blink20" }, sequences).leftEye, "blink20");
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: .12 }, {}, { leftEye: "blink20" }, sequences).leftEye, "blink10");
  assert.equal(selectPaintedFrames({ eyeBlinkLeft: 1 }, {}, { leftEye: "open" }, sequences).leftEye, "closed");
});

test("all six jaw and three pucker/press strength drawings are reachable", () => {
  const { sequences } = expandedFixture();
  for (let index = 0; index < sequences.jaw.length; index++) {
    assert.equal(selectPaintedFrames({ jawOpen: index / 5 }, {}, {}, sequences).mouth, sequences.jaw[index]);
  }
  for (const [channel, name] of [["mouthPucker", "pucker"], ["mouthPressLeft", "press"]]) {
    for (const [amount, index] of [[.25, 0], [.5, 1], [1, 2]]) assert.equal(selectPaintedFrames({ [channel]: amount }, {}, {}, sequences).mouth, sequences[name][index]);
  }
  assert.equal(selectPaintedFrames({ mouthFunnel: .25 }, {}, {}, sequences).mouth, "funnelSoft");
  assert.equal(selectPaintedFrames({ mouthFunnel: 1 }, {}, {}, sequences).mouth, "funnel");
  assert.deepEqual(selectPaintedFrames({}, {}, {}, sequences), neutral);
});

test("left/right pucker chooses distinct drawings using anatomical direction and both strengths", () => {
  const { sequences } = expandedFixture();
  for (const [channel, name] of [["mouthLeft", "puckerLeft"], ["mouthRight", "puckerRight"]]) {
    for (const [amount, index] of [[.3, 0], [.5, 1], [1, 2]]) {
      assert.equal(selectPaintedFrames({ mouthPucker: 1, [channel]: amount }, {}, {}, sequences).mouth, sequences[name][index]);
      assert.equal(selectPaintedFrames({ mouthPucker: amount, [channel]: 1 }, {}, {}, sequences).mouth, sequences[name][index]);
    }
  }
  assert.equal(selectPaintedFrames({ mouthPucker: 1, mouthLeft: 1, mouthRight: 1 }, {}, {}, sequences).mouth, "pucker");
  for (const name of ["mouthLeft", "mouthRight"]) assert.equal(selectPaintedFrames({ [name]: 1 }, {}, {}, sequences).mouth, "closed", "no pucker is fabricated without its channel");
  assert.equal(selectPaintedFrames({ mouthPucker: .5, mouthLeft: .2 }, {}, { mouth: "puckerLeftMid" }, sequences).mouth, "puckerLeftSoft");
  assert.equal(selectPaintedFrames({ mouthPucker: .5, mouthLeft: .1 }, {}, { mouth: "puckerLeftSoft" }, sequences).mouth, "puckerMid");
});

test("extended mouth priorities keep press/closure above directional pucker and funnel", () => {
  const { sequences } = expandedFixture();
  const channels = { jawOpen: 1, mouthPucker: 1, mouthLeft: 1, mouthFunnel: 1, mouthClose: 1, mouthPressRight: 1 };
  assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, "press");
  delete channels.mouthPressRight; assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, "closed");
  delete channels.mouthClose; assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, "puckerLeft");
  delete channels.mouthPucker; assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, "funnel");
});

test("independent shift sequences preserve anatomical sign, strength, and neutral cancellation", () => {
  const { sequences } = expandedFixture({ shifts: true });
  for (const name of ["mouthLeft", "mouthRight"]) {
    for (const [amount, index] of [[.3, 0], [.5, 1], [1, 2]]) {
      assert.equal(selectPaintedFrames({ [name]: amount }, {}, {}, sequences).mouth, sequences[name][index]);
    }
    const previous = { mouth: sequences[name][2] };
    assert.equal(selectPaintedFrames({}, {}, previous, sequences).mouth, "closed");
    assert.equal(selectPaintedFrames({ mouthLeft: .9, mouthRight: .9 }, {}, previous, sequences).mouth, "closed");
    assert.equal(selectPaintedFrames({ [name]: 1 }, { expression: 0 }, previous, sequences).mouth, "closed");
  }
  assert.equal(selectPaintedFrames({ mouthLeft: .8, mouthRight: .5 }, {}, {}, sequences).mouth, "shiftLeftSoft");
  assert.equal(selectPaintedFrames({ mouthLeft: .5, mouthRight: .8 }, {}, {}, sequences).mouth, "shiftRightSoft");
  assert.equal(selectPaintedFrames({ mouthLeft: .2 }, {}, { mouth: "shiftLeftSoft" }, sequences).mouth, "shiftLeftSoft");
  assert.equal(selectPaintedFrames({ mouthLeft: .14 }, {}, { mouth: "shiftLeftSoft" }, sequences).mouth, "closed");
  assert.equal(selectPaintedFrames({ mouthRight: 1 }, {}, { mouth: "shiftLeft" }, sequences).mouth, "shiftRight");
});

test("pure shifts require explicit separate sequences; absent art preserves the remaining mouth inputs", () => {
  const { sequences } = expandedFixture({ shifts: true });
  delete sequences.mouthRight;
  assert.equal(selectPaintedFrames({ mouthLeft: 1 }, {}, {}, sequences).mouth, "shiftLeft");
  assert.equal(selectPaintedFrames({ mouthRight: 1, jawOpen: 1 }, {}, { mouth: "shiftLeft" }, sequences).mouth, "openWide");
  assert.equal(selectPaintedFrames({ mouthRight: 1, mouthSmileLeft: 1 }, {}, {}, sequences).mouth, "smileClosed");
  assert.equal(selectPaintedFrames({ mouthRight: 1, mouthFrownRight: 1 }, {}, {}, sequences).mouth, "frownClosed");
  for (const name of ["mouthLeft", "mouthRight"]) {
    const aliased = { ...sequences, [name]: sequences.puckerLeft };
    assert.equal(selectPaintedFrames({ [name]: 1 }, {}, {}, aliased).mouth, "closed");
    assert.equal(selectPaintedFrames({ [name]: 1 }, {}, {}, { [name]: ["side"] }).mouth, "closed");
  }
});

test("independent shifts stay below press, closure, pucker and funnel, above emotion and jaw", () => {
  const { sequences } = expandedFixture({ shifts: true });
  for (const [name, pucker, shift] of [["mouthLeft", "puckerLeft", "shiftLeft"], ["mouthRight", "puckerRight", "shiftRight"]]) {
    const channels = { [name]: 1, mouthPressLeft: 1, mouthClose: 1, mouthPucker: 1, mouthFunnel: 1, mouthSmileLeft: 1, jawOpen: 1 };
    assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, "press");
    delete channels.mouthPressLeft; assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, "closed");
    delete channels.mouthClose; assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, pucker);
    delete channels.mouthPucker; assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, "funnel");
    delete channels.mouthFunnel; assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, shift);
    delete channels[name]; assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, "smileOpen");
    delete channels.mouthSmileLeft; assert.equal(selectPaintedFrames(channels, {}, {}, sequences).mouth, "openWide");
  }
  assert.equal(selectPaintedFrames({ mouthPucker: 1, mouthLeft: 1, mouthRight: 1 }, {}, {}, sequences).mouth, "pucker");
});

test("shift capability requires independent source rectangles in every pose and rejects pucker aliases", () => {
  const manifest = expandedFixture({ shifts: true, poses: true });
  const normalized = validatePaintedManifest(manifest);
  for (const name of ["mouthLeft", "mouthRight"]) {
    assert.equal(PAINTED_CHANNEL_SUPPORT[name], "unsupported");
    assert.equal(paintedChannelSupport(fixture())[name], "unsupported");
    assert.equal(paintedChannelSupport(expandedFixture())[name], "unsupported");
    assert.equal(paintedChannelSupport(normalized)[name], "frame");
  }
  delete manifest.sequences.mouthRight;
  assert.equal(paintedChannelSupport(validatePaintedManifest(manifest)).mouthRight, "unsupported");
  normalized.sequences.mouthLeft[0] = "changed";
  assert.equal(manifest.sequences.mouthLeft[0], "shiftLeftSoft");
  for (const mutate of [
    (m) => m.sequences.mouthLeft = m.sequences.puckerLeft,
    (m) => m.sequences.mouthLeft = m.sequences.mouthRight,
    (m) => m.atlases.mouth.frames.shiftLeftSoft = [...m.atlases.mouth.frames.puckerLeftSoft],
    (m) => m.atlases.mouth.frames.shiftLeftSoft = [...m.atlases.mouth.frames.shiftRightSoft],
    (m) => m.atlases.mouthAngle.frames.shiftLeftSoft = [...m.atlases.mouthAngle.frames.puckerLeftSoft],
    (m) => delete m.atlases.mouthAngle.frames.shiftLeftSoft,
  ]) {
    const invalid = expandedFixture({ shifts: true, poses: true }); mutate(invalid);
    assert.equal(paintedChannelSupport(invalid).mouthLeft, "unsupported");
    assert.throws(() => validatePaintedManifest(invalid), /独立移嘴|缺少关键帧/);
  }
});

test("renderer draws different real sources for pure left/right and clears capability on legacy reload", async () => {
  const manifest = expandedFixture({ shifts: true }), h = harness();
  await h.renderer.load(manifest);
  for (const [name, frame] of [["mouthLeft", "shiftLeft"], ["mouthRight", "shiftRight"]]) {
    h.calls.length = 0;
    h.renderer.render({ [name]: 1 });
    assert.equal(h.renderer.channelSupport[name], "frame");
    assert.equal(h.renderer.frames.mouth, frame);
    assert.deepEqual(h.drawings().find(({ src }) => src === "./assets/mouth.png").args.slice(0, 4), manifest.atlases.mouth.frames[frame]);
  }
  await h.renderer.load(expandedFixture());
  for (const name of ["mouthLeft", "mouthRight"]) {
    assert.equal(h.renderer.channelSupport[name], "unsupported");
    h.renderer.render({ [name]: 1, mouthPucker: 1 });
    assert.equal(h.renderer.frames.mouth, name === "mouthLeft" ? "puckerLeft" : "puckerRight");
    h.renderer.render({ [name]: 1, jawOpen: 1 });
    assert.equal(h.renderer.frames.mouth, "openWide");
  }
  h.renderer.dispose();
});

test("manifest copies additional frames/sequences and static pose overrides without aliasing", () => {
  const input = expandedFixture({ poses: true });
  input.layers.leftEye.clip = [[55, 30], [75, 30], [75, 45]];
  const next = validatePaintedManifest(input), profile = next.poses.find(({ id }) => id === "left3");
  assert.equal(profile.layers.leftEye.atlas, "eyesAngle");
  assert.equal(profile.layers.leftEye.clip, undefined);
  assert.equal(profile.layers.rightEye.visible, false);
  assert.deepEqual(profile.layers.mouth.dest, [54, 58, 15, 15]);
  assert.equal(next.poses.find(({ id }) => id === "up").layers.leftEye.clip.length, 3);
  next.sequences.eyes[1] = "changed";
  profile.layers.mouth.dest[0] = 0;
  next.atlases.eyes.frames.blink10[0] = 999;
  assert.equal(input.sequences.eyes[1], "blink10");
  assert.equal(input.poses[3].layers.mouth.dest[0], 54);
  assert.notEqual(input.atlases.eyes.frames.blink10[0], 999);
});

test("manifest requires every extra sequence key in each pose-specific atlas", () => {
  const missing = expandedFixture({ poses: true }); delete missing.atlases.eyesAngle.frames.blink90;
  assert.throws(() => validatePaintedManifest(missing), /blink90.*缺少/);
  for (const change of [
    (m) => m.sequences.eyes = [], (m) => m.sequences.jaw = ["closed"],
    (m) => m.sequences.press = ["press", "press"], (m) => m.sequences.unknown = ["closed"],
    (m) => m.sequences.eyes = Array.from({ length: 33 }, (_, i) => `frame${i}`),
    (m) => m.atlases.eyes.frames["bad/path"] = [0, 0, 1, 1],
    (m) => m.poses[3].layers.mouth.atlas = "missing",
  ]) {
    const manifest = expandedFixture({ poses: true }); change(manifest);
    assert.throws(() => validatePaintedManifest(manifest));
  }
});

test("brow sequence validation requires neutral first and every declared painting in all brow atlases", () => {
  const original = browFixture(), copy = validatePaintedManifest(original);
  copy.sequences.browUp[1] = "different";
  assert.equal(original.sequences.browUp[1], "upSoft");
  for (const mutate of [
    (m) => m.sequences.browUp = ["upSoft", "upMid", "up"],
    (m) => m.sequences.browDown = ["neutral"],
    (m) => m.sequences.browWorried = ["neutral", "worriedSoft", "worriedSoft"],
    (m) => delete m.atlases.brows.frames.outerUpMid,
    (m) => {
      m.atlases.angleBrow = structuredClone(m.atlases.brows);
      delete m.atlases.angleBrow.frames.downSoft;
      m.poses = [{ id: "angle", yaw: 1, pitch: 0, base: "./assets/angle.png", layers: { rightBrow: { atlas: "angleBrow" } } }];
    },
  ]) {
    const manifest = browFixture(); mutate(manifest);
    assert.throws(() => validatePaintedManifest(manifest), /序列|缺少关键帧/);
  }
  const legacy = validatePaintedManifest(fixture());
  assert.equal(Object.keys(legacy.sequences).length, 0);
});

test("manifest rejects malformed, duplicate, remote and excessive pose definitions", () => {
  for (const change of [
    (m) => m.poses = [], (m) => m.poses[1].yaw = 1.1, (m) => m.poses[1].pitch = NaN,
    (m) => m.poses[1].id = "front", (m) => m.poses[1].yaw = 0,
    (m) => m.poses[1].base = "https://example.com/pose.png", (m) => m.poses[1].layers.hair = {},
    (m) => m.poses[1].layers.leftEye = false,
    (m) => m.poses = Array.from({ length: 26 }, (_, i) => ({ id: `pose${i}`, yaw: i / 26, pitch: 0, base: m.base })),
  ]) {
    const manifest = expandedFixture({ poses: true }); change(manifest);
    assert.throws(() => validatePaintedManifest(manifest));
  }
});

test("legacy manifests get an implicit front; pose packs can inherit it safely", () => {
  assert.deepEqual(validatePaintedManifest(fixture()).poses.map(({ id, yaw, pitch }) => ({ id, yaw, pitch })), [{ id: "front", yaw: 0, pitch: 0 }]);
  const manifest = fixture(); manifest.poses = [{ id: "left", yaw: 1, pitch: 0, base: "./assets/left.png" }];
  const validated = validatePaintedManifest(manifest);
  assert.equal(validated.poses[0].id, "front");
  assert.equal(validated.poses[1].layers.mouth.visible, true);
});

test("all thirteen actually drawn head poses are individually reachable without synthesis", () => {
  const { poses } = validatePaintedManifest(expandedFixture({ poses: true }));
  for (const expected of poses) assert.equal(selectPaintedPose(poses, expected, "front").id, expected.id);
  assert.equal(selectPaintedPose(poses, { yaw: 999, pitch: 0 }).id, "left3");
  assert.equal(selectPaintedPose(poses, { yaw: NaN, pitch: Infinity }).id, "front");
  assert.equal(selectPaintedPose(poses, null).id, "front");
  assert.equal(selectPaintedPose([], {}), null);
});

test("pose distance hysteresis suppresses boundary chatter and returns exact neutral", () => {
  const { poses } = validatePaintedManifest(expandedFixture({ poses: true }));
  assert.equal(selectPaintedPose(poses, { yaw: .18 }, "front").id, "front");
  assert.equal(selectPaintedPose(poses, { yaw: .23 }, "front").id, "left1");
  assert.equal(selectPaintedPose(poses, { yaw: .14 }, "left1").id, "left1");
  assert.equal(selectPaintedPose(poses, { yaw: .10 }, "left1").id, "front");
  assert.equal(selectPaintedPose(poses, { yaw: 0, pitch: 0 }, "left3").id, "front");
  assert.equal(selectPaintedPose(poses, { yaw: 1, pitch: -1 }, "front").id, "downLeft");
  assert.equal(selectPaintedPose(poses, { yaw: -.9, pitch: 1 }, "front").id, "upRight");
});

test("pose selection is part of the composition cache and uses its real base image", async () => {
  const h = harness(); await h.renderer.load(expandedFixture({ poses: true }));
  assert.equal(h.renderer.poseId, "front");
  assert.deepEqual(h.renderer.pose, { id: "front", yaw: 0, pitch: 0 });
  h.renderer.render({}, {}, .016); h.calls.length = 0;
  h.renderer.render({}, {}, .016, { yaw: 1 });
  assert.equal(h.renderer.poseId, "left3");
  assert.equal(h.drawings()[0].src, "./assets/left3.png");
  assert.equal(h.drawings().length, 4, "profile hides far eye and brow");
  assert.ok(h.drawings().some(({ src }) => src === "./assets/eyes-angle.png"));
  assert.ok(h.drawings().some(({ src }) => src === "./assets/mouth-angle.png"));
  assert.deepEqual(h.drawings().find(({ src }) => src.endsWith("mouth-angle.png")).args.slice(-4), [54, 58, 15, 15]);
  assert.ok(h.drawings().every(({ alpha }) => alpha === 1));
  assert.equal(h.scratchDrawings().length, 0, "no full-face or pose transition crossfade");
  h.calls.length = 0;
  h.renderer.render({}, {}, .016, { yaw: .99 });
  assert.equal(h.calls.length, 0, "same selected pose reuses the canvas");
  h.renderer.render({}, {}, .016, {});
  assert.equal(h.drawings()[0].src, "./assets/base.png");
  assert.equal(h.drawings().length, 6, "hidden profile layers return on front");
  const pose = h.renderer.pose; pose.yaw = 1;
  assert.equal(h.renderer.pose.yaw, 0);
  h.renderer.dispose();
  assert.equal(h.renderer.poseId, null); assert.equal(h.renderer.pose, null);
});

test("changing pose clears active feature blends so no previous-perspective pixels remain", async () => {
  const h = harness(); await h.renderer.load(expandedFixture({ poses: true }));
  h.renderer.render({}, {}, .010);
  h.renderer.render({ eyeBlinkLeft: .1, jawOpen: .2 }, {}, .010);
  assert.ok(h.scratchDrawings().length > 0);
  h.calls.length = 0;
  h.renderer.render({ eyeBlinkLeft: .1, jawOpen: .2 }, {}, .010, { yaw: 1 });
  assert.equal(h.scratchDrawings().length, 0);
  assert.equal(h.drawings()[0].src, "./assets/left3.png");
  assert.ok(h.drawings().every(({ alpha }) => alpha === 1));
  h.renderer.dispose();
});

test("adjacent mouth stages use one premultiplied local blend for at most 40 ms", async () => {
  const h = harness(); await h.renderer.load(expandedFixture());
  h.renderer.render({}, {}, .010); h.calls.length = 0;
  h.renderer.render({ jawOpen: .2 }, {}, .020);
  assert.equal(h.renderer.frames.mouth, "jaw10");
  assert.equal(h.scratchDrawings().length, 2);
  assert.ok(h.scratchDrawings().every(({ alpha, src }) => alpha === .5 && src.endsWith("mouth.png")));
  assert.equal(h.scratchDrawings()[1].composite, "lighter");
  assert.equal(h.drawings().length, 6);
  h.calls.length = 0;
  h.renderer.render({ jawOpen: .2 }, {}, .020);
  assert.equal(h.scratchDrawings().length, 0);
  assert.equal(h.drawings().length, 6);
  h.calls.length = 0;
  h.renderer.render({ jawOpen: .2 }, {}, .016);
  assert.equal(h.calls.length, 0);
  h.renderer.dispose();
});

test("cross-family mouth changes and large jumps never blend unrelated shapes", async () => {
  const h = harness(); await h.renderer.load(expandedFixture());
  h.renderer.render({}, {}, .016); h.calls.length = 0;
  h.renderer.render({ jawOpen: 1 }, {}, .016);
  assert.equal(h.scratchDrawings().length, 0);
  h.calls.length = 0;
  h.renderer.render({ mouthPucker: 1, mouthLeft: 1 }, {}, .016);
  assert.equal(h.renderer.frames.mouth, "puckerLeft");
  assert.equal(h.scratchDrawings().length, 0);
  h.calls.length = 0;
  h.renderer.render({ mouthPucker: 1, mouthRight: 1 }, {}, .016);
  assert.equal(h.renderer.frames.mouth, "puckerRight");
  assert.equal(h.scratchDrawings().length, 0);
  h.renderer.dispose();
});

test("extra pose images load once and aggregate decoded pixels are bounded", async () => {
  const h = harness(), manifest = expandedFixture({ poses: true });
  await h.renderer.load(manifest);
  assert.equal(h.images.length, 18, "base plus 12 extra poses and 5 atlases");
  for (const pose of manifest.poses) h.renderer.render({}, {}, .016, pose);
  assert.equal(h.images.length, 18);
  await h.renderer.load(manifest); assert.equal(h.images.length, 18);
  h.renderer.dispose();
  const oversized = harness({ dimensions: {
    "./assets/base.png": [8192, 8192], "./assets/eyes.png": [512, 512],
  } });
  await assert.rejects(oversized.renderer.load(fixture()), /总尺寸过大/);
  assert.equal(oversized.renderer.loaded, false);
  oversized.renderer.dispose();
});

test("multi-pose loading has at most four pending decodes and dispose cancels the queue", async () => {
  const h = harness({ auto: false }), manifest = expandedFixture({ poses: true });
  const pending = h.renderer.load(manifest);
  assert.equal(h.images.length, 4);
  h.finish();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(h.images.length, 8);
  assert.equal(h.images.filter((image) => image.onload !== null).length, 4);
  h.renderer.dispose();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.images.length, 8, "queued poses do not start after cancellation");
  assert.ok(h.images.every((image) => image.onload === null && image.onerror === null));
});

test("flipFrames validates existing safe frame keys and is copied independently", () => {
  const manifest = expandedFixture(); manifest.atlases.mouth.flipFrames = ["puckerRight"];
  const next = validatePaintedManifest(manifest);
  assert.deepEqual(next.atlases.mouth.flipFrames, ["puckerRight"]);
  next.atlases.mouth.flipFrames.push("closed");
  assert.deepEqual(manifest.atlases.mouth.flipFrames, ["puckerRight"]);
  for (const invalid of ["puckerRight", ["notExisting"], ["puckerRight", "puckerRight"], ["__proto__"], ["../pucker"]]) {
    const input = expandedFixture(); input.atlases.mouth.flipFrames = invalid;
    assert.throws(() => validatePaintedManifest(input), /镜像关键帧无效/);
  }
});

test("per-frame mirror composes with the layer mirror as XOR and preserves placement", async () => {
  for (const layerFlip of [false, true]) for (const frameFlip of [false, true]) {
    const h = harness(), manifest = expandedFixture();
    manifest.layers.mouth.flipX = layerFlip;
    manifest.atlases.mouth.frames.puckerRight = [...manifest.atlases.mouth.frames.puckerLeft];
    manifest.atlases.mouth.flipFrames = frameFlip ? ["puckerRight"] : [];
    await h.renderer.load(manifest);
    h.renderer.render({ mouthPucker: 1, mouthRight: 1 });
    const mouth = h.drawings().find(({ src }) => src === "./assets/mouth.png");
    assert.equal(mouth.scaleX, layerFlip !== frameFlip ? -1 : 1);
    const [dx, , width] = mouth.args.slice(-4);
    const x1 = mouth.translateX + mouth.scaleX * dx, x2 = x1 + mouth.scaleX * width;
    assert.deepEqual([Math.min(x1, x2), Math.max(x1, x2)], [40, 60]);
    assert.deepEqual(mouth.args.slice(0, 4), manifest.atlases.mouth.frames.puckerLeft);
    h.renderer.dispose();
  }
});

test("adjacent mouth blending mirrors each source separately before premultiplied addition", async () => {
  for (const layerFlip of [false, true]) {
    const h = harness(), manifest = expandedFixture();
    manifest.layers.mouth.flipX = layerFlip;
    manifest.atlases.mouth.frames.puckerRight = [...manifest.atlases.mouth.frames.puckerLeft];
    manifest.atlases.mouth.flipFrames = ["puckerRight"];
    await h.renderer.load(manifest);
    h.renderer.render({ mouthPucker: .5, mouthRight: .5 }, {}, .020);
    assert.equal(h.renderer.frames.mouth, "puckerRightMid");
    h.calls.length = 0;
    h.renderer.render({ mouthPucker: 1, mouthRight: 1 }, {}, .020);
    const sources = h.scratchDrawings();
    assert.equal(sources.length, 2);
    assert.equal(sources[0].scaleX, 1);
    assert.equal(sources[1].scaleX, -1);
    assert.equal(sources[1].translateX, 20);
    assert.equal(sources[1].composite, "lighter");
    const composite = h.drawings().find(({ src }) => src === "canvas:1");
    assert.equal(composite.scaleX, layerFlip ? -1 : 1);
    assert.equal(composite.alpha, 1);
    h.calls.length = 0;
    h.renderer.render({ mouthPucker: .5, mouthRight: .5 }, {}, .020);
    assert.equal(h.scratchDrawings()[0].scaleX, -1, "reverse transition retains the outgoing frame's mirror");
    assert.equal(h.scratchDrawings()[1].scaleX, 1);
    h.renderer.dispose();
  }
});

test("gaze is neutral without real signals and independent for each anatomical eye", () => {
  const zero = { leftEye: { x: 0, y: 0 }, rightEye: { x: 0, y: 0 } };
  assert.deepEqual(selectPaintedGaze(), zero);
  assert.deepEqual(selectPaintedGaze(null, null, null), zero);
  assert.deepEqual(selectPaintedGaze({ eyeLookUpLeft: NaN, eyeLookOutRight: Infinity }), zero);
  assert.deepEqual(selectPaintedGaze({ eyeLookUpLeft: 1, eyeLookDownRight: .5, eyeLookInLeft: .8, eyeLookOutRight: .6 }), {
    leftEye: { x: -.8, y: -1 }, rightEye: { x: -.6, y: .5 },
  });
  assert.deepEqual(selectPaintedGaze({ eyeLookOutLeft: 1, eyeLookInRight: 1 }), {
    leftEye: { x: 1, y: 0 }, rightEye: { x: 1, y: 0 },
  });
  assert.deepEqual(selectPaintedGaze({ eyeLookUpLeft: 1 }, { gaze: 0 }), zero);
});

test("static gaze bias is additive, bounded and cancellable by actual input", () => {
  const layers = { leftEye: { gazeBias: [.3, .5] }, rightEye: { gazeBias: [-.2, .4] } };
  assert.deepEqual(selectPaintedGaze({}, {}, layers), { leftEye: { x: .3, y: .5 }, rightEye: { x: -.2, y: .4 } });
  assert.deepEqual(selectPaintedGaze({ eyeLookInLeft: .3, eyeLookUpLeft: .5, eyeLookInRight: .2, eyeLookUpRight: .4 }, {}, layers), {
    leftEye: { x: 0, y: 0 }, rightEye: { x: 0, y: 0 },
  });
  assert.equal(selectPaintedGaze({ eyeLookDownLeft: 100 }, { gaze: 1.5 }, layers).leftEye.y, 1);
  assert.equal(selectPaintedGaze({ eyeLookUpLeft: -1 }, {}, layers).leftEye.y, .5);
});

test("gaze support metadata reflects actual layered assets, never baked-in legacy eyes", async () => {
  assert.equal(PAINTED_CHANNEL_SUPPORT.eyeLookUpLeft, "unsupported");
  assert.equal(paintedChannelSupport(fixture()).eyeLookUpLeft, "unsupported");
  const manifest = gazeFixture(), support = paintedChannelSupport(manifest);
  for (const side of ["Left", "Right"]) for (const direction of ["Up", "Down", "In", "Out"]) assert.equal(support[`eyeLook${direction}${side}`], "approximate");
  assert.equal(support.tongueOut, "unsupported");
  assert.ok(Object.isFrozen(support));
  const h = harness(); await h.renderer.load(manifest);
  assert.equal(h.renderer.channelSupport.eyeLookUpRight, "approximate");
  await h.renderer.load(fixture());
  assert.equal(h.renderer.channelSupport.eyeLookUpRight, "unsupported");
  h.renderer.dispose();
});

test("layered eye manifest validates/copies iris, apertures and per-pose biases", () => {
  const manifest = gazeFixture();
  manifest.layers.leftEye.gazeBias = [.2, .4];
  manifest.poses = [{ id: "down", yaw: 0, pitch: -1, base: "./assets/down.png", layers: { leftEye: { gazeBias: [.1, .6] } } }];
  const result = validatePaintedManifest(manifest);
  result.atlases.eyes.gaze.iris[0] = 0;
  result.atlases.eyes.gaze.apertures.open[0][0] = 0;
  result.layers.leftEye.gazeBias[0] = 1;
  assert.equal(manifest.atlases.eyes.gaze.iris[0], .35);
  assert.equal(manifest.atlases.eyes.gaze.apertures.open[0][0], .1);
  assert.equal(manifest.layers.leftEye.gazeBias[0], .2);
  assert.deepEqual(result.poses.find(({ id }) => id === "down").layers.leftEye.gazeBias, [.1, .6]);
});

test("layered eye validation rejects unsafe resources, missing holes and out-of-range data", () => {
  for (const change of [
    (m) => m.atlases.eyes.gaze.src = "https://example.com/iris.png",
    (m) => m.atlases.eyes.gaze.rect = [0, 0, 0, 10],
    (m) => m.atlases.eyes.gaze.iris = [.9, .2, .3, .3],
    (m) => m.atlases.eyes.gaze.iris = [0, -1, .2, .3],
    (m) => m.atlases.eyes.gaze.range = [.6, .1],
    (m) => m.atlases.eyes.gaze.range = [.1, Infinity],
    (m) => delete m.atlases.eyes.gaze.apertures.quarter,
    (m) => m.atlases.eyes.gaze.apertures.open = [[0, 0], [1, 0]],
    (m) => m.atlases.eyes.gaze.apertures.open = [[0, 0], [1, 0], [1.1, 1]],
    (m) => m.atlases.eyes.gaze.apertures.open = [[0, 0], [.5, .5], [1, 1]],
    (m) => m.atlases.eyes.gaze.apertures.unknown = [],
    (m) => m.atlases.eyes.gaze.apertures.closed = m.atlases.eyes.gaze.apertures.open,
    (m) => m.atlases.eyes.gaze.apertures.happyClosed = m.atlases.eyes.gaze.apertures.open,
    (m) => m.layers.leftEye.gazeBias = [.1, 2],
    (m) => m.layers.mouth.gazeBias = [0, 0],
    (m) => m.atlases.mouth.gaze = m.atlases.eyes.gaze,
  ]) {
    const manifest = gazeFixture(); change(manifest);
    assert.throws(() => validatePaintedManifest(manifest));
  }
});

test("gaze draws the original white/lid first then a fixed-size iris inside its exact opening", async () => {
  const h = harness(), manifest = gazeFixture();
  await h.renderer.load(manifest);
  assert.equal(h.images.length, 5, "shared iris image decodes once for both eyes");
  h.renderer.render();
  const draws = h.drawings();
  assert.equal(draws.length, 8);
  assert.equal(draws[1].src, "./assets/eyes.png");
  assert.equal(draws[2].src, "./assets/iris.png");
  assert.equal(draws[1].clips.length, 0);
  assert.deepEqual(draws[2].clips.at(-1), [[2, 3], [18, 3], [18, 12], [2, 12]]);
  assert.deepEqual(draws[2].args, [0, 0, 40, 40, 7, 4.5, 4, 6]);
  assert.equal(h.canvases.length, 1, "direct gaze needs no per-eye canvas");
  h.calls.length = 0;
  h.renderer.render({ eyeLookUpLeft: 1 }, {}, 0);
  const up = h.drawings().filter(({ src }) => src === "./assets/iris.png");
  assert.ok(up[0].args.slice(-4).every((value, index) => Math.abs(value - [7, 3, 4, 6][index]) < 1e-9), "iris moves but its width/height never change");
  assert.deepEqual(up[1].args.slice(-4), [7, 4.5, 4, 6], "other eye stays neutral");
  h.renderer.dispose();
});

test("all four layer/frame mirror XOR combinations preserve WORLD horizontal and vertical gaze", async () => {
  const center = (draw) => {
    const [x, y, w, h] = draw.args.slice(-4);
    return [draw.translateX + draw.scaleX * (x + w / 2), draw.translateY + draw.scaleY * (y + h / 2)];
  };
  for (const layerFlip of [false, true]) for (const frameFlip of [false, true]) {
    const h = harness(), manifest = gazeFixture();
    manifest.layers.leftEye.flipX = layerFlip;
    manifest.atlases.eyes.flipFrames = frameFlip ? ["open"] : [];
    await h.renderer.load(manifest); h.renderer.render();
    const original = center(h.drawings().find(({ src }) => src === "./assets/iris.png"));
    h.calls.length = 0;
    h.renderer.render({ eyeLookOutLeft: 1, eyeLookUpLeft: 1 }, {}, 0);
    const moved = center(h.drawings().find(({ src }) => src === "./assets/iris.png"));
    assert.ok(Math.abs(moved[0] - original[0] - 3) < 1e-9, `${layerFlip}/${frameFlip} horizontal gaze reversed`);
    assert.ok(Math.abs(moved[1] - original[1] + 1.5) < 1e-9, `${layerFlip}/${frameFlip} vertical gaze reversed`);
    h.calls.length = 0;
    h.renderer.render({ eyeLookInLeft: 1, eyeLookDownLeft: 1 }, {}, 0);
    const reversed = center(h.drawings().find(({ src }) => src === "./assets/iris.png"));
    assert.ok(Math.abs(reversed[0] - original[0] + 3) < 1e-9);
    assert.ok(Math.abs(reversed[1] - original[1] - 1.5) < 1e-9);
    h.renderer.dispose();
  }
});

test("closed and happy-closed paintings contain no iris draw at any gaze extreme", async () => {
  const h = harness(); await h.renderer.load(gazeFixture());
  for (const happy of [0, 1]) {
    h.calls.length = 0;
    h.renderer.render({ eyeBlinkLeft: 1, eyeBlinkRight: 1, mouthSmileLeft: happy, mouthSmileRight: happy,
      eyeLookUpLeft: 1, eyeLookDownRight: 1, eyeLookOutLeft: 1, eyeLookInRight: 1 }, {}, 0);
    assert.equal(h.drawings().filter(({ src }) => src === "./assets/iris.png").length, 0);
    assert.equal(h.renderer.frames.leftEye, happy ? "happyClosed" : "closed");
  }
  h.renderer.dispose();
});

test("adjacent blink endpoints clip iris separately before weighted addition", async () => {
  const h = harness(); await h.renderer.load(gazeFixture());
  h.renderer.render(); h.calls.length = 0;
  h.renderer.render({ eyeBlinkLeft: .25, eyeLookUpLeft: .5 }, {}, .015);
  const endpointIris = h.scratchDrawings().filter(({ src }) => src === "./assets/iris.png");
  assert.equal(endpointIris.length, 2);
  assert.deepEqual(endpointIris[0].clips.at(-1), [[2, 3], [18, 3], [18, 12], [2, 12]]);
  assert.deepEqual(endpointIris[1].clips.at(-1), [[2, 5.25], [18, 5.25], [18, 12], [2, 12]]);
  assert.ok(endpointIris.every(({ alpha }) => alpha === 1), "compose each endpoint before weighting");
  const endpointComposites = h.scratchDrawings().filter(({ src }) => src.startsWith("canvas:"));
  assert.equal(endpointComposites.length, 2);
  assert.equal(endpointComposites[0].alpha, .5);
  assert.equal(endpointComposites[1].alpha, .5);
  assert.equal(endpointComposites[1].composite, "lighter");
  assert.ok(h.drawings().every(({ alpha }) => alpha === 1));
  assert.equal(h.canvases.length, 3);
  h.renderer.dispose();
});

test("adjacent gaze endpoint movement also obeys mirror XOR", async () => {
  for (const layerFlip of [false, true]) for (const frameFlip of [false, true]) {
    const h = harness(), manifest = gazeFixture();
    manifest.layers.leftEye.flipX = layerFlip;
    manifest.atlases.eyes.flipFrames = frameFlip ? ["open", "quarter"] : [];
    await h.renderer.load(manifest);
    h.renderer.render({ eyeLookOutLeft: 1 }, {}, 0);
    h.calls.length = 0;
    h.renderer.render({ eyeLookOutLeft: 1, eyeBlinkLeft: .25 }, {}, .015);
    for (const iris of h.scratchDrawings().filter(({ src }) => src === "./assets/iris.png")) {
      const localDx = iris.args.at(-4) - 7;
      const worldDx = localDx * iris.scaleX * (layerFlip ? -1 : 1);
      assert.ok(Math.abs(worldDx - 3) < 1e-9);
      assert.deepEqual(iris.args.slice(-2), [4, 6]);
    }
    h.renderer.dispose();
  }
});

test("gaze smoothing is short, settles exactly, and stable gaze reuses cached composition", async () => {
  const h = harness(); await h.renderer.load(gazeFixture());
  h.renderer.render();
  h.renderer.render({ eyeLookUpLeft: 1 }, {}, .016);
  assert.ok(h.renderer.gaze.leftEye.y < 0 && h.renderer.gaze.leftEye.y > -1);
  for (let i = 0; i < 30; i++) h.renderer.render({ eyeLookUpLeft: 1 }, {}, .016);
  assert.equal(h.renderer.gaze.leftEye.y, -1);
  h.calls.length = 0;
  for (let i = 0; i < 30; i++) h.renderer.render({ eyeLookUpLeft: 1 }, {}, .016);
  assert.equal(h.calls.length, 0);
  h.renderer.render({ eyeLookDownLeft: 1 }, {}, 0);
  assert.equal(h.renderer.gaze.leftEye.y, 1, "dt=0 is deterministic immediate acceptance");
  assert.equal(h.drawings().length, 8);
  h.renderer.dispose();
});

test("legacy eyes ignore gaze channels and preserve the stable-frame cache", async () => {
  const h = harness(); await h.renderer.load(fixture());
  h.renderer.render(); h.calls.length = 0;
  h.renderer.render({ eyeLookDownLeft: 1, eyeLookInRight: 1 }, {}, .016);
  assert.equal(h.calls.length, 0);
  assert.equal(h.canvases.length, 1);
  assert.deepEqual(h.renderer.gaze, { leftEye: { x: 0, y: 0 }, rightEye: { x: 0, y: 0 } });
  h.renderer.dispose();
});

test("pose changes clear gaze blink transitions and immediately apply cancellable static bias", async () => {
  const h = harness(), manifest = gazeFixture();
  manifest.poses = [{ id: "down", yaw: 0, pitch: -1, base: "./assets/down.png", layers: { leftEye: { gazeBias: [0, .4] }, rightEye: { gazeBias: [0, .4] } } }];
  await h.renderer.load(manifest); h.renderer.render();
  h.renderer.render({ eyeBlinkLeft: .25 }, {}, .010);
  h.calls.length = 0;
  h.renderer.render({ eyeBlinkLeft: .25, eyeLookUpLeft: .4 }, {}, .010, { pitch: -1 });
  assert.deepEqual(h.renderer.gaze, { leftEye: { x: 0, y: 0 }, rightEye: { x: 0, y: .4 } });
  assert.equal(h.scratchDrawings().length, 0);
  assert.equal(h.renderer.poseId, "down");
  assert.ok(h.drawings().every(({ alpha }) => alpha === 1));
  h.renderer.dispose();
});

test("gaze image source bounds and aggregate decoded budget are checked", async () => {
  for (const [dimensions, message] of [
    [{ "./assets/iris.png": [20, 20] }, /虹膜源矩形超出/],
    [{ "./assets/iris.png": [8192, 8192] }, /总尺寸过大/],
  ]) {
    const h = harness({ dimensions });
    await assert.rejects(h.renderer.load(gazeFixture()), message);
    assert.equal(h.renderer.loaded, false);
    h.renderer.dispose();
  }
});

test("failed iris load does not replace the previous usable legacy character", async () => {
  const h = harness({ fail: new Set(["./assets/iris.png"]) });
  await h.renderer.load(fixture());
  await assert.rejects(h.renderer.load(gazeFixture()), /iris.png/);
  assert.equal(h.renderer.loaded, true);
  assert.equal(h.renderer.channelSupport.eyeLookUpLeft, "unsupported");
  assert.equal(h.renderer.render(), h.canvas);
  h.renderer.dispose();
});

test("iris loading participates in external abort and handler cleanup", async () => {
  const h = harness({ auto: false }), controller = new AbortController();
  const pending = h.renderer.load(gazeFixture(), { signal: controller.signal });
  assert.ok(h.images.some((image) => image.src === "./assets/iris.png"));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(h.images.every((image) => image.removed && image.onload === null && image.onerror === null));
  h.renderer.dispose();
});

test("repeated independent gaze/blinks allocate at most three canvases and dispose releases them", async () => {
  const h = harness(); await h.renderer.load(gazeFixture());
  h.renderer.render();
  for (let i = 0; i < 90; i++) {
    h.renderer.render({ eyeBlinkLeft: i % 2 ? .25 : .5, eyeBlinkRight: i % 2 ? 0 : .25,
      eyeLookUpLeft: i % 3 / 2, eyeLookDownRight: i % 4 / 3, jawOpen: i % 5 / 4 }, {}, .016);
  }
  assert.equal(h.canvases.length, 3);
  assert.equal(h.images.length, 5);
  await h.renderer.load(gazeFixture());
  assert.equal(h.images.length, 5);
  h.renderer.dispose(); h.renderer.dispose();
  assert.ok(h.canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
  assert.equal(h.renderer.channelSupport.eyeLookUpLeft, "unsupported");
});
