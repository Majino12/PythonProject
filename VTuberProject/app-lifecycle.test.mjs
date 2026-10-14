import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { normalizePreferences } from "./project-store.js";

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const recordingSource = appSource.slice(
  appSource.indexOf("function toggleRecording()"),
  appSource.indexOf("async function export3DModel()"),
);

function recordingHarness() {
  const recorders = [];
  const streams = [];
  const downloads = [];
  const messages = [];
  const elements = new Map();
  const element = () => ({
    disabled: false,
    textContent: "",
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
  });
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options.mimeType;
      this.state = "inactive";
      recorders.push(this);
    }
    start() { this.state = "recording"; }
    // Browsers change state synchronously but deliver final data/stop later.
    stop() { this.state = "inactive"; }
    flush(text) {
      this.ondataavailable?.({ data: new Blob([text]) });
      this.onstop?.();
    }
  }
  const context = {
    state: { viewMode: "2d", recorder: null, exportingModel: false, chunks: [] },
    ui: { recordButton: element(), exportModelButton: element(), recordingTime: element(), modelStyle: element() },
    canvas: {
      captureStream() {
        const track = { stopped: false, stop() { this.stopped = true; } };
        const stream = { getTracks: () => [track] };
        streams.push(stream);
        return stream;
      },
    },
    MediaRecorder: FakeMediaRecorder,
    window: { MediaRecorder: FakeMediaRecorder },
    Blob,
    performance,
    console: { error() {}, warn() {}, log() {} },
    toast: (message) => messages.push(message),
    updateAppearanceControls() { context.ui.modelStyle.disabled = Boolean(context.state.recorder) || context.state.exportingModel; },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    URL: {
      createObjectURL(blob) { downloads.push(blob); return `blob:${downloads.length}`; },
      revokeObjectURL() {},
    },
    document: { createElement: () => ({ click() {} }) },
    downloadBlob: (blob) => downloads.push(blob),
  };
  vm.createContext(context);
  vm.runInContext(recordingSource, context, { filename: "app.js:toggleRecording" });
  return { context, recorders, streams, downloads, messages, toggle: () => context.toggleRecording() };
}

test("recording cannot restart while the previous stop is still queued", () => {
  const h = recordingHarness();
  h.toggle();
  const first = h.recorders[0];
  assert.equal(first.state, "recording");
  h.toggle();
  assert.equal(first.state, "inactive");
  h.toggle();
  h.toggle();
  assert.equal(h.recorders.length, 1, "the recorder must remain locked through final data and stop");
  first.flush("first video");
  assert.equal(h.context.state.recorder, null);
  assert.ok(h.streams[0].getTracks()[0].stopped);
  h.toggle();
  assert.equal(h.recorders.length, 2, "a new recording is allowed after the save finishes");
  assert.equal(h.context.state.recorder, h.recorders[1]);
});

test("each recording saves only its own chunks and ignores an old stop callback", async () => {
  const h = recordingHarness();
  h.toggle();
  const first = h.recorders[0];
  first.ondataavailable({ data: new Blob(["first-"]) });
  h.toggle();
  first.flush("video");
  h.toggle();
  const second = h.recorders[1];
  // A stale callback must not contaminate or clear the current recording.
  first.ondataavailable({ data: new Blob(["late-old-data"]) });
  first.onstop();
  assert.equal(h.context.state.recorder, second);
  second.ondataavailable({ data: new Blob(["second-"]) });
  h.toggle();
  second.flush("video");
  assert.equal(h.downloads.length, 2);
  assert.equal(await h.downloads[0].text(), "first-video");
  assert.equal(await h.downloads[1].text(), "second-video");
  assert.ok(h.streams.every((stream) => stream.getTracks()[0].stopped));
});

test("empty recording releases capture tracks without a download", () => {
  const h = recordingHarness();
  h.toggle();
  h.toggle();
  h.recorders[0].flush("");
  assert.equal(h.context.state.recorder, null);
  assert.equal(h.downloads.length, 0);
  assert.ok(h.streams[0].getTracks()[0].stopped);
});

