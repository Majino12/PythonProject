import test from "node:test";
import assert from "node:assert/strict";
import {
  demoBrowLift, FaceSession, normalizeHeadPose, parseBlendshapeFrame, transitionPreviewFrame,
} from "./face-session.js";
import { FaceEditor } from "./face-editor.js";
import { createDemoMotion } from "./demo-motion.js";

test("JSON single-frame reader only accepts bounded numeric ARKit data", () => {
  const frame = parseBlendshapeFrame('{"blendshapes":{"jawOpen":0.7,"secret":"never","_neutral":1}}');
  assert.equal(frame.jawOpen, .7);
  assert.equal(Object.keys(frame).length, 52);
  assert.equal("secret" in frame, false);
  for (const bad of ['null', '[]', '{"_neutral":1}', '{"jawOpen":"bad"}', '{', " ".repeat(65537)]) {
    assert.throws(() => parseBlendshapeFrame(bad));
  }
});

test("head pose normalization accepts only finite own numbers and clamps both axes", () => {
  const input = Object.freeze({ yaw: 2, pitch: -2 });
  assert.deepEqual(normalizeHeadPose(input), { yaw: 1, pitch: -1 });
  assert.deepEqual(input, { yaw: 2, pitch: -2 }, "normalization must not mutate caller data");
  assert.deepEqual(normalizeHeadPose({ yaw: -0.35, pitch: 0.6 }), { yaw: -0.35, pitch: 0.6 });

  const inherited = Object.create({ yaw: 0.8, pitch: -0.7 });
  for (const invalid of [undefined, null, [], inherited, { yaw: "0.5", pitch: Infinity }, { yaw: NaN, pitch: -Infinity }]) {
    assert.deepEqual(normalizeHeadPose(invalid), { yaw: 0, pitch: 0 });
  }
});

