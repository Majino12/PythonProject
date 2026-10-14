const PROJECT_FORMAT = "moemotion-project";
const PROJECT_VERSION = 1;
const DATABASE_NAME = "moemotion-projects";
const STORE_NAME = "projects";
const CURRENT_PROJECT_KEY = "current";
export const MAX_IMAGE_DATA_URL_LENGTH = 28 * 1024 * 1024;
const MAX_PROJECT_JSON_LENGTH = MAX_IMAGE_DATA_URL_LENGTH + 8192;

export const DEFAULT_PREFERENCES = Object.freeze({
  background: "gradient", viewMode: "2d", modelStyle: "studio",
  head: 90, blink: 85, mouth: 90, expression: 100, body: 75,
  demoMotion: "idle", framing: "portrait", appearance: Object.freeze({}),
});

const RANGE_LIMITS = Object.freeze({
  head: [0, 140], blink: [20, 150], mouth: [20, 150],
  expression: [20, 150], body: [0, 140],
});

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Whitelisting also keeps credentials, device IDs and tracking data out of backups.
export function normalizePreferences(raw) {
  const source = isRecord(raw) ? raw : {};
  const preferences = { ...DEFAULT_PREFERENCES, appearance: {} };
  if (own(source, "demoMotion") && ["idle", "greeting", "speaking"].includes(source.demoMotion)) preferences.demoMotion = source.demoMotion;
  if (own(source, "framing") && ["portrait", "full"].includes(source.framing)) preferences.framing = source.framing;
  if (own(source, "appearance") && isRecord(source.appearance)) {
    const appearance = source.appearance;
    if (own(appearance, "hairStyle") && ["short", "bob", "long"].includes(appearance.hairStyle)) preferences.appearance.hairStyle = appearance.hairStyle;
    for (const key of ["hair", "outfit", "eyes"]) {
      if (own(appearance, key) && typeof appearance[key] === "string" && /^#[a-f\d]{6}$/i.test(appearance[key])) preferences.appearance[key] = appearance[key].toLowerCase();
    }
  }
  if (own(source, "background") && ["gradient", "transparent", "green"].includes(source.background)) {
    preferences.background = source.background;
  }
  if (own(source, "viewMode") && ["2d", "3d"].includes(source.viewMode)) {
    preferences.viewMode = source.viewMode;
  }
  if (own(source, "modelStyle") && ["studio", "light"].includes(source.modelStyle)) {
    preferences.modelStyle = source.modelStyle;
  }
  for (const [key, [minimum, maximum]] of Object.entries(RANGE_LIMITS)) {
    if (!own(source, key)) continue;
    const rawValue = source[key];
    if (typeof rawValue !== "number" && (typeof rawValue !== "string" || !rawValue.trim())) continue;
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric)) {
      preferences[key] = Math.round(Math.min(maximum, Math.max(minimum, numeric)));
    }
  }
  return preferences;
}

function normalizeName(value) {
  if (typeof value !== "string") return "我的角色";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) || "我的角色";
}

function imageHeaderBytes(base64) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  // Only decode the signature, never allocate another full image in memory.
  for (const character of base64.slice(0, 24)) {
    if (character === "=") break;
    buffer = (buffer << 6) | alphabet.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return bytes;
}

function validateImageDataUrl(value) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("项目中的角色图片格式不正确。");
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error("项目图片太大，请使用 20 MB 以内的 PNG、JPG 或 WebP 图片。");
  const header = /^data:image\/(png|jpeg|webp);base64,/.exec(value);
  if (!header) throw new Error("项目只支持内嵌的 PNG、JPG 或 WebP 图片，不支持外部链接或 SVG。");
  const base64 = value.slice(header[0].length);
  if (!base64.length || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("项目中的图片数据已损坏，请重新导入图片。");
  }
  const bytes = imageHeaderBytes(base64);
  const hasBytes = (offset, signature) => signature.every((byte, index) => bytes[offset + index] === byte);
  const validSignature = header[1] === "png" ? hasBytes(0, [137, 80, 78, 71, 13, 10, 26, 10])
    : header[1] === "jpeg" ? hasBytes(0, [255, 216, 255])
      : hasBytes(0, [82, 73, 70, 70]) && hasBytes(8, [87, 69, 66, 80]);
  if (!validSignature) throw new Error("项目中的图片类型与内容不一致，请重新导入图片。");
  return value;
}

