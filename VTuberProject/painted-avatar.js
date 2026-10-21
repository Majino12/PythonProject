const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export const PAINTED_FRAME_SETS = Object.freeze({
  eyes: Object.freeze(["open", "quarter", "half", "threeQuarter", "closed", "happyClosed"]),
  brows: Object.freeze(["neutral", "up", "down", "worried", "outerUp"]),
  mouth: Object.freeze(["closed", "openSmall", "openMedium", "openWide", "smileClosed", "smileOpen", "frownClosed", "frownOpen", "funnel", "pucker", "press", "side"]),
});

const ALL_CHANNELS = [
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight",
  "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
  "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen", "jawRight",
  "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft", "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft", "mouthSmileRight",
  "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight", "tongueOut",
];
const DIRECT_CHANNELS = new Set(["browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "eyeBlinkLeft", "eyeBlinkRight", "jawOpen", "mouthClose", "mouthFunnel", "mouthPucker"]);
const APPROXIMATE_CHANNELS = new Set(["cheekSquintLeft", "cheekSquintRight", "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "mouthFrownLeft", "mouthFrownRight", "mouthLeft", "mouthRight", "mouthPressLeft", "mouthPressRight", "mouthSmileLeft", "mouthSmileRight"]);

/** Finite painted states, not 52 independent meshes or independently drawn lip corners. */
export const PAINTED_CHANNEL_SUPPORT = Object.freeze(Object.fromEntries(ALL_CHANNELS.map((key) => [key,
  DIRECT_CHANNELS.has(key) ? "frame" : APPROXIMATE_CHANNELS.has(key) ? "approximate" : "unsupported",
])));

const LAYER_KINDS = Object.freeze({ leftEye: "eyes", rightEye: "eyes", leftBrow: "brows", rightBrow: "brows", mouth: "mouth" });
const DRAW_ORDER = Object.freeze(["leftEye", "rightEye", "leftBrow", "rightBrow", "mouth"]);
const SEQUENCE_KINDS = Object.freeze({ eyes: "eyes", jaw: "mouth", pucker: "mouth", press: "mouth", puckerLeft: "mouth", puckerRight: "mouth", funnel: "mouth" });
const DEFAULT_EYES = PAINTED_FRAME_SETS.eyes.slice(0, 5);
const DEFAULT_JAW = ["closed", "openSmall", "openMedium", "openWide"];
const BLEND_LAYERS = Object.freeze(["leftEye", "rightEye", "mouth"]);

/** Quantize without rapid switching around a boundary; large changes may skip states. */
export function paintedFrameIndex(value, previousIndex, boundaries, margin = .035) {
  value = clamp(finite(value));
  let index = Number.isInteger(previousIndex) && previousIndex >= 0 && previousIndex <= boundaries.length
    ? previousIndex : boundaries.filter((boundary) => value >= boundary).length;
  while (index < boundaries.length && value > boundaries[index] + margin) index += 1;
  while (index > 0 && value < boundaries[index - 1] - margin) index -= 1;
  return index;
}

/**
 * Pure frame selection. Eyes and eyebrows are independent; the mouth is ONE
 * finite painted states. Press > closure > pucker > funnel > side > emotion > jaw.
 * No nonzero idle smile or blink is introduced when all inputs are zero.
 */
export function selectPaintedFrames(channels = {}, intensity = {}, previous = {}, sequences = {}) {
  channels ||= {};
  intensity ||= {};
  previous ||= {};
  sequences ||= {};
  const gain = (name) => clamp(finite(intensity[name], 1), 0, 1.5);
  const value = (key, group = "expression") => clamp(finite(channels[key]) * gain(group));
  const threshold = (current, target, enter, leave = enter - .1) => current === target ? leave : enter;
  const eyeFrames = sequences.eyes || DEFAULT_EYES;
  const staged = (frames, amount, oldFrame, includesNeutral = true) => {
    const boundaries = frames.slice(1).map((_, index) => includesNeutral ? (index + .5) / (frames.length - 1) : (index + 1) / frames.length);
    return frames[paintedFrameIndex(amount, frames.indexOf(oldFrame), boundaries, .018)];
  };
  const eye = (side, oldFrame) => {
    const rawBlink = value(`eyeBlink${side}`, "blink");
    const squint = value(`eyeSquint${side}`), cheek = value(`cheekSquint${side}`);
    const blink = clamp(rawBlink + squint * .4 + cheek * .15 - (rawBlink < .6 ? value(`eyeWide${side}`) * .15 : 0));
    const happy = value(`mouthSmile${side}`);
    if (blink >= (oldFrame === "happyClosed" ? .76 : .86) && happy >= (oldFrame === "happyClosed" ? .45 : .60)) return "happyClosed";
    const oldIndex = oldFrame === "happyClosed" ? eyeFrames.length - 1 : eyeFrames.indexOf(oldFrame);
    if (sequences.eyes) {
      // Preserve exact intermediate drawings at unit gain, while a genuinely
      // full tracked blink still closes at the app's normal .85 sensitivity.
      const closed = finite(channels[`eyeBlink${side}`]) >= .97 && gain("blink") >= .5;
      return staged(eyeFrames, closed ? 1 : blink, eyeFrames[oldIndex]);
    }
    // The final threshold still reaches the painted fully-closed lid at the
    // app's normal .85 blink gain; a strong tracked blink must not stop at 75%.
    return eyeFrames[paintedFrameIndex(blink, oldIndex, [.125, .375, .625, .80], .025)];
  };
  const brow = (side, oldFrame) => {
    const down = value(`browDown${side}`), inner = value("browInnerUp"), outer = value(`browOuterUp${side}`);
    const frown = value(`mouthFrown${side}`);
    if (down >= threshold(oldFrame, "down", .58, .46)) return "down";
    if (inner >= threshold(oldFrame, "worried", .46, .36) && (down >= .18 || frown >= .43) && outer < .50) return "worried";
    if (outer >= threshold(oldFrame, "outerUp", .52, .40) && inner < .43) return "outerUp";
    if (Math.max(inner, outer) >= threshold(oldFrame, "up", .46, .34)) return "up";
    return "neutral";
  };
  const mouth = () => {
    const oldFrame = previous.mouth;
    const press = Math.max(value("mouthPressLeft"), value("mouthPressRight"));
    if (sequences.press) {
      if (press >= (sequences.press.includes(oldFrame) ? .12 : .20)) return staged(sequences.press, press, oldFrame, false);
    } else if (press >= threshold(oldFrame, "press", .54, .42)) return "press";
    const jawFrames = sequences.jaw || DEFAULT_JAW;
    if (value("mouthClose", "mouth") >= .62) return jawFrames[0];
    const pucker = value("mouthPucker", "mouth");
    if (sequences.pucker || sequences.puckerLeft || sequences.puckerRight) {
      const oldPucker = [sequences.pucker, sequences.puckerLeft, sequences.puckerRight].some((frames) => frames?.includes(oldFrame));
      if (pucker >= (oldPucker ? .12 : .20)) {
        const direction = value("mouthLeft") - value("mouthRight");
        const left = sequences.puckerLeft, right = sequences.puckerRight;
        if (left && direction >= (left.includes(oldFrame) ? .15 : .25)) return staged(left, Math.min(pucker, direction), oldFrame, false);
        if (right && direction <= -(right.includes(oldFrame) ? .15 : .25)) return staged(right, Math.min(pucker, -direction), oldFrame, false);
        return sequences.pucker ? staged(sequences.pucker, pucker, oldFrame, false) : "pucker";
      }
    } else if (pucker >= threshold(oldFrame, "pucker", .55, .43)) return "pucker";
    const funnel = value("mouthFunnel", "mouth");
    if (sequences.funnel) {
      if (funnel >= (sequences.funnel.includes(oldFrame) ? .12 : .20)) return staged(sequences.funnel, funnel, oldFrame, false);
    } else if (funnel >= threshold(oldFrame, "funnel", .50, .38)) return "funnel";
    const side = Math.abs(value("mouthRight") - value("mouthLeft"));
    if (side >= threshold(oldFrame, "side", .62, .50)) return "side";
    const jaw = value("jawOpen", "mouth");
    const smile = Math.max(value("mouthSmileLeft"), value("mouthSmileRight"));
    const frown = Math.max(value("mouthFrownLeft"), value("mouthFrownRight"));
    const oldSmile = oldFrame?.startsWith("smile"), oldFrown = oldFrame?.startsWith("frown");
    const hasSmile = smile >= (oldSmile ? .33 : .46), hasFrown = frown >= (oldFrown ? .33 : .46);
    if (hasSmile || hasFrown) {
      const emotion = hasFrown && (!hasSmile || frown > smile + (oldFrown ? -.05 : .08)) ? "frown" : "smile";
      const wasOpen = oldFrame === `${emotion}Open`;
      return `${emotion}${jaw > (wasOpen ? .10 : .16) ? "Open" : "Closed"}`;
    }
    if (sequences.jaw) return staged(jawFrames, jaw, oldFrame);
    return jawFrames[paintedFrameIndex(jaw, jawFrames.indexOf(oldFrame), [.10, .34, .65], .025)];
  };
  return {
    leftEye: eye("Left", previous.leftEye), rightEye: eye("Right", previous.rightEye),
    leftBrow: brow("Left", previous.leftBrow), rightBrow: brow("Right", previous.rightBrow), mouth: mouth(),
  };
}

/** Select an actually painted orientation. Positive yaw = character's left
 * (viewer's right), positive pitch = looking up; both inputs are [-1, 1].
 * Retain the old painting until a neighbour improves distance by margin.
 */
export function selectPaintedPose(poses, input = {}, previousId = null, margin = .075) {
  if (!Array.isArray(poses) || poses.length === 0) return null;
  const yaw = clamp(finite(input?.yaw), -1, 1), pitch = clamp(finite(input?.pitch), -1, 1);
  const distance = (pose) => Math.hypot(yaw - pose.yaw, pitch - pose.pitch);
  let nearest = poses[0];
  for (const pose of poses.slice(1)) if (distance(pose) < distance(nearest)) nearest = pose;
  if (distance(nearest) < 1e-9) return nearest;
  const previous = poses.find((pose) => pose.id === previousId);
  if (previous && distance(previous) <= distance(nearest) + clamp(finite(margin, .075), 0, .25)) return previous;
  return nearest;
}

function adjacentSequence(layerId, from, to, sequences) {
  const groups = layerId === "mouth"
    ? [sequences.jaw || DEFAULT_JAW, sequences.pucker, sequences.press, sequences.puckerLeft, sequences.puckerRight, sequences.funnel]
    : [sequences.eyes || DEFAULT_EYES];
  return groups.some((frames) => frames && frames.indexOf(from) >= 0 && frames.indexOf(to) >= 0 && Math.abs(frames.indexOf(from) - frames.indexOf(to)) === 1);
}

function abortError(message = "角色图集加载已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function localAsset(path) {
  if (typeof path !== "string" || !path.startsWith("./assets/") || !/^\.\/assets\/[A-Za-z0-9._/-]+\.(png|webp|jpe?g)$/i.test(path)
    || path.slice(2).split("/").some((part) => !part || part === "." || part === "..")) throw new Error("角色图集只能使用内置 assets 本地图片");
  return path;
}

function rectangle(value, description) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)
    || value[0] < 0 || value[1] < 0 || value[2] <= 0 || value[3] <= 0) throw new Error(`${description}矩形无效`);
  return [...value];
}

function clipPolygon(value, width, height) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length < 3 || value.length > 32
    || !value.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
      && point[0] >= 0 && point[0] <= width && point[1] >= 0 && point[1] <= height)) throw new Error("表情层裁剪多边形无效");
  return value.map((point) => [...point]);
}

