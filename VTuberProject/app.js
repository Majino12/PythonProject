import { extractFaceMotion, extractPoseMotion, normalizeExpressions } from "./motion.js";
import { createProject, parseProject, normalizePreferences, saveProject, loadProject } from "./project-store.js";
import { extractAppearance } from "./appearance.js";
import { createDemoMotion } from "./demo-motion.js";
import { PaintedAvatar, PAINTED_CHANNEL_SUPPORT } from "./painted-avatar.js";
import { LUNA_PAINTED_MANIFEST, LUNA_PAINTED_RIG } from "./painted-luna.js";
import { createAvatar3D } from "./avatar-loader.js";
import { FaceSession, normalizeHeadPose } from "./face-session.js";
import { FaceEditor } from "./face-editor.js";

const $ = (selector) => document.querySelector(selector);

const canvas = $("#avatarCanvas");
const ctx = canvas.getContext("2d", { alpha: true });
const video = $("#camera");
let faceEditor = null;
const DEMO_PALETTE = { skin: "#f5d9ce", hair: "#bcb5c9", outfit: "#39374e", eyes: "#9571bc", accent: "#8c7bac" };
const DEMO_IMAGE_RIG = Object.freeze({
  leftEye: { x: 550, y: 143, w: 49, h: 31 },
  rightEye: { x: 480, y: 147, w: 51, h: 31 },
  mouth: { x: 519, y: 191, w: 42, h: 24 },
  face: { x: 517, y: 153, w: 140, h: 158 },
  skin: DEMO_PALETTE.skin, patchesEnabled: true,
});
const MOTION_DEFAULTS = Object.freeze({
  x: 0, y: 0, roll: 0,
  blinkL: 0, blinkR: 0, eyeWideL: 0, eyeWideR: 0,
  lookX: 0, lookY: 0,
  mouth: 0, mouthX: 0, smile: 0, frown: 0, pucker: 0,
  browUp: 0, browDownL: 0, browDownR: 0, cheek: 0,
  bodyLean: 0, bodyBob: 0, bodyTurn: 0, hipSway: 0,
  armL: 0, armR: 0, elbowL: 0, elbowR: 0,
  elbowSideL: 1, elbowSideR: 1,
  armSinL: 0, armSinR: 0, armCosL: 1, armCosR: 1,
  armDepthL: 0, armDepthR: 0, legL: 0, legR: 0,
});
const BODY_NEUTRAL_DEFAULTS = Object.freeze({
  shoulderY: .45, lean: 0, bodyTurn: 0, hipSway: 0, armL: 0, armR: 0,
});
const EXPRESSION_KEYS = [
  "blinkL", "blinkR", "eyeWideL", "eyeWideR", "mouth", "smile", "frown",
  "pucker", "browUp", "browDownL", "browDownR", "cheek", "lookX", "lookY", "mouthX",
];
const ui = {
  fileInput: $("#fileInput"),
  dropzone: $("#dropzone"),
  fileRow: $("#fileRow"),
  fileThumb: $("#fileThumb"),
  fileName: $("#fileName"),
  fileMeta: $("#fileMeta"),
  replaceButton: $("#replaceButton"),
  cameraButton: $("#cameraButton"),
  demoButton: $("#demoButton"),
  status: $("#status"),
  scanState: $("#scanState"),
  threeCanvas: $("#threeCanvas"),
  threeLoading: $("#threeLoading"),
  landmarkPill: $("#landmarkPill"),
  recordButton: $("#recordButton"),
  exportModelButton: $("#exportModelButton"),
  projectName: $("#projectName"),
  saveState: $("#saveState"),
  projectInput: $("#projectInput"),
  exportProjectButton: $("#exportProjectButton"),
  openProjectButton: $("#openProjectButton"),
  recalibrateButton: $("#recalibrateButton"),
  stopCameraButton: $("#stopCameraButton"),
  resetTuningButton: $("#resetTuningButton"),
  previewButton: $("#previewButton"),
  exitPreviewButton: $("#exitPreviewButton"),
  screenshotButton: $("#screenshotButton"),
  demoMotion: $("#demoMotion"),
  hairStyle: $("#hairStyle"),
  modelStyle: $("#modelStyle"),
  appearanceHint: $("#appearanceHint"),
  hairColor: $("#hairColor"),
  outfitColor: $("#outfitColor"),
  eyesColor: $("#eyesColor"),
  resetAppearance: $("#resetAppearance"),
  demoAvatarButton: $("#demoAvatarButton"),
  faceEditorRoot: $("#faceEditor"),
  aiOpenButton: $("#aiOpenButton"),
  aiDialog: $("#aiDialog"),
  characterPrompt: $("#characterPrompt"),
  apiKey: $("#apiKey"),
  apiConsent: $("#apiConsent"),
  generateButton: $("#generateButton"),
  generationProgress: $("#generationProgress"),
  generationHint: $("#generationHint"),
  toggleApiKey: $("#toggleApiKey"),
  cameraConsentDialog: $("#cameraConsentDialog"),
  cameraConsent: $("#cameraConsent"),
  cameraConsentButton: $("#cameraConsentButton"),
  qualityCard: $("#qualityCard"),
  qualityScore: $("#qualityScore"),
  qualityList: $("#qualityList"),
  calibration: $("#calibration"),
  calibrationCount: $("#calibrationCount"),
  helpDialog: $("#helpDialog"),
  helpButton: $("#helpButton"),
  toast: $("#toast"),
  faceBadge: $("#faceBadge"),
  bodyBadge: $("#bodyBadge"),
  meters: { eye: $("#eyeMeter"), mouth: $("#mouthMeter"), head: $("#headMeter"), body: $("#bodyMeter") },
  ranges: {
    head: $("#headRange"), blink: $("#blinkRange"), mouth: $("#mouthRange"),
    expression: $("#expressionRange"), body: $("#bodyRange"),
  },
};

const state = {
  mode: "demo",
  viewMode: "2d",
  background: "gradient",
  image: null,
  imageUrl: "",
  imageRig: null,
  avatar2dKind: "static",
  paintedAvatar: null,
  paintedRig: null,
  paintedBuildController: null,
  faceLandmarker: null,
  imageLandmarker: null,
  poseLandmarker: null,
  visionPromise: null,
  visionLoadToken: 0,
  lastVideoTime: -1,
  tracking: { ...MOTION_DEFAULTS },
  smooth: { ...MOTION_DEFAULTS },
  recorder: null,
  hasCustomAvatar: false,
  ready: false,
  calibrating: false,
  calibrationUntil: 0,
  calibrationSamples: [],
  bodyCalibrationSamples: [],
  expressionCalibrationSamples: [],
  neutral: { x: 0, y: 0, roll: 0 },
  bodyNeutral: { ...BODY_NEUTRAL_DEFAULTS },
  expressionNeutral: Object.fromEntries(EXPRESSION_KEYS.map((key) => [key, 0])),
  poseFrame: 0,
  poseHistory: {},
  bodyDetected: false,
  lastFaceSeen: 0,
  lastBodySeen: 0,
  lastVideoProgressAt: 0,
  lastMotionSeen: {},
  lastAnimationTime: 0,
  cameraStarting: false,
  cameraStartToken: 0,
  exportingModel: false,
  selectedStyle: "anime",
  cameraConsentGranted: false,
  avatar3d: null,
  build3d: "idle",
  avatar3dPromise: null,
  avatarBuildToken: 0,
  avatarBuildController: null,
  modelStyle: "studio",
  imageImportToken: 0,
  imageDataUrl: null,
  generating: false,
  projectBusy: true,
  storageAvailable: true,
  projectRevision: 0,
  savedRevision: 0,
  savePromise: null,
  previewMode: false,
  face2d: new FaceSession(),
  demoMotion: "idle",
  framing: "portrait",
  appearance: { hairStyle: "bob", faceWidth: 1, eyeScale: 1, palette: { ...DEMO_PALETTE } },
  appearanceOverrides: {},
  landmarkMessage: "✦ 示例角色已自动绑定",
  avatarPalette: {
    skin: "#f0c7cb",
    hair: "#2a1d3c",
    outfit: "#8f67ea",
    eyes: "#bc96ff",
    accent: "#ff83bd",
  },
};

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a, b, amount) => a + (b - a) * amount;
const point = (landmarks, index, width, height) => ({ x: landmarks[index].x * width, y: landmarks[index].y * height });
const median = (values) => {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const withTimeout = (promise, timeoutMs, message) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

function currentPaintedHeadPose() {
  if (state.face2d?.poseManual) return normalizeHeadPose(state.face2d.manualPose);
  const headGain = Number(ui.ranges.head.value) / 80;
  return normalizeHeadPose({
    yaw: state.smooth.x * headGain,
    // MoeMotion y is positive while looking down; painted pitch is positive up.
    pitch: -state.smooth.y * headGain,
  });
}

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ui.toast.classList.remove("show"), 3200);
}

function setStatus(title, detail, live = true) {
  const titleNode = ui.status.querySelector("b");
  const detailNode = ui.status.querySelector("small");
  if (titleNode.textContent !== title) titleNode.textContent = title;
  if (detailNode.textContent !== detail) detailNode.textContent = detail;
  ui.status.querySelector("span").style.background = live ? "var(--green)" : "#ffcf70";
}

function setSourceMode(mode) {
  const cameraSelected = mode === "camera";
  ui.cameraButton.classList.toggle("selected", cameraSelected);
  ui.demoButton.classList.toggle("selected", !cameraSelected);
  ui.cameraButton.setAttribute("aria-pressed", String(cameraSelected));
  ui.demoButton.setAttribute("aria-pressed", String(!cameraSelected));
  ui.demoMotion.disabled = cameraSelected;
  updateCameraControls();
}

