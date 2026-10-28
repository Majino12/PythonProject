const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export const PAINTED_FRAME_SETS = Object.freeze({
  eyes: Object.freeze(["open", "quarter", "half", "threeQuarter", "closed", "happyClosed"]),
  brows: Object.freeze(["neutral", "up", "down", "worried", "outerUp"]),
  mouth: Object.freeze(["closed", "openSmall", "openMedium", "openWide", "smileClosed", "smileOpen", "frownClosed", "frownOpen", "funnel", "pucker", "press"]),
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
const APPROXIMATE_CHANNELS = new Set(["cheekSquintLeft", "cheekSquintRight", "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "mouthFrownLeft", "mouthFrownRight", "mouthPressLeft", "mouthPressRight", "mouthSmileLeft", "mouthSmileRight"]);

/** Finite painted states, not 52 independent meshes or independently drawn lip corners. */
export const PAINTED_CHANNEL_SUPPORT = Object.freeze(Object.fromEntries(ALL_CHANNELS.map((key) => [key,
  DIRECT_CHANNELS.has(key) ? "frame" : APPROXIMATE_CHANNELS.has(key) ? "approximate" : "unsupported",
])));

// Pure translation paintings opt in separately from directional pucker. Each
// sequence contains non-neutral paintings ordered weak -> strong, in the
// character's anatomical direction. Legacy `side` is never an opt-in.
function independentMouthSequenceKeys(sequences, name) {
  const frames = sequences?.[name];
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > 32
    || !frames.every(safeKey) || new Set(frames).size !== frames.length) return false;
  const otherKeys = new Set(["side", ...PAINTED_FRAME_SETS.mouth,
    ...Object.entries(sequences).filter(([key]) => key !== name).flatMap(([, sequence]) => Array.isArray(sequence) ? sequence : [])]);
  return frames.every((key) => !otherKeys.has(key));
}

function hasIndependentMouthArtwork(manifest, name) {
  if (!independentMouthSequenceKeys(manifest?.sequences, name)) return false;
  const sequence = manifest.sequences[name];
  const layers = [manifest?.layers?.mouth, ...(manifest?.poses || []).map((pose) => ({ ...manifest?.layers?.mouth, ...pose.layers?.mouth }))];
  return layers.every((layer) => {
    const frames = manifest?.atlases?.[layer?.atlas]?.frames;
    return frames && sequence.every((key) => {
      const rect = frames[key];
      return Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite) && rect[2] > 0 && rect[3] > 0
        && Object.entries(frames).every(([otherKey, other]) => otherKey === key || !Array.isArray(other)
          || other.some((value, index) => value !== rect[index]));
    });
  });
}

/** Resource-aware support: layered eyes opt in per eye; independent mouth
 * shifts require their own source rectangles in every pose's mouth atlas.
 * This describes asset availability, not a visual-quality approval. */
export function paintedChannelSupport(manifest) {
  const support = { ...PAINTED_CHANNEL_SUPPORT };
  for (const [layerId, side] of [["leftEye", "Left"], ["rightEye", "Right"]]) {
    const layers = [manifest?.layers?.[layerId], ...(manifest?.poses || []).map((pose) => ({ ...manifest?.layers?.[layerId], ...pose.layers?.[layerId] }))];
    if (layers.some((layer) => manifest?.atlases?.[layer?.atlas]?.gaze)) {
      for (const direction of ["Up", "Down", "In", "Out"]) support[`eyeLook${direction}${side}`] = "approximate";
    }
  }
  for (const name of ["mouthLeft", "mouthRight"]) {
    if (hasIndependentMouthArtwork(manifest, name)) support[name] = "frame";
  }
  return Object.freeze(support);
}

/** Pure gaze in canvas directions (+x right, +y down). Anatomical left/right
 * channels are independent; static pose bias is additive and can be cancelled.
 * Sprite mirroring is a rendering detail and must never reverse these values. */
export function selectPaintedGaze(channels = {}, intensity = {}, layers = {}) {
  const gain = clamp(finite(intensity?.gaze, finite(intensity?.expression, 1)), 0, 1.5);
  const value = (key) => clamp(finite(channels?.[key]));
  const select = (side, layerId) => {
    const bias = layers?.[layerId]?.gazeBias;
    const horizontal = value(`eyeLookOut${side}`) - value(`eyeLookIn${side}`);
    return {
      x: clamp(horizontal * (side === "Left" ? 1 : -1) * gain + finite(bias?.[0]), -1, 1),
      y: clamp((value(`eyeLookDown${side}`) - value(`eyeLookUp${side}`)) * gain + finite(bias?.[1]), -1, 1),
    };
  };
  return { leftEye: select("Left", "leftEye"), rightEye: select("Right", "rightEye") };
}

const LAYER_KINDS = Object.freeze({ leftEye: "eyes", rightEye: "eyes", leftBrow: "brows", rightBrow: "brows", mouth: "mouth" });
const DRAW_ORDER = Object.freeze(["leftEye", "rightEye", "leftBrow", "rightBrow", "mouth"]);
const BROW_SEQUENCES = Object.freeze(["browUp", "browDown", "browWorried", "browOuterUp"]);
const SEQUENCE_KINDS = Object.freeze({ eyes: "eyes", jaw: "mouth", pucker: "mouth", press: "mouth", puckerLeft: "mouth", puckerRight: "mouth", funnel: "mouth", mouthLeft: "mouth", mouthRight: "mouth",
  browUp: "brows", browDown: "brows", browWorried: "brows", browOuterUp: "brows" });
const DEFAULT_EYES = PAINTED_FRAME_SETS.eyes.slice(0, 5);
const DEFAULT_JAW = ["closed", "openSmall", "openMedium", "openWide"];
const BLEND_LAYERS = Object.freeze(["leftEye", "rightEye", "leftBrow", "rightBrow", "mouth"]);

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
 * finite painted states. Press > closure > pucker > funnel > independent shift > emotion > jaw.
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
    if (BROW_SEQUENCES.some((name) => sequences[name])) {
      const holding = (name, fallback) => oldFrame === fallback || oldFrame !== "neutral" && sequences[name]?.includes(oldFrame);
      const choose = (name, amount, fallback, enter, leave) => {
        const frames = sequences[name];
        if (!frames) return amount >= threshold(oldFrame, fallback, enter, leave) ? fallback : "neutral";
        // Every brow sequence starts with the same neutral drawing. A usual
        // [neutral, soft, mid, strong] sequence activates at .12/.41/.70,
        // with .018 hysteresis after expression gain. Smaller tracked raises
        // are therefore visible without amplifying or moving the artwork.
        const boundaries = frames.slice(1).map((_, index) => frames.length === 2 ? .12 : .12 + index * .58 / (frames.length - 2));
        return frames[paintedFrameIndex(amount, frames.indexOf(oldFrame), boundaries, .018)];
      };
      const pressure = choose("browDown", down, "down", .58, .46);
      if (pressure !== "neutral" && down >= (holding("browDown", "down") ? .46 : .58)) return pressure;
      const worry = choose("browWorried", inner, "worried", .46, .36);
      const wasWorried = holding("browWorried", "worried");
      const worryContext = sequences.browWorried
        ? (down >= (wasWorried ? .12 : .18) || frown >= (wasWorried ? .12 : .20)) && outer < (wasWorried ? .55 : .50)
        : (down >= .18 || frown >= .43) && outer < .50;
      if (worry !== "neutral" && worryContext) return worry;
      // Mild pressure should not hide a much stronger raise because of a
      // small noisy down coefficient. A short dominance band avoids chatter.
      if (pressure !== "neutral" && down >= Math.max(inner, outer) + (holding("browDown", "down") ? -.035 : .035)) return pressure;
      const outerRaise = choose("browOuterUp", outer, "outerUp", .52, .40);
      if (outerRaise !== "neutral" && inner < .43
        && (!sequences.browOuterUp || outer > inner + (holding("browOuterUp", "outerUp") ? .02 : .06))) return outerRaise;
      return choose("browUp", Math.max(inner, outer), "up", .46, .34);
    }
    // No optional brow sequences: preserve the original five-state pack.
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
    const direction = value("mouthLeft") - value("mouthRight");
    const shiftName = direction > 0 ? "mouthLeft" : "mouthRight";
    if (independentMouthSequenceKeys(sequences, shiftName)) {
      const shift = sequences[shiftName];
      if (Math.abs(direction) >= (shift.includes(oldFrame) ? .15 : .25)) return staged(shift, Math.abs(direction), oldFrame, false);
    }
    // A pack without independent shift drawings preserves the other mouth
    // inputs. Never substitute a pucker painting or the old ambiguous `side`.
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
    ? [sequences.jaw || DEFAULT_JAW, sequences.pucker, sequences.press, sequences.puckerLeft, sequences.puckerRight, sequences.funnel, sequences.mouthLeft, sequences.mouthRight]
    : LAYER_KINDS[layerId] === "brows" ? BROW_SEQUENCES.map((name) => sequences[name]) : [sequences.eyes || DEFAULT_EYES];
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

function normalizedPair(value, description, min, max) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((part) => Number.isFinite(part) && part >= min && part <= max)) throw new Error(`${description}无效`);
  return [...value];
}

