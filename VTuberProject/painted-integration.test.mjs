import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { inflateSync } from "node:zlib";
import { FaceEditor } from "./face-editor.js";
import { selectPaintedFrames, selectPaintedPose, validatePaintedManifest, paintedChannelSupport } from "./painted-avatar.js";
import { LUNA_EYE_ART } from "./painted-luna-eye-art.js";
import { LUNA_MOUTH_ART, LUNA_BROW_ART } from "./painted-luna-mouth-art.js";
import { FaceSession, transitionPreviewFrame } from "./face-session.js";
import { createDemoMotion } from "./demo-motion.js";
import { LUNA_PAINTED_MANIFEST, LUNA_PAINTED_RIG } from "./painted-luna.js";

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("./legacy-studio.html", import.meta.url), "utf8");
const faceEditorSource = readFileSync(new URL("./face-editor.js", import.meta.url), "utf8");
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

function eyeOpening(layer) {
  const art = LUNA_EYE_ART[layer.atlas];
  assert.ok(art, `${layer.atlas} must have measured eye artwork metadata`);
  const [sourceX, sourceY, sourceWidth, sourceHeight] = art.rects[0];
  const [whiteX0, whiteY0, whiteX1, whiteY1] = art.white;
  const [destX, destY, destWidth, destHeight] = layer.dest;
  const sourceCenterX = ((whiteX0 + whiteX1) / 2 - sourceX) / sourceWidth;
  const sourceCenterY = ((whiteY0 + whiteY1) / 2 - sourceY) / sourceHeight;
  return {
    x: destX + (layer.flipX ? 1 - sourceCenterX : sourceCenterX) * destWidth,
    y: destY + sourceCenterY * destHeight,
    width: (whiteX1 - whiteX0) / sourceWidth * destWidth,
    height: (whiteY1 - whiteY0) / sourceHeight * destHeight,
    scaleX: destWidth / sourceWidth,
    scaleY: destHeight / sourceHeight,
  };
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
    ...Object.values(normalized.atlases).flatMap((atlas) => atlas.gaze ? [atlas.src, atlas.gaze.src] : [atlas.src]),
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

test("the shipped v0.13 manifest registers 24 mouth source regions and 13 brow stages", () => {
  const normalized = validatePaintedManifest(LUNA_PAINTED_MANIFEST);
  assert.equal(normalized.poses.length, 13);
  assert.equal(normalized.sequences.eyes.length, 11, "open through closed register eleven blink stages; this is not visual approval");
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
  for (const [name,art] of Object.entries(LUNA_MOUTH_ART)) {
    const atlas = normalized.atlases[name];
    assert.match(atlas.src, /luna-painted-v4\/mouths-/);
    assert.equal(new Set([...mouthStates].map((key) => JSON.stringify(atlas.frames[key]))).size,24,
      `${name} must use 24 distinct drawings, not a repaired duplicate`);
    assert.deepEqual(atlas.flipFrames, []);
    for (const frame of Object.values(art.frames)) assert.deepEqual(frame.slice(2), [180,180]);
    assert.ok(art.frames.puckerRight[0] < art.frames.puckerLeft[0],
      "viewer-left paintings (first half of row three) mean anatomical mouthRight");
  }
  assert.notDeepEqual(frontMouth.frames.puckerRight, frontMouth.frames.puckerLeft);
  for (const name of ["sideMouth","profileMouth"]) {
    for (const suffix of ["Soft","Mid",""]) {
      assert.deepEqual(normalized.atlases[name+"Left"].frames["puckerLeft"+suffix], normalized.atlases[name].frames["puckerRight"+suffix]);
      assert.deepEqual(normalized.atlases[name+"Left"].frames["puckerRight"+suffix], normalized.atlases[name].frames["puckerLeft"+suffix]);
    }
  }
  assert.equal(Object.keys(LUNA_BROW_ART.frames).length,13);
  for (const name of ["browUp","browDown","browWorried","browOuterUp"]) {
    assert.equal(normalized.sequences[name].length,4);
    assert.equal(normalized.sequences[name][0],"neutral");
  }
  assert.equal(normalized.atlases.brows.src,"./assets/luna-painted-v4/brows.png");
});

test("the shipped old pack declares pure mouth shifts unsupported and preserves other mouth signals", () => {
  const normalized = validatePaintedManifest(LUNA_PAINTED_MANIFEST);
  const support = paintedChannelSupport(normalized);
  for (const [name, pucker] of [["mouthLeft", "puckerLeft"], ["mouthRight", "puckerRight"]]) {
    assert.equal(support[name], "unsupported");
    assert.equal(normalized.sequences[name], undefined);
    assert.equal(selectPaintedFrames({ [name]: 1 }, {}, { mouth: pucker }, normalized.sequences).mouth, "closed");
    assert.equal(selectPaintedFrames({ [name]: 1, jawOpen: 1 }, {}, {}, normalized.sequences).mouth, "openWide");
    assert.equal(selectPaintedFrames({ [name]: 1, mouthPucker: 1 }, {}, {}, normalized.sequences).mouth, pucker);
  }
  assert.equal(selectPaintedFrames({ mouthLeft: 1, mouthRight: 1 }, {}, {}, normalized.sequences).mouth, "closed");
});

test("v0.13 mouths and brows keep fixed uniform art scale in all 13 poses", () => {
  const normalized = validatePaintedManifest(LUNA_PAINTED_MANIFEST);
  for (const pose of normalized.poses) {
    for (const key of ["mouth","leftBrow","rightBrow"]) {
      const layer = pose.layers[key];
      if (!layer.visible) continue;
      const atlas = normalized.atlases[layer.atlas];
      const frame = atlas.frames[key === "mouth" ? "closed" : "neutral"];
      assert.ok(Math.abs(layer.dest[2]/frame[2]-layer.dest[3]/frame[3]) < 1e-9,
        `${pose.id}/${key} may be uniformly placed but must never be squeezed`);
    }
  }
  const front = normalized.poses.find(({id})=>id==="front").layers.mouth;
  assert.ok(Math.abs(front.dest[0]+front.dest[2]/2-523)<1e-9);
  assert.ok(Math.abs(front.dest[1]+front.dest[3]*64/180-580)<1e-9,
    "all front jaw drawings share a registered upper-lip anchor");
});

test("the shipped brow drawings are reachable through real 2D demo and transition inputs", () => {
  const session = new FaceSession();
  const sequences = LUNA_PAINTED_MANIFEST.sequences;
  const states = new Set();
  for(let now=0;now<10000;now+=16){
    const frame=session.update(createDemoMotion(now,"greeting"),"demo",now,.016);
    states.add(selectPaintedFrames(frame,{expression:1},{},sequences).leftBrow);
  }
  assert.ok(states.has("neutral") && states.has("upSoft") && states.has("upMid"));
  for (const [time,key,expected] of [[450,"leftBrow","up"],[1600,"leftBrow","down"],[3100,"leftBrow","worried"],[4500,"leftBrow","outerUp"]]) {
    assert.equal(selectPaintedFrames(transitionPreviewFrame(time),{},{},sequences)[key],expected);
  }
});

test("yaw and diagonal eye pairs share one axis and raised diagonal lips sit lower", () => {
  const poses=Object.fromEntries(validatePaintedManifest(LUNA_PAINTED_MANIFEST).poses.map(p=>[p.id,p]));
  for(const id of ["right20","left20","right40","left40","right40-up","right40-down"]){
    const a=eyeOpening(poses[id].layers.leftEye),b=eyeOpening(poses[id].layers.rightEye);
    assert.ok(Math.abs(a.y-b.y)<1e-9,`${id} must not introduce a false roll between the eye centers`);
  }
  for(const [id,expected] of [["right40-up",466.8],["left40-up",468.8]]){
    const d=poses[id].layers.mouth.dest;
    assert.ok(Math.abs(d[1]+d[3]*64/180-expected)<.01,`${id} mouth must be registered below the old too-high lip line`);
  }
  assert.equal(poses["left40-up"].layers.rightEye.visible,false,"alignment must not paint a far eye over the occluding fringe");
});

test("every referenced PNG keeps genuinely transparent and fully painted pixels", () => {
  const normalized = validatePaintedManifest(LUNA_PAINTED_MANIFEST);
  const sources = new Set([
    normalized.base,
    ...Object.values(normalized.atlases).flatMap((atlas) => atlas.gaze ? [atlas.src, atlas.gaze.src] : [atlas.src]),
    ...normalized.poses.map((pose) => pose.base),
  ]);
  for (const source of sources) {
    const { pixels, transparent, opaque } = pngAlphaSummary(source);
    assert.ok(transparent >= Math.max(1, pixels * .005), `${source} lost its real transparent background`);
    assert.ok(opaque >= Math.max(1, pixels * .005), `${source} no longer contains a substantially opaque painted region`);
  }
});

test("the painted destinations, measured eye openings and crop rig stay inside the actual canvas", () => {
  const { width, height } = LUNA_PAINTED_MANIFEST;
  for (const [layerName, layer] of Object.entries(LUNA_PAINTED_MANIFEST.layers)) {
    const [x, y, layerWidth, layerHeight] = layer.dest;
    assert.ok(x >= 0 && y >= 0 && x + layerWidth <= width && y + layerHeight <= height, `${layerName} leaves the canvas`);
    for (const point of layer.clip || []) {
      assert.ok(point[0] >= 0 && point[0] <= width && point[1] >= 0 && point[1] <= height, `${layerName} clip leaves the canvas`);
    }
  }
  for (const key of ["leftEye", "rightEye"]) {
    const opening = eyeOpening(LUNA_PAINTED_MANIFEST.layers[key]);
    assert.ok(Math.abs(LUNA_PAINTED_RIG[key].x - opening.x) <= 1, `${key} rig x must match the painted white opening, not transparent padding`);
    assert.ok(Math.abs(LUNA_PAINTED_RIG[key].y - opening.y) <= 1, `${key} rig y must match the painted white opening, not transparent padding`);
    assert.ok(LUNA_PAINTED_RIG[key].w > 0 && LUNA_PAINTED_RIG[key].h > 0);
  }
  const [mouthX, mouthY, mouthWidth, mouthHeight] = LUNA_PAINTED_MANIFEST.layers.mouth.dest;
  assert.deepEqual(LUNA_PAINTED_RIG.mouth, {
    x: mouthX + mouthWidth / 2, y: mouthY + mouthHeight / 2, w: mouthWidth, h: mouthHeight,
  });
  const face = LUNA_PAINTED_RIG.face;
  assert.ok(face.x >= 0 && face.x < width && face.y >= 0 && face.y < height && face.w > 0 && face.h > 0);
});

test("v0.12 keeps natural eye scale, real near/far perspective and explicit anatomical mirroring", () => {
  const normalized = validatePaintedManifest(LUNA_PAINTED_MANIFEST);
  const poses = Object.fromEntries(normalized.poses.map((pose) => [pose.id, pose]));
  const opening = (poseId, layerId) => eyeOpening(poses[poseId].layers[layerId]);
  const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= .51, `${label}: expected ${expected}, received ${actual}`);

  const frontLeft = opening("front", "leftEye"), frontRight = opening("front", "rightEye");
  close(frontLeft.width, 94, "front anatomical-left white width");
  close(frontRight.width, 94, "front anatomical-right white width");
  close(frontLeft.x - frontRight.x, 210, "front eye-center spacing");
  assert.ok(frontLeft.x - frontRight.x < 228 * .95,
    "the eye centers must remain materially closer than v0.11's 228 px spacing");
  assert.ok(frontLeft.width < 156 * .75,
    "the visible front eye must remain substantially smaller than the v0.11 156 px eye destination");
  assert.deepEqual(LUNA_PAINTED_RIG.leftEye, { x: 627, y: 448, w: 126, h: 67 });
  assert.deepEqual(LUNA_PAINTED_RIG.rightEye, { x: 417, y: 448, w: 126, h: 67 });

  for (const [rightPose, leftPose, nearWidth, farWidth] of [
    ["right20", "left20", 84, 62],
    ["right40", "left40", 77, 44],
  ]) {
    for (const [poseId, nearId, farId] of [[rightPose, "rightEye", "leftEye"], [leftPose, "leftEye", "rightEye"]]) {
      const near = opening(poseId, nearId), far = opening(poseId, farId);
      close(near.width, nearWidth, `${poseId} near-eye white width`);
      close(far.width, farWidth, `${poseId} far-eye white width`);
      assert.ok(near.width > far.width * 1.2, `${poseId} near eye must remain visibly wider than the far eye`);
    }
  }

  for (const pose of normalized.poses) {
    for (const layerId of ["leftEye", "rightEye"]) {
      const layer = pose.layers[layerId];
      if (!layer.visible) continue;
      const measured = eyeOpening(layer);
      assert.ok(Math.abs(measured.scaleX - measured.scaleY) <= 1e-9,
        `${pose.id}/${layerId} must use one uniform artwork scale rather than stretching the eye`);
      const atlas = normalized.atlases[layer.atlas];
      assert.ok(atlas.gaze, `${pose.id}/${layerId} must use an independent iris sprite`);
      assert.ok(atlas.gaze.apertures.open.length >= 3, `${pose.id}/${layerId} must retain a real open-eye mask`);
      assert.deepEqual(atlas.gaze.apertures.closed, [], `${pose.id}/${layerId} closed eye must hide the iris`);
      assert.deepEqual(atlas.gaze.apertures.happyClosed, [], `${pose.id}/${layerId} happy-closed eye must hide the iris`);
    }
  }

  for (const poseId of ["front", "up", "down"]) {
    assert.equal(poses[poseId].layers.leftEye.flipX, false, `${poseId} anatomical-left eye uses the canonical sprite`);
    assert.equal(poses[poseId].layers.rightEye.flipX, true, `${poseId} anatomical-right eye mirrors the canonical sprite`);
  }
  for (const [rightPose, leftPose] of [["right20", "left20"], ["right40", "left40"], ["right65", "left65"]]) {
    assert.equal(poses[rightPose].layers.rightEye.flipX, false, `${rightPose} near anatomical-right eye must not be reversed`);
    assert.equal(poses[leftPose].layers.leftEye.flipX, true, `${leftPose} mirrored near anatomical-left eye must reverse exactly once`);
  }
  for (const [rightPose, leftPose] of [["right20", "left20"], ["right40", "left40"]]) {
    assert.equal(poses[rightPose].layers.leftEye.flipX, false, `${rightPose} far anatomical-left eye uses its canonical source`);
    assert.equal(poses[leftPose].layers.rightEye.flipX, true, `${leftPose} far anatomical-right eye mirrors that source exactly once`);
  }
});