function safeKey(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !["constructor", "prototype"].includes(value);
}

/** Validate/copy trusted, imported built-in manifest data; never accept file or remote URLs. */
export function validatePaintedManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Number.isInteger(manifest.width) || !Number.isInteger(manifest.height)
    || manifest.width < 1 || manifest.height < 1 || manifest.width > 4096 || manifest.height > 4096) throw new Error("角色图集尺寸或版本无效");
  const result = { version: 1, width: manifest.width, height: manifest.height, base: localAsset(manifest.base), atlases: {}, layers: {}, sequences: {}, poses: [] };
  if (manifest.sequences !== undefined && (!manifest.sequences || typeof manifest.sequences !== "object" || Array.isArray(manifest.sequences))) throw new Error("表情序列无效");
  for (const [name, frames] of Object.entries(manifest.sequences || {})) {
    if (!Object.hasOwn(SEQUENCE_KINDS, name) || !Array.isArray(frames) || frames.length < (name === "eyes" || name === "jaw" ? 2 : 1)
      || frames.length > 32 || !frames.every(safeKey) || new Set(frames).size !== frames.length) throw new Error(`表情序列 ${name} 无效`);
    result.sequences[name] = [...frames];
  }
  const validateLayer = (layerId, layer) => {
    const kind = LAYER_KINDS[layerId];
    if (!layer || !safeKey(layer.atlas) || !Object.hasOwn(manifest.atlases || {}, layer.atlas)) throw new Error(`缺少 ${layerId} 绘制层`);
    const atlas = manifest.atlases[layer.atlas];
    if (!atlas || typeof atlas !== "object") throw new Error(`缺少 ${layerId} 图集`);
    const dest = rectangle(layer.dest, `${layerId} 目标`);
    if (dest[0] + dest[2] > result.width || dest[1] + dest[3] > result.height) throw new Error(`${layerId} 超出角色画布`);
    const validated = { atlas: layer.atlas, dest, flipX: layer.flipX === true, visible: layer.visible !== false };
    const clip = clipPolygon(layer.clip, result.width, result.height);
    if (clip) validated.clip = clip;
    if (!Object.hasOwn(result.atlases, layer.atlas)) {
      if (!atlas.frames || typeof atlas.frames !== "object" || Array.isArray(atlas.frames)
        || Object.keys(atlas.frames).length > 128) throw new Error(`${layer.atlas} 关键帧无效或过多`);
      const frames = {};
      for (const [key, rect] of Object.entries(atlas.frames)) {
        if (!safeKey(key)) throw new Error(`${layer.atlas} 关键帧名称无效`);
        frames[key] = rectangle(rect, `${layer.atlas}/${key} 源`);
      }
      const flipFrames = atlas.flipFrames ?? [];
      if (!Array.isArray(flipFrames) || flipFrames.length > 128 || new Set(flipFrames).size !== flipFrames.length
        || !flipFrames.every((key) => safeKey(key) && Object.hasOwn(frames, key))) throw new Error(`${layer.atlas} 镜像关键帧无效`);
      result.atlases[layer.atlas] = { src: localAsset(atlas.src), frames, flipFrames: [...flipFrames] };
    }
    const frames = result.atlases[layer.atlas].frames;
    const required = [...PAINTED_FRAME_SETS[kind], ...Object.entries(result.sequences).filter(([name]) => SEQUENCE_KINDS[name] === kind).flatMap(([, sequence]) => sequence)];
    for (const frame of required) if (!Object.hasOwn(frames, frame)) throw new Error(`${layer.atlas}/${frame} 缺少关键帧`);
    return validated;
  };
  for (const layerId of DRAW_ORDER) result.layers[layerId] = validateLayer(layerId, manifest.layers?.[layerId]);
  if (manifest.poses !== undefined && (!Array.isArray(manifest.poses) || manifest.poses.length < 1 || manifest.poses.length > 25)) throw new Error("角色朝向数量无效（最多 25 张）");
  const ids = new Set(), angles = new Set();
  for (const pose of manifest.poses || []) {
    if (!pose || !safeKey(pose.id) || ids.has(pose.id) || !Number.isFinite(pose.yaw) || !Number.isFinite(pose.pitch)
      || Math.abs(pose.yaw) > 1 || Math.abs(pose.pitch) > 1) throw new Error("角色朝向标识或角度无效");
    const key = `${pose.yaw},${pose.pitch}`;
    if (angles.has(key)) throw new Error("角色朝向角度重复");
    ids.add(pose.id); angles.add(key);
    if (pose.layers !== undefined && (!pose.layers || typeof pose.layers !== "object" || Array.isArray(pose.layers)
      || Object.keys(pose.layers).some((name) => !Object.hasOwn(LAYER_KINDS, name)))) throw new Error("角色朝向绘制层无效");
    const layers = {};
    for (const layerId of DRAW_ORDER) {
      const override = pose.layers?.[layerId];
      if (override !== undefined && (!override || typeof override !== "object" || Array.isArray(override))) throw new Error("角色朝向绘制层覆盖无效");
      layers[layerId] = validateLayer(layerId, { ...result.layers[layerId], ...override });
    }
    result.poses.push({ id: pose.id, yaw: pose.yaw, pitch: pose.pitch, base: localAsset(pose.base), layers });
  }
  if (!angles.has("0,0")) {
    if (ids.has("front") || result.poses.length >= 25) throw new Error("角色朝向必须为正面保留一个位置");
    result.poses.unshift({ id: "front", yaw: 0, pitch: 0, base: result.base, layers: result.layers });
  }
  return result;
}

