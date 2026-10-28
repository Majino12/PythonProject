import { PaintedAvatar, validatePaintedManifest } from "./painted-avatar.js";
import { LUNA_PAINTED_MANIFEST } from "./painted-luna.js";

const CROP = Object.freeze({ x: 180, y: 200, width: 700, height: 580 });
const CELL = Object.freeze({ width: 350, height: 290 });
const controls = document.querySelector("#galleryControls");
const gallery = document.querySelector("#paintedGallery");
const status = document.querySelector("#galleryStatus");
const mouthSupport = document.querySelector("#galleryMouthSupport");
const presetButtons = [...document.querySelectorAll("[data-gallery-preset]")];
const gazeButtons = [...document.querySelectorAll("[data-gallery-gaze]")];
const browButtons = [...document.querySelectorAll("[data-gallery-brow]")];
const sliders = Object.fromEntries([...document.querySelectorAll("[data-gallery-channel]")]
  .map((input) => [input.dataset.galleryChannel, input]));
const direction = document.querySelector("#galleryPuckerDirection");
const renderer = new PaintedAvatar();
const manifest = validatePaintedManifest(LUNA_PAINTED_MANIFEST);
const cards = new Map();
let activePreset = "neutral";
let redrawQueued = false;

const presets = Object.freeze({
  neutral: { blink: 0, jaw: 0, pucker: 0, press: 0, direction: "center" },
  blink: { blink: 1, jaw: 0, pucker: 0, press: 0, direction: "center" },
  jaw: { blink: 0, jaw: 1, pucker: 0, press: 0, direction: "center" },
  mouthLeft: { blink: 0, jaw: 0, pucker: 0, press: 0, direction: "left" },
  mouthRight: { blink: 0, jaw: 0, pucker: 0, press: 0, direction: "right" },
  puckerLeft: { blink: 0, jaw: 0, pucker: .92, press: 0, direction: "left" },
  puckerRight: { blink: 0, jaw: 0, pucker: .92, press: 0, direction: "right" },
  press: { blink: 0, jaw: 0, pucker: 0, press: .92, direction: "center" },
});

function syncControls() {
  for (const input of Object.values(sliders)) {
    const output = input.closest("label")?.querySelector("output");
    if (output) output.textContent = `${Math.round(Number(input.value) * 100)}%`;
  }
  for (const button of presetButtons) button.setAttribute("aria-pressed", String(button.dataset.galleryPreset === activePreset));
  for (const button of gazeButtons) button.setAttribute("aria-pressed", String(Number(button.dataset.galleryGaze) === Number(sliders.gaze.value)));
  for (const button of browButtons) button.setAttribute("aria-pressed", String(button.dataset.galleryBrow === sliders.browMode.value));
}

function channelsFromControls() {
  const blink = Number(sliders.blink.value);
  const jaw = Number(sliders.jaw.value);
  const pucker = Number(sliders.pucker.value);
  const press = Number(sliders.press.value);
  const gaze = Math.max(-1, Math.min(1, Number(sliders.gaze.value) || 0));
  const brow = Math.max(0, Math.min(1, Number(sliders.brow?.value) || 0));
  const browMode = sliders.browMode?.value || "neutral";
  const browChannels = sliders.brow ? {
    browInnerUp: ["raise", "worried"].includes(browMode) ? brow : 0,
    browDownLeft: browMode === "frown" ? brow : 0,
    browDownRight: browMode === "frown" ? brow : 0,
    browOuterUpLeft: browMode === "outerLeft" ? brow : 0,
    browOuterUpRight: browMode === "outerRight" ? brow : 0,
    mouthFrownLeft: browMode === "worried" ? brow : 0,
    mouthFrownRight: browMode === "worried" ? brow : 0,
  } : {};
  return {
    eyeBlinkLeft: blink,
    eyeBlinkRight: blink,
    jawOpen: jaw,
    mouthPucker: pucker,
    mouthPressLeft: press,
    mouthPressRight: press,
    mouthLeft: direction.value === "left" ? .8 : 0,
    mouthRight: direction.value === "right" ? .8 : 0,
    eyeLookUpLeft: Math.max(0, gaze),
    eyeLookUpRight: Math.max(0, gaze),
    eyeLookDownLeft: Math.max(0, -gaze),
    eyeLookDownRight: Math.max(0, -gaze),
    ...browChannels,
  };
}

