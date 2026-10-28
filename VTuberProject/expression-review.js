import { CHANNELS, DEMO, sanitizeChannels, channelSupport, selectExpression, selectGaze, sampleDemo } from "./expression-model.js";
import { createMotionState, advanceMotion, NATURAL_DEMO, sampleNaturalDemo } from "./expression-motion.js";
import { loadExpressionAssets, drawExpression } from "./expression-renderer.js";

const PRESETS = Object.freeze([
  { id: "neutral", group: "all", label: "中性", channels: {} },
  { id: "quarterBlink", group: "eyes", label: "轻闭眼", asset: "extendedEyes", channels: { eyeBlinkLeft: .25, eyeBlinkRight: .25 } },
  { id: "halfBlink", group: "eyes", label: "半闭眼", channels: { eyeBlinkLeft: .5, eyeBlinkRight: .5 } },
  { id: "threeQuarterBlink", group: "eyes", label: "近闭眼", asset: "extendedEyes", channels: { eyeBlinkLeft: .75, eyeBlinkRight: .75 } },
  { id: "blink", group: "eyes", label: "闭眼", channels: { eyeBlinkLeft: 1, eyeBlinkRight: 1 } },
  { id: "winkLeft", group: "eyes", label: "角色左眼眨眼", detail: "画面右眼", channels: { eyeBlinkLeft: 1 } },
  { id: "winkRight", group: "eyes", label: "角色右眼眨眼", detail: "画面左眼", channels: { eyeBlinkRight: 1 } },
  { id: "lookLeft", group: "gaze", label: "向角色左侧看", detail: "朝画面右侧", asset: "gaze", channels: { eyeLookOutLeft: .75, eyeLookInRight: .75 } },
  { id: "lookRight", group: "gaze", label: "向角色右侧看", detail: "朝画面左侧", asset: "gaze", channels: { eyeLookInLeft: .75, eyeLookOutRight: .75 } },
  { id: "lookUp", group: "gaze", label: "向上看", asset: "gaze", channels: { eyeLookUpLeft: .75, eyeLookUpRight: .75 } },
  { id: "lookDown", group: "gaze", label: "向下看", asset: "gaze", channels: { eyeLookDownLeft: .75, eyeLookDownRight: .75 } },
  { id: "lookLeftUp", group: "gaze", label: "向角色左上看", detail: "朝画面右上", asset: "gaze", channels: { eyeLookOutLeft: .65, eyeLookInRight: .65, eyeLookUpLeft: .65, eyeLookUpRight: .65 } },
  { id: "lookRightUp", group: "gaze", label: "向角色右上看", detail: "朝画面左上", asset: "gaze", channels: { eyeLookInLeft: .65, eyeLookOutRight: .65, eyeLookUpLeft: .65, eyeLookUpRight: .65 } },
  { id: "lookLeftDown", group: "gaze", label: "向角色左下看", detail: "朝画面右下", asset: "gaze", channels: { eyeLookOutLeft: .65, eyeLookInRight: .65, eyeLookDownLeft: .65, eyeLookDownRight: .65 } },
  { id: "lookRightDown", group: "gaze", label: "向角色右下看", detail: "朝画面左下", asset: "gaze", channels: { eyeLookInLeft: .65, eyeLookOutRight: .65, eyeLookDownLeft: .65, eyeLookDownRight: .65 } },
  { id: "lookHalf", group: "gaze", label: "半闭眼、侧看", detail: "向角色左侧看", asset: "gaze", channels: { eyeBlinkLeft: .5, eyeBlinkRight: .5, eyeLookOutLeft: .65, eyeLookInRight: .65 } },
  { id: "lookWink", group: "gaze", label: "单眼眨眼、侧看", detail: "左眼闭合，右眼向角色右侧看", asset: "gaze", channels: { eyeBlinkLeft: 1, eyeLookInLeft: .65, eyeLookOutRight: .65 } },
  { id: "parted", group: "mouth", label: "嘴唇刚开缝", asset: "extendedJaw", channels: { jawOpen: .18 } },
  { id: "openSmall", group: "mouth", label: "小幅张嘴", channels: { jawOpen: .4 } },
  { id: "openMedium", group: "mouth", label: "中幅张嘴", asset: "extendedJaw", channels: { jawOpen: .68 } },
  { id: "openWide", group: "mouth", label: "大幅张嘴", channels: { jawOpen: .95 } },
  { id: "pucker", group: "mouth", label: "噘嘴", channels: { mouthPucker: .9 } },
  { id: "press", group: "mouth", label: "抿嘴", channels: { mouthPressLeft: .9, mouthPressRight: .9 } },
  { id: "shiftLeft", group: "mouth", label: "角色左移嘴", detail: "朝画面右侧", asset: "shiftLeft", channels: { mouthLeft: .9 } },
  { id: "shiftRight", group: "mouth", label: "角色右移嘴", detail: "朝画面左侧", asset: "shiftRight", channels: { mouthRight: .9 } },
  { id: "browsUp", group: "brows", label: "抬眉", channels: { browInnerUp: .9 } },
  { id: "browsDown", group: "brows", label: "压眉", channels: { browDownLeft: .9, browDownRight: .9 } },
  { id: "browLeftUp", group: "brows", label: "角色左眉抬起", detail: "画面右眉", channels: { browOuterUpLeft: .9 } },
  { id: "browRightUp", group: "brows", label: "角色右眉抬起", detail: "画面左眉", channels: { browOuterUpRight: .9 } },
  { id: "combination", group: "combined", label: "眨眼、抬眉、说话", channels: { eyeBlinkLeft: 1, browOuterUpRight: .9, jawOpen: .4 } },
  { id: "softSpeak", group: "combined", label: "半闭眼、小幅张嘴", channels: { eyeBlinkLeft: .5, eyeBlinkRight: .5, jawOpen: .4 } },
  { id: "pressedFrown", group: "combined", label: "压眉、抿嘴", channels: { browDownLeft: .9, browDownRight: .9, mouthPressLeft: .9, mouthPressRight: .9 } },
].map((preset) => Object.freeze({ ...preset, channels: Object.freeze(sanitizeChannels(preset.channels)) })));
const VARIANTS = Object.freeze({
  candidate: { label: "已确认视线", status: "approved", scope: "正面视线效果已获用户确认" },
  motion: { label: "已确认自然动作", status: "approved", scope: "五档表情与自然动作已确认" },
  approved: { label: "已确认基础版", status: "approved", scope: "基础表情已获用户确认" },
});
const STATUS_LABELS = Object.freeze({ undecided: "未判断", pass: "通过", revise: "需修改" });
const $ = (selector) => document.querySelector(selector);
const presetById = new Map(PRESETS.map((preset) => [preset.id, preset]));
let assets;
let ready = false;
let support = {};
let coefficients = sanitizeChannels({});
let targetState = selectExpression(coefficients);
let renderedState = { ...targetState };
let renderedGaze = selectGaze({});
let motion = createMotionState(renderedState);
let renderMode = "static";
let demoMode = "natural";
let variant = "candidate";
let loadSequence = 0;
let activeGroup = "gaze";
let activePresetId = "neutral";
let feedback;
let storageKey;
let storageWarning = "";
let playing = false;
let animationFrame = 0;
let demoStartedAt = 0;
let lastDemoTick = 0;
let demoStepId = "neutral";
let faceOnly = true;
let lastPaint = "";
const feedbackCache = new Map();
const FRAME_LABELS = Object.freeze({ open: "睁眼", quarter: "轻闭眼", half: "半闭", threeQuarter: "近闭眼", closed: "闭眼", neutral: "中性", parted: "开缝", openSmall: "小张", openMedium: "中张", openWide: "大张", pucker: "噘嘴", press: "抿嘴", shiftLeft: "角色左移", shiftRight: "角色右移", up: "抬起", down: "压低" });

