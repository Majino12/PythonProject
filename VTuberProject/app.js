const $ = (selector) => document.querySelector(selector);

const canvas = $("#avatarCanvas");
const ctx = canvas.getContext("2d", { alpha: true });
const video = $("#camera");
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
  landmarkPill: $("#landmarkPill"),
  recordButton: $("#recordButton"),
  heroStartButton: $("#heroStartButton"),
  nextButton: $("#nextButton"),
  qualityCard: $("#qualityCard"),
  qualityScore: $("#qualityScore"),
  qualityList: $("#qualityList"),
  calibration: $("#calibration"),
  calibrationCount: $("#calibrationCount"),
  welcomeDialog: $("#welcomeDialog"),
  helpDialog: $("#helpDialog"),
  welcomeStartButton: $("#welcomeStartButton"),
  welcomeDemoButton: $("#welcomeDemoButton"),
  helpButton: $("#helpButton"),
  toast: $("#toast"),
  meters: { eye: $("#eyeMeter"), mouth: $("#mouthMeter"), head: $("#headMeter") },
  ranges: { head: $("#headRange"), blink: $("#blinkRange"), mouth: $("#mouthRange") },
};

const state = {
  mode: "demo",
  background: "gradient",
  image: null,
  imageUrl: "",
  imageRig: null,
  faceLandmarker: null,
  imageLandmarker: null,
  lastVideoTime: -1,
  tracking: { x: 0, y: 0, roll: 0, blinkL: 0, blinkR: 0, mouth: 0, smile: 0 },
  smooth: { x: 0, y: 0, roll: 0, blinkL: 0, blinkR: 0, mouth: 0, smile: 0 },
  recorder: null,
  chunks: [],
  hasCustomAvatar: false,
  ready: false,
  calibrating: false,
  calibrationUntil: 0,
  calibrationSamples: [],
  neutral: { x: 0, y: 0, roll: 0 },
};

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a, b, amount) => a + (b - a) * amount;
const point = (landmarks, index, width, height) => ({ x: landmarks[index].x * width, y: landmarks[index].y * height });

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ui.toast.classList.remove("show"), 3200);
}

function setStatus(title, detail, live = true) {
  ui.status.querySelector("b").textContent = title;
  ui.status.querySelector("small").textContent = detail;
  ui.status.querySelector("span").style.background = live ? "var(--green)" : "#ffcf70";
}

function setJourney(stage) {
  const steps = [$("#journeyImage"), $("#journeyCamera"), $("#journeyReady")];
  const activeIndex = { image: 0, camera: 1, ready: 2 }[stage] ?? 0;
  steps.forEach((step, index) => {
    step.classList.toggle("done", index < activeIndex || (stage === "ready" && index === 2));
    step.classList.toggle("current", index === activeIndex && stage !== "ready");
  });
}

function updateNextButton() {
  ui.nextButton.classList.toggle("ready", state.ready);
  if (!state.hasCustomAvatar) {
    ui.nextButton.querySelector("span").textContent = "先换成我的角色图";
    ui.nextButton.querySelector("b").textContent = "推荐下一步 →";
  } else if (state.mode !== "camera") {
    ui.nextButton.querySelector("span").textContent = "下一步：开启摄像头";
    ui.nextButton.querySelector("b").textContent = "自动校准 →";
  } else if (state.calibrating) {
    ui.nextButton.querySelector("span").textContent = "正在自动校准…";
    ui.nextButton.querySelector("b").textContent = "请保持正脸";
  } else {
    ui.nextButton.querySelector("span").textContent = "已经可以开始使用";
    ui.nextButton.querySelector("b").textContent = "✓ 全部就绪";
  }
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

function savePreferences() {
  try {
    localStorage.setItem("moemotion-preferences", JSON.stringify({
      background: state.background,
      head: ui.ranges.head.value,
      blink: ui.ranges.blink.value,
      mouth: ui.ranges.mouth.value,
    }));
  } catch (error) {
    console.warn("Could not save preferences", error);
  }
}

function restorePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("moemotion-preferences") || "null");
    if (!saved) return;
    for (const name of ["head", "blink", "mouth"]) {
      if (saved[name]) {
        ui.ranges[name].value = saved[name];
        $(`#${name}Output`).textContent = `${saved[name]}%`;
      }
    }
    if (["gradient", "transparent", "green"].includes(saved.background)) {
      state.background = saved.background;
      document.querySelectorAll("[data-background]").forEach((button) => button.classList.toggle("selected", button.dataset.background === saved.background));
    }
  } catch (error) {
    console.warn("Could not restore preferences", error);
  }
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