function imageSize(image) {
  const width = image.naturalWidth ?? image.width, height = image.naturalHeight ?? image.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > 67_108_864) throw new Error("角色图集图片尺寸无效或过大");
  return [width, height];
}

/**
 * Painted fixed-rectangle compositor. No WebGL, UV warps, procedural skin,
 * expression-dependent scaling, or full-face crossfades. Atlas images load once.
 * Supply only a manifest imported by the app, not a user-provided path/JSON.
 */
export class PaintedAvatar {
  constructor({ createCanvas, createImage, timeoutMs = 15_000 } = {}) {
    this._createCanvas = createCanvas || (() => typeof document !== "undefined" ? document.createElement("canvas") : null);
    this.canvas = this._createCanvas();
    this._createImage = createImage || (() => typeof Image !== "undefined" ? new Image() : null);
    this._timeoutMs = clamp(finite(timeoutMs, 15_000), 1, 60_000);
    this._context = this.canvas?.getContext("2d") || null;
    this._manifest = null;
    this._images = new Map();
    this._choices = {};
    this._transitions = {};
    this._pose = null;
    this._blendSize = [1, 1];
    this._eyeScratchCanvas = null;
    this._eyeScratchContext = null;
    this._hasComposition = false;
    this._loadController = null;
    this._loadSequence = 0;
    this._disposed = false;
  }