const visibleChannels = () => CHANNELS.filter((channel) => channel.group !== "gaze" || assets?.available?.gaze === true);
const presetAvailable = (preset) => !preset.asset || assets?.available?.[preset.asset] === true;
const frameSummary = (frame) => `左眼 ${FRAME_LABELS[frame.eyeLeft] || frame.eyeLeft} / 右眼 ${FRAME_LABELS[frame.eyeRight] || frame.eyeRight} · 嘴 ${FRAME_LABELS[frame.mouth] || frame.mouth} · 眉 ${FRAME_LABELS[frame.browLeft] || frame.browLeft}/${FRAME_LABELS[frame.browRight] || frame.browRight}`;

function gazeSummary() {
  if (!assets?.available?.gaze) return "";
  const direction = ({ x, y }) => `横 ${x.toFixed(2)} / 纵 ${y.toFixed(2)}`;
  return `\n视线：左眼 ${direction(renderedGaze.eyeLeft)} · 右眼 ${direction(renderedGaze.eyeRight)}（画面向右、向下为正）`;
}

function updateStateReadout() {
  const differs = JSON.stringify(renderedState) !== JSON.stringify(targetState);
  $("#stateReadout").textContent = $("#originalToggle").checked
    ? `当前显示：已确认原画。\n暂存的输入目标：${frameSummary(targetState)}\n关闭原画对照后恢复表情；导出会标记当前显示的是原画。`
    : `当前画稿：${frameSummary(renderedState)}\n输入目标：${frameSummary(targetState)}${differs ? `\n${playing ? "自然过渡中" : "已冻结自然过渡帧"}，当前画稿尚未到达输入目标；系数显示的是目标输入。` : "\n当前画稿与输入目标一致。"}${gazeSummary()}`;
}