function updateCameraControls() {
  ui.recalibrateButton.disabled = state.mode !== "camera" || state.calibrating;
  ui.stopCameraButton.disabled = state.mode !== "camera" && !state.cameraStarting;
  ui.stopCameraButton.textContent = state.cameraStarting ? "取消连接" : "关闭摄像头";
}

function setCameraButtonLabel(connecting = false) {
  ui.cameraButton.querySelector("b").textContent = connecting ? "正在连接…" : state.mode === "camera" ? "摄像头跟踪" : "开启摄像头";
  ui.cameraButton.querySelector("small").textContent = connecting ? "可切回自动演示" : "脸部 + 肢体";
}

function setViewButtons(mode, disabled = false) {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === mode;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = disabled;
  });
}

function updateViewPresentation() {
  const show3d = state.viewMode === "3d" && state.build3d === "ready" && state.avatar3d;
  canvas.classList.toggle("hidden", show3d);
  ui.threeCanvas.classList.toggle("hidden", !show3d);
  ui.exportModelButton.classList.toggle("hidden", !show3d);
  const studio = state.avatar3d?.modelStyle === "studio";
  ui.landmarkPill.textContent = show3d
    ? studio ? "✧ 精细 3D · 表情与发丝物理已就绪" : state.avatar3d?.fallbackUsed ? "⬡ 轻量备用模型 · 精细模型暂不可用" : "⬡ 轻量 3D · 拖动可旋转"
    : state.landmarkMessage;
  ui.exportModelButton.title = studio ? "下载保留骨骼、表情、配色和许可的 VRM；不包含当前动作" : "下载中立姿态单文件 GLB";
  updateAppearanceControls();
  ui.faceEditorRoot?.classList.toggle("hidden", state.viewMode === "3d");
  if (!state.build3d.includes("building")) ui.landmarkPill.classList.remove("hidden");
}

function updateAppearanceControls() {
  ui.modelStyle.value = state.modelStyle;
  ui.modelStyle.disabled = state.build3d === "building" || Boolean(state.recorder) || state.exportingModel;
  const studio = state.avatar3d ? state.avatar3d.modelStyle === "studio" : state.modelStyle === "studio";
  ui.hairStyle.disabled = studio || state.exportingModel;
  for (const input of [ui.hairColor, ui.outfitColor, ui.eyesColor, ui.resetAppearance]) input.disabled = state.exportingModel;
  ui.appearanceHint.textContent = studio
    ? "精细模型参考图片配色，保留模板的发型和服装。不是原图的完整重建；原图不会改变。"
    : "轻量模型可切换发型、参考图片取色。需要更细致的脸部和服装时，选择精细模型。";
}

function cancelPaintedBuild() {
  state.paintedBuildController?.abort();
  state.paintedBuildController = null;
}

function useStaticAvatar2D() {
  cancelPaintedBuild();
  state.paintedAvatar?.dispose?.();
  state.paintedAvatar = null;
  state.paintedRig = null;
  state.avatar2dKind = "static";
  state.face2d?.clearTest();
  faceEditor?.refreshControls();
}

function installPaintedAvatar(avatar) {
  const previous = state.paintedAvatar;
  state.paintedAvatar = avatar;
  state.paintedRig = LUNA_PAINTED_RIG;
  state.avatar2dKind = "painted";
  if (previous !== avatar) previous?.dispose?.();
  faceEditor?.refreshControls();
}

function resetAvatar3D() {
  state.avatarBuildToken += 1;
  state.avatarBuildController?.abort();
  state.avatarBuildController = null;
  state.avatar3d?.dispose?.();
  state.avatar3d = null;
  state.avatar3dPromise = null;
  state.build3d = "idle";
  ui.threeLoading.classList.add("hidden");
  ui.recordButton.disabled = Boolean(state.exportingModel);
  setViewButtons(state.viewMode);
  updateAppearanceControls();
}

function setThreeLoading(title, detail) {
  ui.threeLoading.querySelector("b").textContent = title;
  ui.threeLoading.querySelector("small").textContent = detail;
}

async function ensureAvatar3D() {
  if (state.avatar3d) return state.avatar3d;
  if (state.avatar3dPromise) return state.avatar3dPromise;
  const token = ++state.avatarBuildToken;
  const controller = state.avatarBuildController = new AbortController();
  state.build3d = "building";
  ui.threeLoading.classList.remove("hidden");
  ui.landmarkPill.classList.add("hidden");
  ui.recordButton.disabled = true;
  setViewButtons(state.viewMode, true);
  updateAppearanceControls();
  state.avatar3dPromise = (async () => {
    try {
      const avatar = await createAvatar3D(ui.threeCanvas, {
        modelStyle: state.modelStyle,
        signal: controller.signal,
        onProgress: (style) => setThreeLoading(style === "studio" ? "正在载入精细 3D 模型" : "正在构建轻量 3D 模型", style === "studio" ? "加载骨骼、表情和发丝物理 · 首次引擎加载需要联网" : "精细模型不可用时，会自动使用轻量模型"),
      });
      if (token !== state.avatarBuildToken) { avatar.dispose(); throw new DOMException("加载已取消", "AbortError"); }
      state.avatar3d = avatar;
      applyAvatarAppearance();
      avatar.setFraming?.(state.framing);
      avatar.setBackground(state.background);
      state.build3d = "ready";
      return avatar;
    } catch (error) {
      if (token !== state.avatarBuildToken) throw new DOMException("加载已取消", "AbortError");
      if (token === state.avatarBuildToken) {
        console.warn("3D initialization failed", error);
        state.avatar3d?.dispose?.();
        state.avatar3d = null;
        state.build3d = "error";
      }
      throw error;
    } finally {
      if (token === state.avatarBuildToken) {
        state.avatar3dPromise = null;
        state.avatarBuildController = null;
        ui.threeLoading.classList.add("hidden");
        setViewButtons(state.viewMode, false);
        ui.recordButton.disabled = state.exportingModel;
        updateAppearanceControls();
      }
    }
  })();
  return state.avatar3dPromise;
}