function redraw() {
  redrawQueued = false;
  const channels = channelsFromControls();
  for (const pose of manifest.poses) {
    const composed = renderer.render(channels, { blink: 1, mouth: 1, expression: 1 }, 0, pose);
    const canvas = cards.get(pose.id);
    const context = canvas?.getContext("2d");
    if (!composed || !context) continue;
    context.clearRect(0, 0, CELL.width, CELL.height);
    context.drawImage(composed, CROP.x, CROP.y, CROP.width, CROP.height, 0, 0, CELL.width, CELL.height);
  }
}

function scheduleRedraw() {
  syncControls();
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(redraw);
}

function applyPreset(name) {
  const preset = presets[name];
  if (!preset) return;
  activePreset = name;
  for (const key of ["blink", "jaw", "pucker", "press"]) sliders[key].value = String(preset[key]);
  direction.value = preset.direction;
  scheduleRedraw();
}

function buildCards() {
  const fragment = document.createDocumentFragment();
  for (const pose of manifest.poses) {
    const figure = document.createElement("figure");
    const canvas = document.createElement("canvas");
    const caption = document.createElement("figcaption");
    const angle = document.createElement("small");
    canvas.width = CELL.width;
    canvas.height = CELL.height;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${pose.id} 方向的面部验收图`);
    caption.append(document.createTextNode(pose.id), angle);
    angle.textContent = `yaw ${pose.yaw.toFixed(2)} · pitch ${pose.pitch.toFixed(2)}`;
    figure.append(canvas, caption);
    fragment.append(figure);
    cards.set(pose.id, canvas);
  }
  gallery.replaceChildren(fragment);
}

presetButtons.forEach((button) => button.addEventListener("click", () => applyPreset(button.dataset.galleryPreset)));
["blink", "jaw", "pucker", "press"].forEach((key) => sliders[key].addEventListener("input", () => {
  activePreset = null;
  scheduleRedraw();
}));
sliders.gaze.addEventListener("input", scheduleRedraw);
gazeButtons.forEach((button) => button.addEventListener("click", () => {
  sliders.gaze.value = button.dataset.galleryGaze;
  scheduleRedraw();
}));
sliders.brow.addEventListener("input", scheduleRedraw);
sliders.browMode.addEventListener("change", scheduleRedraw);
browButtons.forEach((button) => button.addEventListener("click", () => {
  sliders.browMode.value = button.dataset.galleryBrow;
  scheduleRedraw();
}));
direction.addEventListener("change", () => {
  activePreset = null;
  scheduleRedraw();
});
window.addEventListener("pagehide", () => renderer.dispose(), { once: true });

try {
  if (CROP.x + CROP.width > manifest.width || CROP.y + CROP.height > manifest.height) {
    throw new Error("验收裁剪区域超出角色画布");
  }
  buildCards();
  await renderer.load(LUNA_PAINTED_MANIFEST);
  controls.disabled = false;
  const left = renderer.channelSupport.mouthLeft === "frame";
  const right = renderer.channelSupport.mouthRight === "frame";
  mouthSupport.textContent = `纯左移嘴：${left ? "有独立画稿" : "unsupported（缺少独立画稿）"}；纯右移嘴：${right ? "有独立画稿" : "unsupported（缺少独立画稿）"}。左右噘嘴属于另一组口型；缺少纯移嘴画稿时保留其余嘴型输入。`;
  status.textContent = `已载入 ${manifest.poses.length} 个实际方向；所有格子共用一个解码后的渲染器。`;
  applyPreset("neutral");
} catch (error) {
  status.classList.add("error");
  status.textContent = `验收画廊载入失败：${error?.message || "未知错误"}`;
  renderer.dispose();
}
