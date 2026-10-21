import test from "node:test";
import assert from "node:assert/strict";
import { ARKIT_CHANNELS, DEFAULT_CHANNEL_SETTINGS } from "./arkit-blendshapes.js";
import {
  DEFAULT_PREFERENCES, MAX_IMAGE_DATA_URL_LENGTH, normalizePreferences,
  createProject, parseProject, saveProject, loadProject, clearProject,
} from "./project-store.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lR8AAAAASUVORK5CYII=";
const JPEG = "data:image/jpeg;base64," + Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]).toString("base64");
const WEBP = "data:image/webp;base64," + Buffer.from("RIFF1234WEBPVP8 ").toString("base64");

test("preferences supply defaults and never share mutable state", () => {
  for (const invalid of [undefined, null, [], "broken", true]) {
    assert.deepEqual(normalizePreferences(invalid), DEFAULT_PREFERENCES);
  }
  const first = normalizePreferences({});
  first.head = 4;
  first.face2d.channels.jawOpen = { inputMin: .2 };
  assert.equal(normalizePreferences({}).head, 90);
  assert.deepEqual(normalizePreferences({}).face2d, { channels: {} });
  assert.equal(Object.isFrozen(DEFAULT_PREFERENCES.face2d.channels), true);
});

test("preferences whitelist known options and clamp finite range values", () => {
  assert.deepEqual(normalizePreferences({
    background: "green", viewMode: "3d", head: -8, blink: 190,
    mouth: "73", expression: 99.7, body: 0, apiKey: "secret", cameraConsent: true,
  }), {
    background: "green", viewMode: "3d", modelStyle: "studio", head: 0, blink: 150,
    mouth: 73, expression: 100, body: 0,
    demoMotion: "idle", framing: "portrait", appearance: {}, face2d: { channels: {} },
  });
  for (const invalid of [NaN, Infinity, -Infinity, "invalid", "", " ", null, true, {}, []]) {
    assert.equal(normalizePreferences({ mouth: invalid }).mouth, 90);
  }
  assert.equal(normalizePreferences({ background: "javascript:x", viewMode: "4d" }).background, "gradient");
  assert.equal(normalizePreferences(Object.create({ head: 0, background: "green" })).head, 90);
});

test("model styles whitelist only explicit studio/light preferences", () => {
  assert.equal(DEFAULT_PREFERENCES.modelStyle, "studio");
  for (const modelStyle of ["studio", "light"]) assert.equal(normalizePreferences({ modelStyle }).modelStyle, modelStyle);
  for (const modelStyle of [undefined, null, "", "Studio", "vrm", "javascript:x", true, 0, [], {}, new String("light")]) {
    assert.equal(normalizePreferences({ modelStyle }).modelStyle, "studio");
  }
  assert.equal(normalizePreferences(Object.create({ modelStyle: "light" })).modelStyle, "studio");
  const explicit = Object.assign(Object.create({ modelStyle: "studio" }), { modelStyle: "light" });
  assert.equal(normalizePreferences(explicit).modelStyle, "light");
});

test("studio and light selections round-trip with original image and appearance settings", () => {
  for (const modelStyle of ["studio", "light"]) {
    const project = createProject({ name: "角色风格", imageDataUrl: PNG,
      preferences: { viewMode: "3d", modelStyle, appearance: { hair: "#123456", hairStyle: "long" } } });
    const restored = parseProject(JSON.stringify(project));
    assert.equal(restored.preferences.modelStyle, modelStyle);
    assert.equal(restored.preferences.viewMode, "3d");
    assert.equal(restored.imageDataUrl, PNG);
    assert.deepEqual(restored.preferences.appearance, { hair: "#123456", hairStyle: "long" });
    assert.equal(Object.hasOwn(restored, "modelBinary"), false);
  }
});

test("older version-one projects default to studio without losing their image or preferences", () => {
  const previous = { format: "moemotion-project", version: 1, name: "旧角色", imageDataUrl: PNG,
    preferences: { viewMode: "3d", background: "green", framing: "full", appearance: { outfit: "#445566" } } };
  const restored = parseProject(JSON.stringify(previous));
  assert.equal(restored.version, 1);
  assert.equal(restored.preferences.modelStyle, "studio");
  assert.equal(restored.preferences.background, "green");
  assert.equal(restored.preferences.framing, "full");
  assert.deepEqual(restored.preferences.face2d, { channels: {} });
  assert.deepEqual(restored.preferences.appearance, { outfit: "#445566" });
  assert.equal(restored.imageDataUrl, PNG);
  assert.equal(Object.hasOwn(previous.preferences, "modelStyle"), false);
});