async function setViewMode(mode) {
  if (!["2d", "3d"].includes(mode) || mode === state.viewMode && (mode === "2d" || state.build3d === "ready")) return;
  if (state.recorder) {
    toast("请先停止当前录制，再切换 2D / 3D。");
    return;
  }
  state.viewMode = mode;
  setViewButtons(mode);
  if (mode === "2d") {
    ui.threeLoading.classList.add("hidden");
    updateViewPresentation();
    toast(state.avatar2dKind === "painted"
      ? "已切换到高清分层 2D，独立绘制的眼、眉与嘴型会跟随动作。"
      : "已切换到单图安全模式；原表情保持不变，仅驱动整体动作。");
    savePreferences();
    return;
  }
  try {
    await ensureAvatar3D();
    if (state.viewMode !== "3d") return;
    updateViewPresentation();
    state.avatar3d.render();
    toast(state.avatar3d.fallbackUsed ? "精细模型暂时不可用，已切换到轻量备用模型。" : "3D 已就绪。拖动可旋转，双击回到正面。");
  } catch (error) {
    if (error.name === "AbortError") return;
    state.viewMode = "2d";
    setViewButtons("2d");
    updateViewPresentation();
    toast("当前设备或网络暂时无法加载 3D，已安全返回 2D。可以稍后重试。");
  }
  savePreferences();
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

function currentProject() {
  return createProject({
    name: ui.projectName.value,
    imageDataUrl: state.imageDataUrl,
    preferences: {
      background: state.background,
      viewMode: state.viewMode,
      demoMotion: state.demoMotion,
      framing: state.framing,
      modelStyle: state.modelStyle,
      appearance: state.appearanceOverrides,
      face2d: state.face2d?.settings,
      ...Object.fromEntries(Object.entries(ui.ranges).map(([key, range]) => [key, Number(range.value)])),
    },
  });
}

function applyPreferences(raw) {
  const saved = normalizePreferences(raw);
  state.face2d?.setSettings(saved.face2d);
  faceEditor?.refreshControls();
  for (const [name, range] of Object.entries(ui.ranges)) {
    range.value = saved[name];
    $(`#${name}Output`).textContent = `${range.value}%`;
  }
  state.background = saved.background;
  state.demoMotion = saved.demoMotion;
  state.framing = saved.framing;
  if (state.modelStyle !== saved.modelStyle) resetAvatar3D();
  state.modelStyle = saved.modelStyle;
  updateFraming();
  ui.demoMotion.value = saved.demoMotion;
  state.appearanceOverrides = { ...saved.appearance };
  applyAvatarAppearance();
  document.body.style.setProperty("--preview-background", state.background === "green" ? "#00b140" : "#100e18");
  state.avatar3d?.setBackground(state.background);
  document.querySelectorAll("[data-background]").forEach((button) => {
    const selected = button.dataset.background === saved.background;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  return saved;
}

function savePreferences() {
  if (state.projectBusy) return;
  state.projectRevision += 1;
  clearTimeout(savePreferences.timer);
  ui.saveState.textContent = state.storageAvailable ? "正在保存…" : "本机保存不可用 · 请下载项目备份";
  if (state.storageAvailable) savePreferences.timer = setTimeout(flushProjectSave, 200);
}

async function flushProjectSave() {
  clearTimeout(savePreferences.timer);
  if (state.savePromise || !state.storageAvailable) return state.savePromise;
  if (state.savedRevision >= state.projectRevision) return;
  state.savePromise = (async () => {
    try {
      while (state.savedRevision < state.projectRevision) {
        const revision = state.projectRevision;
        await saveProject(currentProject());
        state.savedRevision = revision;
      }
      ui.saveState.textContent = "已保存到本机";
    } catch (error) {
      state.storageAvailable = false;
      ui.saveState.textContent = "本机保存不可用 · 请下载项目备份";
      console.warn("Project save unavailable", error);
      toast("浏览器无法保存项目。请用“下载项目”备份，避免丢失角色。");
    } finally {
      state.savePromise = null;
    }
  })();
  return state.savePromise;
}

function setProjectBusy(busy) {
  state.projectBusy = busy;
  $(".workspace").inert = busy;
}

function canReplaceProject() {
  if (state.projectBusy || state.generating || state.recorder || state.exportingModel) {
    toast("请先完成当前生成、录制或导出，再更换角色或项目。");
    return false;
  }
  return true;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function outputName(extension) {
  const name = (ui.projectName.value.trim() || "我的角色").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return `${name}-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.${extension}`;
}

function exportProject() {
  try {
    const project = currentProject();
    downloadBlob(new Blob([JSON.stringify(project)], { type: "application/json" }), outputName("moemotion"));
    toast("项目备份已下载，包含角色图片和设置，不含密钥或摄像头数据。");
  } catch (error) { toast(error.message || "项目备份失败，请重试。"); }
}

async function installProject(project) {
  // Decode before changing settings so a damaged backup cannot replace the working project.
  if (project.imageDataUrl) {
    const installed = await importImageData(project.imageDataUrl, project.name);
    if (!installed) throw new Error("项目中的角色图片无法读取，原项目已保留。");
  } else {
    state.imageImportToken += 1;
    await makeDemoAvatar();
    state.hasCustomAvatar = false;
    state.imageDataUrl = null;
    state.landmarkMessage = state.avatar2dKind === "painted"
      ? "✦ 高清分层 2D · 眼睛、眉毛与嘴型独立绘制"
      : "◇ 分层表情暂不可用 · 已显示中性示例立绘";
    ui.fileRow.classList.add("hidden");
    ui.qualityCard.classList.add("hidden");
    ui.scanState.classList.add("hidden");
    ui.dropzone.classList.remove("hidden");
    updateViewPresentation();
  }
  ui.projectName.value = project.name;
  const preferences = applyPreferences(project.preferences);
  useDemo();
  await setViewMode(preferences.viewMode);
}

async function openProject(file) {
  if (!file || !canReplaceProject()) return;
  if (file.size > 29 * 1024 * 1024) return toast("项目文件过大，请选择 MoeMotion 导出的项目备份。");
  setProjectBusy(true);
  try {
    const project = parseProject(await file.text());
    await installProject(project);
    toast("项目已打开。摄像头保持关闭，需要时可手动开启。");
  } catch (error) { toast(error.message || "无法打开这个项目，原项目已保留。"); }
  finally { setProjectBusy(false); savePreferences(); }
}

async function initializeProject() {
  setProjectBusy(true);
  ui.saveState.textContent = "正在恢复本机项目…";
  const protectStoredProject = (error) => {
    state.storageAvailable = false;
    ui.saveState.textContent = "恢复失败 · 请刷新或打开项目备份";
    toast("本机项目暂时无法恢复，已暂停自动保存以保护旧数据。可刷新重试或打开备份。");
    console.warn("Project restore unavailable", error);
  };
  try {
    let project = null;
    try { project = await loadProject(); }
    catch (error) { protectStoredProject(error); }
    // A user's saved image must not depend on the optional bundled demo asset.
    if (project?.imageDataUrl) {
      try {
        await installProject(project);
        ui.saveState.textContent = "已恢复上次项目 · 摄像头未开启";
        return;
      } catch (error) {
        protectStoredProject(error);
        project = null;
      }
    }
    let demoAvailable = false;
    try { demoAvailable = await makeDemoAvatar(); }
    catch (error) {
      console.warn("Demo illustration unavailable", error);
      setStatus("请导入角色", "示例立绘暂时无法载入", false);
      toast("示例立绘暂时无法载入，可导入自己的图片或打开项目备份。");
    }
    if (project) {
      ui.projectName.value = project.name;
      const preferences = applyPreferences(project.preferences);
      useDemo();
      await setViewMode(preferences.viewMode);
    } else {
      try { applyPreferences(JSON.parse(localStorage.getItem("moemotion-preferences") || "null")); }
      catch { applyPreferences(null); }
    }
    if (state.storageAvailable) {
      ui.saveState.textContent = project
        ? demoAvailable ? "已恢复上次项目 · 摄像头未开启" : "设置已恢复 · 请导入角色图片"
        : "修改后自动保存在此浏览器";
    }
  } finally { setProjectBusy(false); }
}

function setPreviewMode(enabled) {
  state.previewMode = enabled;
  document.body.classList.toggle("preview-mode", enabled);
  ui.exitPreviewButton.classList.toggle("hidden", !enabled);
  ui.previewButton.setAttribute("aria-pressed", String(enabled));
  (enabled ? ui.exitPreviewButton : ui.previewButton).focus();
  window.dispatchEvent(new Event("resize"));
}

function updateFraming() {
  state.avatar3d?.setFraming?.(state.framing);
  document.querySelectorAll("[data-framing]").forEach((button) => {
    const selected = button.dataset.framing === state.framing;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

async function takeScreenshot() {
  if (!state.image || state.exportingModel || state.build3d === "building") return toast("画面正在准备，请稍后截图。");
  ui.screenshotButton.disabled = true;
  try {
    const activeCanvas = state.viewMode === "3d" ? ui.threeCanvas : canvas;
    if (state.viewMode === "3d") state.avatar3d.render();
    else render();
    const blob = await new Promise((resolve) => activeCanvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("没有可保存的画面");
    downloadBlob(blob, outputName("png"));
    toast("PNG 截图已下载，只包含角色画面，不包含界面。");
  } catch { toast("截图失败，请重试或切换到 2D 模式。"); }
  finally { ui.screenshotButton.disabled = false; }
}

function showQualityReport(image, landmarks) {
  const shortestSide = Math.min(image.naturalWidth, image.naturalHeight);
  const ratio = image.naturalWidth / image.naturalHeight;
  const checks = [
    { ok: shortestSide >= 768, good: "清晰度足够，动作细节会更自然", bad: "分辨率偏低，建议使用至少 768px 的图片" },
    { ok: ratio >= .45 && ratio <= 1.25, good: "画面比例适合虚拟形象", bad: "建议使用竖版或接近方形的角色图" },
    { ok: Boolean(landmarks), good: "五官清晰，自动绑定成功", bad: "五官不够清晰，正在使用通用绑定" },
  ];
  const score = checks.filter((item) => item.ok).length;
  ui.qualityScore.textContent = score === 3 ? "优秀" : score === 2 ? "可以使用" : "建议换图";
  ui.qualityScore.style.color = score >= 2 ? "#b6f7d6" : "#ffcf70";
  ui.qualityList.replaceChildren(...checks.map((item) => {
    const li = document.createElement("li");
    li.className = item.ok ? "" : "warn";
    li.textContent = item.ok ? item.good : item.bad;
    return li;
  }));
  ui.qualityCard.classList.remove("hidden");
}

function openAiStudio() {
  if (!ui.aiDialog.open) ui.aiDialog.showModal();
  setTimeout(() => ui.characterPrompt.focus(), 80);
}

function updateGenerateButton() {
  const validPrompt = ui.characterPrompt.value.trim().length >= 3;
  const validKey = ui.apiKey.value.trim().startsWith("sk-") && ui.apiKey.value.trim().length >= 20;
  ui.generateButton.disabled = state.generating || !(validPrompt && validKey && ui.apiConsent.checked);
}

function base64ToAvatarFile(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], `ai-avatar-${Date.now()}.png`, { type: "image/png" });
}

async function generateAvatar() {
  if (state.generating || ui.generateButton.disabled || !canReplaceProject()) return;
  const apiKey = ui.apiKey.value.trim();
  const description = ui.characterPrompt.value.trim();
  state.generating = true;
  const generationControls = [ui.characterPrompt, ui.apiKey, ui.apiConsent, ...document.querySelectorAll("[data-style], [data-prompt]")];
  generationControls.forEach((control) => { control.disabled = true; });
  updateGenerateButton();
  ui.generationProgress.classList.remove("hidden");
  const hints = ["正在整理五官与身体结构", "正在绘制角色服装与配色", "正在优化透明背景和动捕姿势", "快完成了，正在输出高清立绘"];
  let hintIndex = 0;
  const hintTimer = setInterval(() => {
    hintIndex = Math.min(hints.length - 1, hintIndex + 1);
    ui.generationHint.textContent = hints[hintIndex];
  }, 9000);
  try {
    const response = await fetch("/api/generate-avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, description, style: state.selectedStyle }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `生成失败（${response.status}）`);
    const file = base64ToAvatarFile(result.image);
    ui.apiKey.value = "";
    ui.apiConsent.checked = false;
    closeDialog(ui.aiDialog);
    const imported = await importImage(file, { generated: true });
    if (imported) toast("AI 角色已载入，正在分析五官。可下载项目留存备份。");
    else {
      downloadBlob(file, outputName("png"));
      toast("立绘已生成，但未能载入，已下载原始图片供你保留。");
    }
  } catch (error) {
    toast(error.message || "AI 生成失败，请检查 API Key 和网络后重试。");
  } finally {
    state.generating = false;
    generationControls.forEach((control) => { control.disabled = false; });
    ui.apiKey.value = "";
    ui.apiKey.type = "password";
    ui.toggleApiKey.textContent = "显示";
    ui.apiConsent.checked = false;
    clearInterval(hintTimer);
    ui.generationProgress.classList.add("hidden");
    ui.generationHint.textContent = hints[0];
    updateGenerateButton();
  }
}

async function makeDemoAvatar() {
  const importToken = state.imageImportToken;
  cancelPaintedBuild();
  const controller = new AbortController();
  state.paintedBuildController = controller;
  const img = new Image();
  let painted = null;
  let paintedError = null;
  try {
    await withTimeout(new Promise((resolve, reject) => {
      const stop = () => {
        img.onload = img.onerror = null;
        img.removeAttribute("src");
        reject(new DOMException("示例角色载入已取消", "AbortError"));
      };
      controller.signal.addEventListener("abort", stop, { once: true });
      img.onload = () => { controller.signal.removeEventListener("abort", stop); resolve(); };
      img.onerror = () => { controller.signal.removeEventListener("abort", stop); reject(new Error("示例立绘无法载入，请检查 assets 文件夹或导入自己的图片。")); };
      img.src = "./assets/demo-luna-v1.png";
    }), 10_000, "示例立绘载入超时");
    if (controller.signal.aborted || importToken !== state.imageImportToken) return false;
    painted = new PaintedAvatar({ timeoutMs: 30_000 });
    try {
      await painted.load(LUNA_PAINTED_MANIFEST, { signal: controller.signal });
    } catch (error) {
      painted.dispose();
      painted = null;
      if (controller.signal.aborted || importToken !== state.imageImportToken || error?.name === "AbortError") return false;
      paintedError = error;
      console.warn("Painted 2D avatar unavailable; using the neutral illustration", error);
    }
    if (controller.signal.aborted || importToken !== state.imageImportToken) {
      painted?.dispose();
      return false;
    }
    state.image = img;
    state.imageUrl = img.src;
    state.imageRig = DEMO_IMAGE_RIG;
    state.appearance = { hairStyle: "bob", faceWidth: .94, eyeScale: 1, palette: { ...DEMO_PALETTE } };
    state.avatarPalette = { ...DEMO_PALETTE };
    if (painted) {
      installPaintedAvatar(painted);
      state.landmarkMessage = "✦ 高清分层 2D · 眼睛、眉毛与嘴型独立绘制";
    } else {
      useStaticAvatar2D();
      state.landmarkMessage = "◇ 分层表情暂不可用 · 已显示中性示例立绘";
      if (paintedError) toast("高清分层表情暂时无法载入，已安全显示中性示例立绘。可刷新后重试。");
    }
    applyAvatarAppearance();
    updateViewPresentation();
    return true;
  } finally {
    controller.abort();
    if (state.paintedBuildController === controller) state.paintedBuildController = null;
  }
}

async function loadVision() {
  if (state.faceLandmarker && state.imageLandmarker && state.poseLandmarker) return true;
  if (!state.visionPromise) {
    const loadToken = ++state.visionLoadToken;
    state.visionPromise = (async () => {
      try {
        setStatus("加载动作引擎", "首次使用需要联网下载模型", false);
        const { FaceLandmarker, FilesetResolver, PoseLandmarker } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs");
        const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm");
        const options = {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU",
          },
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          minFaceDetectionConfidence: .35,
          minFacePresenceConfidence: .35,
          minTrackingConfidence: .35,
        };
        const modelResults = await Promise.allSettled([
          FaceLandmarker.createFromOptions(fileset, { ...options, runningMode: "IMAGE" }),
          FaceLandmarker.createFromOptions(fileset, { ...options, runningMode: "VIDEO" }),
          PoseLandmarker.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
              delegate: "GPU",
            },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: .45,
            minPosePresenceConfidence: .45,
            minTrackingConfidence: .45,
          }),
        ]);
        const failure = modelResults.find((result) => result.status === "rejected");
        if (loadToken !== state.visionLoadToken || failure) {
          modelResults.forEach((result) => { if (result.status === "fulfilled") result.value.close?.(); });
          if (failure) throw failure.reason;
          return false;
        }
        const [imageLandmarker, faceLandmarker, poseLandmarker] = modelResults.map((result) => result.value);
        state.imageLandmarker = imageLandmarker;
        state.faceLandmarker = faceLandmarker;
        state.poseLandmarker = poseLandmarker;
        return true;
      } catch (error) {
        if (loadToken !== state.visionLoadToken) return false;
        console.error(error);
        toast("动作模型加载失败，已保留自动演示模式。请检查网络后重试。");
        setStatus("演示模式", "动作模型暂不可用", false);
        return false;
      }
    })();
  }
  try {
    const ready = await withTimeout(state.visionPromise, 45_000, "动作模型加载超时");
    if (!ready) state.visionPromise = null;
    return ready;
  } catch (error) {
    console.error(error);
    state.visionLoadToken += 1;
    state.visionPromise = null;
    toast("动作模型加载时间过长，已继续使用自动演示；稍后可再次开启摄像头。");
    setStatus("演示模式", "动作模型加载超时，可重试", false);
    return false;
  }
}

function colorFromImage(image, x, y) {
  const sample = document.createElement("canvas");
  sample.width = sample.height = 1;
  const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
  sampleCtx.drawImage(image, clamp(x, 0, image.naturalWidth - 1), clamp(y, 0, image.naturalHeight - 1), 1, 1, 0, 0, 1, 1);
  const [r, g, b] = sampleCtx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

function appearanceFromImage(image, rig) {
  const scale = Math.min(1, 384 / Math.max(image.naturalWidth, image.naturalHeight));
  const sample = document.createElement("canvas");
  sample.width = Math.max(1, Math.round(image.naturalWidth * scale));
  sample.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = sample.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, sample.width, sample.height);
  const scaledRig = Object.fromEntries(["face", "leftEye", "rightEye"].map((key) => [key,
    Object.fromEntries(Object.entries(rig[key]).map(([axis, value]) => [axis, value * scale])),
  ]));
  return extractAppearance(context.getImageData(0, 0, sample.width, sample.height), scaledRig);
}

function applyAvatarAppearance() {
  const profile = state.appearance;
  const overrides = state.appearanceOverrides;
  const palette = { ...profile.palette };
  for (const key of ["hair", "outfit", "eyes"]) if (overrides[key]) palette[key] = overrides[key];
  const hairStyle = overrides.hairStyle || profile.hairStyle;
  state.avatarPalette = palette;
  state.avatar3d?.setAppearance({ ...profile, hairStyle, palette });
  ui.hairStyle.value = overrides.hairStyle || "auto";
  ui.hairColor.value = palette.hair;
  ui.outfitColor.value = palette.outfit;
  ui.eyesColor.value = palette.eyes;
  updateAppearanceControls();
}

function updateAvatarPalette(image, rig) {
  try {
    state.appearance = appearanceFromImage(image, rig);
    applyAvatarAppearance();
  } catch (error) {
    console.warn("Could not sample avatar colors", error);
  }
}

function rigFromLandmarks(landmarks, image) {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const p = (i) => point(landmarks, i, w, h);
  // MediaPipe names left/right from the character's anatomical viewpoint.
  const le = [p(362), p(263), p(386), p(374)];
  const re = [p(33), p(133), p(159), p(145)];
  const mouth = [p(61), p(291), p(13), p(14)];
  const eyeBox = (eye) => ({
    x: (eye[0].x + eye[1].x) / 2,
    y: (eye[2].y + eye[3].y) / 2,
    w: Math.abs(eye[1].x - eye[0].x) * 1.65,
    h: Math.max(Math.abs(eye[3].y - eye[2].y) * 3.6, Math.abs(eye[1].x - eye[0].x) * .58),
  });
  const leftEye = eyeBox(le);
  const rightEye = eyeBox(re);
  const faceLeft = p(234);
  const faceRight = p(454);
  const forehead = p(10);
  const chin = p(152);
  return {
    patchesEnabled: true,
    leftEye,
    rightEye,
    mouth: {
      x: (mouth[0].x + mouth[1].x) / 2,
      y: (mouth[2].y + mouth[3].y) / 2,
      w: Math.abs(mouth[1].x - mouth[0].x) * 1.45,
      h: Math.max(Math.abs(mouth[3].y - mouth[2].y) * 4, Math.abs(mouth[1].x - mouth[0].x) * .52),
    },
    face: {
      x: (faceLeft.x + faceRight.x) / 2,
      y: (forehead.y + chin.y) / 2,
      w: Math.abs(faceRight.x - faceLeft.x),
      h: Math.abs(chin.y - forehead.y),
    },
    skin: colorFromImage(image, p(6).x, mix(forehead.y, p(6).y, .7)),
  };
}

async function importImage(file, { generated = false } = {}) {
  if (!file) return false;
  if (!generated && !canReplaceProject()) return false;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    toast("请选择 PNG、JPG 或 WEBP 图片。");
    return false;
  }
  if (file.size > 20 * 1024 * 1024) {
    toast("图片超过 20MB，请先压缩后重试。");
    return false;
  }
  const importToken = ++state.imageImportToken;
  // Cancel pending atlas I/O immediately so it cannot finish later and replace
  // the selected portrait. Keep the active image until the new one decodes.
  cancelPaintedBuild();
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("无法读取这张图片"));
      reader.readAsDataURL(file);
    });
    if (importToken !== state.imageImportToken) return false;
    const installed = await importImageData(dataUrl, file.name, importToken);
    if (installed) savePreferences();
    return installed;
  } catch (error) {
    if (importToken === state.imageImportToken) toast(error.message || "无法读取这张图片，请换一个文件。");
    return false;
  }
}

