import { REVIEW_STATUSES, REVIEW_GROUPS, LANDMARK_LABELS, validateReviewManifest, reviewStorageKey, emptyReview,
  readReview, serializeReview, exportReview, faceViewBox } from "./character-review-model.js";

const $ = (selector) => document.querySelector(selector);
const svgNS = "http://www.w3.org/2000/svg";
const landmarkNames = Object.keys(LANDMARK_LABELS);
let manifest;
let review;
let activePose;
let activeGroup = "yaw";
let view = "full";
let storageWarning = "";
const frames = new Map();
const selectedByGroup = new Map();

function svgElement(name, attributes = {}) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function addLandmarks(svg, pose) {
  const group = svgElement("g", { class: "landmarks", "aria-hidden": "true" });
  const eyeNames = landmarkNames.slice(0, 4);
  const lineNames = [eyeNames, ["noseTip", "philtrum", "upperLip", "chin"]];
  for (const [index, names] of lineNames.entries()) {
    // Only connect observed points; no horizontal axis or inferred anatomy is imposed.
    const points = names.filter((key) => pose.landmarks[key]).map((key) => pose.landmarks[key].join(","));
    if (points.length > 1) group.append(svgElement("polyline", { points: points.join(" "), class: "landmark-line", stroke: index ? "#ffd28c" : "#7fe1f2" }));
  }
  for (const [index, name] of landmarkNames.entries()) {
    const point = pose.landmarks[name];
    if (!point) continue;
    const dot = svgElement("circle", { cx: point[0], cy: point[1], r: pose.width * 0.005, class: "landmark-dot", fill: index < 4 ? "#7fe1f2" : "#ffd28c" });
    const title = svgElement("title");
    title.textContent = `${index + 1} ${LANDMARK_LABELS[name]} (${point.join(", ")})`;
    dot.append(title);
    const label = svgElement("text", { x: point[0] + pose.width * 0.009, y: point[1] - pose.width * 0.008,
      "font-size": pose.width * 0.018, class: "landmark-label" });
    label.textContent = String(index + 1);
    group.append(dot, label);
  }
  svg.append(group);
}

function renderArt(container, pose) {
  const svg = svgElement("svg", { viewBox: `0 0 ${pose.width} ${pose.height}`, preserveAspectRatio: "xMidYMid meet",
    role: "img", "aria-label": `${pose.label}，静态结构画稿` });
  const art = svgElement("image", { href: pose.src, x: 0, y: 0, width: pose.width, height: pose.height });
  svg.append(art);
  addLandmarks(svg, pose);
  const status = document.createElement("div");
  status.className = "image-status";
  status.textContent = "正在加载画稿…";
  container.replaceChildren(svg, status);
  const frame = { svg, pose, valid: false };
  frames.set(container.id, frame);
  updateArtView();

  const image = new Image();
  image.onload = () => {
    if (frames.get(container.id) !== frame) return;
    if (image.naturalWidth !== pose.width || image.naturalHeight !== pose.height) {
      frame.valid = false;
      status.classList.add("error");
      status.textContent = `图像尺寸与清单不一致，已暂停显示标志点。实际 ${image.naturalWidth} × ${image.naturalHeight}；记录 ${pose.width} × ${pose.height}。`;
      updateArtView();
      return;
    }
    frame.valid = true;
    status.remove();
    updateArtView();
  };
  image.onerror = () => {
    if (frames.get(container.id) !== frame) return;
    frame.valid = false;
    status.classList.add("error");
    status.textContent = "画稿加载失败，请检查本地文件或重新启动项目服务。";
    const path = document.createElement("small");
    path.textContent = pose.src;
    status.append(path);
    updateArtView();
  };
  image.src = pose.src;
}

function updateArtView() {
  for (const { svg, pose, valid } of frames.values()) {
    const box = view === "face" ? faceViewBox(pose) : [0, 0, pose.width, pose.height];
    svg.setAttribute("viewBox", box.join(" "));
    svg.querySelector(".landmarks").setAttribute("visibility", valid && $("#showLandmarks").checked ? "visible" : "hidden");
  }
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === view));
  $("#landmarkGuide").hidden = !$("#showLandmarks").checked;
  $("#zoomGuide").hidden = view !== "face";
}

function updateFeedbackSummary() {
  const state = review[activePose.id];
  const badge = $("#candidateBadge");
  badge.textContent = activePose.approved ? "静态设计已确认" : "静态设计待确认";
  badge.className = `badge${activePose.approved ? " approved" : ""}`;
  $("#feedbackState").textContent = `本浏览器补充判断：${REVIEW_STATUSES[state.status]}`;
  for (const button of document.querySelectorAll("[data-pose]")) {
    const pose = manifest.poses.find((item) => item.id === button.dataset.pose);
    button.querySelector("small").textContent = `${pose.approved ? "静态已确认" : "静态待确认"} · 补充${REVIEW_STATUSES[review[pose.id].status]}`;
  }
  const states = Object.values(review);
  $("#reviewProgress").textContent = `本浏览器补充反馈：${states.filter((item) => item.status !== "undecided").length} / ${states.length} 张已记录判断 · ${states.filter((item) => item.status === "revise").length} 张提出修改`;
}

