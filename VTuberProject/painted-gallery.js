import { PaintedAvatar, validatePaintedManifest } from "./painted-avatar.js";
import { LUNA_PAINTED_MANIFEST } from "./painted-luna.js";

const CROP = Object.freeze({ x: 180, y: 200, width: 700, height: 580 });
const CELL = Object.freeze({ width: 350, height: 290 });
const controls = document.querySelector("#galleryControls");
const gallery = document.querySelector("#paintedGallery");
const status = document.querySelector("#galleryStatus");
const presetButtons = [...document.querySelectorAll("[data-gallery-preset]")];
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
}

function channelsFromControls() {
  const blink = Number(sliders.blink.value);
  const jaw = Number(sliders.jaw.value);
  const pucker = Number(sliders.pucker.value);
  const press = Number(sliders.press.value);
  return {
    eyeBlinkLeft: blink,
    eyeBlinkRight: blink,
    jawOpen: jaw,
    mouthPucker: pucker,
    mouthPressLeft: press,
    mouthPressRight: press,
    mouthLeft: direction.value === "left" && pucker > 0 ? .8 : 0,
    mouthRight: direction.value === "right" && pucker > 0 ? .8 : 0,
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
Object.values(sliders).forEach((input) => input.addEventListener("input", () => {
  activePreset = null;
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
  status.textContent = `已载入 ${manifest.poses.length} 个实际方向；所有格子共用一个解码后的渲染器。`;
  applyPreset("neutral");
} catch (error) {
  status.classList.add("error");
  status.textContent = `验收画廊载入失败：${error?.message || "未知错误"}`;
  renderer.dispose();
}