export function createProject({ name, imageDataUrl = null, preferences } = {}) {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: normalizeName(name),
    imageDataUrl: validateImageDataUrl(imageDataUrl),
    preferences: normalizePreferences(preferences),
  };
}

export function parseProject(raw) {
  let source = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_PROJECT_JSON_LENGTH) throw new Error("项目文件太大，请选择由本软件导出的角色项目。");
    try {
      source = JSON.parse(raw);
    } catch {
      throw new Error("项目文件不是有效的 JSON，请选择由本软件导出的角色项目。");
    }
  }
  if (!isRecord(source) || !own(source, "format") || source.format !== PROJECT_FORMAT) {
    throw new Error("这不是 MoeMotion 角色项目，请选择正确的项目文件。");
  }
  if (!own(source, "version") || source.version !== PROJECT_VERSION) {
    throw new Error("暂不支持这个项目版本，请使用匹配的 MoeMotion 版本打开。");
  }
  if (!own(source, "name") || typeof source.name !== "string" || !own(source, "imageDataUrl")) {
    throw new Error("项目缺少角色名称或图片数据，请重新导出项目。");
  }
  if (source.imageDataUrl !== null && typeof source.imageDataUrl !== "string") {
    throw new Error("项目中的角色图片格式不正确。");
  }
  return createProject({
    name: source.name,
    imageDataUrl: source.imageDataUrl,
    preferences: own(source, "preferences") ? source.preferences : undefined,
  });
}

function storageError(error) {
  if (error?.name === "QuotaExceededError") {
    return new Error("浏览器存储空间不足，未能自动保存。请下载项目备份。", { cause: error });
  }
  return new Error("浏览器暂时无法保存角色。请检查隐私或存储设置，并下载项目备份。", { cause: error });
}

function openProjectDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const finish = (error, database) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(database);
    };
    const timer = setTimeout(() => finish(new Error("打开本地角色存储超时，请关闭其他 MoeMotion 页面后重试。")), 5000);
    try {
      if (!globalThis.indexedDB?.open) throw new Error("IndexedDB unavailable");
      request = globalThis.indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        finish(null, database);
      };
      request.onerror = () => finish(storageError(request.error));
      request.onblocked = () => finish(new Error("本地角色存储被其他页面占用，请关闭其他 MoeMotion 页面后重试。"));
    } catch (error) {
      finish(storageError(error));
    }
  });
}

async function runTransaction(mode, operation) {
  const database = await openProjectDatabase();
  return new Promise((resolve, reject) => {
    let transaction;
    let request;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      database.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try { transaction?.abort(); } catch { /* Transaction may already have finished. */ }
      finish(new Error("本地角色存储响应超时，请下载项目备份后重试。"));
    }, 5000);
    try {
      transaction = database.transaction(STORE_NAME, mode);
      transaction.oncomplete = () => finish(null, request.result);
      transaction.onerror = () => finish(storageError(transaction.error || request?.error));
      transaction.onabort = () => finish(storageError(transaction.error || request?.error));
      request = operation(transaction.objectStore(STORE_NAME));
    } catch (error) {
      try { transaction?.abort(); } catch { /* No active transaction remains. */ }
      finish(storageError(error));
    }
  });
}

export async function saveProject(project) {
  const safeProject = parseProject(project);
  await runTransaction("readwrite", (store) => store.put(safeProject, CURRENT_PROJECT_KEY));
  return safeProject;
}

export async function loadProject() {
  const project = await runTransaction("readonly", (store) => store.get(CURRENT_PROJECT_KEY));
  return project === undefined ? null : parseProject(project);
}

export async function clearProject() {
  await runTransaction("readwrite", (store) => store.delete(CURRENT_PROJECT_KEY));
}