function validateGaze(gaze, frames) {
  if (!gaze || typeof gaze !== "object" || Array.isArray(gaze)) throw new Error("分层眼球配置无效");
  const iris = rectangle(gaze.iris, "虹膜局部");
  if (iris[0] + iris[2] > 1 || iris[1] + iris[3] > 1) throw new Error("虹膜局部矩形超出归一化范围");
  if (!gaze.apertures || typeof gaze.apertures !== "object" || Array.isArray(gaze.apertures)
    || Object.keys(gaze.apertures).some((key) => !safeKey(key) || !Object.hasOwn(frames, key))) throw new Error("眼白孔洞关键帧无效");
  const apertures = {};
  for (const key of Object.keys(frames)) {
    const aperture = gaze.apertures[key];
    if (!Array.isArray(aperture)) throw new Error(`${key} 缺少眼白孔洞`);
    if (aperture.length === 0) { apertures[key] = []; continue; }
    if (key === "closed" || key === "happyClosed") throw new Error("闭眼关键帧的眼白孔洞必须为空");
    const polygon = clipPolygon(aperture, 1, 1);
    const twiceArea = polygon.reduce((sum, [x, y], index) => {
      const next = polygon[(index + 1) % polygon.length];
      return sum + x * next[1] - next[0] * y;
    }, 0);
    if (Math.abs(twiceArea) < 1e-7) throw new Error(`${key} 眼白孔洞面积无效`);
    apertures[key] = polygon;
  }
  return { src: localAsset(gaze.src), rect: rectangle(gaze.rect, "虹膜源"), iris,
    range: normalizedPair(gaze.range, "眼球活动范围", 0, .5), apertures };
}