function saveFeedback() {
  review[activePose.id] = { status: document.querySelector('[name="reviewStatus"]:checked').value,
    note: $("#reviewNote").value, updatedAt: new Date().toISOString() };
  const status = $("#saveStatus");
  try {
    localStorage.setItem(reviewStorageKey(manifest), serializeReview(manifest, review));
    storageWarning = "";
    status.textContent = "补充反馈已自动保存到本浏览器。";
    status.className = "";
  } catch {
    storageWarning = "浏览器未能保存反馈，请离开前导出 JSON。";
    status.textContent = storageWarning;
    status.className = "warning";
  }
  updateFeedbackSummary();
}

function selectPose(pose) {
  activePose = pose;
  selectedByGroup.set(pose.group, pose.id);
  $("#candidateHeading").textContent = pose.label;
  $("#feedbackHeading").textContent = `${pose.label} · 补充反馈`;
  renderArt($("#candidateArt"), pose);
  for (const button of document.querySelectorAll("[data-pose]")) button.setAttribute("aria-pressed", String(button.dataset.pose === pose.id));
  for (const radio of document.querySelectorAll('[name="reviewStatus"]')) radio.checked = radio.value === review[pose.id].status;
  $("#reviewNote").value = review[pose.id].note;
  $("#saveStatus").textContent = storageWarning || (review[pose.id].updatedAt ? "已恢复本浏览器保存的补充反馈。" : "补充反馈自动保存在本浏览器。");
  $("#saveStatus").className = storageWarning ? "warning" : "";
  const list = $("#notesList");
  list.replaceChildren(...pose.notes.map((note) => { const item = document.createElement("li"); item.textContent = note; return item; }));
  $("#poseNotes").hidden = !pose.notes.length;
  $("#poseNotes").open = false;
  updateFeedbackSummary();
}

function selectGroup(group) {
  const poses = manifest.poses.filter((pose) => pose.group === group);
  if (!poses.length) return;
  activeGroup = group;
  for (const button of document.querySelectorAll("[data-group]")) button.setAttribute("aria-pressed", String(button.dataset.group === group));
  const picker = $("#posePicker");
  picker.setAttribute("aria-label", `选择${REVIEW_GROUPS[group]}画稿`);
  picker.replaceChildren(...poses.map((pose) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pose-thumb";
    button.dataset.pose = pose.id;
    const image = new Image();
    image.src = pose.src;
    image.alt = "";
    image.addEventListener("error", () => { image.hidden = true; });
    const label = document.createElement("span");
    label.textContent = pose.label;
    const status = document.createElement("small");
    status.textContent = `${pose.approved ? "静态已确认" : "静态待确认"} · 补充${REVIEW_STATUSES[review[pose.id].status]}`;
    label.append(status);
    button.append(image, label);
    button.addEventListener("click", () => selectPose(pose));
    return button;
  }));
  selectPose(poses.find((pose) => pose.id === selectedByGroup.get(group)) || poses[0]);
}

function downloadFeedback() {
  const payload = JSON.stringify(exportReview(manifest, review), null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `character-structure-review-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#saveStatus").textContent = storageWarning || "已准备反馈 JSON 下载；图片和项目素材保持原样。";
}

async function init() {
  try {
    const response = await fetch("./assets/short-hair-v1/review.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`画稿清单读取失败（HTTP ${response.status}）。`);
    manifest = validateReviewManifest(await response.json());
    document.title = `${manifest.characterName} · 静态设计回看`;
    $("#approvalSummary").textContent = `作品确认：${manifest.poses.filter((pose) => pose.approved).length} / ${manifest.poses.length} 张静态稿已获人工批准。下方补充反馈与确认记录分开保存。`;
    try { review = readReview(manifest, localStorage.getItem(reviewStorageKey(manifest))); }
    catch { review = emptyReview(manifest); storageWarning = "未能读取之前的反馈；本次可继续记录并导出 JSON。"; }
    for (const button of document.querySelectorAll("[data-group]")) {
      button.disabled = !manifest.poses.some((pose) => pose.group === button.dataset.group);
      button.addEventListener("click", () => selectGroup(button.dataset.group));
    }
    for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => { view = button.dataset.view; updateArtView(); });
    $("#showLandmarks").addEventListener("change", updateArtView);
    for (const radio of document.querySelectorAll('[name="reviewStatus"]')) radio.addEventListener("change", saveFeedback);
    $("#reviewNote").addEventListener("input", saveFeedback);
    $("#exportReview").addEventListener("click", downloadFeedback);
    renderArt($("#referenceArt"), manifest.poses.find((pose) => pose.id === manifest.referenceId));
    selectGroup(manifest.poses.some((pose) => pose.group === activeGroup) ? activeGroup : manifest.poses.find((pose) => pose.group !== "front").group);
    $("#loadStatus").hidden = true;
    $("#reviewApp").hidden = false;
  } catch (error) {
    $("#loadStatus").className = "error";
    $("#loadStatus").textContent = `${error.message} 请从本地项目服务打开此页面，并确认 assets/short-hair-v1/review.json 及对应图片已准备好。`;
  }
}

init();