async function importImageData(dataUrl, name, importToken = ++state.imageImportToken) {
  cancelPaintedBuild();
  const image = new Image();
  await withTimeout(new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("图片无法解码，请使用有效的 PNG、JPG 或 WEBP。"));
    image.src = dataUrl;
  }), 10_000, "图片读取超时，请换一张较小的图片。");
  if (importToken !== state.imageImportToken) return false;
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 16_000_000) {
    throw new Error("图片尺寸过大，请缩小至 1600 万像素以内，单边不超过 8192px。");
  }
    useStaticAvatar2D();
    state.image = image;
    state.imageUrl = dataUrl;
    state.imageDataUrl = dataUrl;
    state.imageRig = fallbackRig(image);
    state.appearanceOverrides = {};
    updateAvatarPalette(image, state.imageRig);
    state.hasCustomAvatar = true;
    state.landmarkMessage = "◇ 单图安全模式 · 五官保持原图，仅驱动整体动作";
    state.ready = false;
    ui.dropzone.classList.add("hidden");
    ui.fileRow.classList.remove("hidden");
    ui.fileThumb.src = dataUrl;
    ui.fileName.textContent = name;
    ui.fileMeta.textContent = `${image.naturalWidth} × ${image.naturalHeight} · 分析中`;
    ui.scanState.classList.remove("hidden");
    ui.landmarkPill.classList.add("hidden");
    void analyzeImage(image, importToken);
    return true;
}