test("the app uses the painted compositor and never activates the retired portrait warp", () => {
  assert.doesNotMatch(appSource, /portrait-warp\.js|\bPortraitWarp\b|\bportraitWarp\b/);
  assert.match(appSource, /import \{ PaintedAvatar \} from "\.\/painted-avatar\.js"/);
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

  assert.match(appSource, /getSupport: \(\) => state\.avatar2dKind === "painted" \? state\.paintedAvatar\?\.channelSupport \|\| \{\} : \{\}/,
    "the editor must read support from the loaded pack so gaze is enabled only when real iris assets exist");
});

test("the main look-up and look-down UI presets always move both irises together", () => {
  assert.equal((indexHtml.match(/data-face-test="lookUp"/g) || []).length, 1);
  assert.equal((indexHtml.match(/data-face-test="lookDown"/g) || []).length, 1);

  const presetMarker = "    const presets = {";
  const presetStart = faceEditorSource.indexOf(presetMarker);
  const presetEnd = faceEditorSource.indexOf("\n    };", presetStart);
  assert.ok(presetStart >= 0 && presetEnd > presetStart, "FaceEditor must retain its declarative preset map");
  const objectStart = faceEditorSource.indexOf("{", presetStart);
  const presets = runInNewContext(`(${faceEditorSource.slice(objectStart, presetEnd + 6)})`);

  assert.deepEqual({ ...presets.lookUp }, { eyeLookUpLeft: .9, eyeLookUpRight: .9 });
  assert.deepEqual({ ...presets.lookDown }, { eyeLookDownLeft: .9, eyeLookDownRight: .9 });
  assert.equal(presets.lookUp.eyeLookUpLeft, presets.lookUp.eyeLookUpRight,
    "look-up must not leave either eye behind");
  assert.equal(presets.lookDown.eyeLookDownLeft, presets.lookDown.eyeLookDownRight,
    "look-down must not leave either eye behind");

  const clickHandler = faceEditorSource.slice(
    faceEditorSource.indexOf("presetButtons.forEach"),
    faceEditorSource.indexOf("this.poseManual?.addEventListener", presetStart),
  );
  assert.match(clickHandler, /const frame = presets\[button\.dataset\.faceTest\]/);
  assert.match(clickHandler, /this\.session\.test\(frame\)/,
    "the preset click must submit the complete two-eye frame, not only its first channel");
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
  for (const preset of ["neutral", "blink", "jaw", "mouthLeft", "mouthRight", "puckerLeft", "puckerRight", "press"]) {
    assert.match(galleryHtml, new RegExp(`data-gallery-preset="${preset}"`));
  }
  assert.match(galleryHtml, /data-gallery-channel="gaze"[^>]+min="-1"[^>]+max="1"/);
  for (const gaze of ["1", "0", "-1"]) assert.match(galleryHtml, new RegExp(`data-gallery-gaze="${gaze}"`));
  assert.match(gallerySource, /\["blink", "jaw", "pucker", "press"\]\.forEach/,
    "expression sliders must not include or reset the independent gaze control");
  assert.match(gallerySource, /sliders\.gaze\.addEventListener\("input", scheduleRedraw\)/);
  assert.doesNotMatch(
    gallerySource.slice(gallerySource.indexOf("function applyPreset("), gallerySource.indexOf("function buildCards(")),
    /sliders\.gaze/,
    "expression presets must preserve the locked gaze used to compare all poses",
  );
});