function updateProgress() {
  const ids = PRESETS.filter(presetAvailable).map(({ id }) => id);
  const values = ids.map((id) => feedback[id]);
  $("#reviewProgress").textContent = `${values.filter((item) => item.status !== "undecided").length} / ${ids.length} 个可用预设已评价 · ${values.filter((item) => item.status === "revise").length} 个需修改`;
}

function emptyFeedback() {
  return Object.fromEntries(PRESETS.map(({ id }) => [id, { status: "undecided", note: "", updatedAt: null }]));
}

function restoreFeedback() {
  feedback = emptyFeedback();
  storageWarning = "";
  const cached = feedbackCache.get(storageKey);
  if (cached) { feedback = cached.feedback; storageWarning = cached.warning; return; }
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.schemaVersion !== 1 || saved.assetId !== assets.manifest.id || saved.assetVersion !== assets.manifest.version || !saved.feedback) {
      throw new Error("反馈版本不匹配");
    }
    for (const id of Object.keys(feedback)) {
      const item = saved.feedback[id];
      if (!item || !Object.hasOwn(STATUS_LABELS, item.status)) continue;
      feedback[id] = { status: item.status, note: typeof item.note === "string" ? item.note.slice(0, 4000) : "",
        updatedAt: typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt)) ? item.updatedAt : null };
    }
  } catch {
    storageWarning = "未能读取之前的反馈；本次仍可记录并导出 JSON。";
  }
}

function stopDemo(message = "演示已暂停；可继续静止观察。") {
  const wasPlaying = playing;
  playing = false;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  $("#demoToggle").setAttribute("aria-pressed", "false");
  $("#demoToggle").textContent = "播放演示";
  if (wasPlaying) $("#motionStatus").textContent = message;
  if (ready && wasPlaying) {
    // Freeze the visible frame. Do not settle it to the latest input target.
    if (renderMode === "natural") { activePresetId = null; $("#previewHeading").textContent = "自然动作 · 已暂停当前帧"; }
    updateFeedbackPanel(); updateStateReadout(); paint(true);
  }
}

function fail(error) {
  ready = false;
  stopDemo();
  $("#workspaceControls").disabled = true;
  $("#loadStatus").hidden = false;
  $("#loadStatus").className = "load-status error";
  $("#loadStatus").textContent = `表情素材未能完整载入或绘制：${error?.message || "未知错误"}。当前表情控制已停用，可切换上方素材版本重新载入。`;
  $("#expressionCanvas").hidden = true;
  $("#referenceCanvas").hidden = true;
  $("#canvasPlaceholder").hidden = false;
  $("#canvasPlaceholder").className = "error";
  $("#canvasPlaceholder").textContent = "预览不可用，请查看上方错误。";
  $("#variantScope").textContent = "此版本未能载入";
}