function makeDemoAvatar() {
  const source = document.createElement("canvas");
  source.width = 900;
  source.height = 900;
  const c = source.getContext("2d");
  const g = c.createLinearGradient(0, 0, 900, 900);
  g.addColorStop(0, "#211b39");
  g.addColorStop(1, "#352347");
  c.fillStyle = g;
  c.fillRect(0, 0, 900, 900);

  c.save();
  c.translate(450, 480);
  c.fillStyle = "#2b203b";
  c.beginPath(); c.ellipse(0, 90, 285, 350, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = "#8f67ea";
  c.beginPath(); c.moveTo(-230, 400); c.quadraticCurveTo(-210, 195, -115, 162); c.lineTo(115, 162); c.quadraticCurveTo(210, 195, 230, 400); c.closePath(); c.fill();
  c.fillStyle = "#f3cbd0";
  c.fillRect(-36, 120, 72, 120);
  c.beginPath(); c.ellipse(0, -18, 190, 220, 0, 0, Math.PI * 2); c.fill();

  c.fillStyle = "#2a1d3c";
  c.beginPath(); c.moveTo(-175, -108); c.quadraticCurveTo(-118, -286, 30, -226); c.quadraticCurveTo(180, -195, 190, -34); c.quadraticCurveTo(115, -140, 35, -153); c.quadraticCurveTo(-45, -118, -90, -165); c.quadraticCurveTo(-106, -91, -175, -45); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(-174, -82); c.quadraticCurveTo(-238, 18, -163, 175); c.lineTo(-96, 107); c.quadraticCurveTo(-151, 10, -124, -72); c.fill();
  c.beginPath(); c.moveTo(172, -75); c.quadraticCurveTo(232, 39, 153, 185); c.lineTo(105, 103); c.quadraticCurveTo(157, 10, 128, -80); c.fill();

  for (const x of [-72, 72]) {
    c.fillStyle = "#493762";
    c.beginPath(); c.ellipse(x, -12, 43, 28, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#bc96ff";
    c.beginPath(); c.ellipse(x, -8, 24, 23, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#23182f";
    c.beginPath(); c.ellipse(x, -5, 10, 17, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "white";
    c.beginPath(); c.arc(x - 6, -13, 5, 0, Math.PI * 2); c.fill();
  }
  c.strokeStyle = "#563b59"; c.lineWidth = 7; c.lineCap = "round";
  c.beginPath(); c.moveTo(-25, 80); c.quadraticCurveTo(0, 96, 25, 80); c.stroke();
  c.fillStyle = "rgba(241,133,164,.22)";
  c.beginPath(); c.ellipse(-118, 52, 35, 15, 0, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.ellipse(118, 52, 35, 15, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = "#ff83bd";
  c.beginPath(); c.moveTo(0, -242); c.lineTo(17, -205); c.lineTo(57, -206); c.lineTo(29, -175); c.lineTo(39, -137); c.lineTo(0, -158); c.lineTo(-39, -137); c.lineTo(-29, -175); c.lineTo(-57, -206); c.lineTo(-17, -205); c.closePath(); c.fill();
  c.restore();

  c.fillStyle = "rgba(255,255,255,.7)";
  for (const [x, y, r] of [[130,130,3],[760,170,5],[735,690,3],[175,745,4]]) {
    c.beginPath(); c.arc(x,y,r,0,Math.PI*2); c.fill();
  }

  const img = new Image();
  img.onload = () => {
    state.image = img;
    state.imageUrl = source.toDataURL("image/png");
    state.imageRig = {
      leftEye: { x: 378, y: 468, w: 102, h: 66 },
      rightEye: { x: 522, y: 468, w: 102, h: 66 },
      mouth: { x: 450, y: 560, w: 86, h: 50 },
      face: { x: 450, y: 462, w: 380, h: 440 },
      skin: "#f0c7cb",
    };
  };
  img.src = source.toDataURL("image/png");
}

async function loadVision() {
  if (state.faceLandmarker && state.imageLandmarker) return true;
  try {
    setStatus("加载面捕引擎", "首次使用需要联网下载模型", false);
    const { FaceLandmarker, FilesetResolver } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm");
    const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm");
    const options = {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      numFaces: 1,
      outputFaceBlendshapes: true,
    };
    [state.imageLandmarker, state.faceLandmarker] = await Promise.all([
      FaceLandmarker.createFromOptions(fileset, { ...options, runningMode: "IMAGE" }),
      FaceLandmarker.createFromOptions(fileset, { ...options, runningMode: "VIDEO" }),
    ]);
    return true;
  } catch (error) {
    console.error(error);
    toast("面捕模型加载失败，已保留自动演示模式。请检查网络后重试。");
    setStatus("演示模式", "面捕模型暂不可用", false);
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

function rigFromLandmarks(landmarks, image) {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const p = (i) => point(landmarks, i, w, h);
  const le = [p(33), p(133), p(159), p(145)];
  const re = [p(362), p(263), p(386), p(374)];
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

async function importImage(file) {
  if (!file || !file.type.startsWith("image/")) {
    toast("请选择 PNG、JPG 或 WEBP 图片。");
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    toast("图片超过 20MB，请先压缩后重试。");
    return;
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = async () => {
    if (state.imageUrl.startsWith("blob:")) URL.revokeObjectURL(state.imageUrl);
    state.image = image;
    state.imageUrl = url;
    state.imageRig = fallbackRig(image);
    state.hasCustomAvatar = true;
    state.ready = false;
    setJourney("camera");
    updateNextButton();
    ui.dropzone.classList.add("hidden");
    ui.fileRow.classList.remove("hidden");
    ui.fileThumb.src = url;
    ui.fileName.textContent = file.name;
    ui.fileMeta.textContent = `${image.naturalWidth} × ${image.naturalHeight} · 分析中`;
    ui.scanState.classList.remove("hidden");
    ui.landmarkPill.classList.add("hidden");
    const ready = await loadVision();
    if (ready) {
      try {
        const result = state.imageLandmarker.detect(image);
        const detectedLandmarks = result.faceLandmarks?.[0];
        if (detectedLandmarks) {
          state.imageRig = rigFromLandmarks(detectedLandmarks, image);
          ui.fileMeta.textContent = `${image.naturalWidth} × ${image.naturalHeight} · 已自动绑定`;
          ui.landmarkPill.textContent = "✦ 五官识别完成 · 已自动绑定";
          toast("角色绑定完成。下一步只需开启摄像头。");
        } else {
          ui.fileMeta.textContent = `${image.naturalWidth} × ${image.naturalHeight} · 使用通用绑定`;
          ui.landmarkPill.textContent = "◇ 未检测到人脸 · 已使用通用绑定";
          toast("没有检测到清晰正脸，已使用通用绑定。建议换一张正脸图。");
        }
        showQualityReport(image, detectedLandmarks);
      } catch (error) {
        console.error(error);
        ui.fileMeta.textContent = "已使用通用绑定";
        showQualityReport(image, null);
      }
    } else {
      ui.fileMeta.textContent = "离线模式 · 使用通用绑定";
      ui.landmarkPill.textContent = "◇ 离线通用绑定";
      showQualityReport(image, null);
    }
    ui.scanState.classList.add("hidden");
    ui.landmarkPill.classList.remove("hidden");
  };
  image.onerror = () => { URL.revokeObjectURL(url); toast("无法读取这张图片，请换一个文件。"); };
  image.src = url;
}

function fallbackRig(image) {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  return {
    leftEye: { x: w * .43, y: h * .40, w: w * .13, h: h * .065 },
    rightEye: { x: w * .57, y: h * .40, w: w * .13, h: h * .065 },
    mouth: { x: w * .5, y: h * .55, w: w * .15, h: h * .075 },
    face: { x: w * .5, y: h * .44, w: w * .42, h: h * .5 },
    skin: colorFromImage(image, w * .5, h * .34),
  };
}

async function startCamera() {
  ui.cameraButton.disabled = true;
  const ready = await loadVision();
  if (!ready) { ui.cameraButton.disabled = false; return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
    video.srcObject = stream;
    await video.play();
    state.mode = "camera";
    state.ready = false;
    state.calibrating = true;
    state.calibrationUntil = performance.now() + 3200;
    state.calibrationSamples = [];
    state.neutral = { x: 0, y: 0, roll: 0 };
    ui.cameraButton.classList.add("selected");
    ui.demoButton.classList.remove("selected");
    ui.calibration.classList.remove("hidden");
    setJourney("camera");
    updateNextButton();
    setStatus("自动校准", "保持正脸约 3 秒", false);
    toast("摄像头已连接，请保持正脸，校准会自动完成。");
  } catch (error) {
    console.error(error);
    toast("无法使用摄像头，请在浏览器地址栏允许摄像头权限。");
    setStatus("演示模式", "摄像头权限未开启", false);
  } finally {
    ui.cameraButton.disabled = false;
  }
}

function useDemo() {
  state.mode = "demo";
  state.calibrating = false;
  state.ready = false;
  ui.calibration.classList.add("hidden");
  ui.demoButton.classList.add("selected");
  ui.cameraButton.classList.remove("selected");
  setStatus("演示模式", "使用内置自然动作", true);
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
  setJourney(state.hasCustomAvatar ? "camera" : "image");
  updateNextButton();
}

function updateCalibration(now) {
  if (!state.calibrating) return;
  const remaining = Math.max(0, state.calibrationUntil - now);
  ui.calibrationCount.textContent = String(Math.max(1, Math.ceil(remaining / 1000)));
  if (remaining > 0) return;
  if (state.calibrationSamples.length < 5) {
    state.calibrationUntil = now + 1000;
    ui.calibration.querySelector("b").textContent = "请把脸放进镜头中央";
    ui.calibration.querySelector("small").textContent = "检测到面部后会自动继续";
    setStatus("等待面部", "请正对摄像头", false);
    return;
  }
  if (state.calibrationSamples.length) {
    for (const key of ["x", "y", "roll"]) {
      state.neutral[key] = state.calibrationSamples.reduce((sum, sample) => sum + sample[key], 0) / state.calibrationSamples.length;
    }
  }
  state.calibrating = false;
  state.ready = true;
  ui.calibration.classList.add("hidden");
  ui.calibration.querySelector("b").textContent = "保持正脸，正在自动校准";
  ui.calibration.querySelector("small").textContent = "不用做任何操作";
  setJourney("ready");
  updateNextButton();
  setStatus("全部就绪", "角色正在跟随你的动作", true);
  toast("校准完成！现在眨眼、说话、摇头试试看。");
}

function categoryMap(result) {
  const categories = result.faceBlendshapes?.[0]?.categories || [];
  return Object.fromEntries(categories.map(({ categoryName, score }) => [categoryName, score]));
}

function trackCamera(now) {
  if (state.mode !== "camera" || !state.faceLandmarker || video.readyState < 2 || video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;
  const result = state.faceLandmarker.detectForVideo(video, now);
  if (!result.faceLandmarks?.length) {
    setStatus("寻找面部", "请正对摄像头", false);
    return;
  }
  if (state.calibrating) {
    ui.calibration.querySelector("b").textContent = "保持正脸，正在自动校准";
    ui.calibration.querySelector("small").textContent = "不用做任何操作";
  }
  if (!state.calibrating) setStatus("摄像头面捕", "正在实时追踪", true);
  const landmarks = result.faceLandmarks[0];
  const blends = categoryMap(result);
  const left = landmarks[33];
  const right = landmarks[263];
  const nose = landmarks[1];
  const eyeMidX = (left.x + right.x) / 2;
  const eyeMidY = (left.y + right.y) / 2;
  const eyeDistance = Math.max(.001, Math.hypot(right.x - left.x, right.y - left.y));
  const raw = {
    x: clamp((nose.x - eyeMidX) / eyeDistance * 2.4, -1, 1),
    y: clamp((nose.y - eyeMidY) / eyeDistance * 2.8 - 1.05, -1, 1),
    roll: clamp(Math.atan2(right.y - left.y, right.x - left.x) / .35, -1, 1),
  };
  if (state.calibrating) state.calibrationSamples.push(raw);
  state.tracking.x = clamp(raw.x - state.neutral.x, -1, 1);
  state.tracking.y = clamp(raw.y - state.neutral.y, -1, 1);
  state.tracking.roll = clamp(raw.roll - state.neutral.roll, -1, 1);
  state.tracking.blinkL = clamp(blends.eyeBlinkLeft ?? 0);
  state.tracking.blinkR = clamp(blends.eyeBlinkRight ?? 0);
  state.tracking.mouth = clamp((blends.jawOpen ?? 0) * 1.25);
  state.tracking.smile = clamp(((blends.mouthSmileLeft ?? 0) + (blends.mouthSmileRight ?? 0)) / 2);
}

function trackDemo(now) {
  if (state.mode !== "demo") return;
  const t = now / 1000;
  const blink = Math.pow(Math.max(0, Math.sin(t * 2.15 + 1.1)), 24);
  state.tracking.x = Math.sin(t * .64) * .42;
  state.tracking.y = Math.sin(t * .47 + .8) * .22;
  state.tracking.roll = Math.sin(t * .52) * .28;
  state.tracking.blinkL = blink;
  state.tracking.blinkR = clamp(blink + Math.pow(Math.max(0, Math.sin(t * .77)), 42) * .25);
  state.tracking.mouth = .1 + (Math.sin(t * 3.1) + 1) * .14 + Math.pow(Math.max(0, Math.sin(t * .9)), 3) * .22;
  state.tracking.smile = .25 + Math.sin(t * .41) * .1;
}

function drawBackground() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.background === "transparent") return;
  if (state.background === "green") {
    ctx.fillStyle = "#00b140";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const gradient = ctx.createRadialGradient(360, 330, 40, 360, 360, 510);
  gradient.addColorStop(0, "#322746");
  gradient.addColorStop(.58, "#1c1828");
  gradient.addColorStop(1, "#12101b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = .13;
  ctx.strokeStyle = "#c5a9ff";
  ctx.lineWidth = 1;
  for (let i = -720; i < 720; i += 52) {
    ctx.beginPath(); ctx.moveTo(i, 720); ctx.lineTo(i + 720, 0); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawPatch(image, box, amount, type, skin) {
  const sx = box.x - box.w / 2;
  const sy = box.y - box.h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(box.x, box.y, box.w * .54, box.h * .58, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = skin;
  ctx.fillRect(sx, sy, box.w, box.h);
  const scaleY = type === "eye" ? Math.max(.06, 1 - amount * .94) : 1 + amount * 1.05;
  ctx.translate(box.x, box.y);
  ctx.scale(type === "mouth" ? 1 + amount * .12 : 1, scaleY);
  ctx.drawImage(image, sx, sy, box.w, box.h, -box.w / 2, -box.h / 2, box.w, box.h);
  ctx.restore();
  if (type === "eye" && amount > .72) {
    ctx.save();
    ctx.strokeStyle = "rgba(45, 27, 48, .7)";
    ctx.lineWidth = Math.max(1.5, box.h * .045);
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(box.x - box.w * .28, box.y); ctx.quadraticCurveTo(box.x, box.y + box.h * .1, box.x + box.w * .28, box.y); ctx.stroke();
    ctx.restore();
  }
}

function render() {
  drawBackground();
  const image = state.image;
  const rig = state.imageRig;
  if (!image || !rig) return;
  const headAmount = Number(ui.ranges.head.value) / 100;
  const blinkAmount = Number(ui.ranges.blink.value) / 100;
  const mouthAmount = Number(ui.ranges.mouth.value) / 100;
  const s = state.smooth;
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const drawHeight = imageRatio > 1 ? canvas.height / imageRatio : canvas.height * .95;
  const drawWidth = drawHeight * imageRatio;
  const baseScale = Math.min((canvas.width * .94) / drawWidth, (canvas.height * .96) / drawHeight);
  const finalWidth = drawWidth * baseScale;
  const finalHeight = drawHeight * baseScale;
  const imageScale = finalWidth / image.naturalWidth;

  ctx.save();
  ctx.translate(canvas.width / 2 + s.x * 15 * headAmount, canvas.height / 2 + s.y * 9 * headAmount);
  ctx.rotate(s.roll * .055 * headAmount);
  ctx.scale(1 + Math.abs(s.x) * .008, 1);
  ctx.translate(-finalWidth / 2, -finalHeight / 2);
  ctx.scale(imageScale, imageScale);
  ctx.drawImage(image, 0, 0);
  drawPatch(image, rig.leftEye, clamp(s.blinkL * blinkAmount), "eye", rig.skin);
  drawPatch(image, rig.rightEye, clamp(s.blinkR * blinkAmount), "eye", rig.skin);
  drawPatch(image, rig.mouth, clamp(s.mouth * mouthAmount), "mouth", rig.skin);
  ctx.restore();
}

function animate(now = performance.now()) {
  trackDemo(now);
  trackCamera(now);
  updateCalibration(now);
  for (const key of Object.keys(state.smooth)) {
    const speed = key.startsWith("blink") ? .42 : key === "mouth" ? .3 : .16;
    state.smooth[key] = mix(state.smooth[key], state.tracking[key], speed);
  }
  render();
  const blinkValue = (state.smooth.blinkL + state.smooth.blinkR) / 2;
  ui.meters.eye.style.width = `${clamp(blinkValue) * 100}%`;
  ui.meters.mouth.style.width = `${clamp(state.smooth.mouth) * 100}%`;
  ui.meters.head.style.width = `${clamp((Math.abs(state.smooth.x) + Math.abs(state.smooth.roll)) / 1.4) * 100}%`;
  requestAnimationFrame(animate);
}

function toggleRecording() {
  if (!window.MediaRecorder || !canvas.captureStream) {
    toast("当前浏览器不支持画布录制，请使用最新版 Chrome 或 Edge。");
    return;
  }
  if (state.recorder?.state === "recording") {
    state.recorder.stop();
    return;
  }
  const stream = canvas.captureStream(30);
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
  state.chunks = [];
  state.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
  state.recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
  state.recorder.onstop = () => {
    const blob = new Blob(state.chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `moemotion-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.webm`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.recordButton.classList.remove("recording");
    ui.recordButton.querySelector("span").textContent = "录制透明视频";
    toast("录制完成，WebM 视频已保存。");
  };
  state.recorder.start();
  ui.recordButton.classList.add("recording");
  ui.recordButton.querySelector("span").textContent = "停止并保存";
  toast("正在录制。再次点击即可停止并保存。");
}

function openFilePicker() {
  ui.fileInput.value = "";
  ui.fileInput.click();
}

function markWelcomeSeen() {
  try { localStorage.setItem("moemotion-welcome-seen", "1"); } catch (error) { console.warn(error); }
}

ui.fileInput.addEventListener("change", (event) => importImage(event.target.files[0]));
ui.replaceButton.addEventListener("click", openFilePicker);
ui.heroStartButton.addEventListener("click", openFilePicker);
ui.cameraButton.addEventListener("click", startCamera);
ui.demoButton.addEventListener("click", useDemo);
ui.recordButton.addEventListener("click", toggleRecording);
ui.nextButton.addEventListener("click", () => {
  if (!state.hasCustomAvatar) openFilePicker();
  else if (state.mode !== "camera") startCamera();
  else if (state.calibrating) toast("正在校准，请保持正脸，很快就好。");
  else toast("已经准备好了。你可以录制视频，或继续调整背景和动作幅度。");
});
ui.helpButton.addEventListener("click", () => ui.helpDialog.showModal());
ui.welcomeStartButton.addEventListener("click", () => {
  markWelcomeSeen();
  closeDialog(ui.welcomeDialog);
  openFilePicker();
});
ui.welcomeDemoButton.addEventListener("click", () => {
  markWelcomeSeen();
  closeDialog(ui.welcomeDialog);
  toast("正在使用示例角色。准备好图片后，点击左侧导入即可。");
});
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
ui.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  ui.dropzone.classList.remove("dragging");
  importImage(event.dataTransfer.files[0]);
});
document.querySelectorAll("[data-background]").forEach((button) => {
  button.addEventListener("click", () => {
    state.background = button.dataset.background;
    document.querySelectorAll("[data-background]").forEach((item) => item.classList.toggle("selected", item === button));
    savePreferences();
  });
});
Object.entries(ui.ranges).forEach(([name, range]) => {
  const output = $(`#${name}Output`);
  range.addEventListener("input", () => { output.textContent = `${range.value}%`; savePreferences(); });
});
window.addEventListener("beforeunload", () => {
  video.srcObject?.getTracks().forEach((track) => track.stop());
  if (state.imageUrl.startsWith("blob:")) URL.revokeObjectURL(state.imageUrl);
});

restorePreferences();
setJourney("image");
updateNextButton();
makeDemoAvatar();
requestAnimationFrame(animate);
setTimeout(() => {
  try {
    if (!localStorage.getItem("moemotion-welcome-seen")) ui.welcomeDialog.showModal();
  } catch (error) {
    console.warn(error);
  }
}, 280);