/** Validate/copy trusted, imported built-in manifest data; never accept file or remote URLs. */
export function validatePaintedManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Number.isInteger(manifest.width) || !Number.isInteger(manifest.height)
    || manifest.width < 1 || manifest.height < 1 || manifest.width > 4096 || manifest.height > 4096) throw new Error("角色图集尺寸或版本无效");
  const result = { version: 1, width: manifest.width, height: manifest.height, base: localAsset(manifest.base), atlases: {}, layers: {}, sequences: {}, poses: [] };
  if (manifest.sequences !== undefined && (!manifest.sequences || typeof manifest.sequences !== "object" || Array.isArray(manifest.sequences))) throw new Error("表情序列无效");
  for (const [name, frames] of Object.entries(manifest.sequences || {})) {
    const isBrow = BROW_SEQUENCES.includes(name);
    if (!Object.hasOwn(SEQUENCE_KINDS, name) || !Array.isArray(frames) || frames.length < (name === "eyes" || name === "jaw" || isBrow ? 2 : 1)
      || frames.length > 32 || !frames.every(safeKey) || new Set(frames).size !== frames.length) throw new Error(`表情序列 ${name} 无效`);
    if (isBrow && frames[0] !== "neutral") throw new Error(`眉毛序列 ${name} 必须从 neutral 开始`);
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
    if (layer.gazeBias !== undefined) {
      if (kind !== "eyes") throw new Error("仅眼睛绘制层可设置视线偏置");
      validated.gazeBias = normalizedPair(layer.gazeBias, "视线偏置", -1, 1);
    }
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
      if (atlas.gaze !== undefined) result.atlases[layer.atlas].gaze = validateGaze(atlas.gaze, frames);
    }
    if (result.atlases[layer.atlas].gaze && kind !== "eyes") throw new Error("分层虹膜图集仅可用于眼睛");
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
  for (const name of ["mouthLeft", "mouthRight"]) {
    if (result.sequences[name] && !hasIndependentMouthArtwork(result, name)) throw new Error(`独立移嘴序列 ${name} 必须使用独有画稿，不可复用其他口型或左右同稿`);
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
    this._gazeScratchCanvas = null;
    this._gazeScratchContext = null;
    this._gaze = selectPaintedGaze();
    this._channelSupport = PAINTED_CHANNEL_SUPPORT;
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
      const paths = [...new Set([next.base, ...Object.values(next.atlases).flatMap((atlas) => atlas.gaze ? [atlas.src, atlas.gaze.src] : [atlas.src]), ...next.poses.map((pose) => pose.base)])];
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
        if (atlas.gaze) {
          const [irisWidth, irisHeight] = imageSize(images.get(atlas.gaze.src));
          const rect = atlas.gaze.rect;
          if (rect[0] + rect[2] > irisWidth || rect[1] + rect[3] > irisHeight) throw new Error("虹膜源矩形超出图集边界");
        }
      }
      this._manifest = next;
      this._images = images;
      this._choices = {};
      this._transitions = {};
      this._pose = selectPaintedPose(next.poses);
      this._gaze = selectPaintedGaze();
      this._channelSupport = paintedChannelSupport(next);
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
    // dt is seconds. Frame channels use no extra EMA. Only the continuously
    // translated iris receives a short 35 ms response, with a finite snap.
    // Only neighbouring drawings overlap (eye 30 / brow 35 / mouth 40 ms).
    // A large expression or pose jump is immediate, never a full-face fade.
    const delta = clamp(finite(dt), 0, .1);
    const manifest = this._manifest;
    const selectedPose = selectPaintedPose(manifest.poses, pose, this._pose?.id);
    const poseChanged = selectedPose.id !== this._pose?.id;
    const frames = selectPaintedFrames(channels, intensity, this._choices, manifest.sequences);
    const frameChanged = DRAW_ORDER.some((layerId) => frames[layerId] !== this._choices[layerId]);
    const hadTransition = Object.values(this._transitions).some(Boolean);
    const targetGaze = selectPaintedGaze(channels, intensity, selectedPose.layers);
    const gazeStep = delta === 0 || poseChanged || !this._hasComposition ? 1 : 1 - Math.exp(-delta / .035);
    let gazeChanged = false;
    for (const layerId of ["leftEye", "rightEye"]) {
      const layer = selectedPose.layers[layerId], enabled = Boolean(manifest.atlases[layer.atlas].gaze);
      const old = this._gaze[layerId], target = enabled ? targetGaze[layerId] : { x: 0, y: 0 };
      const smooth = (axis) => {
        const next = old[axis] + (target[axis] - old[axis]) * gazeStep;
        return Math.abs(next - target[axis]) < .002 ? target[axis] : next;
      };
      const next = { x: smooth("x"), y: smooth("y") };
      if (enabled && layer.visible && (next.x !== old.x || next.y !== old.y)) gazeChanged = true;
      this._gaze[layerId] = next;
    }
    // The caller may still animate the composited canvas's position/rotation.
    // Reuse its pixels until a painted feature or local transition changes.
    if (this._hasComposition && !frameChanged && !hadTransition && !poseChanged && !gazeChanged) return this.canvas;
    this._hasComposition = false;
    if (poseChanged) this._transitions = {};
    this._pose = selectedPose;
    for (const layerId of BLEND_LAYERS) {
      const oldFrame = this._choices[layerId], newFrame = frames[layerId];
      if (oldFrame !== newFrame) {
        this._transitions[layerId] = !poseChanged && delta > 0 && adjacentSequence(layerId, oldFrame, newFrame, manifest.sequences)
          ? { from: oldFrame, elapsed: 0, duration: layerId === "mouth" ? .040 : LAYER_KINDS[layerId] === "brows" ? .035 : .030 } : null;
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
              if (atlas.gaze) {
                ctx.translate(dx, dy);
                this._drawGazeEye(ctx, atlas, frame, width, height, this._gaze[layerId], layer.flipX);
                return;
              }
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
            const scratch = atlas.gaze
              ? this._blendGazeEye(atlas, transition.from, frames[layerId], width, height, progress, this._gaze[layerId], layer.flipX)
              : this._blendFeature(image, atlas.frames[transition.from], atlas.frames[frames[layerId]], width, height, progress,
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

  _prepareScratch(gazeEndpoint = false) {
    const canvasKey = gazeEndpoint ? "_gazeScratchCanvas" : "_eyeScratchCanvas";
    const contextKey = gazeEndpoint ? "_gazeScratchContext" : "_eyeScratchContext";
    if (!this[canvasKey]) {
      const canvas = this._createCanvas();
      // A custom canvas factory may only supply the main canvas. Fall back to
      // a clean discrete drawing rather than clearing it or fading the eye.
      if (!canvas || canvas === this.canvas || canvas === this._eyeScratchCanvas || canvas === this._gazeScratchCanvas) return null;
      this[canvasKey] = canvas;
      this[contextKey] = canvas.getContext("2d");
    }
    const canvas = this[canvasKey], ctx = this[contextKey];
    if (!ctx) return null;
    // One small reusable buffer serves both eyes and mouth. Its size depends on
    // manifest, never expression coefficients; no canvas allocation per frame.
    const [maxWidth, maxHeight] = this._blendSize;
    if (canvas.width !== maxWidth) canvas.width = maxWidth;
    if (canvas.height !== maxHeight) canvas.height = maxHeight;
    return { canvas, ctx };
  }

  _blendFeature(image, from, to, width, height, progress, flipFrom = false, flipTo = false) {
    const buffer = this._prepareScratch();
    if (!buffer) return null;
    const { canvas, ctx } = buffer;
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

  _drawGazeEye(ctx, atlas, frame, width, height, gaze, layerFlip) {
    const config = atlas.gaze, frameFlip = atlas.flipFrames.includes(frame);
    ctx.save();
    try {
      if (frameFlip) { ctx.translate(width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(this._images.get(atlas.src), ...atlas.frames[frame], 0, 0, width, height);
      const aperture = config.apertures[frame];
      // A fully closed painting has no opening: never draw any iris over it.
      if (aperture.length === 0) return;
      ctx.save();
      try {
        ctx.beginPath();
        aperture.forEach(([u, v], index) => index === 0 ? ctx.moveTo(u * width, v * height) : ctx.lineTo(u * width, v * height));
        ctx.closePath();
        ctx.clip();
        const [u, v, iw, ih] = config.iris;
        // Aperture/iris registration belongs to the unmirrored art. Invert
        // only local horizontal travel under XOR mirroring so WORLD gaze
        // remains the same. Size never depends on blink or look coefficients.
        const dx = gaze.x * config.range[0] * (frameFlip !== layerFlip ? -1 : 1);
        const dy = gaze.y * config.range[1];
        ctx.drawImage(this._images.get(config.src), ...config.rect, (u + dx) * width, (v + dy) * height, iw * width, ih * height);
      } finally { ctx.restore(); }
    } finally { ctx.restore(); }
  }

  _blendGazeEye(atlas, from, to, width, height, progress, gaze, layerFlip) {
    const blend = this._prepareScratch(), endpoint = this._prepareScratch(true);
    if (!blend || !endpoint) return null;
    const { canvas, ctx } = blend;
    ctx.save();
    try {
      ctx.setTransform?.(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const draw = (frame, alpha, composite) => {
        const target = endpoint.ctx;
        target.save();
        try {
          target.setTransform?.(1, 0, 0, 1, 0, 0);
          target.clearRect(0, 0, endpoint.canvas.width, endpoint.canvas.height);
          target.globalAlpha = 1;
          target.globalCompositeOperation = "source-over";
          target.imageSmoothingEnabled = true;
          target.imageSmoothingQuality = "high";
          this._drawGazeEye(target, atlas, frame, width, height, gaze, layerFlip);
        } finally { target.restore(); }
        ctx.globalAlpha = alpha;
        ctx.globalCompositeOperation = composite;
        ctx.drawImage(endpoint.canvas, 0, 0, width, height, 0, 0, width, height);
      };
      // Each endpoint gets its OWN aperture before alpha weighting. Clipping
      // only the final blend would leak iris across one endpoint's eyelid.
      draw(from, 1 - progress, "source-over");
      draw(to, progress, "lighter");
    } finally { ctx.restore(); }
    return canvas;
  }

  get frames() { return { ...this._choices }; }
  get loaded() { return !this._disposed && this._manifest !== null; }
  get baseImage() { return this.loaded ? this._images.get(this._manifest.base) : null; }
  get poseId() { return this.loaded ? this._pose?.id ?? null : null; }
  get pose() { return this.loaded && this._pose ? { id: this._pose.id, yaw: this._pose.yaw, pitch: this._pose.pitch } : null; }
  get channelSupport() { return this._channelSupport; }
  get gaze() { return { leftEye: { ...this._gaze.leftEye }, rightEye: { ...this._gaze.rightEye } }; }

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
    this._gaze = selectPaintedGaze();
    this._channelSupport = PAINTED_CHANNEL_SUPPORT;
    this._hasComposition = false;
    if (this._eyeScratchCanvas) this._eyeScratchCanvas.width = this._eyeScratchCanvas.height = 1;
    this._eyeScratchCanvas = null;
    this._eyeScratchContext = null;
    if (this._gazeScratchCanvas) this._gazeScratchCanvas.width = this._gazeScratchCanvas.height = 1;
    this._gazeScratchCanvas = null;
    this._gazeScratchContext = null;
    if (this.canvas) this.canvas.width = this.canvas.height = 1;
    this._context = null;
  }
}