function paint(force = false) {
  if (!ready) return;
  const options = { faceOnly, guides: $("#guidesToggle").checked, original: $("#originalToggle").checked, gaze: renderedGaze };
  const signature = JSON.stringify([renderedState, options]);
  if (!force && signature === lastPaint) return;
  try {
    drawExpression($("#expressionCanvas"), assets, renderedState, options);
    lastPaint = signature;
    $("#expressionCanvas").setAttribute("aria-label", options.original ? "已经用户确认的正面原画" : `${frameSummary(renderedState)}${gazeSummary()}，正面表情预览`);
    $("#previewBadge").textContent = options.original ? "原画对照" : playing ? demoMode === "natural" ? "自然演示" : "逐稿观察" : renderMode === "natural" ? "自然暂停帧" : "静止预览";
    $("#guidesCaption").hidden = !options.guides;
  } catch (error) { fail(error); }
}

function paintReference() {
  try { drawExpression($("#referenceCanvas"), assets, selectExpression({}), { faceOnly, guides: false, original: true }); }
  catch (error) { fail(error); }
}

function syncSliders() {
  for (const { key } of CHANNELS) {
    const slider = document.querySelector(`[data-channel="${key}"]`);
    if (!slider) continue;
    slider.value = String(coefficients[key]);
    slider.closest("label").querySelector("output").textContent = coefficients[key].toFixed(2);
  }
}

function updateFeedbackPanel() {
  const preset = presetById.get(activePresetId);
  const item = preset ? feedback[preset.id] : null;
  $("#feedbackHeading").textContent = preset ? `${preset.label} · 补充评价` : renderMode === "natural" ? "自然动作观察" : "自定义参数";
  $("#feedbackControls").disabled = playing || !preset || !presetAvailable(preset) || $("#originalToggle").checked;
  $("#feedbackHint").textContent = playing ? "停止演示并选择明确预设后，可记录逐稿评价。" : $("#originalToggle").checked ? "关闭原画对照后，可评价表情预设。" : preset ? "本版预设单独保存，已有批准记录保持独立。" : renderMode === "natural" ? "当前保留自然动作的可见帧。选择明确预设再评价；导出保留当前帧与目标。" : "选择预设后可记录评价；导出会保留当前参数。";
  for (const radio of document.querySelectorAll('[name="feedbackStatus"]')) radio.checked = radio.value === (item?.status || "undecided");
  $("#feedbackNote").value = item?.note || "";
  $("#saveStatus").textContent = storageWarning || (item?.updatedAt ? "已恢复此预设的本地反馈。" : "尚未记录此预设的评价。");
  $("#saveStatus").className = `save-status${storageWarning ? " warning" : ""}`;
  updateProgress();
}

function updatePresetButtons() {
  for (const button of document.querySelectorAll("[data-preset]")) button.setAttribute("aria-pressed", String(button.dataset.preset === activePresetId));
}

function setCoefficients(next, { presetId = null, resetSelection = false, label, mode = "manual" } = {}) {
  coefficients = sanitizeChannels(next);
  renderedGaze = selectGaze(coefficients, assets.available);
  targetState = selectExpression(coefficients, resetSelection ? {} : targetState, assets.available);
  renderedState = { ...targetState };
  motion = createMotionState(renderedState);
  renderMode = mode;
  activePresetId = presetId;
  $("#previewHeading").textContent = label || presetById.get(presetId)?.label || "自定义参数";
  updatePresetButtons();
  syncSliders();
  updateStateReadout();
  paint();
}

function selectPreset(preset) {
  stopDemo();
  if (!presetAvailable(preset)) return;
  $("#originalToggle").checked = false;
  setCoefficients(preset.channels, { presetId: preset.id, resetSelection: true, mode: "static" });
  $("#motionStatus").textContent = "静止预览；左右方向均以角色自身为准。";
  updateFeedbackPanel();
  paint(true);
}