async function analyzeImage(image, importToken) {
    const ready = await loadVision();
    if (importToken !== state.imageImportToken) return;
    if (ready) {
      try {
        const result = state.imageLandmarker.detect(image);
        const detectedLandmarks = result.faceLandmarks?.[0];
        if (detectedLandmarks) {
          state.imageRig = rigFromLandmarks(detectedLandmarks, image);
          updateAvatarPalette(image, state.imageRig);
          ui.fileMeta.textContent = `${image.naturalWidth} × ${image.naturalHeight} · 已定位人脸`;
          state.landmarkMessage = "◇ 单图安全模式 · 五官保持原图，仅驱动整体动作";
          toast(state.viewMode === "3d" ? "角色分析完成，3D 外观与动作已自动更新。" : "已定位人脸。为避免扭曲，上传单图会保留原表情，仅驱动整体动作。");
        } else {
          ui.fileMeta.textContent = `${image.naturalWidth} × ${image.naturalHeight} · 未定位清晰人脸`;
          state.landmarkMessage = "◇ 单图安全模式 · 表情保持原图";
          toast("没有检测到清晰正脸。图片会保持原表情并仅使用轻微整体动作。");
        }
        showQualityReport(image, detectedLandmarks);
      } catch (error) {
        console.error(error);
        ui.fileMeta.textContent = "分析未完成 · 保持原图";
        state.landmarkMessage = "◇ 单图安全模式 · 表情保持原图";
        showQualityReport(image, null);
      }
    } else {
      ui.fileMeta.textContent = "离线模式 · 保持原图";
      state.landmarkMessage = "◇ 离线单图模式 · 表情保持原图";
      showQualityReport(image, null);
    }
    ui.scanState.classList.add("hidden");
    updateViewPresentation();
}

function fallbackRig(image) {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  return {
    patchesEnabled: false,
    leftEye: { x: w * .57, y: h * .40, w: w * .13, h: h * .065 },
    rightEye: { x: w * .43, y: h * .40, w: w * .13, h: h * .065 },
    mouth: { x: w * .5, y: h * .55, w: w * .15, h: h * .075 },
    face: { x: w * .5, y: h * .44, w: w * .42, h: h * .5 },
    skin: colorFromImage(image, w * .5, h * .34),
  };
}

function requestCameraAccess() {
  if (state.mode === "camera") return beginCalibration();
  if (state.cameraConsentGranted) {
    startCamera();
    return;
  }
  ui.cameraConsent.checked = false;
  ui.cameraConsentButton.disabled = true;
  ui.cameraConsentDialog.showModal();
}

async function startCamera() {
  if (state.cameraStarting) {
    toast("摄像头正在连接，请稍候。");
    return;
  }
  const startToken = ++state.cameraStartToken;
  let pendingStream = null;
  state.cameraStarting = true;
  ui.cameraButton.setAttribute("aria-busy", "true");
  ui.cameraButton.disabled = true;
  updateCameraControls();
  setCameraButtonLabel(true);
  try {
    const ready = await loadVision();
    if (!ready || startToken !== state.cameraStartToken) return;
    video.srcObject?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    pendingStream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 720, facingMode: "user" }, audio: false });
    if (startToken !== state.cameraStartToken) {
      pendingStream.getTracks().forEach((track) => track.stop());
      pendingStream = null;
      return;
    }
    video.srcObject = pendingStream;
    await video.play();
    if (startToken !== state.cameraStartToken) {
      pendingStream.getTracks().forEach((track) => track.stop());
      if (video.srcObject === pendingStream) video.srcObject = null;
      pendingStream = null;
      return;
    }
    pendingStream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (state.mode !== "camera" || video.srcObject !== pendingStream) return;
        useDemo();
        toast("摄像头连接已结束，已自动切回演示模式。");
      }, { once: true });
    });
    state.mode = "camera";
    state.lastVideoTime = -1;
    state.lastVideoProgressAt = performance.now();
    setSourceMode("camera");
    beginCalibration();
  } catch (error) {
    pendingStream?.getTracks().forEach((track) => track.stop());
    if (video.srcObject === pendingStream) video.srcObject = null;
    if (startToken !== state.cameraStartToken) return;
    console.error(error);
    useDemo();
    toast("无法使用摄像头，请在浏览器地址栏允许摄像头权限。");
    setStatus("演示模式", "摄像头权限未开启", false);
  } finally {
    if (startToken === state.cameraStartToken) {
      state.cameraStarting = false;
      ui.cameraButton.disabled = false;
      ui.cameraButton.setAttribute("aria-busy", "false");
      setCameraButtonLabel(false);
      updateCameraControls();
    }
  }
}

function useDemo() {
  state.face2d?.clearTest();
  faceEditor?.refreshControls();
  if (state.cameraStarting) {
    state.cameraStartToken += 1;
    state.cameraStarting = false;
    ui.cameraButton.disabled = false;
    ui.cameraButton.setAttribute("aria-busy", "false");
  }
  state.mode = "demo";
  state.calibrating = false;
  state.ready = false;
  ui.calibration.classList.add("hidden");
  setSourceMode("demo");
  setCameraButtonLabel(false);
  ui.faceBadge.classList.add("active");
  ui.bodyBadge.classList.add("active");
  setStatus("演示模式", "使用内置自然动作", true);
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
  updateCameraControls();
}

function beginCalibration() {
  if (state.mode !== "camera" || !video.srcObject) return;
  state.ready = false;
  state.calibrating = true;
  state.calibrationUntil = performance.now() + 3200;
  state.calibrationSamples = [];
  state.bodyCalibrationSamples = [];
  state.expressionCalibrationSamples = [];
  state.face2d?.beginCalibration();
  faceEditor?.refreshControls();
  state.poseHistory = {};
  state.bodyDetected = false;
  state.lastFaceSeen = 0;
  state.lastBodySeen = 0;
  state.lastMotionSeen = {};
  state.neutral = { x: 0, y: 0, roll: 0 };
  state.bodyNeutral = { ...BODY_NEUTRAL_DEFAULTS };
  state.expressionNeutral = Object.fromEntries(EXPRESSION_KEYS.map((key) => [key, 0]));
  ui.calibration.querySelector("b").textContent = "保持正脸，正在自动校准";
  ui.calibration.querySelector("small").textContent = "自然放松表情，肩膀和双手尽量入镜";
  ui.calibration.classList.remove("hidden");
  ui.faceBadge.classList.remove("active");
  ui.bodyBadge.classList.remove("active");
  updateCameraControls();
  setStatus("自动校准", "保持正脸约 3 秒", false);
  toast("请保持正脸、放松表情，校准会自动完成。");
}

function updateCalibration(now) {
  if (!state.calibrating) return;
  const remaining = Math.max(0, state.calibrationUntil - now);
  ui.calibrationCount.textContent = String(Math.max(1, Math.ceil(remaining / 1000)));
  if (remaining > 0) return;
  if (state.calibrationSamples.length < 5 || now - state.lastFaceSeen > 360) {
    if (now - state.lastFaceSeen > 360) {
      state.calibrationSamples = [];
      state.expressionCalibrationSamples = [];
      state.bodyCalibrationSamples = [];
      state.face2d?.beginCalibration();
    }
    state.calibrationUntil = now + 1000;
    ui.calibration.querySelector("b").textContent = "请把脸放进镜头中央";
    ui.calibration.querySelector("small").textContent = "检测到面部后会自动继续";
    setStatus("等待面部", "请正对摄像头", false);
    return;
  }
  if (state.calibrationSamples.length) {
    for (const key of ["x", "y", "roll"]) {
      state.neutral[key] = median(state.calibrationSamples.map((sample) => sample[key]));
    }
  }
  if (state.bodyCalibrationSamples.length) {
    for (const key of Object.keys(BODY_NEUTRAL_DEFAULTS)) {
      state.bodyNeutral[key] = median(state.bodyCalibrationSamples.map((sample) => sample[key]));
    }
  }
  if (state.expressionCalibrationSamples.length) {
    for (const key of EXPRESSION_KEYS) {
      state.expressionNeutral[key] = median(state.expressionCalibrationSamples.map((sample) => sample[key]));
    }
  }
  state.calibrating = false;
  state.face2d?.finishCalibration();
  state.ready = true;
  ui.calibration.classList.add("hidden");
  ui.calibration.querySelector("b").textContent = "保持正脸，正在自动校准";
  ui.calibration.querySelector("small").textContent = "不用做任何操作";
  updateCameraControls();
  setStatus("全部就绪", state.bodyDetected ? "脸部与肢体正在实时跟踪" : "脸部跟踪已就绪，退后一点可识别肢体", true);
  toast(state.bodyDetected ? "校准完成！现在眨眼、说话或抬手试试看。" : "脸部校准完成。让肩膀和双手入镜即可启用肢体跟踪。");
}