test("transition preview loops through smooth complete ARKit frames", () => {
  const neutral = transitionPreviewFrame(0);
  assert.equal(Object.keys(neutral).length, 52);
  for (const elapsed of [0, 350, 675, 1450, 1975, 2850, 3450, 4450, 4975, 6400, NaN, -100]) {
    const frame = transitionPreviewFrame(elapsed);
    assert.equal(Object.keys(frame).length, 52);
    assert.ok(Object.values(frame).every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
  }
  assert.deepEqual(transitionPreviewFrame(6400), neutral, "the preview loop must return to neutral without a seam");
  assert.equal(transitionPreviewFrame(675).eyeBlinkLeft, 1);
  assert.equal(transitionPreviewFrame(675).eyeBlinkRight, 1);
  assert.equal(transitionPreviewFrame(1975).jawOpen, .92);
  assert.equal(transitionPreviewFrame(3450).mouthPucker, .94);
  assert.equal(transitionPreviewFrame(4975).mouthPressLeft, .92);
  assert.equal(transitionPreviewFrame(4975).mouthPressRight, .92);
  assert.equal(transitionPreviewFrame(450).browInnerUp, .88);
  assert.equal(transitionPreviewFrame(1600).browDownLeft, .88);
  assert.equal(transitionPreviewFrame(1600).browDownRight, .88);
  assert.equal(transitionPreviewFrame(3100).browInnerUp, .88);
  assert.equal(transitionPreviewFrame(3100).browDownLeft, 0);
  assert.equal(transitionPreviewFrame(3100).mouthFrownLeft, .24,
    "the worried cue must stay below the mouth emotion threshold");
  assert.equal(transitionPreviewFrame(3100).mouthFrownRight, 0);
  assert.equal(transitionPreviewFrame(4500).browOuterUpLeft, .88);
  assert.equal(transitionPreviewFrame(4500).browOuterUpRight, 0);
  for (const elapsed of [450, 1600, 4500]) {
    assert.equal(transitionPreviewFrame(elapsed).mouthFrownLeft, 0);
    assert.equal(transitionPreviewFrame(elapsed).mouthFrownRight, 0);
  }

  const beforePeak = transitionPreviewFrame(3449);
  const atPeak = transitionPreviewFrame(3450);
  assert.ok(Math.max(...["mouthPucker", "mouthLeft", "mouthRight"]
    .map((key) => Math.abs(atPeak[key] - beforePeak[key]))) < .001,
    "adjacent frames around the pucker peak must not jump between left and right drawings");
});

test("2D demo brows cross painted stages smoothly while camera and manual input stay untouched", () => {
  const idle = [], greeting = [], speaking = [];
  for (let now = 0; now <= 18000; now += 16) {
    idle.push(demoBrowLift(createDemoMotion(now, "idle").browUp, now));
    greeting.push(demoBrowLift(createDemoMotion(now, "greeting").browUp, now));
    speaking.push(demoBrowLift(createDemoMotion(now, "speaking").browUp, now));
  }
  assert.ok(Math.min(...idle) >= .02 && Math.max(...idle) <= .20 + 1e-12);
  assert.ok(Math.max(...idle) > .12, "idle must occasionally reach the first soft painted brow stage");
  assert.ok(Math.max(...greeting) > .41, "greeting must reach the middle painted brow stage");
  assert.ok(Math.max(...speaking) > .41, "speaking must reach the middle painted brow stage");
  for (const [name, values] of [["idle", idle], ["greeting", greeting], ["speaking", speaking]]) {
    assert.ok(values.every((value) => Number.isFinite(value) && value >= .02 && value <= .48));
    assert.ok(values.slice(1).every((value, index) => Math.abs(value - values[index]) < .025),
      `${name} brow motion must remain continuous between display frames`);
  }

  const demo = new FaceSession();
  demo.update(createDemoMotion(2400, "idle"), "demo", 2400, 1);
  assert.ok(Math.abs(demo.raw.browInnerUp - .2) < 1e-12);
  assert.equal(demo.raw.browOuterUpLeft, demo.raw.browOuterUpRight);

  const camera = new FaceSession();
  camera.update(createDemoMotion(2400, "speaking"), "camera", 2400, 1);
  assert.equal(camera.raw.browInnerUp, 0, "camera mode must never receive synthetic demo brows");

  const manual = new FaceSession();
  manual.test({ jawOpen: .5 });
  manual.update(createDemoMotion(2400, "speaking"), "demo", 2400, 1);
  assert.equal(manual.raw.browInnerUp, 0, "manual frames must never receive synthetic demo brows");

  const other = new FaceSession();
  other.update({ browUp: .02 }, "other", 2400, 1);
  assert.equal(other.raw.browInnerUp, .02, "only the explicit demo mode may amplify the compact motion bus");
});

test("manual expression, head pose and transition preview have independent lifecycles", () => {
  const session = new FaceSession();
  let revision = session.revision;
  session.testPose({ yaw: .8, pitch: -.4 });
  assert.equal(session.revision, ++revision);
  session.test({ jawOpen: .7 });
  assert.equal(session.revision, ++revision);
  assert.equal(session.manual, true);
  assert.equal(session.poseManual, true);
  assert.deepEqual(session.manualPose, { yaw: .8, pitch: -.4 });

  session.clearExpressionTest();
  assert.equal(session.revision, ++revision);
  assert.equal(session.manual, false);
  assert.equal(session.poseManual, true, "leaving expression test must preserve the chosen direction");
  session.test({ eyeBlinkLeft: 1 });
  revision += 1;
  session.clearPoseTest();
  assert.equal(session.revision, ++revision);
  assert.equal(session.manual, true, "leaving direction test must preserve the expression test");
  assert.equal(session.poseManual, false);
  assert.deepEqual(session.manualPose, { yaw: 0, pitch: 0 });

  session.testPose({ yaw: -.6, pitch: .25 });
  revision += 1;
  session.startTransitionPreview(100);
  assert.equal(session.revision, ++revision);
  assert.equal(session.transitionPreview, true);
  assert.deepEqual(session.manualPose, { yaw: -.6, pitch: .25 });
  session.update({}, "demo", 775, 1);
  assert.equal(session.raw.eyeBlinkLeft, 1, "elapsed preview time must drive the expected transition frame");
  session.stopTransitionPreview();
  assert.equal(session.revision, ++revision);
  assert.equal(session.transitionPreview, false);
  assert.equal(session.manual, false);
  assert.equal(session.poseManual, true, "stopping transition preview must preserve the chosen direction");
});

test("global resets clear every temporary face and direction override", () => {
  for (const reset of [
    (session) => session.clearTest(),
    (session) => session.setSettings({ channels: { jawOpen: { outputMax: .7 } } }),
    (session) => session.beginCalibration(),
  ]) {
    const session = new FaceSession();
    session.testPose({ yaw: .9, pitch: .5 });
    session.startTransitionPreview(123);
    session.focus = true;
    reset(session);
    assert.equal(session.manual, false);
    assert.equal(session.poseManual, false);
    assert.equal(session.transitionPreview, false);
    assert.equal(session.transitionStartedAt, 0);
    assert.equal(session.focus, false);
    assert.deepEqual(session.manualPose, { yaw: 0, pitch: 0 });
    assert.ok(Object.values(session.manualFrame).every((value) => value === 0));
  }
});

test("camera channels keep asymmetry and stale frames relax instead of freezing", () => {
  const session = new FaceSession();
  session.receive({ faceBlendshapes: [{ categories: [
    { categoryName: "mouthSmileLeft", score: .8 },
    { categoryName: "mouthSmileRight", score: .1 },
  ] }] }, 100);
  assert.equal(session.update({}, "camera", 101, .016).mouthSmileLeft, .8);
  assert.equal(session.output.mouthSmileRight, .1);
  session.update({}, "camera", 400, .016);
  assert.equal(session.raw.mouthSmileLeft, 0);
  assert.ok(session.output.mouthSmileLeft < .8);
});

test("manual testing isolates one channel and never changes persisted settings", () => {
  const session = new FaceSession();
  session.setSettings({ channels: { jawOpen: { outputMax: .7 } } });
  const saved = structuredClone(session.settings);
  session.test({ jawOpen: 1 });
  session.update({ blinkL: 1 }, "demo", 10, .016);
  assert.equal(session.output.jawOpen, .7);
  assert.equal(session.output.eyeBlinkLeft, 0);
  assert.deepEqual(session.settings, saved);
  session.clearTest();
  assert.equal(session.update({ blinkL: 1 }, "demo", 20, .016).eyeBlinkLeft, 1);
});

test("neutral calibration centers camera values without touching demo or saved settings", () => {
  const session = new FaceSession();
  session.beginCalibration();
  for (let i = 0; i < 6; i++) session.receive({ faceBlendshapes: [{ categories: [
    { categoryName: "jawOpen", score: .2 },
  ] }] }, i, true);
  session.finishCalibration();
  assert.equal(session.update({}, "camera", 10, .016).jawOpen, 0);
  assert.equal(session.neutral.jawOpen, .2);
  session.update({ mouth: .5 }, "demo", 20, 1);
  assert.equal(session.raw.jawOpen, .5);
  assert.deepEqual(session.settings, { channels: {} });
});

test("project settings restore exits test mode and excludes temporary camera data", () => {
  const session = new FaceSession();
  session.test({ eyeBlinkLeft: 1 });
  session.setSettings({ channels: {}, manual: true, cameraFrame: { jawOpen: 1 } });
  assert.equal(session.manual, false);
  assert.deepEqual(session.settings, { channels: {} });
});

test("restarting calibration releases manual input and discards all previous neutral samples", () => {
  const session = new FaceSession();
  session.receive({ faceBlendshapes: [{ categories: [{ categoryName: "jawOpen", score: .4 }] }] }, 10, true);
  session.test({ eyeBlinkLeft: 1 });
  session.update({}, "camera", 20, .016);
  session.beginCalibration();
  assert.equal(session.manual, false);
  assert.equal(session.samples.length, 0);
  assert.equal(session.cameraTime, -Infinity);
  assert.equal(session.update({}, "camera", 30, .016).eyeBlinkLeft, 0);
  assert.ok(Object.values(session.neutral).every((value) => value === 0));
});

test("invalid camera timestamps never replace the last valid frame or calibration samples", () => {
  const session = new FaceSession();
  const frame = { faceBlendshapes: [{ categories: [{ categoryName: "jawOpen", score: .7 }] }] };
  session.receive(frame, 100, true);
  for (const now of [NaN, Infinity, -Infinity, undefined, "101"]) session.receive({}, now, true);
  assert.equal(session.cameraTime, 100);
  assert.equal(session.samples.length, 1);
  assert.equal(session.update({}, "camera", 110, .016).jawOpen, .7);
});

test("calibration sample memory remains bounded and uses a median robust to one outlier", () => {
  const session = new FaceSession();
  session.beginCalibration();
  for (let i = 0; i < 140; i += 1) session.receive({ faceBlendshapes: [{ categories: [
    { categoryName: "jawOpen", score: i === 139 ? 1 : .2 },
  ] }] }, i, true);
  assert.equal(session.samples.length, 120);
  session.finishCalibration();
  assert.equal(session.neutral.jawOpen, .2);
  assert.equal(session.samples.length, 0);
});

function faceEditorHarness() {
  const element = () => {
    const classes = new Set();
    return {
      value: "0.5", checked: false, textContent: "", files: [], open: false,
      listeners: new Map(),
      append() {}, click() {}, setAttribute() {},
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains: (name) => classes.has(name),
      },
      addEventListener(name, callback) { this.listeners.set(name, callback); },
    };
  };
  const elements = new Map();
  const presets = Object.fromEntries(["blink", "open", "smile", "funnel", "brow", "sad"].map((name) => [name, {
    ...element(), dataset: { faceTest: name },
  }]));
  const root = {
    ...element(),
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    querySelectorAll(selector) { return selector === "[data-face-test]" ? Object.values(presets) : []; },
  };
  const session = new FaceSession();
  const messages = [];
  const indicator = element(), view = { mode: "2d" };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: element } });
  let editor;
  try { editor = new FaceEditor(root, session, {
    onChange() {}, onMessage(message) { messages.push(message); }, indicator, is2D: () => view.mode === "2d",
  }); }
  finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalThis.document;
  }
  return {
    session, editor, root, messages, indicator, view, presets,
    chooseChannel(key) {
      editor.channel.value = key;
      editor.channel.listeners.get("change")();
    },
    slide(value) {
      editor.testRange.value = String(value);
      editor.testRange.listeners.get("input")();
    },
    startImport() {
      let resolve;
      const read = new Promise((done) => { resolve = done; });
      editor.file.files = [{ size: 100, text: () => read }];
      const completion = editor.file.listeners.get("change")();
      return { resolve, completion };
    },
  };
}