  _loadImage(path, signal) {
    if (this._images.has(path)) return Promise.resolve(this._images.get(path));
    return new Promise((resolve, reject) => {
      const image = this._createImage();
      if (!image) { reject(new Error("当前环境无法加载角色图片")); return; }
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        image.onload = image.onerror = null;
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(image);
      };
      const onAbort = () => {
        finish(signal.reason instanceof Error ? signal.reason : abortError());
        image.removeAttribute?.("src");
      };
      image.onload = () => { try { imageSize(image); finish(); } catch (error) { finish(error); } };
      image.onerror = () => finish(new Error(`角色图集载入失败：${path}`));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      try { image.src = path; } catch (error) { finish(error); }
    });
  }

  async load(manifest, { signal } = {}) {
    if (this._disposed) throw new Error("角色绘制器已销毁");
    if (!this._context) throw new Error("当前环境不支持角色绘制");
    const next = validatePaintedManifest(manifest);
    if (signal?.aborted) throw abortError();
    this._loadController?.abort(abortError("已切换到另一个角色图集"));
    const sequence = ++this._loadSequence;
    const controller = new AbortController();
    this._loadController = controller;
    const onAbort = () => controller.abort(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("角色图集加载超时，请重试")), this._timeoutMs);
    try {
      const paths = [...new Set([next.base, ...Object.values(next.atlases).map((atlas) => atlas.src), ...next.poses.map((pose) => pose.base)])];
      const images = new Map();
      let cursor = 0, decodedPixels = 0;
      // Decode at most four local images concurrently. Large pose packs have
      // an aggregate decoded-pixel budget, not an unbounded image per frame.
      await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
        while (cursor < paths.length) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const path = paths[cursor++], image = await this._loadImage(path, controller.signal);
          const [width, height] = imageSize(image);
          decodedPixels += width * height;
          if (decodedPixels > 67_108_864) throw new Error("角色朝向与表情图集总尺寸过大");
          images.set(path, image);
        }
      }));
      if (controller.signal.aborted || this._disposed || sequence !== this._loadSequence) throw abortError();
      for (const atlas of Object.values(next.atlases)) {
        const [width, height] = imageSize(images.get(atlas.src));
        for (const frame of Object.values(atlas.frames)) if (frame[0] + frame[2] > width || frame[1] + frame[3] > height) throw new Error("表情关键帧超出图集边界");
      }
      this._manifest = next;
      this._images = images;
      this._choices = {};
      this._transitions = {};
      this._pose = selectPaintedPose(next.poses);
      const blendLayers = next.poses.flatMap((pose) => BLEND_LAYERS.map((name) => pose.layers[name]));
      this._blendSize = [Math.ceil(Math.max(...blendLayers.map((layer) => layer.dest[2]))), Math.ceil(Math.max(...blendLayers.map((layer) => layer.dest[3])))];
      this._hasComposition = false;
      this.canvas.width = next.width;
      this.canvas.height = next.height;
      return this;
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (sequence === this._loadSequence) this._loadController = null;
    }
  }

  render(channels = {}, intensity = {}, dt = 0, pose = {}) {
    if (this._disposed || !this._manifest || !this._context) return null;
    // dt is seconds. FaceSession already smooths coefficients: no extra EMA.
    // Only neighbouring feature drawings overlap (eye 30 ms / mouth 40 ms).
    // A large expression or pose jump is immediate, never a full-face fade.
    const delta = clamp(finite(dt), 0, .1);
    const manifest = this._manifest;
    const selectedPose = selectPaintedPose(manifest.poses, pose, this._pose?.id);
    const poseChanged = selectedPose.id !== this._pose?.id;
    const frames = selectPaintedFrames(channels, intensity, this._choices, manifest.sequences);
    const frameChanged = DRAW_ORDER.some((layerId) => frames[layerId] !== this._choices[layerId]);
    const hadTransition = Object.values(this._transitions).some(Boolean);
    // The caller may still animate the composited canvas's position/rotation.
    // Reuse its pixels until a painted feature or local transition changes.
    if (this._hasComposition && !frameChanged && !hadTransition && !poseChanged) return this.canvas;
    this._hasComposition = false;
    if (poseChanged) this._transitions = {};
    this._pose = selectedPose;
    for (const layerId of BLEND_LAYERS) {
      const oldFrame = this._choices[layerId], newFrame = frames[layerId];
      if (oldFrame !== newFrame) {
        this._transitions[layerId] = !poseChanged && delta > 0 && adjacentSequence(layerId, oldFrame, newFrame, manifest.sequences)
          ? { from: oldFrame, elapsed: 0, duration: layerId === "mouth" ? .040 : .030 } : null;
      }
      const transition = this._transitions[layerId];
      if (transition) {
        transition.elapsed += delta;
        if (delta === 0 || transition.elapsed >= transition.duration) this._transitions[layerId] = null;
      }
    }
    this._choices = frames;
    const ctx = this._context;
    ctx.save();
    try {
      ctx.setTransform?.(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, manifest.width, manifest.height);
      ctx.drawImage(this._images.get(selectedPose.base), 0, 0, manifest.width, manifest.height);
      for (const layerId of DRAW_ORDER) {
        const layer = selectedPose.layers[layerId], atlas = manifest.atlases[layer.atlas];
        if (!layer.visible) continue;
        const image = this._images.get(atlas.src);
        const [x, y, width, height] = layer.dest;
        ctx.save();
        try {
          if (layer.clip) {
            ctx.beginPath();
            layer.clip.forEach(([px, py], index) => index === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
            ctx.closePath();
            ctx.clip();
          }
          if (layer.flipX) {
            ctx.translate(x + width, y);
            ctx.scale(-1, 1);
          }
          const draw = (frame, alpha = 1) => {
            ctx.save();
            try {
              ctx.globalAlpha = alpha;
              const dx = layer.flipX ? 0 : x, dy = layer.flipX ? 0 : y;
              // Frame mirroring composes with the already applied layer flip:
              // two mirrors cancel (XOR), without moving or warping the art.
              if (atlas.flipFrames.includes(frame)) {
                ctx.translate(dx + width, dy);
                ctx.scale(-1, 1);
                ctx.drawImage(image, ...atlas.frames[frame], 0, 0, width, height);
              } else ctx.drawImage(image, ...atlas.frames[frame], dx, dy, width, height);
            } finally { ctx.restore(); }
          };
          const transition = this._transitions[layerId];
          if (transition) {
            const progress = transition.elapsed / transition.duration;
            const scratch = this._blendFeature(image, atlas.frames[transition.from], atlas.frames[frames[layerId]], width, height, progress,
              atlas.flipFrames.includes(transition.from), atlas.flipFrames.includes(frames[layerId]));
            if (scratch) {
              ctx.globalAlpha = 1;
              ctx.drawImage(scratch, 0, 0, width, height, layer.flipX ? 0 : x, layer.flipX ? 0 : y, width, height);
            } else draw(frames[layerId]);
          } else draw(frames[layerId]);
        } finally { ctx.restore(); }
      }
    } finally { ctx.restore(); }
    this._hasComposition = true;
    return this.canvas;
  }

  _blendFeature(image, from, to, width, height, progress, flipFrom = false, flipTo = false) {
    if (!this._eyeScratchCanvas) {
      const canvas = this._createCanvas();
      // A custom canvas factory may only supply the main canvas. Fall back to
      // a clean discrete drawing rather than clearing it or fading the eye.
      if (!canvas || canvas === this.canvas) return null;
      this._eyeScratchCanvas = canvas;
      this._eyeScratchContext = canvas.getContext("2d");
    }
    const canvas = this._eyeScratchCanvas, ctx = this._eyeScratchContext;
    if (!ctx) return null;
    // One small reusable buffer serves both eyes and mouth. Its size depends on
    // manifest, never expression coefficients; no canvas allocation per frame.
    const [maxWidth, maxHeight] = this._blendSize;
    if (canvas.width !== maxWidth) canvas.width = maxWidth;
    if (canvas.height !== maxHeight) canvas.height = maxHeight;
    ctx.save();
    try {
      ctx.setTransform?.(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // 'lighter' adds premultiplied RGB AND alpha. Where both drawings are
      // opaque, (1 - t) + t stays opaque instead of source-over's .75 at t=.5.
      const draw = (source, alpha, flipped, composite) => {
        ctx.save();
        try {
          ctx.globalCompositeOperation = composite;
          ctx.globalAlpha = alpha;
          if (flipped) { ctx.translate(width, 0); ctx.scale(-1, 1); }
          ctx.drawImage(image, ...source, 0, 0, width, height);
        } finally { ctx.restore(); }
      };
      draw(from, 1 - progress, flipFrom, "source-over");
      draw(to, progress, flipTo, "lighter");
    } finally { ctx.restore(); }
    return canvas;
  }

  get frames() { return { ...this._choices }; }
  get loaded() { return !this._disposed && this._manifest !== null; }
  get baseImage() { return this.loaded ? this._images.get(this._manifest.base) : null; }
  get poseId() { return this.loaded ? this._pose?.id ?? null : null; }
  get pose() { return this.loaded && this._pose ? { id: this._pose.id, yaw: this._pose.yaw, pitch: this._pose.pitch } : null; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._loadSequence += 1;
    this._loadController?.abort(abortError("角色绘制器已销毁"));
    this._loadController = null;
    this._manifest = null;
    this._images.clear();
    this._choices = {};
    this._transitions = {};
    this._pose = null;
    this._blendSize = [1, 1];
    this._hasComposition = false;
    if (this._eyeScratchCanvas) this._eyeScratchCanvas.width = this._eyeScratchCanvas.height = 1;
    this._eyeScratchCanvas = null;
    this._eyeScratchContext = null;
    if (this.canvas) this.canvas.width = this.canvas.height = 1;
    this._context = null;
  }
}