test("3D disposal releases shared materials, stage and shadow resources once", () => {
  const source = readFileSync(new URL("./avatar3d.js", import.meta.url), "utf8");
  const helper = source.slice(source.indexOf("function disposeObject("), source.indexOf("export class Avatar3D"));
  const method = source.slice(source.lastIndexOf("  dispose() {"), source.lastIndexOf("\n}"));
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${helper}\nfunction ${method.trim()}`, context);
  const calls = new Map();
  const resource = (name) => ({ dispose() { calls.set(name, (calls.get(name) || 0) + 1); } });
  const shared = resource("shared material");
  const fixture = {
    scene: {
      traverse(callback) {
        callback({ geometry: resource("avatar geometry"), material: shared });
        callback({ geometry: resource("grid geometry"), material: [shared, resource("grid material")] });
        callback({ shadow: resource("shadow map") });
      },
      clear() { calls.set("scene clear", (calls.get("scene clear") || 0) + 1); },
    },
    renderer: resource("renderer"),
    controlsController: { abort() { calls.set("abort controls", (calls.get("abort controls") || 0) + 1); } },
    activePointerId: 7,
    dragStart: {},
    canvas: {
      hasPointerCapture: (id) => id === 7,
      releasePointerCapture(id) { assert.equal(id, 7); calls.set("release capture", 1); },
      classList: { remove(name) { assert.equal(name, "dragging"); } },
    },
  };
  context.dispose.call(fixture);
  context.dispose.call(fixture);
  for (const name of ["avatar geometry", "grid geometry", "shared material", "grid material", "shadow map", "renderer", "scene clear", "abort controls", "release capture"]) {
    assert.equal(calls.get(name), 1, `${name} should be cleaned exactly once`);
  }
  assert.equal(fixture.dragStart, null);
  assert.equal(fixture.activePointerId, null);
});

function generationHarness({ importSucceeds = true } = {}) {
  const source = appSource.slice(appSource.indexOf("function updateGenerateButton()"), appSource.indexOf("function base64ToAvatarFile("))
    + appSource.slice(appSource.indexOf("async function generateAvatar()"), appSource.indexOf("async function makeDemoAvatar()"));
  const element = (value = "") => ({ value, disabled: false, classList: { add() {}, remove() {} } });
  const controls = [element(), element()];
  const requests = [];
  const downloads = [];
  const imports = [];
  const messages = [];
  let resolveFetch;
  let rejectFetch;
  const pendingFetch = new Promise((resolve, reject) => { resolveFetch = resolve; rejectFetch = reject; });
  const context = {
    state: { generating: false, selectedStyle: "anime" },
    ui: {
      characterPrompt: element("a test character"),
      apiKey: { ...element("sk-unit-test-placeholder-key"), type: "password" },
      apiConsent: { ...element(), checked: true },
      generateButton: element(),
      generationProgress: element(),
      generationHint: element(),
      aiDialog: element(),
      toggleApiKey: element(),
    },
    document: { querySelectorAll: () => controls },
    canReplaceProject: () => true,
    fetch: (url, options) => { requests.push({ url, options }); return pendingFetch; },
    base64ToAvatarFile: () => new Blob(["generated image"], { type: "image/png" }),
    closeDialog() {},
    importImage: async (file, options) => { imports.push({ file, options }); return importSucceeds; },
    downloadBlob: (file, name) => downloads.push({ file, name }),
    outputName: (extension) => `test.${extension}`,
    toast: (message) => messages.push(message),
    setInterval: () => 1,
    clearInterval() {},
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "app.js:generation" });
  return { context, controls, requests, downloads, imports, messages, resolveFetch, rejectFetch };
}

test("AI generation remains single-flight even when inputs change or it is called again", async () => {
  const h = generationHarness();
  const pending = h.context.generateAvatar();
  assert.equal(h.context.state.generating, true);
  assert.ok(h.controls.every((control) => control.disabled));
  h.context.ui.characterPrompt.value = "a different character";
  h.context.updateGenerateButton();
  assert.equal(h.context.ui.generateButton.disabled, true);
  await h.context.generateAvatar();
  // Also guard the entry point independently of the disabled button.
  h.context.ui.generateButton.disabled = false;
  await h.context.generateAvatar();
  assert.equal(h.requests.length, 1);
  assert.equal(JSON.parse(h.requests[0].options.body).description, "a test character");
  h.resolveFetch({ ok: true, json: async () => ({ image: "mock image data" }) });
  await pending;
  assert.equal(h.imports.length, 1);
  assert.equal(h.imports[0].options.generated, true);
  assert.equal(h.context.state.generating, false);
  assert.ok(h.controls.every((control) => !control.disabled));
  assert.equal(h.context.ui.apiKey.value, "");
  assert.equal(h.context.ui.apiConsent.checked, false);
  assert.equal(h.context.ui.generateButton.disabled, true);
});

test("AI generation failure clears credentials and unlocks controls without another request", async () => {
  const h = generationHarness();
  const pending = h.context.generateAvatar();
  h.rejectFetch(new Error("Simulated offline failure"));
  await pending;
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.state.generating, false);
  assert.equal(h.context.ui.apiKey.value, "");
  assert.equal(h.context.ui.apiKey.type, "password");
  assert.equal(h.context.ui.apiConsent.checked, false);
  assert.equal(h.context.ui.generateButton.disabled, true);
  assert.ok(h.controls.every((control) => !control.disabled));
  assert.equal(h.imports.length, 0);
  assert.equal(h.downloads.length, 0);
});

test("a generated image is downloaded for safekeeping when avatar import fails", async () => {
  const h = generationHarness({ importSucceeds: false });
  const pending = h.context.generateAvatar();
  h.resolveFetch({ ok: true, json: async () => ({ image: "mock image data" }) });
  await pending;
  assert.equal(h.requests.length, 1);
  assert.equal(h.downloads.length, 1);
  assert.equal(await h.downloads[0].file.text(), "generated image");
  assert.equal(h.downloads[0].name, "test.png");
});

test("calibration rejects enough samples when the face is no longer recently visible", () => {
  const source = appSource.slice(appSource.indexOf("function updateCalibration(now)"), appSource.indexOf("const FACE_MOTION_KEYS"));
  const samples = Array.from({ length: 8 }, () => ({ x: .2, y: 0, roll: 0 }));
  const context = {
    state: {
      calibrating: true, ready: false, calibrationUntil: 1000, lastFaceSeen: 200,
      calibrationSamples: samples.slice(), bodyCalibrationSamples: samples.slice(), expressionCalibrationSamples: samples.slice(),
    },
    ui: { calibrationCount: {}, calibration: { querySelector: () => ({}) } },
    setStatus() {},
    median() { assert.fail("stale samples must not establish a neutral pose"); },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "app.js:calibration" });
  context.updateCalibration(1100);
  assert.equal(context.state.calibrating, true);
  assert.equal(context.state.ready, false);
  assert.equal(context.state.calibrationUntil, 2100);
  assert.equal(context.state.calibrationSamples.length, 0);
  assert.equal(context.state.bodyCalibrationSamples.length, 0);
  assert.equal(context.state.expressionCalibrationSamples.length, 0);
});

test("flushing a clean project does not leave a promise that blocks later autosaves", async () => {
  const source = appSource.slice(appSource.indexOf("function savePreferences()"), appSource.indexOf("function setProjectBusy("));
  const writes = [];
  const context = {
    state: { projectBusy: false, storageAvailable: true, projectRevision: 0, savedRevision: 0, savePromise: null },
    ui: { saveState: {} },
    currentProject: () => ({ name: "updated project" }),
    saveProject: async (project) => { writes.push(project); },
    setTimeout: () => 1,
    clearTimeout() {},
    console,
    toast() {},
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "app.js:project save queue" });
  await context.flushProjectSave();
  context.savePreferences();
  await context.flushProjectSave();
  assert.equal(writes.length, 1);
  assert.equal(context.state.savedRevision, context.state.projectRevision);
  assert.equal(context.state.savePromise, null);
});

function startupHarness({ project = null, demoFails = false, storageFails = false, imageFails = false } = {}) {
  const source = appSource.slice(appSource.indexOf("async function initializeProject()"), appSource.indexOf("function setPreviewMode("));
  const calls = [], messages = [];
  const context = {
    state: { storageAvailable: true, projectBusy: false },
    ui: { saveState: {}, projectName: { value: "我的角色" } },
    setProjectBusy(busy) { context.state.projectBusy = busy; },
    loadProject: async () => { calls.push("load"); if (storageFails) throw new Error("Storage unavailable"); return project; },
    installProject: async (value) => { calls.push("install"); if (imageFails) throw new Error("Image invalid"); context.installedProject = value; },
    makeDemoAvatar: async () => { calls.push("demo"); if (demoFails) throw new Error("Demo 404"); return true; },
    applyPreferences(value) { context.preferences = value; return { viewMode: "2d", ...value }; },
    useDemo() {},
    setViewMode: async (mode) => { context.viewMode = mode; },
    setStatus() {},
    localStorage: { getItem: () => null },
    toast: (message) => messages.push(message),
    console: { warn() {} },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "app.js:project startup" });
  return { context, calls, messages };
}

test("saved custom image restores without loading an unavailable demo asset", async () => {
  const project = { name: "自己的角色", imageDataUrl: "data:image/png;base64,test", preferences: { appearance: { hair: "#123456" } } };
  const h = startupHarness({ project, demoFails: true });
  await h.context.initializeProject();
  assert.deepEqual(h.calls, ["load", "install"]);
  assert.equal(h.context.installedProject, project);
  assert.equal(h.context.state.storageAvailable, true);
  assert.equal(h.context.state.projectBusy, false);
  assert.match(h.context.ui.saveState.textContent, /已恢复/);
});

test("missing demo on first launch unlocks import without disabling healthy storage", async () => {
  const h = startupHarness({ demoFails: true });
  await h.context.initializeProject();
  assert.deepEqual(h.calls, ["load", "demo"]);
  assert.equal(h.context.state.storageAvailable, true);
  assert.equal(h.context.state.projectBusy, false);
  assert.match(h.messages[0], /导入自己的图片/);
  assert.doesNotMatch(h.context.ui.saveState.textContent, /恢复失败/);
});

test("saved demo preferences survive missing illustration without blaming the database", async () => {
  const preferences = { framing: "full", appearance: { hair: "#123456" }, viewMode: "3d" };
  const h = startupHarness({ project: { name: "自选配色", imageDataUrl: null, preferences }, demoFails: true });
  await h.context.initializeProject();
  assert.equal(h.context.ui.projectName.value, "自选配色");
  assert.equal(h.context.preferences, preferences);
  assert.equal(h.context.viewMode, "3d");
  assert.equal(h.context.state.storageAvailable, true);
  assert.equal(h.context.state.projectBusy, false);
  assert.match(h.context.ui.saveState.textContent, /设置已恢复/);
});

test("genuine storage and custom-image restore errors still preserve stored data", async () => {
  for (const options of [{ storageFails: true }, { project: { imageDataUrl: "corrupt image" }, imageFails: true }]) {
    const h = startupHarness(options);
    await h.context.initializeProject();
    assert.equal(h.context.state.storageAvailable, false);
    assert.equal(h.context.state.projectBusy, false);
    assert.match(h.context.ui.saveState.textContent, /恢复失败/);
    assert.ok(h.calls.includes("demo"));
  }
});

test("portrait crop stays inside the source image even with a low or large face", () => {
  const start = appSource.indexOf('  const closeUp = state.framing === "portrait"');
  const source = appSource.slice(start, appSource.indexOf("\n\n  ctx.save();", start));
  for (const [faceY, faceH, framing] of [[820, 100, "portrait"], [800, 300, "portrait"], [150, 100, "portrait"], [820, 100, "full"]]) {
    const context = {
      state: { framing }, image: { naturalWidth: 800, naturalHeight: 1000 },
      rig: { patchesEnabled: true, face: { x: 400, y: faceY, h: faceH } },
      canvas: { width: 720, height: 720 },
      clamp: (value, low, high) => Math.max(low, Math.min(high, value)),
    };
    vm.createContext(context);
    vm.runInContext(`function measureFrame() { ${source}; return {frameTop, frameHeight, centerY}; }`, context);
    const frame = context.measureFrame();
    assert.ok(frame.frameTop >= 0);
    assert.ok(frame.frameTop + frame.frameHeight <= 1000);
    assert.ok(Number.isFinite(frame.centerY));
    if (framing === "full") assert.equal(frame.frameTop, 0);
  }
});

function avatarLifecycleHarness() {
  const element = () => {
    const classes = new Set(), children = new Map(), listeners = new Map();
    return {
      value: "", textContent: "", innerHTML: "", disabled: false, listeners,
      classList: {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name),
        toggle(name, enabled = !classes.has(name)) { if (enabled) classes.add(name); else classes.delete(name); },
      },
      addEventListener: (name, callback) => listeners.set(name, callback),
      setAttribute() {},
      querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
    };
  };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const requests = [], messages = [], downloads = [], windowListeners = new Map();
  const views = ["2d", "3d"].map((view) => ({ ...element(), dataset: { view } }));
  const ui = Object.fromEntries([
    "threeCanvas", "threeLoading", "landmarkPill", "recordButton", "exportModelButton", "modelStyle", "hairStyle",
    "appearanceHint", "hairColor", "outfitColor", "eyesColor", "resetAppearance", "demoMotion", "projectName",
    "fileRow", "qualityCard", "scanState", "dropzone",
  ].map((name) => [name, element()]));
  ui.ranges = {};
  const context = {
    state: {
      avatar3d: null, avatar3dPromise: null, avatarBuildController: null, avatarBuildToken: 0, build3d: "idle",
      modelStyle: "studio", viewMode: "2d", recorder: null, exportingModel: false,
      projectBusy: false, generating: false, framing: "portrait", background: "gradient",
      imageImportToken: 0, imageUrl: "", landmarkMessage: "2D ready", mode: "demo", appearanceOverrides: {},
    },
    ui, canvas: element(), video: { srcObject: null }, portraitWarp: null,
    AbortController, DOMException, Blob,
    document: {
      querySelectorAll: (selector) => selector === "[data-view]" ? views : [],
      body: { style: { setProperty() {} } },
      createElement: () => { const anchor = { click() { downloads.push(anchor); } }; return anchor; },
    },
    window: { addEventListener: (name, callback) => windowListeners.set(name, callback) },
    URL: { createObjectURL: () => "blob:fixture", revokeObjectURL() {} },
    setTimeout: () => 1,
    normalizePreferences,
    createAvatar3D(canvas, options) {
      const gate = deferred();
      requests.push({ canvas, options, ...gate });
      return gate.promise;
    },
    applyAvatarAppearance() { context.updateAppearanceControls(); },
    updateFraming() { context.state.avatar3d?.setFraming(context.state.framing); },
    savePreferences() { context.saveCount = (context.saveCount || 0) + 1; },
    makeDemoAvatar: async () => true,
    importImageData: async () => true,
    useDemo() { context.state.mode = "demo"; },
    toast: (message) => messages.push(message),
    console: { warn() {}, error() {} },
  };
  const section = (start, end) => appSource.slice(appSource.indexOf(start), appSource.indexOf(end, appSource.indexOf(start)));
  const source = section("function setViewButtons(", "function closeDialog(")
    + section("function applyPreferences(", "function savePreferences(")
    + section("function canReplaceProject(", "function downloadBlob(")
    + section("async function installProject(", "async function openProject(")
    + section("async function export3DModel(", "function openFilePicker(")
    + section('ui.modelStyle.addEventListener("change"', 'ui.projectName.addEventListener("change"')
    + section('window.addEventListener("pagehide"', '\nsetViewButtons("2d");');
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "app.js:3D lifecycle" });
  return { context, requests, messages, downloads, views, deferred, windowListeners,
    changeModel: () => ui.modelStyle.listeners.get("change")(),
  };
}

function modelFixture(style = "studio") {
  return {
    modelStyle: style, exportExtension: style === "studio" ? "vrm" : "glb", fallbackUsed: false,
    disposed: 0, rendered: 0,
    dispose() { this.disposed += 1; }, render() { this.rendered += 1; },
    setFraming() {}, setBackground() {},
  };
}

test("concurrent 3D requests share one build and both receive the ready model", async () => {
  const h = avatarLifecycleHarness();
  const first = h.context.ensureAvatar3D(), second = h.context.ensureAvatar3D();
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.state.build3d, "building");
  assert.equal(h.context.ui.recordButton.disabled, true);
  assert.equal(h.context.ui.modelStyle.disabled, true);
  const avatar = modelFixture();
  h.requests[0].resolve(avatar);
  assert.equal(await first, avatar);
  assert.equal(await second, avatar);
  assert.equal(h.context.state.avatar3dPromise, null);
  assert.equal(h.context.state.build3d, "ready");
  assert.equal(h.context.ui.recordButton.disabled, false);
  assert.equal(await h.context.ensureAvatar3D(), avatar);
  assert.equal(h.requests.length, 1);
});

test("late cancelled model cannot replace a newer model or unlock its loading controls", async () => {
  const h = avatarLifecycleHarness();
  const first = h.context.ensureAvatar3D();
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  h.context.resetAvatar3D();
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.context.state.modelStyle = "light";
  const second = h.context.ensureAvatar3D();
  const stale = modelFixture();
  h.requests[0].resolve(stale);
  await firstRejected;
  assert.equal(stale.disposed, 1);
  assert.equal(h.context.state.avatar3d, null);
  assert.equal(h.context.state.build3d, "building");
  assert.equal(h.context.ui.recordButton.disabled, true);
  assert.equal(h.context.ui.threeLoading.classList.contains("hidden"), false);
  const current = modelFixture("light");
  h.requests[1].resolve(current);
  assert.equal(await second, current);
  assert.equal(h.context.state.avatar3d, current);
});

test("opening a different-model 2D project cancels loading and restores 2D recording", async () => {
  const h = avatarLifecycleHarness();
  const loading = h.context.setViewMode("3d");
  await h.context.installProject({ name: "2D project", imageDataUrl: "fixture", preferences: { modelStyle: "light", viewMode: "2d" } });
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.context.state.viewMode, "2d");
  assert.equal(h.context.state.modelStyle, "light");
  assert.equal(h.context.ui.recordButton.disabled, false);
  assert.ok(h.views.every((button) => !button.disabled));
  const stale = modelFixture();
  h.requests[0].resolve(stale);
  await loading;
  assert.equal(stale.disposed, 1);
  assert.equal(h.context.state.avatar3d, null);
  assert.equal(h.context.state.viewMode, "2d");
  assert.equal(h.context.ui.recordButton.disabled, false);
});

test("opening a different-model 3D project waits for the new build and ignores the old one", async () => {
  const h = avatarLifecycleHarness();
  const oldView = h.context.setViewMode("3d");
  const restored = h.context.installProject({ name: "Light project", imageDataUrl: "fixture", preferences: { modelStyle: "light", viewMode: "3d" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].options.modelStyle, "light");
  const current = modelFixture("light");
  h.requests[1].resolve(current);
  await restored;
  h.requests[0].resolve(modelFixture());
  await oldView;
  assert.equal(h.context.state.avatar3d, current);
  assert.equal(h.context.state.viewMode, "3d");
  assert.equal(h.context.state.build3d, "ready");
});

test("late ordinary errors from a cancelled build cannot force the replacement back to 2D", async () => {
  const h = avatarLifecycleHarness();
  const oldView = h.context.setViewMode("3d");
  h.context.resetAvatar3D();
  h.context.state.modelStyle = "light";
  const newView = h.context.setViewMode("3d");
  const current = modelFixture("light");
  h.requests[1].resolve(current);
  await newView;
  // A failure already queued when the abort arrives can retain its original Error.
  h.requests[0].reject(new Error("Old model network failure"));
  await oldView;
  assert.equal(h.context.state.avatar3d, current);
  assert.equal(h.context.state.viewMode, "3d");
  assert.equal(h.context.state.build3d, "ready");
  assert.equal(h.messages.some((message) => message.includes("已安全返回 2D")), false);
});

test("pagehide cancels a pending model and bfcache restoration creates only one replacement", async () => {
  const h = avatarLifecycleHarness();
  const oldView = h.context.setViewMode("3d");
  let cameraStopped = 0, portraitDisposed = 0;
  h.context.video.srcObject = { getTracks: () => [{ stop() { cameraStopped += 1; } }] };
  h.context.portraitWarp = { dispose() { portraitDisposed += 1; } };
  h.windowListeners.get("pagehide")({ persisted: true });
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(cameraStopped, 1);
  assert.equal(portraitDisposed, 1);
  assert.equal(h.context.portraitWarp, null);
  h.windowListeners.get("pageshow")({ persisted: false });
  assert.equal(h.requests.length, 1);
  h.windowListeners.get("pageshow")({ persisted: true });
  assert.equal(h.requests.length, 2);
  h.requests[0].resolve(modelFixture());
  await oldView;
  const current = modelFixture();
  h.requests[1].resolve(current);
  await h.context.state.avatar3dPromise;
  assert.equal(h.context.state.avatar3d, current);
  assert.equal(h.context.state.viewMode, "3d");
  assert.equal(h.context.state.mode, "demo");
});

test("model switching is rejected while recording, exporting or already loading", async () => {
  for (const busy of [{ recorder: { state: "recording" } }, { exportingModel: true }, { build3d: "building" }]) {
    const h = avatarLifecycleHarness();
    const current = modelFixture();
    Object.assign(h.context.state, { avatar3d: current, build3d: "ready" }, busy);
    h.context.ui.modelStyle.value = "light";
    await h.changeModel();
    assert.equal(h.context.state.modelStyle, "studio");
    assert.equal(h.context.ui.modelStyle.value, "studio");
    assert.equal(h.context.state.avatar3d, current);
    assert.equal(current.disposed, 0);
    assert.equal(h.requests.length, 0);
  }
});

test("VRM export locks model and color controls until completion", async () => {
  const h = avatarLifecycleHarness();
  const gate = h.deferred(), current = modelFixture();
  current.exportGLB = () => gate.promise;
  Object.assign(h.context.state, { avatar3d: current, build3d: "ready", viewMode: "3d" });
  const exported = h.context.export3DModel();
  for (const key of ["modelStyle", "hairStyle", "hairColor", "outfitColor", "eyesColor", "resetAppearance", "recordButton"]) {
    assert.equal(h.context.ui[key].disabled, true, `${key} must be locked during export`);
  }
  h.context.ui.modelStyle.value = "light";
  await h.changeModel();
  assert.equal(current.disposed, 0);
  gate.resolve(new Uint8Array([1, 2, 3]).buffer);
  await exported;
  assert.equal(h.downloads.length, 1);
  assert.match(h.downloads[0].download, /\.vrm$/);
  assert.equal(h.context.state.exportingModel, false);
  assert.equal(h.context.ui.modelStyle.disabled, false);
  assert.equal(h.context.ui.hairColor.disabled, false);
  assert.equal(h.context.ui.recordButton.disabled, false);
  assert.equal(h.context.ui.hairStyle.disabled, true, "studio keeps its template hair");
});

test("recording updates model-switch controls through the queued stop callback", () => {
  const h = recordingHarness();
  h.toggle();
  assert.equal(h.context.ui.modelStyle.disabled, true);
  h.toggle();
  assert.equal(h.context.ui.modelStyle.disabled, true);
  h.recorders[0].flush("recorded video");
  assert.equal(h.context.ui.modelStyle.disabled, false);
});