test("the QA gallery exercises pure left/right without pucker and exposes missing-art capability", () => {
  const presetsStart = gallerySource.indexOf("const presets = Object.freeze(");
  const presetsEnd = gallerySource.indexOf("\nfunction syncControls", presetsStart);
  const presets = runInNewContext(`${gallerySource.slice(presetsStart, presetsEnd)}\npresets;`);
  const start = gallerySource.indexOf("function channelsFromControls()");
  const end = gallerySource.indexOf("\nfunction redraw()", start);
  const sliders = Object.fromEntries(["blink", "jaw", "pucker", "press", "gaze"].map((key) => [key, { value: "0" }]));
  const direction = { value: "center" };
  const channelsFromControls = runInNewContext(`(${gallerySource.slice(start, end)})`, { sliders, direction });
  const presetFunctionStart = gallerySource.indexOf("function applyPreset(");
  const presetFunctionEnd = gallerySource.indexOf("\nfunction buildCards()", presetFunctionStart);
  const applyPreset = runInNewContext(`(${gallerySource.slice(presetFunctionStart, presetFunctionEnd)})`, {
    sliders, direction, presets, activePreset: null, scheduleRedraw() {},
  });
  for (const [name, opposite] of [["mouthLeft", "mouthRight"], ["mouthRight", "mouthLeft"]]) {
    applyPreset(name);
    const pure = channelsFromControls();
    assert.equal(pure[name], .8);
    assert.equal(pure[opposite], 0);
    assert.equal(pure.mouthPucker, 0);
    sliders.jaw.value = ".7";
    assert.equal(channelsFromControls()[name], .8, "jaw control must not erase directional input");
    assert.equal(channelsFromControls().jawOpen, .7);
  }
  applyPreset("puckerLeft");
  assert.equal(channelsFromControls().mouthPucker, .92);
  assert.equal(channelsFromControls().mouthLeft, .8);
  applyPreset("puckerRight");
  assert.equal(channelsFromControls().mouthRight, .8);
  applyPreset("neutral");
  assert.equal(channelsFromControls().mouthLeft, 0);
  assert.equal(channelsFromControls().mouthRight, 0);
  assert.match(galleryHtml, /旧版素材排查页，视觉尚未通过验收/);
  assert.match(galleryHtml, /id="galleryMouthSupport"/);
  assert.match(gallerySource, /renderer\.channelSupport\.mouthLeft/);
  assert.match(gallerySource, /renderer\.channelSupport\.mouthRight/);
  assert.match(gallerySource, /unsupported（缺少独立画稿）/);
});