test("appearance overrides round-trip without sharing objects or admitting unsafe values", () => {
  const saved = normalizePreferences({ demoMotion: "greeting", appearance: { hairStyle: "long", hair: "#AaBbcC", outfit: "url(x)", eyes: "red", apiKey: "secret" } });
  assert.deepEqual(saved.appearance, { hairStyle: "long", hair: "#aabbcc" });
  assert.equal(saved.demoMotion, "greeting");
  assert.deepEqual(parseProject(JSON.stringify(createProject({ preferences: saved }))).preferences, saved);
  saved.appearance.eyes = "#ffffff";
  assert.deepEqual(normalizePreferences({}).appearance, {});
  assert.equal(normalizePreferences({ demoMotion: "unknown" }).demoMotion, "idle");
});

test("ARKit52 settings round-trip as project preferences without sharing nested objects", () => {
  const face2d = { channels: {
    eyeBlinkLeft: { inputMin: .12, inputMax: .8, outputMin: .1, outputMax: .9, smoothing: 80, curve: "smooth" },
    jawOpen: { inputMin: .05, inputMax: .7, outputMin: 0, outputMax: 1, smoothing: 140, curve: "easeOut" },
  } };
  const project = createProject({ imageDataUrl: PNG, preferences: { face2d } });
  const restored = parseProject(JSON.stringify(project));
  assert.deepEqual(restored.preferences.face2d, face2d);
  assert.equal(restored.version, 1);
  assert.equal(restored.imageDataUrl, PNG);
  face2d.channels.jawOpen.smoothing = 0;
  assert.equal(project.preferences.face2d.channels.jawOpen.smoothing, 140);
  restored.preferences.face2d.channels.eyeBlinkLeft.inputMin = .4;
  assert.equal(project.preferences.face2d.channels.eyeBlinkLeft.inputMin, .12);
});

test("ARKit settings clamp finite channel limits and default invalid configurations", () => {
  const preferences = normalizePreferences({ face2d: { channels: {
    jawOpen: { inputMin: -10, inputMax: 10, outputMin: -5, outputMax: 4, smoothing: 999, curve: "easeIn" },
    eyeBlinkLeft: { smoothing: -30, curve: "unknown", outputMax: Infinity },
    eyeBlinkRight: { inputMin: NaN, smoothing: NaN },
    mouthSmileLeft: null,
    mouthSmileRight: [],
  } } });
  assert.deepEqual(preferences.face2d.channels.jawOpen, {
    inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1, smoothing: 400, curve: "easeIn",
  });
  assert.equal(preferences.face2d.channels.eyeBlinkLeft.smoothing, 0);
  assert.equal(preferences.face2d.channels.eyeBlinkLeft.curve, DEFAULT_CHANNEL_SETTINGS.curve);
  assert.equal(preferences.face2d.channels.eyeBlinkLeft.outputMax, DEFAULT_CHANNEL_SETTINGS.outputMax);
  assert.deepEqual(preferences.face2d.channels.eyeBlinkRight, DEFAULT_CHANNEL_SETTINGS);
  assert.equal(Object.hasOwn(preferences.face2d.channels, "mouthSmileLeft"), false);
  assert.equal(Object.hasOwn(preferences.face2d.channels, "mouthSmileRight"), false);
  for (const face2d of [null, [], "invalid", 0, { channels: [] }, { channels: null }]) {
    assert.deepEqual(normalizePreferences({ face2d }).face2d, { channels: {} });
  }
});

test("ARKit persistence keeps only canonical settings, never camera or manual-test state", () => {
  const preferences = normalizePreferences({ face2d: {
    raw: { jawOpen: .3 }, smooth: { jawOpen: .2 }, cameraFrame: "private-camera-frame",
    manualValues: { eyeBlinkLeft: 1 }, testing: true, apiKey: "private-api-key",
    channels: {
      jawOpen: { smoothing: 60, raw: .7, smooth: .4, manualValue: 1, enabled: true, secret: "private-secret" },
      _neutral: { smoothing: 200 }, unknownChannel: { smoothing: 100 },
    },
  } });
  assert.deepEqual(preferences.face2d, { channels: { jawOpen: { ...DEFAULT_CHANNEL_SETTINGS, smoothing: 60 } } });
  const serialized = JSON.stringify(createProject({ preferences }));
  for (const forbidden of ["private", '"raw"', '"smooth"', "manualValue", "testing", "apiKey", "cameraFrame", "unknownChannel", "_neutral"]) {
    assert.equal(serialized.includes(forbidden), false, `must not persist ${forbidden}`);
  }
});