function selectGroup(group) {
  stopDemo();
  if (group === "gaze" && assets?.available?.gaze !== true) group = "eyes";
  activeGroup = group;
  for (const button of document.querySelectorAll("[data-group]")) button.setAttribute("aria-pressed", String(button.dataset.group === group));
  const buttons = PRESETS.filter((preset) => preset.group === "all" || preset.group === group).map((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.preset = preset.id;
    button.textContent = preset.label;
    button.disabled = !presetAvailable(preset);
    if (preset.detail || button.disabled) {
      const detail = document.createElement("small");
      detail.textContent = button.disabled ? "缺少独立画稿" : preset.detail;
      button.append(detail);
    }
    button.addEventListener("click", () => selectPreset(preset));
    return button;
  });
  $("#presetButtons").replaceChildren(...buttons);
  $("#directionNote").textContent = group === "gaze"
    ? "左右以角色自身为准。可用高级控制把视线与闭眼、嘴型自由组合。"
    : "角色左侧在画面右侧；左右移嘴使用各自的画稿。";
  updatePresetButtons();
}

function buildSequenceReview() {
  const rows = [
    { group: "eyes", title: "眼睛 · 从睁到闭", detail: "eyes", neutralLabel: "睁眼", ids: ["neutral", "quarterBlink", "halfBlink", "threeQuarterBlink", "blink"] },
    { group: "mouth", title: "嘴部 · 从闭到开", detail: "mouth", neutralLabel: "闭合", ids: ["neutral", "parted", "openSmall", "openMedium", "openWide"] },
  ];
  $("#sequenceRows").replaceChildren(...rows.map((row) => {
    const section = document.createElement("section");
    section.className = "sequence-row";
    const heading = document.createElement("h3");
    heading.textContent = row.title;
    const strip = document.createElement("div");
    strip.className = "sequence-strip";
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", row.title);
    for (const id of row.ids) {
      const preset = presetById.get(id);
      if (!presetAvailable(preset)) continue;
      const label = id === "neutral" ? row.neutralLabel : preset.label;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sequence-card";
      button.dataset.preset = id;
      button.setAttribute("aria-label", `${label}，选择此预设`);
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      drawExpression(canvas, assets, selectExpression(preset.channels, {}, assets.available), { detail: row.detail, guides: false, original: false });
      const caption = document.createElement("span");
      caption.className = "sequence-caption";
      caption.textContent = label;
      button.append(canvas, caption);
      button.addEventListener("click", () => { selectGroup(row.group); selectPreset(preset); });
      strip.append(button);
    }
    section.append(heading, strip);
    return section;
  }));
  updatePresetButtons();
}

function buildSliders() {
  $("#channelSliders").replaceChildren(...visibleChannels().map((channel) => {
    const label = document.createElement("label");
    label.className = "channel-control";
    const title = document.createElement("span");
    title.className = "channel-title";
    title.textContent = channel.label;
    const output = document.createElement("output");
    output.textContent = "0.00";
    const code = document.createElement("code");
    code.textContent = channel.key;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = ".01";
    slider.value = "0";
    slider.dataset.channel = channel.key;
    slider.id = `channel-${channel.key}`;
    output.htmlFor = slider.id;
    slider.disabled = support[channel.key] === "unsupported";
    title.append(output);
    label.append(title, code, slider);
    if (!["frame", "gaze"].includes(support[channel.key])) {
      const note = document.createElement("small");
      note.textContent = support[channel.key] === "unsupported" ? "缺少独立画稿，当前不支持" : "整部位画稿近似";
      label.append(note);
    }
    slider.addEventListener("input", () => {
      stopDemo();
      $("#originalToggle").checked = false;
      setCoefficients({ ...coefficients, [channel.key]: Number(slider.value) });
      updateFeedbackPanel();
      paint(true);
    });
    return label;
  }));
}