const FACE_MOTION_KEYS = [
  "x", "y", "roll", "blinkL", "blinkR", "eyeWideL", "eyeWideR", "lookX", "lookY",
  "mouth", "mouthX", "smile", "frown", "pucker", "browUp", "browDownL", "browDownR", "cheek",
];
const BODY_MOTION_KEYS = [
  "bodyLean", "bodyBob", "bodyTurn", "hipSway", "armL", "armR", "elbowL", "elbowR",
  "elbowSideL", "elbowSideR", "armSinL", "armSinR", "armCosL", "armCosR",
  "armDepthL", "armDepthR", "legL", "legR",
];

function applyMotion(values, now) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in state.tracking) || !Number.isFinite(value)) continue;
    state.tracking[key] = value;
    state.lastMotionSeen[key] = now;
  }
}

function relaxStaleMotion(keys, now, holdMs = 190) {
  for (const key of keys) {
    if (now - (state.lastMotionSeen[key] || 0) > holdMs) state.tracking[key] = MOTION_DEFAULTS[key] ?? 0;
  }
}

function clearStalePoseHistory(now, immediate = false) {
  for (const suffix of ["L", "R"]) {
    if (!immediate && now - (state.lastMotionSeen[`armSin${suffix}`] || 0) <= 280) continue;
    delete state.poseHistory[`elbowDirection${suffix}`];
  }
}

function handleTrackingStall(now, detail = "摄像头画面暂停，动作正回到自然姿态") {
  if (now - state.lastFaceSeen > 360) {
    relaxStaleMotion(FACE_MOTION_KEYS, now, 0);
    ui.faceBadge.classList.remove("active");
    setStatus("等待摄像头画面", detail, false);
  }
  if (now - state.lastBodySeen > 360) {
    relaxStaleMotion(BODY_MOTION_KEYS, now, 0);
    clearStalePoseHistory(now, true);
    state.bodyDetected = false;
    ui.bodyBadge.classList.remove("active");
  }
}

function trackPose(now) {
  if (!state.poseLandmarker) return;
  state.poseFrame += 1;
  if (state.poseFrame % 2 !== 0) return;
  try {
    const result = state.poseLandmarker.detectForVideo(video, now);
    const extracted = extractPoseMotion(result, state.bodyNeutral, state.poseHistory);
    if (!extracted) {
      if (now - state.lastBodySeen > 220) {
        relaxStaleMotion(BODY_MOTION_KEYS, now, 0);
        clearStalePoseHistory(now, true);
        state.bodyDetected = false;
        ui.bodyBadge.classList.remove("active");
      }
      return;
    }
    state.lastBodySeen = now;
    state.bodyDetected = true;
    ui.bodyBadge.classList.add("active");
    if (state.calibrating) {
      state.bodyCalibrationSamples.push(extracted.raw);
      if (state.bodyCalibrationSamples.length > 120) state.bodyCalibrationSamples.shift();
    }
    applyMotion(extracted.motion, now);
    relaxStaleMotion(BODY_MOTION_KEYS, now, 240);
    clearStalePoseHistory(now);
  } catch (error) {
    if (now - state.lastBodySeen > 240) {
      state.bodyDetected = false;
      ui.bodyBadge.classList.remove("active");
      relaxStaleMotion(BODY_MOTION_KEYS, now, 0);
      clearStalePoseHistory(now, true);
    }
    console.warn("Pose tracking skipped", error);
  }
}

function trackCamera(now) {
  if (state.mode !== "camera") return;
  if (!state.faceLandmarker || video.readyState < 2) {
    handleTrackingStall(now, "正在等待有效的摄像头画面");
    return;
  }
  if (video.currentTime === state.lastVideoTime) {
    if (now - state.lastVideoProgressAt > 420) handleTrackingStall(now);
    return;
  }
  state.lastVideoTime = video.currentTime;
  state.lastVideoProgressAt = now;
  trackPose(now);
  try {
    const result = state.faceLandmarker.detectForVideo(video, now);
    const extracted = extractFaceMotion(result);
    if (!extracted) {
      if (now - state.lastFaceSeen > 220) {
        relaxStaleMotion(FACE_MOTION_KEYS, now, 0);
        ui.faceBadge.classList.remove("active");
        setStatus("寻找面部", "请让面部保持在镜头范围内", false);
      }
      return;
    }
    state.lastFaceSeen = now;
    state.face2d?.receive(result, now, state.calibrating);
    ui.faceBadge.classList.add("active");
    if (state.calibrating) {
      state.calibrationSamples.push(extracted.pose);
      state.expressionCalibrationSamples.push(extracted.expressions);
      if (state.calibrationSamples.length > 120) state.calibrationSamples.shift();
      if (state.expressionCalibrationSamples.length > 120) state.expressionCalibrationSamples.shift();
      ui.calibration.querySelector("b").textContent = "保持正脸，正在自动校准";
      ui.calibration.querySelector("small").textContent = "眼睛自然睁开，嘴巴放松";
    }
    if (!state.calibrating) setStatus("宽角度面捕", state.bodyDetected ? "侧脸、表情与肢体正在实时追踪" : "表情追踪中 · 退后可识别肢体", true);
    const pose = {
      x: clamp(extracted.pose.x - state.neutral.x, -1, 1),
      y: clamp(extracted.pose.y - state.neutral.y, -1, 1),
      roll: clamp(extracted.pose.roll - state.neutral.roll, -1, 1),
    };
    const expressions = normalizeExpressions(extracted.expressions, state.expressionNeutral);
    applyMotion({ ...pose, ...expressions }, now);
  } catch (error) {
    console.warn("Face tracking skipped", error);
    if (now - state.lastFaceSeen > 240) {
      relaxStaleMotion(FACE_MOTION_KEYS, now, 0);
      ui.faceBadge.classList.remove("active");
      setStatus("面捕正在恢复", "动作已平滑回到自然姿态", false);
    }
  }
}

function trackDemo(now) {
  if (state.mode !== "demo") return;
  Object.assign(state.tracking, createDemoMotion(now, state.demoMotion));
}