test("ARKit preferences ignore inherited wrappers, channels and per-channel properties", () => {
  const inheritedFace = Object.create({ face2d: { channels: { jawOpen: {} } } });
  assert.deepEqual(normalizePreferences(inheritedFace).face2d, { channels: {} });
  assert.deepEqual(normalizePreferences({ face2d: Object.create({ channels: { jawOpen: {} } }) }).face2d, { channels: {} });
  const channelMap = Object.assign(Object.create({ eyeBlinkRight: { smoothing: 400 } }), {
    jawOpen: Object.assign(Object.create({ smoothing: 400, outputMin: .8 }), { inputMin: .1 }),
  });
  const settings = normalizePreferences({ face2d: { channels: channelMap } }).face2d;
  assert.deepEqual(settings, { channels: { jawOpen: { ...DEFAULT_CHANNEL_SETTINGS, inputMin: .1 } } });
  const payload = JSON.parse('{"channels":{"__proto__":{"polluted":true},"jawOpen":{"__proto__":{"smoothing":400},"smoothing":90}}}');
  assert.deepEqual(normalizePreferences({ face2d: payload }).face2d, {
    channels: { jawOpen: { ...DEFAULT_CHANNEL_SETTINGS, smoothing: 90 } },
  });
  assert.equal({}.polluted, undefined);
});

test("all 52 full-precision configurations fit in the expanded bounded project envelope", () => {
  const channels = Object.fromEntries(ARKIT_CHANNELS.map((name) => [name, {
    inputMin: .12345678901234567, inputMax: .9234567890123456,
    outputMin: .02345678901234567, outputMax: .8234567890123456,
    smoothing: 123.45678901234567, curve: "easeOut",
  }]));
  const project = createProject({ preferences: { face2d: { channels } } });
  assert.equal(Object.keys(project.preferences.face2d.channels).length, 52);
  const serialized = JSON.stringify(project);
  assert.ok(serialized.length > 8192, "test payload must exceed the previous settings allowance");
  assert.ok(serialized.length < 32 * 1024);
  // Whitespace is valid JSON and exercises the combined image/settings envelope without allocating a decoded image.
  const padded = " ".repeat(MAX_IMAGE_DATA_URL_LENGTH) + serialized;
  assert.deepEqual(parseProject(padded), project);
});

test("a demo project round-trips without an image or secret data", () => {
  const project = createProject({ name: "  小月\u0000  ", preferences: { apiKey: "sk-secret", body: 42 } });
  assert.equal(project.name, "小月");
  assert.equal(project.imageDataUrl, null);
  assert.equal(project.preferences.body, 42);
  assert.deepEqual(parseProject(JSON.stringify(project)), project);
  assert.equal(JSON.stringify(project).includes("secret"), false);
  assert.equal(createProject().name, "我的角色");
  assert.equal(createProject({ name: "x".repeat(200) }).name.length, 60);
});

test("PNG, JPEG and WebP images survive project serialization", () => {
  for (const imageDataUrl of [PNG, JPEG, WEBP]) {
    const project = createProject({ name: "角色", imageDataUrl, preferences: { background: "transparent" } });
    assert.equal(parseProject(JSON.stringify(project)).imageDataUrl, imageDataUrl);
  }
});

test("external URLs, SVG and MIME-spoofed images are rejected", () => {
  for (const imageDataUrl of [
    "https://example.com/avatar.png", "blob:http://localhost/avatar", "file:///secret.png",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:text/html;base64,PHN2Zz48L3N2Zz4=",
    "data:image/png;base64,PHN2Zz48L3N2Zz4=", JPEG.replace("jpeg", "png"),
    PNG.replace(";base64,", ";charset=utf-8;base64,"), {}, 0,
  ]) assert.throws(() => createProject({ imageDataUrl }));
});

test("invalid base64 and oversized project data fail before persistence", () => {
  for (const imageDataUrl of [
    "data:image/png;base64,", PNG + "!", PNG + "A", PNG.replace("iVBOR", "iV BO"),
    "data:image/png;base64,====", "data:image/png;base64,AA=A",
  ]) assert.throws(() => createProject({ imageDataUrl }));
  assert.throws(() => createProject({ imageDataUrl: "x".repeat(MAX_IMAGE_DATA_URL_LENGTH + 1) }), /太大/);
  assert.throws(() => parseProject("x".repeat(MAX_IMAGE_DATA_URL_LENGTH + 32 * 1024 + 1)), /太大/);
});

test("corrupt, unrelated, inherited and future-version project envelopes are rejected", () => {
  const valid = createProject();
  for (const raw of [
    "broken JSON", "null", "[]", null, [], {}, { ...valid, format: "other" },
    { ...valid, version: 2 }, { ...valid, version: "1" }, { ...valid, name: null },
    { ...valid, imageDataUrl: undefined }, Object.create(valid),
  ]) assert.throws(() => parseProject(raw));
  const missingImage = { ...valid };
  delete missingImage.imageDataUrl;
  assert.throws(() => parseProject(missingImage), /缺少/);
});

