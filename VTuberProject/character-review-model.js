export const REVIEW_STATUSES = Object.freeze({ undecided: "未判断", pass: "通过", revise: "需修改" });
export const REVIEW_GROUPS = Object.freeze({ yaw: "侧转", up: "斜上", down: "斜下" });
export const LANDMARK_LABELS = Object.freeze({
  eyeOuterViewerLeft: "画面左眼外眼角",
  eyeInnerViewerLeft: "画面左眼内眼角",
  eyeInnerViewerRight: "画面右眼内眼角",
  eyeOuterViewerRight: "画面右眼外眼角",
  noseTip: "鼻尖",
  philtrum: "人中",
  upperLip: "上唇中点",
  chin: "下巴",
});

export function validateReviewManifest(value) {
  if (!value || value.version !== 1 || typeof value.characterName !== "string" || !value.characterName.trim()
    || !Array.isArray(value.poses) || !value.poses.length) throw new Error("画稿清单格式不完整。");
  const ids = new Set();
  const poses = value.poses.map((pose) => {
    if (!pose || typeof pose.id !== "string" || !pose.id || ids.has(pose.id)) throw new Error("画稿编号缺失或重复。");
    ids.add(pose.id);
    if (typeof pose.label !== "string" || !pose.label || !["front", ...Object.keys(REVIEW_GROUPS)].includes(pose.group)) {
      throw new Error(`画稿 ${pose.id} 缺少名称或角度组别。`);
    }
    if (!Number.isInteger(pose.width) || pose.width <= 0 || !Number.isInteger(pose.height) || pose.height <= 0) {
      throw new Error(`画稿 ${pose.id} 的原始尺寸无效。`);
    }
    if (typeof pose.src !== "string" || !/^\.\/assets\/[a-zA-Z0-9_./-]+\.(png|webp|avif|jpe?g)$/i.test(pose.src)
      || pose.src.split("/").includes("..")) throw new Error(`画稿 ${pose.id} 必须引用项目内的本地图像。`);
    const landmarks = {};
    for (const [key, point] of Object.entries(pose.landmarks || {})) {
      if (!Object.hasOwn(LANDMARK_LABELS, key)) continue;
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)
        || point[0] < 0 || point[0] > pose.width || point[1] < 0 || point[1] > pose.height) {
        throw new Error(`画稿 ${pose.id} 的标志点 ${key} 超出原图或格式无效。`);
      }
      landmarks[key] = [...point];
    }
    return { id: pose.id, label: pose.label, group: pose.group, src: pose.src, width: pose.width, height: pose.height,
      approved: pose.approved === true, notes: Array.isArray(pose.notes) ? pose.notes.filter((note) => typeof note === "string") : [], landmarks };
  });
  const reference = poses.find((pose) => pose.id === value.referenceId);
  if (!reference || reference.group !== "front" || !reference.approved) throw new Error("缺少已确认的正面参考画稿。");
  if (!poses.some((pose) => pose.group !== "front")) throw new Error("清单尚未包含侧向角度画稿。");
  return { version: 1, assetRevision: typeof value.assetRevision === "string" ? value.assetRevision : "initial",
    characterName: value.characterName.trim(), referenceId: reference.id, poses };
}

export function reviewStorageKey(manifest) {
  // A different asset set starts a separate review; approval must never silently carry into replacement images.
  const identity = JSON.stringify([manifest.version, manifest.assetRevision, manifest.referenceId, manifest.poses.map(({ id, src, width, height }) => [id, src, width, height])]);
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i += 1) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  return `vtuber-character-review:${(hash >>> 0).toString(16)}`;
}

export function emptyReview(manifest) {
  return Object.fromEntries(manifest.poses.filter((pose) => pose.group !== "front").map((pose) => [pose.id, { status: "undecided", note: "", updatedAt: null }]));
}

export function readReview(manifest, raw) {
  const review = emptyReview(manifest);
  if (raw == null) return review;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || parsed.schemaVersion !== 1 || parsed.assetSet !== reviewStorageKey(manifest) || !parsed.review || typeof parsed.review !== "object") {
    throw new Error("保存的反馈格式不匹配。");
  }
  for (const id of Object.keys(review)) {
    const saved = parsed.review[id];
    if (!saved || !Object.hasOwn(REVIEW_STATUSES, saved.status)) continue;
    review[id] = { status: saved.status, note: typeof saved.note === "string" ? saved.note.slice(0, 4000) : "",
      updatedAt: typeof saved.updatedAt === "string" && Number.isFinite(Date.parse(saved.updatedAt)) ? saved.updatedAt : null };
  }
  return review;
}

export function serializeReview(manifest, review) {
  return JSON.stringify({ schemaVersion: 1, assetSet: reviewStorageKey(manifest), review }, null, 2);
}

export function exportReview(manifest, review, exportedAt = new Date().toISOString()) {
  return { schemaVersion: 1, purpose: "静态角色结构补充反馈；作品 approved 字段来自人工批准记录，review 字段来自本浏览器反馈，不代表表情或动画验收。",
    approvalRecord: "./assets/short-hair-v1/design-approval.json",
    characterName: manifest.characterName, assetSet: reviewStorageKey(manifest), exportedAt,
    reference: manifest.poses.find((pose) => pose.id === manifest.referenceId),
    poses: manifest.poses.filter((pose) => pose.group !== "front").map((pose) => ({
      ...pose, review: { ...review[pose.id], statusLabel: REVIEW_STATUSES[review[pose.id]?.status] || REVIEW_STATUSES.undecided },
    })) };
}

export const FACE_VIEW_SHORT_EDGE_FRACTION = 0.64;

export function faceViewBox(pose) {
  // Every drawing uses the same normalized square window. Landmarks choose only
  // its center; changing the feature span must never change the zoom level.
  const size = Math.min(pose.width, pose.height) * FACE_VIEW_SHORT_EDGE_FRACTION;
  const points = Object.values(pose.landmarks);
  let centerX = pose.width / 2;
  let centerY = pose.height * 0.42;
  if (points.length >= 3) {
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    centerY = (Math.min(...ys) + Math.max(...ys)) / 2 - (Math.max(...ys) - Math.min(...ys)) * 0.12;
  }
  return [Math.max(0, Math.min(pose.width - size, centerX - size / 2)),
    Math.max(0, Math.min(pose.height - size, centerY - size / 2)), size, size];
}