test("a pending JSON test-frame import cannot reactivate manual testing after a project switch", async () => {
  const h = faceEditorHarness();
  const pending = h.startImport();
  h.session.setSettings({ channels: { jawOpen: { outputMax: .4 } } });
  h.editor.refreshControls();
  pending.resolve('{"jawOpen":0.9}');
  await pending.completion;
  assert.equal(h.session.manual, false, "an old project's file read must not take over the new project");
  assert.equal(h.session.settings.channels.jawOpen.outputMax, .4);
});

test("leaving manual testing cancels a pending JSON test-frame import", async () => {
  const h = faceEditorHarness();
  const pending = h.startImport();
  h.root.querySelector("#faceExitTest").listeners.get("click")();
  pending.resolve('{"eyeBlinkLeft":1}');
  await pending.completion;
  assert.equal(h.session.manual, false, "exit must also invalidate a still-pending local file read");
});

test("a slower older JSON frame cannot overwrite the most recently selected frame", async () => {
  const h = faceEditorHarness();
  const older = h.startImport(), newer = h.startImport();
  newer.resolve('{"jawOpen":0.3}');
  await newer.completion;
  older.resolve('{"jawOpen":0.9}');
  await older.completion;
  assert.equal(h.session.manual, true);
  assert.equal(h.session.manualFrame.jawOpen, .3);
});