test("the QA gallery maps one signed gaze value to symmetric ARKit up/down channels", () => {
  const start = gallerySource.indexOf("function channelsFromControls()");
  const end = gallerySource.indexOf("\nfunction redraw()", start);
  assert.ok(start >= 0 && end > start, "channelsFromControls must remain independently testable");
  const sliders = Object.fromEntries(["blink", "jaw", "pucker", "press", "gaze"].map((key) => [key, { value: "0" }]));
  const direction = { value: "center" };
  const channelsFromControls = runInNewContext(`(${gallerySource.slice(start, end)})`, { sliders, direction });

  sliders.blink.value = ".4";
  sliders.jaw.value = ".3";
  sliders.pucker.value = ".2";
  sliders.press.value = ".1";
  sliders.gaze.value = "1";
  assert.deepEqual(
    { ...channelsFromControls() },
    {
      eyeBlinkLeft: .4, eyeBlinkRight: .4, jawOpen: .3, mouthPucker: .2,
      mouthPressLeft: .1, mouthPressRight: .1, mouthLeft: 0, mouthRight: 0,
      eyeLookUpLeft: 1, eyeLookUpRight: 1, eyeLookDownLeft: 0, eyeLookDownRight: 0,
    },
    "looking up must preserve the active expression while moving both irises together",
  );

  sliders.gaze.value = "-.75";
  const down = channelsFromControls();
  assert.deepEqual(
    [down.eyeLookUpLeft, down.eyeLookUpRight, down.eyeLookDownLeft, down.eyeLookDownRight],
    [0, 0, .75, .75],
    "negative gaze must map to both down channels without accidentally mirroring one eye",
  );
  assert.deepEqual(
    [down.eyeBlinkLeft, down.eyeBlinkRight, down.jawOpen, down.mouthPucker, down.mouthPressLeft, down.mouthPressRight],
    [.4, .4, .3, .2, .1, .1],
    "changing gaze must not clear blink or mouth controls",
  );

  sliders.gaze.value = "not-a-number";
  const neutral = channelsFromControls();
  assert.deepEqual(
    [neutral.eyeLookUpLeft, neutral.eyeLookUpRight, neutral.eyeLookDownLeft, neutral.eyeLookDownRight],
    [0, 0, 0, 0],
    "invalid gallery input must fail closed to centered gaze",
  );
});