function drawBackground() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.background === "transparent") return;
  if (state.background === "green") {
    ctx.fillStyle = "#00b140";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const gradient = ctx.createRadialGradient(canvas.width * .5, canvas.height * .46, canvas.width * .055, canvas.width * .5, canvas.height * .5, canvas.width * .71);
  gradient.addColorStop(0, "#322746");
  gradient.addColorStop(.58, "#1c1828");
  gradient.addColorStop(1, "#12101b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = .13;
  ctx.strokeStyle = "#c5a9ff";
  ctx.lineWidth = 1;
  for (let i = -canvas.width; i < canvas.width; i += canvas.width / 14) {
    ctx.beginPath(); ctx.moveTo(i, canvas.height); ctx.lineTo(i + canvas.width, 0); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}


function render(dt = 0) {
  drawBackground();
  const headAmount = Number(ui.ranges.head.value) / 80;
  const blinkAmount = Number(ui.ranges.blink.value) / 100;
  const mouthAmount = Number(ui.ranges.mouth.value) / 100;
  const expressionAmount = Number(ui.ranges.expression.value) / 100;
  const bodyAmount = Number(ui.ranges.body.value) / 100;
  const intensity = { head: headAmount, blink: blinkAmount, mouth: mouthAmount, expression: expressionAmount };
  const headPose = currentPaintedHeadPose();
  let image = state.image;
  let rig = state.imageRig;
  if (state.avatar2dKind === "painted" && state.paintedAvatar) {
    try {
      const painted = state.paintedAvatar.render(state.face2d?.output, intensity, dt, headPose);
      if (!painted) throw new Error("分层角色没有可绘制画面");
      image = painted;
      rig = state.paintedRig;
    } catch (error) {
      console.error("Painted 2D rendering failed", error);
      useStaticAvatar2D();
      state.landmarkMessage = "◇ 分层表情已安全停止 · 正在显示中性示例立绘";
      updateViewPresentation();
      toast("高清分层表情已安全停止，当前显示中性示例立绘。");
      image = state.image;
      rig = state.imageRig;
    }
  }
  if (!image || !rig) return;
  const s = state.face2d?.manual ? { ...MOTION_DEFAULTS } : state.smooth;
  const usableFace = rig.patchesEnabled !== false && rig.face
    && [rig.face.x, rig.face.y, rig.face.w, rig.face.h].every(Number.isFinite)
    && rig.face.w > 0 && rig.face.h > 0
    && rig.face.x >= 0 && rig.face.x < (image.naturalWidth ?? image.width)
    && rig.face.y >= 0 && rig.face.y < (image.naturalHeight ?? image.height);
  const imageWidth = image.naturalWidth ?? image.width;
  const imageHeight = image.naturalHeight ?? image.height;
  if (![imageWidth, imageHeight].every(Number.isFinite) || imageWidth < 1 || imageHeight < 1) return;
  const closeUp = state.framing === "portrait" && usableFace;
  const faceFocus = state.face2d?.focus && usableFace;
  const frameHeight = faceFocus ? Math.min(imageHeight, Math.max(64, imageHeight * .06, rig.face.h * 1.65)) : closeUp ? Math.min(imageHeight, Math.max(imageHeight * .36, rig.face.h * (state.avatar2dKind === "painted" ? 2.5 : 4.8))) : imageHeight;
  const frameTop = faceFocus ? clamp(rig.face.y - frameHeight * .50, 0, imageHeight - frameHeight) : closeUp ? clamp(rig.face.y - rig.face.h * 1.15, 0, imageHeight - frameHeight) : 0;
  const imageScale = closeUp || faceFocus ? canvas.height * .93 / frameHeight : Math.min(canvas.width * .94 / imageWidth, canvas.height * .96 / imageHeight);
  const centerX = closeUp || faceFocus ? rig.face.x : imageWidth / 2;
  const centerY = frameTop + frameHeight / 2;

  ctx.save();
  const armBalance = (s.armR - s.armL) * bodyAmount;
  const armEnergy = (Math.abs(s.armL) + Math.abs(s.armR) + s.elbowL * .35 + s.elbowR * .35) * .42 * bodyAmount;
  const staticHeadMotion = state.avatar2dKind === "painted" ? 0 : 1;
  const pseudoYaw = clamp(s.x * headAmount, -.62, .62) * staticHeadMotion;
  ctx.translate(
    canvas.width / 2 + pseudoYaw * 24 + (s.bodyLean + s.hipSway * .35) * 9 * bodyAmount + armBalance * 4,
    canvas.height / 2 + s.y * 9 * headAmount * staticHeadMotion - s.bodyBob * 10 * bodyAmount - armEnergy * 3,
  );
  ctx.rotate(s.roll * .055 * headAmount + s.bodyLean * .038 * bodyAmount);
  ctx.scale(1 + armEnergy * .008, 1 + s.bodyBob * .012 * bodyAmount);
  ctx.translate(-centerX * imageScale, -centerY * imageScale);
  ctx.scale(imageScale, imageScale);
  ctx.drawImage(image, 0, 0, imageWidth, imageHeight);
  ctx.restore();
}

function animate(now = performance.now()) {
  const dt = state.lastAnimationTime ? clamp((now - state.lastAnimationTime) / 1000, 1 / 240, .05) : 1 / 60;
  state.lastAnimationTime = now;
  trackDemo(now);
  trackCamera(now);
  updateCalibration(now);
  state.face2d.update(state.tracking, state.mode, now, dt);
  faceEditor?.update(now, state.mode);
  for (const key of Object.keys(MOTION_DEFAULTS)) {
    const target = Number.isFinite(state.tracking[key]) ? state.tracking[key] : 0;
    let tau = .09;
    if (key.startsWith("blink")) tau = target > state.smooth[key] ? .028 : .052;
    else if (["mouth", "mouthX", "lookX", "lookY"].includes(key)) tau = .055;
    else if (["bodyLean", "bodyBob", "bodyTurn", "hipSway", "legL", "legR"].includes(key)) tau = .15;
    else if (["armL", "armR", "armSinL", "armSinR", "armCosL", "armCosR", "elbowL", "elbowR", "armDepthL", "armDepthR"].includes(key)) tau = .095;
    else if (["elbowSideL", "elbowSideR"].includes(key)) tau = .16;
    else if (["browUp", "browDownL", "browDownR", "cheek", "frown", "pucker"].includes(key)) tau = .105;
    const amount = 1 - Math.exp(-dt / tau);
    state.smooth[key] = mix(state.smooth[key], target, amount);
  }
  if (state.viewMode === "3d" && state.build3d === "ready" && state.avatar3d) {
    try {
      state.avatar3d.update(state.smooth, {
        head: Number(ui.ranges.head.value) / 80,
        blink: Number(ui.ranges.blink.value) / 100,
        mouth: Number(ui.ranges.mouth.value) / 100,
        expression: Number(ui.ranges.expression.value) / 100,
        body: Number(ui.ranges.body.value) / 100,
      });
      state.avatar3d.render();
    } catch (error) {
      console.error("3D rendering failed", error);
      state.avatar3d.dispose?.();
      state.avatar3d = null;
      state.build3d = "error";
      state.viewMode = "2d";
      setViewButtons("2d");
      updateViewPresentation();
      toast("3D 渲染已安全停止，2D 模式仍可继续使用。");
      render(dt);
    }
  } else {
    render(dt);
  }
  const faceOutput = state.viewMode === "2d" ? state.face2d?.output : null;
  const blinkValue = faceOutput ? Math.max(faceOutput.eyeBlinkLeft, faceOutput.eyeBlinkRight) : (state.smooth.blinkL + state.smooth.blinkR) / 2;
  ui.meters.eye.style.width = `${clamp(blinkValue) * 100}%`;
  const mouthValue = faceOutput ? Math.max(faceOutput.jawOpen * (1 - faceOutput.mouthClose), faceOutput.mouthSmileLeft, faceOutput.mouthSmileRight, faceOutput.mouthFunnel, faceOutput.mouthPucker)
    : Math.max(state.smooth.mouth, state.smooth.smile, state.smooth.frown, state.smooth.pucker);
  ui.meters.mouth.style.width = `${clamp(mouthValue) * 100}%`;
  const displayedHeadPose = state.viewMode === "2d" && state.avatar2dKind === "painted" ? currentPaintedHeadPose() : null;
  ui.meters.head.style.width = `${clamp(displayedHeadPose
    ? (Math.abs(displayedHeadPose.yaw) + Math.abs(displayedHeadPose.pitch) + Math.abs(state.smooth.roll) * .35) / 1.7
    : (Math.abs(state.smooth.x) + Math.abs(state.smooth.roll)) / 1.4) * 100}%`;
  ui.meters.body.style.width = `${clamp((Math.abs(state.smooth.bodyLean) + Math.abs(state.smooth.bodyTurn) + Math.abs(state.smooth.armL) + Math.abs(state.smooth.armR) + state.smooth.elbowL + state.smooth.elbowR) / 3.2) * 100}%`;
  requestAnimationFrame(animate);
}

function toggleRecording() {
  if (state.exportingModel) {
    toast("3D 模型正在导出，请完成后再开始录制。");
    return;
  }
  if (state.recorder) {
    if (state.recorder.state === "recording") {
      ui.recordButton.disabled = true;
      ui.recordButton.querySelector("span").textContent = "正在保存…";
      try { state.recorder.stop(); } catch (error) {
        ui.recordButton.disabled = false;
        console.error("Could not stop recording", error);
      }
    }
    return;
  }
  if (state.viewMode === "3d" && (state.build3d !== "ready" || !state.avatar3d)) {
    toast("3D 角色仍在构建，请准备完成后再录制。");
    return;
  }
  const activeCanvas = state.viewMode === "3d" ? ui.threeCanvas : canvas;
  if (!window.MediaRecorder || !activeCanvas.captureStream) {
    toast("当前浏览器不支持画布录制，请使用新版 Chrome、Edge 或 Safari。");
    return;
  }
  let stream;
  try {
    stream = activeCanvas.captureStream(30);
    const candidates = [
      "video/webm;codecs=vp9", "video/webm;codecs=vp8",
      "video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm",
    ];
    const mimeType = typeof MediaRecorder.isTypeSupported === "function"
      ? candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || ""
      : "";
    const options = { videoBitsPerSecond: 6_000_000 };
    if (mimeType) options.mimeType = mimeType;
    const chunks = [];
    let recordingError = null;
    let finished = false;
    const recorder = new MediaRecorder(stream, options);
    state.recorder = recorder;
    const finish = () => {
      if (finished) return;
      finished = true;
      stream.getTracks().forEach((track) => track.stop());
      ui.recordButton.classList.remove("recording");
      ui.recordButton.setAttribute("aria-pressed", "false");
      ui.recordButton.querySelector("span").textContent = "录制视频";
      ui.recordButton.disabled = false;
      ui.exportModelButton.disabled = false;
      const actualType = recorder.mimeType || mimeType || "video/webm";
      if (state.recorder === recorder) state.recorder = null;
      updateAppearanceControls();
      if (recordingError || !chunks.length) {
        toast("录制没有成功保存，请换用新版浏览器后重试。");
        return;
      }
      const blob = new Blob(chunks, { type: actualType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const extension = actualType.includes("mp4") ? "mp4" : "webm";
      anchor.href = url;
      anchor.download = `moemotion-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.${extension}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`录制完成，${extension.toUpperCase()} 视频已保存。`);
    };
    recorder.ondataavailable = (event) => { if (!finished && event.data.size) chunks.push(event.data); };
    recorder.onerror = (event) => {
      if (finished) return;
      recordingError = event.error || new Error("录制编码失败");
      console.error("Recording failed", recordingError);
      if (recorder.state !== "inactive") {
        try { recorder.stop(); } catch (error) { finish(); }
      } else finish();
    };
    recorder.onstop = finish;
    recorder.start();
    updateAppearanceControls();
    ui.exportModelButton.disabled = true;
    ui.recordButton.classList.add("recording");
    ui.recordButton.setAttribute("aria-pressed", "true");
    ui.recordButton.querySelector("span").textContent = "停止并保存";
    toast("正在录制。再次点击即可停止并保存。");
  } catch (error) {
    console.error("Could not start recording", error);
    stream?.getTracks().forEach((track) => track.stop());
    state.recorder = null;
    updateAppearanceControls();
    ui.exportModelButton.disabled = false;
    ui.recordButton.classList.remove("recording");
    ui.recordButton.setAttribute("aria-pressed", "false");
    ui.recordButton.querySelector("span").textContent = "录制视频";
    toast("当前浏览器无法开始录制，角色和动作不会丢失。");
  }
}

async function export3DModel() {
  if (!state.avatar3d || state.build3d !== "ready") {
    toast("3D 角色还没有准备好，请稍后重试。");
    return;
  }
  if (state.recorder) {
    toast("请先停止并保存当前录制，再导出 3D 模型。");
    return;
  }
  if (state.exportingModel) return;
  const original = ui.exportModelButton.innerHTML;
  state.exportingModel = true;
  updateAppearanceControls();
  ui.exportModelButton.disabled = true;
  ui.recordButton.disabled = true;
  ui.exportModelButton.innerHTML = `<span>◌</span> 正在整理 ${state.avatar3d.exportExtension === "vrm" ? "VRM" : "GLB"}…`;
  try {
    const data = await state.avatar3d.exportGLB();
    const blob = new Blob([data], { type: "model/gltf-binary" });
    if (!blob.size) throw new Error("导出的模型为空");
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const extension = state.avatar3d.exportExtension === "vrm" ? "vrm" : "glb";
    anchor.download = `moemotion-avatar-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.${extension}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    toast(extension === "vrm" ? "VRM 已下载，保留骨骼、表情、配色与模型许可；不含当前动作。" : "3D 角色已导出为单文件 GLB（中立姿态）。");
  } catch (error) {
    console.error("3D export failed", error);
    toast("3D 模型导出失败，请重试；页面中的角色不会丢失。");
  } finally {
    state.exportingModel = false;
    updateAppearanceControls();
    ui.exportModelButton.disabled = false;
    ui.recordButton.disabled = false;
    ui.exportModelButton.innerHTML = original;
  }
}

function openFilePicker() {
  if (!canReplaceProject()) return;
  ui.fileInput.value = "";
  ui.fileInput.click();
}

ui.fileInput.addEventListener("change", (event) => importImage(event.target.files[0]));
ui.replaceButton.addEventListener("click", openFilePicker);
ui.aiOpenButton.addEventListener("click", openAiStudio);
ui.cameraButton.addEventListener("click", requestCameraAccess);
ui.demoButton.addEventListener("click", useDemo);
ui.recordButton.addEventListener("click", toggleRecording);
ui.exportModelButton.addEventListener("click", export3DModel);
ui.recalibrateButton.addEventListener("click", beginCalibration);
ui.stopCameraButton.addEventListener("click", () => {
  useDemo();
  state.cameraConsentGranted = false;
  toast("摄像头已关闭，角色继续使用自动演示。");
});
ui.projectName.addEventListener("input", savePreferences);
ui.modelStyle.addEventListener("change", async () => {
  const modelStyle = ui.modelStyle.value;
  if (!canReplaceProject() || state.build3d === "building") {
    ui.modelStyle.value = state.modelStyle;
    return;
  }
  if (!["studio", "light"].includes(modelStyle) || modelStyle === state.modelStyle) return;
  state.modelStyle = modelStyle;
  resetAvatar3D();
  updateViewPresentation();
  await setViewMode("3d");
  savePreferences();
});
ui.projectName.addEventListener("change", () => {
  ui.projectName.value = currentProject().name;
  savePreferences();
  void flushProjectSave();
});
ui.exportProjectButton.addEventListener("click", exportProject);
ui.openProjectButton.addEventListener("click", () => {
  if (!canReplaceProject()) return;
  ui.projectInput.value = "";
  ui.projectInput.click();
});
ui.projectInput.addEventListener("change", (event) => openProject(event.target.files[0]));
ui.resetTuningButton.addEventListener("click", () => {
  const defaults = normalizePreferences({});
  for (const [name, range] of Object.entries(ui.ranges)) {
    range.value = defaults[name];
    $(`#${name}Output`).textContent = `${range.value}%`;
  }
  state.face2d?.clearTest();
  faceEditor?.refreshControls();
  savePreferences();
  toast("动作微调和临时表情、方向试调已恢复默认，角色和背景保持不变。");
});
ui.demoMotion.addEventListener("change", () => {
  state.demoMotion = ui.demoMotion.value;
  savePreferences();
});
ui.hairStyle.addEventListener("change", () => {
  if (state.exportingModel) return;
  if (ui.hairStyle.value === "auto") delete state.appearanceOverrides.hairStyle;
  else state.appearanceOverrides.hairStyle = ui.hairStyle.value;
  applyAvatarAppearance();
  savePreferences();
});
for (const [key, input] of [["hair", ui.hairColor], ["outfit", ui.outfitColor], ["eyes", ui.eyesColor]]) {
  input.addEventListener("input", () => {
    if (state.exportingModel) return;
    state.appearanceOverrides[key] = input.value;
    applyAvatarAppearance();
    savePreferences();
  });
}
ui.resetAppearance.addEventListener("click", () => {
  if (state.exportingModel) return;
  state.appearanceOverrides = {};
  applyAvatarAppearance();
  savePreferences();
  toast("3D 外观已恢复为图片分析结果，原图保持不变。");
});
ui.demoAvatarButton.addEventListener("click", async () => {
  if (!canReplaceProject()) return;
  setProjectBusy(true);
  try {
    await flushProjectSave();
    await installProject(createProject({ name: "月见 Luna", preferences: { ...currentProject().preferences, appearance: {} } }));
    toast(state.avatar2dKind === "painted"
      ? "已换成原创示例月见 Luna。2D 使用独立绘制的眼、眉与嘴型关键帧。"
      : "已换成月见 Luna 的中性示例立绘；分层表情暂时无法载入。");
  } catch (error) { toast(error.message || "示例角色载入失败，请稍后再试。"); }
  finally { setProjectBusy(false); savePreferences(); }
});
ui.previewButton.addEventListener("click", () => setPreviewMode(true));
ui.exitPreviewButton.addEventListener("click", () => setPreviewMode(false));
ui.screenshotButton.addEventListener("click", takeScreenshot);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.previewMode) setPreviewMode(false);
});
ui.aiDialog.addEventListener("close", () => {
  ui.apiKey.value = "";
  ui.apiKey.type = "password";
  ui.toggleApiKey.textContent = "显示";
  ui.apiConsent.checked = false;
  updateGenerateButton();
});
ui.characterPrompt.addEventListener("input", updateGenerateButton);
ui.apiKey.addEventListener("input", updateGenerateButton);
ui.apiConsent.addEventListener("change", updateGenerateButton);
ui.generateButton.addEventListener("click", generateAvatar);
ui.characterPrompt.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !ui.generateButton.disabled) generateAvatar();
});
ui.toggleApiKey.addEventListener("click", () => {
  const reveal = ui.apiKey.type === "password";
  ui.apiKey.type = reveal ? "text" : "password";
  ui.toggleApiKey.textContent = reveal ? "隐藏" : "显示";
});
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    ui.characterPrompt.value = button.dataset.prompt;
    updateGenerateButton();
    ui.characterPrompt.focus();
  });
});
document.querySelectorAll("[data-style]").forEach((button) => {
  button.addEventListener("click", () => {
    state.selectedStyle = button.dataset.style;
    document.querySelectorAll("[data-style]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
  });
});
ui.cameraConsent.addEventListener("change", () => {
  ui.cameraConsentButton.disabled = !ui.cameraConsent.checked;
});
ui.cameraConsentButton.addEventListener("click", () => {
  if (!ui.cameraConsent.checked) return;
  state.cameraConsentGranted = true;
  closeDialog(ui.cameraConsentDialog);
  startCamera();
});
ui.helpButton.addEventListener("click", () => ui.helpDialog.showModal());
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => closeDialog(button.closest("dialog")));
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
});
ui.dropzone.addEventListener("dragover", (event) => { event.preventDefault(); ui.dropzone.classList.add("dragging"); });
ui.dropzone.addEventListener("dragleave", () => ui.dropzone.classList.remove("dragging"));
ui.dropzone.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openFilePicker();
});
ui.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  ui.dropzone.classList.remove("dragging");
  importImage(event.dataTransfer.files[0]);
});
document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setViewMode(button.dataset.view));
});
document.querySelectorAll("[data-framing]").forEach((button) => {
  button.addEventListener("click", () => {
    state.framing = button.dataset.framing;
    updateFraming();
    savePreferences();
  });
});
document.querySelectorAll("[data-background]").forEach((button) => {
  button.addEventListener("click", () => {
    state.background = button.dataset.background;
    document.body.style.setProperty("--preview-background", state.background === "green" ? "#00b140" : "#100e18");
    state.avatar3d?.setBackground(state.background);
    document.querySelectorAll("[data-background]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    savePreferences();
  });
});
Object.entries(ui.ranges).forEach(([name, range]) => {
  const output = $(`#${name}Output`);
  range.addEventListener("input", () => { output.textContent = `${range.value}%`; savePreferences(); });
});
window.addEventListener("beforeunload", (event) => {
  if (state.generating || state.recorder || state.projectRevision > state.savedRevision) {
    void flushProjectSave();
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  // Reject a FileReader/image decode that completes after BFCache restore.
  state.imageImportToken += 1;
  useDemo();
  state.recorder?.stream?.getTracks().forEach((track) => track.stop());
  if (state.imageUrl.startsWith("blob:")) URL.revokeObjectURL(state.imageUrl);
  resetAvatar3D();
  useStaticAvatar2D();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  const previousView = state.viewMode;
  state.avatar3d = null;
  state.build3d = "idle";
  state.viewMode = "2d";
  state.recorder = null;
  useDemo();
  setViewButtons("2d");
  updateViewPresentation();
  if (!state.imageDataUrl) void makeDemoAvatar().catch((error) => {
    console.warn("Could not restore the painted 2D avatar after page restore", error);
    state.landmarkMessage = "◇ 分层表情暂不可用 · 已保留中性示例立绘";
    updateViewPresentation();
  });
  if (previousView === "3d") void setViewMode("3d");
});

faceEditor = new FaceEditor(ui.faceEditorRoot, state.face2d, {
  quickRoot: $("#faceQuick"),
  onChange: savePreferences, onMessage: toast,
  indicator: $("#faceTestIndicator"), is2D: () => state.viewMode === "2d",
  getSupport: () => state.avatar2dKind === "painted" ? PAINTED_CHANNEL_SUPPORT : {},
  canPose: () => state.avatar2dKind === "painted",
  getPose: () => ({ input: currentPaintedHeadPose(), rendered: state.paintedAvatar?.pose || null }),
});
setViewButtons("2d");
setSourceMode("demo");
updateViewPresentation();
ui.faceBadge.classList.add("active");
ui.bodyBadge.classList.add("active");
void initializeProject();
requestAnimationFrame(animate);