test("selecting an invalid newer JSON frame still cancels the older in-flight selection", async () => {
  const h = faceEditorHarness();
  const older = h.startImport(), newer = h.startImport();
  newer.resolve("not valid JSON");
  await newer.completion;
  older.resolve('{"jawOpen":0.9}');
  await older.completion;
  assert.equal(h.session.manual, false);
  assert.equal(h.messages.length, 1);
});

test("failed stale JSON reads do not display errors for a different project", async () => {
  const h = faceEditorHarness();
  const pending = h.startImport();
  h.session.setSettings({});
  pending.resolve("old invalid JSON");
  await pending.completion;
  assert.equal(h.messages.length, 0);
  assert.equal(h.session.manual, false);
});

test("the manual-state checkbox follows a programmatic calibration reset", () => {
  const h = faceEditorHarness();
  h.session.test({ jawOpen: .8 });
  h.editor.refreshControls();
  assert.equal(h.editor.manual.checked, true);
  h.session.beginCalibration();
  h.root.open = true;
  h.editor.update(1000, "camera");
  assert.equal(h.editor.manual.checked, false);
});

test("manual status remains visible with the editor collapsed but stays hidden in 3D", () => {
  const h = faceEditorHarness();
  assert.equal(h.root.open, false);
  h.session.test({ jawOpen: .8 });
  h.editor.update(1000, "demo");
  assert.equal(h.indicator.classList.contains("hidden"), false);
  assert.equal(h.editor.manual.checked, true);
  h.view.mode = "3d";
  h.editor.update(1100, "demo");
  assert.equal(h.indicator.classList.contains("hidden"), true);
  h.view.mode = "2d";
  h.editor.update(1200, "demo");
  assert.equal(h.indicator.classList.contains("hidden"), false);
  h.session.clearTest();
  h.editor.update(1300, "demo");
  assert.equal(h.indicator.classList.contains("hidden"), true);
  assert.equal(h.editor.manual.checked, false);
});

