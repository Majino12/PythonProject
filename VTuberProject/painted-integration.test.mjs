import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { FaceEditor } from "./face-editor.js";
import { selectPaintedFrames, selectPaintedPose, validatePaintedManifest } from "./painted-avatar.js";
import { LUNA_PAINTED_MANIFEST, LUNA_PAINTED_RIG } from "./painted-luna.js";

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const galleryHtml = readFileSync(new URL("./painted-gallery.html", import.meta.url), "utf8");
const gallerySource = readFileSync(new URL("./painted-gallery.js", import.meta.url), "utf8");

function pngHeader(asset) {
  const bytes = readFileSync(new URL(asset, import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${asset} must be a PNG`);
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR", `${asset} must start with IHDR`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
  };
}

function pngAlphaSummary(asset) {
  const bytes = readFileSync(new URL(asset, import.meta.url));
  const header = pngHeader(asset);
  assert.deepEqual([header.bitDepth, header.colorType, bytes[28]], [8, 6, 0], `${asset} must be non-interlaced RGBA8`);
  const idat = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    assert.ok(offset + 12 + size <= bytes.length, `${asset} contains a truncated PNG chunk`);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
    if (type === "IEND") break;
  }
  const packed = inflateSync(Buffer.concat(idat));
  const stride = header.width * 4;
  assert.equal(packed.length, (stride + 1) * header.height, `${asset} has an unexpected decoded byte count`);
  let previous = Buffer.alloc(stride), transparent = 0, opaque = 0;
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left), aboveDistance = Math.abs(estimate - above), upperLeftDistance = Math.abs(estimate - upperLeft);
    return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
  };
  for (let row = 0; row < header.height; row += 1) {
    const start = row * (stride + 1), filter = packed[start];
    assert.ok(filter >= 0 && filter <= 4, `${asset} uses an invalid PNG row filter`);
    const current = Buffer.allocUnsafe(stride);
    for (let column = 0; column < stride; column += 1) {
      const raw = packed[start + 1 + column], left = column >= 4 ? current[column - 4] : 0;
      const above = previous[column], upperLeft = column >= 4 ? previous[column - 4] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      current[column] = (raw + predictor) & 255;
    }
    for (let column = 3; column < stride; column += 4) {
      if (current[column] === 0) transparent += 1;
      if (current[column] >= 240) opaque += 1;
    }
    previous = current;
  }
  return { pixels: header.width * header.height, transparent, opaque };
}

test("the bundled Luna manifest matches the real RGBA files and every source frame", () => {
  const normalized = validatePaintedManifest(LUNA_PAINTED_MANIFEST);
  const base = pngHeader(LUNA_PAINTED_MANIFEST.base);
  assert.deepEqual([base.width, base.height], [LUNA_PAINTED_MANIFEST.width, LUNA_PAINTED_MANIFEST.height]);
  assert.deepEqual([base.bitDepth, base.colorType], [8, 6], "the base must retain an alpha channel");

  for (const [atlasName, atlas] of Object.entries(LUNA_PAINTED_MANIFEST.atlases)) {
    const image = pngHeader(atlas.src);
    assert.deepEqual([image.bitDepth, image.colorType], [8, 6], `${atlasName} must be RGBA`);
    for (const [frameName, frame] of Object.entries(atlas.frames)) {
      assert.ok(frame.every(Number.isInteger), `${atlasName}/${frameName} must use pixel-aligned bounds`);
      const [x, y, width, height] = frame;
      assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0, `${atlasName}/${frameName} must be non-empty`);
      assert.ok(x + width <= image.width && y + height <= image.height, `${atlasName}/${frameName} exceeds ${image.width}x${image.height}`);
    }
  }

  const sources = new Set([
    normalized.base,
    ...Object.values(normalized.atlases).map((atlas) => atlas.src),
    ...normalized.poses.map((pose) => pose.base),
  ]);
  let decodedPixels = 0;
  for (const source of sources) {
    const image = pngHeader(source);
    assert.deepEqual([image.bitDepth, image.colorType], [8, 6], `${source} must be an 8-bit RGBA PNG`);
    decodedPixels += image.width * image.height;
  }
  assert.ok(decodedPixels <= 67_108_864, "the bundled images must fit the renderer's aggregate decode budget");
  for (const pose of normalized.poses) {
    assert.equal(selectPaintedPose(normalized.poses, pose)?.id, pose.id, `${pose.id} must be reachable at its declared angle`);
    for (const layer of Object.values(pose.layers)) assert.ok(Object.hasOwn(normalized.atlases, layer.atlas));
  }
});

test("the shipped v0.11 manifest exposes the confirmed finite drawings and intentional strong-right mirror", () => {
  const normalized = validatePaintedManifest(LUNA_PAINTED_MANIFEST);
  assert.equal(normalized.poses.length, 13);
  assert.equal(normalized.sequences.eyes.length, 11, "open through closed are eleven independently painted blink stages");
  for (const atlas of Object.values(normalized.atlases)) {
    if (atlas.frames.open) assert.ok(Object.hasOwn(atlas.frames, "happyClosed"), "each eye atlas must retain the separate happy-closed drawing");
  }
  const mouthStates = new Set([
    ...normalized.sequences.jaw, ...normalized.sequences.pucker, ...normalized.sequences.press,
    ...normalized.sequences.puckerLeft, ...normalized.sequences.puckerRight, ...normalized.sequences.funnel,
    "smileClosed", "smileOpen", "frownClosed", "frownOpen",
  ]);
  assert.equal(mouthStates.size, 24);

  const frontMouth = normalized.atlases[normalized.poses.find(({ id }) => id === "front").layers.mouth.atlas];
  const strongRight = selectPaintedFrames({ mouthPucker: 1, mouthRight: 1 }, {}, {}, normalized.sequences).mouth;
  assert.equal(strongRight, "puckerRight");
  assert.deepEqual(frontMouth.frames.puckerRight, frontMouth.frames.puckerLeft,
    "the repaired strong-right state intentionally reuses the clean painted opposite source rectangle");
  assert.ok(frontMouth.flipFrames.includes("puckerRight"), "the reused source must be mirrored by the fixed-frame compositor");
});

test("every referenced PNG keeps genuinely transparent and fully painted pixels", () => {
  const normalized = validatePaintedManifest(LUNA_PAINTED_MANIFEST);
  const sources = new Set([
    normalized.base,
    ...Object.values(normalized.atlases).map((atlas) => atlas.src),
    ...normalized.poses.map((pose) => pose.base),
  ]);
  for (const source of sources) {
    const { pixels, transparent, opaque } = pngAlphaSummary(source);
    assert.ok(transparent >= Math.max(1, pixels * .005), `${source} lost its real transparent background`);
    assert.ok(opaque >= Math.max(1, pixels * .005), `${source} no longer contains a substantially opaque painted region`);
  }
});

test("the painted destinations and crop rig stay inside the actual canvas", () => {
  const { width, height } = LUNA_PAINTED_MANIFEST;
  for (const [layerName, layer] of Object.entries(LUNA_PAINTED_MANIFEST.layers)) {
    const [x, y, layerWidth, layerHeight] = layer.dest;
    assert.ok(x >= 0 && y >= 0 && x + layerWidth <= width && y + layerHeight <= height, `${layerName} leaves the canvas`);
    for (const point of layer.clip || []) {
      assert.ok(point[0] >= 0 && point[0] <= width && point[1] >= 0 && point[1] <= height, `${layerName} clip leaves the canvas`);
    }
  }
  for (const key of ["leftEye", "rightEye", "mouth"]) {
    const [x, y, layerWidth, layerHeight] = LUNA_PAINTED_MANIFEST.layers[key].dest;
    assert.ok(Math.abs(LUNA_PAINTED_RIG[key].x - (x + layerWidth / 2)) <= Math.max(4, layerWidth * .05), `${key} rig x must match its painted destination`);
    assert.ok(Math.abs(LUNA_PAINTED_RIG[key].y - (y + layerHeight / 2)) <= Math.max(4, layerHeight * .05), `${key} rig y must match its painted destination`);
    assert.deepEqual([LUNA_PAINTED_RIG[key].w, LUNA_PAINTED_RIG[key].h], [layerWidth, layerHeight]);
  }
  const face = LUNA_PAINTED_RIG.face;
  assert.ok(face.x >= 0 && face.x < width && face.y >= 0 && face.y < height && face.w > 0 && face.h > 0);
});

test("the app uses the painted compositor and never activates the retired portrait warp", () => {
  assert.doesNotMatch(appSource, /portrait-warp\.js|\bPortraitWarp\b|\bportraitWarp\b/);
  assert.match(appSource, /import \{ PaintedAvatar, PAINTED_CHANNEL_SUPPORT \} from "\.\/painted-avatar\.js"/);
  const renderSource = appSource.slice(appSource.indexOf("function render("), appSource.indexOf("function animate("));
  assert.match(renderSource, /state\.paintedAvatar\.render\(state\.face2d\?\.output, intensity, dt, headPose\)/);

  const headPoseSource = appSource.slice(appSource.indexOf("function currentPaintedHeadPose("), appSource.indexOf("function toast("));
  assert.match(headPoseSource, /state\.face2d\?\.poseManual/);
  assert.match(headPoseSource, /normalizeHeadPose\(state\.face2d\.manualPose\)/);
  assert.match(headPoseSource, /yaw:\s*state\.smooth\.x \* headGain/);
  assert.match(headPoseSource, /pitch:\s*-state\.smooth\.y \* headGain/);

  const singleImageSource = appSource.slice(appSource.indexOf("async function importImageData("), appSource.indexOf("async function analyzeImage("));
  assert.ok(singleImageSource.indexOf("useStaticAvatar2D();") < singleImageSource.indexOf("state.image = image;"));
  assert.match(singleImageSource, /单图安全模式/);
});

test("FaceEditor resolves support on every refresh so painted/static switching is truthful", () => {
  let support = { jawOpen: "frame" };
  let poseAvailable = true;
  let supportReads = 0;
  const quickButtons = [{ disabled: true }, { disabled: true }];
  const classes = new Set();
  const poseButton = {
    dataset: { yaw: "0", pitch: "0" }, disabled: true,
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    setAttribute(name, value) { this[name] = value; },
  };
  const fixture = {
    channel: { value: "jawOpen" },
    session: { settings: { channels: {} }, manual: false, focus: false, poseManual: false, manualPose: { yaw: 0, pitch: 0 } },
    config: {}, manual: {}, focus: {}, testRange: { value: "0" }, testOutput: {}, hint: {},
    poseManual: {}, poseValue: {}, poseButtons: [poseButton], transitionButtons: [],
    path: { setAttribute() {} },
    quickRoot: { querySelectorAll: () => quickButtons },
    getSupport() { supportReads += 1; return support; },
    canPose() { return poseAvailable; },
    getPose: () => ({ input: { yaw: 0, pitch: 0 }, rendered: { yaw: 0, pitch: 0 } }),
    lastMeterTime: 0,
  };
  FaceEditor.prototype.refreshControls.call(fixture);
  assert.match(fixture.hint.textContent, /独立绘制的关键帧/);
  assert.ok(quickButtons.every((button) => !button.disabled));
  assert.equal(fixture.poseManual.disabled, false);
  assert.equal(poseButton.disabled, false);
  assert.match(fixture.poseValue.textContent, /跟随 · 当前画稿：正面/);
  support = {};
  poseAvailable = false;
  FaceEditor.prototype.refreshControls.call(fixture);
  assert.match(fixture.hint.textContent, /没有此动作的独立画稿/);
  assert.match(fixture.hint.textContent, /不会用拉伸冒充/);
  assert.ok(quickButtons.every((button) => button.disabled));
  assert.equal(fixture.poseManual.disabled, true);
  assert.equal(poseButton.disabled, true);
  assert.equal(fixture.poseValue.textContent, "当前单图没有头部方向画稿");
  assert.ok(supportReads >= 2);

  assert.match(appSource, /getSupport: \(\) => state\.avatar2dKind === "painted" \? PAINTED_CHANNEL_SUPPORT : \{\}/);
});

test("the offline QA gallery snapshots every manifest pose through one renderer", () => {
  assert.match(galleryHtml, /connect-src 'none'/);
  assert.match(galleryHtml, /<script type="module" src="\.\/painted-gallery\.js"><\/script>/);
  assert.doesNotMatch(gallerySource, /getUserMedia|\bfetch\s*\(|WebSocket|EventSource/);
  assert.equal((gallerySource.match(/new PaintedAvatar\s*\(/g) || []).length, 1);
  assert.match(gallerySource, /for \(const pose of manifest\.poses\)/);
  assert.match(gallerySource, /x: 180, y: 200, width: 700, height: 580/);
  assert.match(gallerySource, /renderer\.render\(channels,[\s\S]*?, 0, pose\)/);
  assert.match(gallerySource, /context\.drawImage\(composed, CROP\.x, CROP\.y, CROP\.width, CROP\.height/);
  for (const preset of ["neutral", "blink", "jaw", "puckerLeft", "puckerRight", "press"]) {
    assert.match(galleryHtml, new RegExp(`data-gallery-preset="${preset}"`));
  }
});