test("unknown fields and prototype pollution payloads do not enter the returned project", () => {
  const source = JSON.parse('{"format":"moemotion-project","version":1,"name":"test","imageDataUrl":null,"apiKey":"secret","cameraFrame":"secret","__proto__":{"polluted":true},"preferences":{"body":40,"apiKey":"secret","__proto__":{"head":0}}}');
  const project = parseProject(source);
  assert.deepEqual(Object.keys(project), ["format", "version", "name", "imageDataUrl", "preferences"]);
  assert.equal(project.preferences.head, 90);
  assert.equal(project.preferences.body, 40);
  assert.equal(Object.hasOwn(project, "__proto__"), false);
  assert.equal({}.polluted, undefined);
  source.preferences.body = 1;
  assert.equal(project.preferences.body, 40);
});

test("missing browser storage is surfaced without using localStorage", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
  try {
    await assert.rejects(saveProject(createProject()), /浏览器暂时无法保存/);
    await assert.rejects(loadProject(), /浏览器暂时无法保存/);
    await assert.rejects(clearProject(), /浏览器暂时无法保存/);
    await assert.rejects(saveProject({}), /这不是/);
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  }
});

function installStorageDouble({ blocked = false, failure = null, initial } = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const state = { value: initial, closes: 0, commits: 0, operations: [] };
  const database = {
    objectStoreNames: { contains: () => true },
    close() { state.closes += 1; },
    transaction(storeName, mode) {
      assert.equal(storeName, "projects");
      const transaction = {
        error: null,
        abort() { this.onabort?.(); },
        objectStore() {
          const operate = (type, key, value) => {
            assert.equal(key, "current");
            state.operations.push([type, mode]);
            const request = { result: undefined, error: failure };
            queueMicrotask(() => {
              if (failure) {
                transaction.error = failure;
                transaction.onabort();
                return;
              }
              if (type === "put") state.value = structuredClone(value);
              else if (type === "delete") state.value = undefined;
              else request.result = state.value === undefined ? undefined : structuredClone(state.value);
              state.commits += 1;
              transaction.oncomplete();
            });
            return request;
          };
          return {
            put: (value, key) => operate("put", key, value),
            get: (key) => operate("get", key),
            delete: (key) => operate("delete", key),
          };
        },
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => {
        if (blocked) request.onblocked();
        request.onsuccess();
      });
      return request;
    } },
  });
  return {
    state,
    restore() {
      if (original) Object.defineProperty(globalThis, "indexedDB", original);
      else delete globalThis.indexedDB;
    },
  };
}

test("IndexedDB save/load/clear complete only after transaction commit and close each connection", async () => {
  const mock = installStorageDouble();
  try {
    assert.equal(await loadProject(), null);
    const project = createProject({ imageDataUrl: PNG, preferences: {
      body: 55, face2d: { channels: { jawOpen: { smoothing: 120, curve: "smooth" } } },
    } });
    const saved = await saveProject({ ...project, apiKey: "discard me", preferences: {
      ...project.preferences,
      face2d: { ...project.preferences.face2d, raw: { jawOpen: .9 }, manualValues: { jawOpen: 1 }, cameraFrame: "private" },
    } });
    assert.equal(mock.state.commits, 2);
    assert.deepEqual(saved, project);
    assert.deepEqual(await loadProject(), project);
    assert.equal(Object.hasOwn(mock.state.value, "apiKey"), false);
    assert.deepEqual(mock.state.value.preferences.face2d, project.preferences.face2d);
    await clearProject();
    assert.equal(await loadProject(), null);
    assert.equal(mock.state.closes, 5);
    assert.deepEqual(mock.state.operations, [
      ["get", "readonly"], ["put", "readwrite"], ["get", "readonly"],
      ["delete", "readwrite"], ["get", "readonly"],
    ]);
  } finally { mock.restore(); }
});

test("storage quota aborts are surfaced and do not pretend the project was saved", async () => {
  const mock = installStorageDouble({ failure: Object.assign(new Error("full"), { name: "QuotaExceededError" }) });
  try {
    await assert.rejects(saveProject(createProject()), /存储空间不足/);
    assert.equal(mock.state.value, undefined);
    assert.equal(mock.state.commits, 0);
    assert.equal(mock.state.closes, 1);
  } finally { mock.restore(); }
});

test("blocked opening rejects, closes late successful connections and never starts a transaction", async () => {
  const mock = installStorageDouble({ blocked: true });
  try {
    await assert.rejects(loadProject(), /其他页面占用/);
    assert.equal(mock.state.closes, 1);
    assert.deepEqual(mock.state.operations, []);
  } finally { mock.restore(); }
});

test("damaged stored data rejects instead of looking like an empty first launch", async () => {
  const mock = installStorageDouble({ initial: { format: "unexpected" } });
  try {
    await assert.rejects(loadProject(), /这不是/);
    assert.equal(mock.state.closes, 1);
    assert.deepEqual(mock.state.value, { format: "unexpected" });
  } finally { mock.restore(); }
});