function demoTick(now) {
  if (!playing || !ready) return;
  const seconds = (now - demoStartedAt) / 1000;
  const timeline = demoMode === "natural" ? NATURAL_DEMO : DEMO;
  const phase = seconds % timeline.duration;
  const step = timeline.steps.find((item) => phase >= item.start && phase < item.end);
  if (demoMode === "natural") {
    coefficients = sanitizeChannels(sampleNaturalDemo(seconds));
    renderedGaze = selectGaze(coefficients, assets.available);
    targetState = selectExpression(coefficients, targetState, assets.available);
    motion = advanceMotion(motion, targetState, now - lastDemoTick, assets.available);
    renderedState = { ...motion.frameState };
    renderMode = "natural";
    activePresetId = null;
    $("#previewHeading").textContent = step.label;
    updatePresetButtons(); syncSliders(); updateStateReadout(); paint();
  } else {
    const presetId = step.id === "rest" ? "neutral" : presetById.has(step.id) ? step.id : null;
    setCoefficients(sampleDemo(seconds), { presetId, label: step.label, resetSelection: true, mode: "frames" });
  }
  lastDemoTick = now;
  if (demoStepId !== step.id) {
    demoStepId = step.id;
    $("#motionStatus").textContent = `${timeline.duration} 秒循环 · ${step.label}`;
    updateFeedbackPanel();
  }
  if (playing && ready) animationFrame = requestAnimationFrame(demoTick);
}

function toggleDemo() {
  if (playing) { stopDemo(); paint(true); return; }
  if (!ready) return;
  $("#originalToggle").checked = false;
  setCoefficients({}, { presetId: demoMode === "frames" ? "neutral" : null, resetSelection: true, mode: demoMode });
  if (!ready) return;
  playing = true;
  demoStartedAt = performance.now();
  lastDemoTick = demoStartedAt;
  demoStepId = "";
  $("#demoToggle").setAttribute("aria-pressed", "true");
  $("#demoToggle").textContent = "暂停演示";
  updateFeedbackPanel();
  paint(true);
  animationFrame = requestAnimationFrame(demoTick);
}

function saveFeedback() {
  stopDemo();
  if (!activePresetId || !presetById.has(activePresetId)) return;
  const status = document.querySelector('[name="feedbackStatus"]:checked')?.value || "undecided";
  const note = $("#feedbackNote").value;
  feedback[activePresetId] = { status, note, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, assetId: assets.manifest.id, assetVersion: assets.manifest.version, feedback }));
    storageWarning = "";
    $("#saveStatus").textContent = "已自动保存到本浏览器。";
    $("#saveStatus").className = "save-status";
  } catch {
    storageWarning = "浏览器未能保存反馈，请离开前导出 JSON。";
    $("#saveStatus").textContent = storageWarning;
    $("#saveStatus").className = "save-status warning";
  }
  updateProgress();
}

function applyJson() {
  stopDemo();
  const status = $("#importStatus");
  try {
    const parsed = JSON.parse($("#channelJson").value);
    const input = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "coefficients") ? parsed.coefficients : parsed;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请提供 JSON 通道对象。");
    const knownChannels = new Set(visibleChannels().map(({ key }) => key));
    const unknown = Object.keys(input).filter((key) => !knownChannels.has(key));
    const supported = Object.keys(input).filter((key) => knownChannels.has(key));
    const ignored = unknown.length ? `已忽略未支持通道：${unknown.join("、")}。` : "";
    if (!supported.length) { status.textContent = `${ignored}没有本样机支持的通道，当前参数保持不变。`; status.className = "warning"; return; }
    for (const key of supported) {
      if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1) throw new Error(`${key} 必须是 0–1 之间的有限数字。`);
    }
    const missingAssets = supported.filter((key) => support[key] === "unsupported" && input[key] > 0);
    const next = sanitizeChannels(Object.fromEntries(supported.map((key) => [key, input[key]])));
    const preset = PRESETS.find((item) => presetAvailable(item) && CHANNELS.every(({ key }) => item.channels[key] === next[key]));
    $("#originalToggle").checked = false;
    setCoefficients(next, { presetId: preset?.id || null, resetSelection: true });
    updateFeedbackPanel();
    paint(true);
    status.textContent = `已应用 ${supported.length} 个通道，未提供的通道设为 0。${ignored}${missingAssets.length ? `这些通道缺少独立画稿，系数保留但不产生该动作：${missingAssets.join("、")}。` : ""}`;
    status.className = unknown.length || missingAssets.length ? "warning" : "";
  } catch (error) { status.textContent = `未应用：${error.message} 当前参数保持不变。`; status.className = "warning"; }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFeedback() {
  stopDemo();
  paint(true);
  if (!ready) return;
  const original = $("#originalToggle").checked;
  const exportedAt = new Date().toISOString();
  const payload = { schemaVersion: 1, scope: "正面表情样机反馈；静态批准、表情评价和完整动态验收各自独立。",
    assetId: assets.manifest.id, assetVersion: assets.manifest.version, assetStatus: assets.manifest.status, variant, exportedAt, sources: assets.manifest.sources,
    coefficients, renderedState: original ? selectExpression({}, {}, assets.available) : renderedState, targetState,
    renderedGaze: original ? selectGaze({}, assets.available) : renderedGaze, supportedChannels: visibleChannels().map(({ key }) => key),
    mode: original ? "original" : renderMode, demoMode, playing, currentPreset: activePresetId,
    visibleContent: original ? "approved-original" : "renderedState",
    preview: { faceOnly, guides: $("#guidesToggle").checked, original },
    feedback: PRESETS.map((preset) => ({ id: preset.id, label: preset.label, available: presetAvailable(preset), coefficients: preset.channels, ...feedback[preset.id] })) };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }), `expression-feedback-${exportedAt.replace(/[:.]/g, "-")}.json`);
  $("#saveStatus").textContent = storageWarning || "已准备反馈 JSON 下载，包含当前参数与各预设评价。";
}

