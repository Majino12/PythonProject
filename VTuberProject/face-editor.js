import {
  CHANNEL_DEFINITIONS, DEFAULT_CHANNEL_SETTINGS, normalizeBlendshapeSettings, mapBlendshapeValue,
} from "./arkit-blendshapes.js";
import { parseBlendshapeFrame } from "./face-session.js";

export function describeHeadPose(pose) {
  const yaw = Number.isFinite(pose?.yaw) ? Math.max(-1, Math.min(1, pose.yaw)) : 0;
  const pitch = Number.isFinite(pose?.pitch) ? Math.max(-1, Math.min(1, pose.pitch)) : 0;
  const horizontal = yaw < -.82 ? "左侧面" : yaw > .82 ? "右侧面" : yaw < -.28 ? "向左" : yaw > .28 ? "向右" : "";
  const vertical = pitch > .28 ? "抬头" : pitch < -.28 ? "低头" : "";
  return [horizontal, vertical].filter(Boolean).join(" · ") || "正面";
}

export class FaceEditor {
  constructor(root, session, {
    onChange, onMessage, indicator, is2D = () => true, getSupport = () => ({}), quickRoot = null,
    canPose = () => false, getPose = () => ({ input: { yaw: 0, pitch: 0 }, rendered: null }),
  }) {
    this.root = root;
    this.session = session;
    this.onChange = onChange;
    this.onMessage = onMessage;
    this.indicator = indicator;
    this.is2D = is2D;
    this.getSupport = getSupport;
    this.canPose = canPose;
    this.getPose = getPose;
    this.quickRoot = quickRoot;
    this.lastMeterTime = -Infinity;
    this.importRequest = 0;
    this.singleChannelTest = false;
    const get = (id) => root.querySelector(`#${id}`);
    this.channel = get("faceChannel");
    this.testRange = get("faceTestValue");
    this.testOutput = get("faceTestOutput");
    this.manual = get("faceManual");
    this.focus = get("faceFocus");
    this.hint = get("faceChannelHint");
    this.source = get("faceInputSource");
    this.raw = get("faceRaw");
    this.output = get("faceMapped");
    this.path = get("faceCurvePath");
    this.dot = get("faceCurveDot");
    this.file = get("faceFrameFile");
    this.poseManual = get("headPoseManual");
    this.poseValue = get("headPoseValue");
    this.poseButtons = [...root.querySelectorAll("[data-head-pose]")];
    this.transitionButtons = [...root.querySelectorAll("[data-transition-preview]"), ...quickRoot?.querySelectorAll("[data-transition-preview]") || []];
    this.config = Object.fromEntries(["inputMin", "inputMax", "outputMin", "outputMax", "smoothing", "curve"]
      .map((key) => [key, root.querySelector(`[data-face-setting="${key}"]`)]));
    const groups = new Map();
    for (const definition of CHANNEL_DEFINITIONS) {
      let group = groups.get(definition.group);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = definition.group;
        groups.set(definition.group, group);
        this.channel.append(group);
      }
      const option = document.createElement("option");
      option.value = definition.key;
      option.textContent = `${definition.label} · ${definition.key}`;
      group.append(option);
    }
    this.channel.value = "jawOpen";
    this.channel.addEventListener("change", () => {
      if (this.session.manual && this.singleChannelTest) this.testSelected();
      else if (this.session.manual) this.testRange.value = String(this.session.manualFrame[this.channel.value]);
      this.refreshControls();
    });
    for (const [key, element] of Object.entries(this.config)) {
      element.addEventListener("change", () => {
        const current = this.session.settings.channels[this.channel.value] || DEFAULT_CHANNEL_SETTINGS;
        this.session.settings = normalizeBlendshapeSettings({
          channels: { ...this.session.settings.channels, [this.channel.value]: {
            ...current, [key]: key === "curve" ? element.value : Number(element.value),
          } },
        });
        this.refreshControls();
        this.onChange();
      });
    }
    this.manual.addEventListener("change", () => {
      if (this.manual.checked) this.testSelected();
      else this.session.clearExpressionTest();
      this.refreshControls();
    });
    this.testRange.addEventListener("input", () => {
      this.testSelected();
      this.refreshControls();
    });
    this.focus.addEventListener("change", () => { this.session.focus = this.focus.checked; });
    get("faceResetChannel").addEventListener("click", () => {
      delete this.session.settings.channels[this.channel.value];
      this.refreshControls();
      this.onChange();
    });
    get("faceResetAll").addEventListener("click", () => {
      this.session.setSettings({});
      this.refreshControls();
      this.onChange();
      this.onMessage("2D 通道已恢复默认，原图和 3D 设置未改变。");
    });
    get("faceExitTest").addEventListener("click", () => {
      this.session.clearTest();
      this.refreshControls();
    });
    indicator?.addEventListener("click", () => {
      this.session.clearTest();
      this.refreshControls();
    });
    const presets = {
      neutral: { jawOpen: 0 },
      blink: { eyeBlinkLeft: 1, eyeBlinkRight: 1 },
      wink: { eyeBlinkLeft: 1 },
      open: { jawOpen: .8 },
      smile: { mouthSmileLeft: .8, mouthSmileRight: .8, cheekSquintLeft: .15, cheekSquintRight: .15 },
      funnel: { mouthFunnel: .8, jawOpen: .3 },
      pucker: { mouthPucker: .9 },
      puckerLeft: { mouthPucker: .9, mouthLeft: .78 },
      puckerRight: { mouthPucker: .9, mouthRight: .78 },
      press: { mouthPressLeft: .9, mouthPressRight: .9 },
      brow: { browOuterUpLeft: .9 },
      sad: { browInnerUp: .8, mouthFrownLeft: .8, mouthFrownRight: .8 },
    };
    const presetButtons = [...root.querySelectorAll("[data-face-test]"), ...quickRoot?.querySelectorAll("[data-face-test]") || []];
    presetButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const frame = presets[button.dataset.faceTest];
        if (!frame) return;
        this.channel.value = Object.keys(frame)[0];
        this.testRange.value = String(Object.values(frame)[0]);
        this.singleChannelTest = false;
        this.session.test(frame);
        this.focus.checked = this.session.focus = true;
        this.refreshControls();
      });
    });
    this.poseManual?.addEventListener("change", () => {
      if (this.poseManual.checked) this.session.testPose(this.getPose()?.input);
      else this.session.clearPoseTest();
      this.refreshControls();
    });
    this.poseButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.session.testPose({ yaw: Number(button.dataset.yaw), pitch: Number(button.dataset.pitch) });
        this.session.focus = true;
        this.refreshControls();
      });
    });
    this.transitionButtons.forEach((button) => {
      button.addEventListener("click", () => {
        if (this.session.transitionPreview) this.session.stopTransitionPreview();
        else {
          this.session.startTransitionPreview(globalThis.performance?.now?.() ?? 0);
          this.session.focus = true;
        }
        this.refreshControls();
      });
    });
    const restore = () => { this.session.clearTest(); this.refreshControls(); };
    root.querySelectorAll("[data-face-resume]").forEach((button) => button.addEventListener("click", restore));
    quickRoot?.querySelectorAll("[data-face-resume]").forEach((button) => button.addEventListener("click", restore));
    get("faceImportFrame").addEventListener("click", () => {
      this.file.value = "";
      this.file.click();
    });
    this.file.addEventListener("change", async () => {
      const file = this.file.files?.[0];
      if (!file) return;
      const request = ++this.importRequest;
      const revision = this.session.revision;
      try {
        if (file.size > 65536) throw new Error("请选择 64 KB 以内的 JSON 单帧文件。");
        const frame = parseBlendshapeFrame(await file.text());
        if (request !== this.importRequest || revision !== this.session.revision) return;
        this.singleChannelTest = false;
        this.session.test(frame);
        const key = Object.keys(frame).find((name) => frame[name] > 0) || "jawOpen";
        this.channel.value = key;
        this.testRange.value = String(frame[key]);
        this.focus.checked = this.session.focus = true;
        this.refreshControls();
        this.onMessage("已在本机载入系数单帧；不保存到项目，退出试调可恢复动作来源。");
      } catch (error) {
        if (request === this.importRequest && revision === this.session.revision) this.onMessage(error.message);
      }
    });
    this.refreshControls();
  }

  testSelected() {
    this.singleChannelTest = true;
    this.session.test({ [this.channel.value]: Number(this.testRange.value) });
  }

  refreshControls() {
    const key = this.channel.value;
    const config = this.session.settings.channels[key] || DEFAULT_CHANNEL_SETTINGS;
    for (const [name, input] of Object.entries(this.config)) input.value = String(config[name]);
    this.manual.checked = this.session.manual;
    this.focus.checked = this.session.focus;
    if (this.poseManual) this.poseManual.checked = this.session.poseManual;
    this.testOutput.textContent = `${Math.round(Number(this.testRange.value) * 100)}%`;
    const expressionAvailable = Boolean(this.getSupport?.()?.jawOpen);
    [...this.root?.querySelectorAll?.("[data-face-test]") || [], ...this.quickRoot?.querySelectorAll?.("[data-face-test]") || []].forEach((button) => {
      button.disabled = !expressionAvailable;
    });
    const poseAvailable = Boolean(this.canPose?.());
    if (this.poseManual) this.poseManual.disabled = !poseAvailable;
    const manualPose = this.session.manualPose || { yaw: 0, pitch: 0 };
    (this.poseButtons || []).forEach((button) => {
      const selected = this.session.poseManual
        && Math.abs(Number(button.dataset.yaw) - manualPose.yaw) < .01
        && Math.abs(Number(button.dataset.pitch) - manualPose.pitch) < .01;
      button.disabled = !poseAvailable;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    (this.transitionButtons || []).forEach((button) => {
      button.disabled = !expressionAvailable;
      button.classList.toggle("selected", this.session.transitionPreview);
      button.setAttribute("aria-pressed", String(this.session.transitionPreview));
      button.textContent = this.session.transitionPreview ? "停止过渡检查" : "检查过渡";
    });
    if (this.poseValue) {
      const pose = this.getPose?.() || {};
      const actual = pose.rendered || pose.input || manualPose;
      this.poseValue.textContent = poseAvailable
        ? `${this.session.poseManual ? "手动" : "跟随"} · 当前画稿：${describeHeadPose(actual)}`
        : "当前单图没有头部方向画稿";
    }
    const support = this.getSupport?.()?.[key] || "unsupported";
    const definition = CHANNEL_DEFINITIONS.find((item) => item.key === key);
    this.hint.textContent = support === "unsupported"
      ? `${definition.label}：保留标准系数；当前角色没有此动作的独立画稿，不会用拉伸冒充。${definition.mediapipe ? "" : "普通摄像头也不提供此通道。"}`
      : `${definition.label}：${support === "approximate" ? "使用最接近的已有画稿（部分动作共用）" : "独立绘制的关键帧"}，不拉伸五官。左右按角色自身方向；曲线控制画稿响应，幅度不改变图层大小。`;
    const points = Array.from({ length: 61 }, (_, i) => {
      const x = i / 60;
      return `${i ? "L" : "M"}${10 + x * 200},${110 - mapBlendshapeValue(x, config) * 100}`;
    });
    this.path.setAttribute("d", points.join(" "));
    this.lastMeterTime = -Infinity;
  }

  update(now, mode) {
    if (now - this.lastMeterTime < 100) return;
    this.lastMeterTime = now;
    const anyManual = this.session.manual || this.session.poseManual;
    this.indicator?.classList.toggle("hidden", !anyManual || !this.is2D());
    if (this.indicator && anyManual) {
      this.indicator.textContent = this.session.transitionPreview
        ? this.session.poseManual ? "正在检查表情过渡 + 方向 · 点击恢复" : "正在检查表情过渡 · 点击恢复"
        : this.session.manual && this.session.poseManual ? "正在试表情 + 方向 · 点击恢复"
          : this.session.poseManual ? "正在试头部方向 · 点击恢复" : "正在试表情 · 点击恢复";
    }
    this.manual.checked = this.session.manual;
    if (this.poseManual) this.poseManual.checked = this.session.poseManual;
    this.root.classList.toggle("manual-active", anyManual);
    if (this.poseValue) {
      const pose = this.getPose?.() || {};
      const actual = pose.rendered || pose.input || this.session.manualPose;
      this.poseValue.textContent = this.canPose?.()
        ? `${this.session.poseManual ? "手动" : "跟随"} · 当前画稿：${describeHeadPose(actual)}`
        : "当前单图没有头部方向画稿";
    }
    if (!this.root.open) return;
    const key = this.channel.value;
    const raw = this.session.raw[key] || 0;
    const output = this.session.output[key] || 0;
    this.raw.textContent = raw.toFixed(3);
    this.output.textContent = output.toFixed(3);
    this.dot.setAttribute("cx", String(10 + raw * 200));
    this.dot.setAttribute("cy", String(110 - output * 100));
    this.source.textContent = this.session.transitionPreview
      ? `${this.session.poseManual ? "表情过渡 + 手动方向" : "表情过渡检查"} · 仅接管 2D，不影响摄像头和 3D`
      : this.session.manual && this.session.poseManual
        ? "手动表情 + 手动方向 · 仅接管 2D；不会关闭已经开启的摄像头"
        : this.session.manual ? "手动试表情 · 仅接管 2D；不会关闭已经开启的摄像头"
          : this.session.poseManual ? "手动试方向 · 自动表情继续运行；仅接管 2D"
      : mode === "camera" ? "摄像头系数 · 丢失人脸后输入归零" : "自动演示系数 · 无需摄像头";
  }
}