test("inspecting another channel preserves an imported multi-channel JSON frame", async () => {
  const h = faceEditorHarness();
  h.slide(.9); // A later JSON import must exit the previous single-channel workflow.
  const pending = h.startImport();
  pending.resolve('{"eyeBlinkLeft":0.8,"eyeBlinkRight":0.1,"jawOpen":0.6}');
  await pending.completion;
  const frame = structuredClone(h.session.manualFrame);
  for (const [key, value] of [["jawOpen", .6], ["eyeBlinkRight", .1], ["mouthSmileLeft", 0], ["eyeBlinkLeft", .8]]) {
    h.chooseChannel(key);
    assert.deepEqual(h.session.manualFrame, frame);
    assert.equal(Number(h.editor.testRange.value), value);
    assert.equal(h.editor.singleChannelTest, false);
    assert.equal(h.session.manual, true);
  }
  h.session.update({}, "demo", 100, .016);
  assert.equal(h.session.output.eyeBlinkLeft, .8);
  assert.equal(h.session.output.eyeBlinkRight, .1);
  assert.equal(h.session.output.jawOpen, .6);
});

test("browsing any quick preset preserves all of its coordinated channels", () => {
  const expected = {
    blink: { eyeBlinkLeft: 1, eyeBlinkRight: 1 },
    open: { jawOpen: .8 },
    smile: { mouthSmileLeft: .8, mouthSmileRight: .8, cheekSquintLeft: .15, cheekSquintRight: .15 },
    funnel: { mouthFunnel: .8, jawOpen: .3 },
    brow: { browOuterUpLeft: .6 },
    sad: { browInnerUp: .6, mouthFrownLeft: .6, mouthFrownRight: .6 },
  };
  for (const [preset, coefficients] of Object.entries(expected)) {
    const h = faceEditorHarness();
    h.slide(.2);
    h.presets[preset].listeners.get("click")();
    const frame = structuredClone(h.session.manualFrame);
    for (const [key, value] of Object.entries(coefficients)) assert.equal(frame[key], value);
    for (const key of [...Object.keys(coefficients), "browInnerUp"]) {
      h.chooseChannel(key);
      assert.deepEqual(h.session.manualFrame, frame, `${preset} must survive channel inspection`);
      assert.equal(Number(h.editor.testRange.value), frame[key]);
    }
    assert.equal(h.editor.singleChannelTest, false);
  }
});

test("moving the test slider deliberately switches an imported frame to isolated single-channel testing", async () => {
  const h = faceEditorHarness();
  const pending = h.startImport();
  pending.resolve('{"eyeBlinkLeft":0.8,"eyeBlinkRight":0.2,"jawOpen":0.6}');
  await pending.completion;
  h.chooseChannel("jawOpen");
  h.slide(.4);
  assert.equal(h.editor.singleChannelTest, true);
  assert.equal(h.session.manualFrame.jawOpen, .4);
  assert.equal(h.session.manualFrame.eyeBlinkLeft, 0);
  assert.equal(h.session.manualFrame.eyeBlinkRight, 0);
  assert.equal(Object.values(h.session.manualFrame).filter((value) => value !== 0).length, 1);
  h.chooseChannel("eyeBlinkRight");
  assert.equal(h.session.manualFrame.jawOpen, 0);
  assert.equal(h.session.manualFrame.eyeBlinkRight, .4);
  assert.equal(Object.values(h.session.manualFrame).filter((value) => value !== 0).length, 1);
});

test("explicitly enabling manual testing starts a single-channel test after viewing a preset", () => {
  const h = faceEditorHarness();
  h.presets.smile.listeners.get("click")();
  h.editor.manual.checked = false;
  h.editor.manual.listeners.get("change")();
  assert.equal(h.session.manual, false);
  h.chooseChannel("jawOpen");
  h.editor.testRange.value = "0.7";
  h.editor.manual.checked = true;
  h.editor.manual.listeners.get("change")();
  assert.equal(h.editor.singleChannelTest, true);
  assert.equal(h.session.manualFrame.jawOpen, .7);
  assert.equal(h.session.manualFrame.mouthSmileLeft, 0);
  h.chooseChannel("eyeBlinkLeft");
  assert.equal(h.session.manualFrame.eyeBlinkLeft, .7);
  assert.equal(h.session.manualFrame.jawOpen, 0);
});