function exportPng() {
  stopDemo();
  paint(true);
  if (!ready) return;
  try {
    const frameLabel = $("#originalToggle").checked ? "original" : activePresetId || (renderMode === "natural" ? "natural-frame" : "custom");
    const filename = `expression-${variant}-${frameLabel}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    $("#expressionCanvas").toBlob((blob) => {
      if (!blob) { $("#saveStatus").textContent = "PNG 导出失败，请重新尝试。"; return; }
      download(blob, filename);
      $("#saveStatus").textContent = "已准备当前预览的 PNG 下载。";
    }, "image/png");
  } catch (error) { $("#saveStatus").textContent = `PNG 导出失败：${error.message}`; }
}

async function loadVariant(nextVariant) {
  if (!Object.hasOwn(VARIANTS, nextVariant)) return;
  const meta = VARIANTS[nextVariant];
  const request = ++loadSequence;
  stopDemo();
  if (ready && storageKey) feedbackCache.set(storageKey, { feedback, warning: storageWarning });
  ready = false;
  $("#workspaceControls").disabled = true;
  $("#loadStatus").hidden = false;
  $("#loadStatus").className = "load-status";
  $("#loadStatus").textContent = `正在完整载入${meta.label}…`;
  $("#variantStatus").textContent = meta.label;
  $("#variantScope").textContent = "正在载入，请稍候";
  $("#canvasPlaceholder").textContent = "正在切换素材版本…";
  $("#canvasPlaceholder").className = "";
  $("#canvasPlaceholder").hidden = false;
  $("#expressionCanvas").hidden = true;
  $("#referenceCanvas").hidden = true;
  $("#sequenceRows").replaceChildren();
  for (const button of document.querySelectorAll("[data-variant]")) button.setAttribute("aria-pressed", String(button.dataset.variant === nextVariant));
  try {
    const loaded = await loadExpressionAssets({ variant: nextVariant });
    if (request !== loadSequence) return;
    if (!loaded?.manifest?.id || loaded.manifest.version == null) throw new Error("画稿缺少素材版本标识");
    if (loaded.manifest.status !== meta.status) throw new Error("载入素材的批准状态与所选版本不一致");
    assets = loaded;
    variant = nextVariant;
    assets.available ||= {};
    support = channelSupport(assets.available);
    const gazeEnabled = assets.available.gaze === true;
    $("[data-group='gaze']").hidden = !gazeEnabled;
    $(".group-tabs").classList.toggle("has-gaze", gazeEnabled);
    const count = visibleChannels().length;
    $("#channelSummary").textContent = `${count} 个 ARKit 通道 · JSON 导入`;
    $("#channelIntro").textContent = `系数范围为 0–1。手动调整会暂停演示；当前版本支持下方 ${count} 个通道。`;
    storageKey = `vtuber-expression-review:${encodeURIComponent(assets.manifest.id)}:${encodeURIComponent(String(assets.manifest.version))}`;
    restoreFeedback();
    buildSliders();
    lastPaint = "";
    ready = true;
    selectGroup(activeGroup);
    selectPreset(presetById.get("neutral"));
    paintReference();
    buildSequenceReview();
    if (!ready) return;
    $("#workspaceControls").disabled = false;
    $("#loadStatus").hidden = true;
    $("#canvasPlaceholder").hidden = true;
    $("#expressionCanvas").hidden = false;
    $("#referenceCanvas").hidden = false;
    $("#variantScope").textContent = meta.scope;
    $("#frameCapability").textContent = nextVariant === "approved"
      ? "当前为已确认基础版：沿用六张已批准源画稿，眼睑三档、张嘴三档。五档版本增加的四个预设在本版停用；本浏览器反馈保持原样。"
      : nextVariant === "motion"
        ? "当前为已确认自然动作版：眼睑五档、张嘴五档，沿用已确认画稿与自然节奏。视线保持原画方向；本版反馈独立保留。"
        : "当前为已确认视线版：五档表情、自然节奏与独立视线均已获用户确认。可切回前两版对照；左右侧转表情在独立页面检查。";
    $("#gazeCapability").textContent = gazeEnabled
      ? "本版使用同一眼球配合五档眼睑，高光随闭眼遮挡消失，中心视线也保持同一眼球外观。可切回已确认版本比较原逐档画稿。自然演示沿用已确认节奏，视线保持朝前。眉头、眉尾与单侧抿嘴仍采用整部位近似；侧向表情与连续转头尚未接入。"
      : "本版视线保持原画方向，不显示独立视线控制。眉头、眉尾与单侧抿嘴采用整部位近似；侧向表情与连续转头尚未接入。";
    $("#capabilityStatus").textContent = `当前支持 ${count} 个通道。${assets.available.shiftLeft && assets.available.shiftRight ? "左右移嘴的独立画稿已载入。" : "缺少独立移嘴画稿的方向已停用。"} 未列出的 ARKit 通道不受当前版本支持。`;
  } catch (error) { if (request === loadSequence) fail(error); }
}

function init() {
    for (const button of document.querySelectorAll("[data-variant]")) button.addEventListener("click", () => loadVariant(button.dataset.variant));
    for (const button of document.querySelectorAll("[data-group]")) button.addEventListener("click", () => selectGroup(button.dataset.group));
    for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => {
      stopDemo(); faceOnly = button.dataset.view === "face";
      for (const item of document.querySelectorAll("[data-view]")) item.setAttribute("aria-pressed", String(item === button));
      paint(true);
      if (ready) paintReference();
    });
    for (const id of ["#guidesToggle", "#originalToggle"]) $(id).addEventListener("change", () => { stopDemo(); updateFeedbackPanel(); updateStateReadout(); paint(true); });
    $("#demoMode").addEventListener("change", () => {
      stopDemo(); demoMode = $("#demoMode").value;
      $("#motionStatus").textContent = `已选择${demoMode === "natural" ? "自然动作，8 秒循环" : "逐稿观察，10 秒循环"}，点击播放开始。`;
    });
    $("#demoToggle").addEventListener("click", toggleDemo);
    for (const radio of document.querySelectorAll('[name="feedbackStatus"]')) radio.addEventListener("change", saveFeedback);
    $("#feedbackNote").addEventListener("input", saveFeedback);
    $("#applyJson").addEventListener("click", applyJson);
    $("#channelJson").addEventListener("input", () => stopDemo());
    $("#advancedControls").addEventListener("toggle", () => { if ($("#advancedControls").open) { stopDemo(); paint(true); } });
    $("#sequenceReview").addEventListener("toggle", () => { if ($("#sequenceReview").open) { stopDemo(); paint(true); } });
    $(".capability-panel").addEventListener("toggle", () => { if ($(".capability-panel").open) { stopDemo(); paint(true); } });
    $("#exportFeedback").addEventListener("click", exportFeedback);
    $("#exportPng").addEventListener("click", exportPng);
    document.addEventListener("visibilitychange", () => { if (document.hidden) { stopDemo("页面已隐藏，演示暂停。返回后可手动播放。"); paint(true); } });
    window.addEventListener("pagehide", () => stopDemo("离开页面，演示已暂停。"));
    loadVariant("candidate");
}

init();
