/** A verified inventory of existing paintings, not a new renderer or an approval.
 * Paths are project-root-relative. Portraits retain their painted backgrounds;
 * local expression masks do not provide full-character alpha or separate limbs. */
import {validateExpressionManifest} from './expression-renderer.js';
import {validateSideExpressionManifest} from './side-expression-renderer.js';
import {validateFrameArtManifest} from './frame-art-renderer.js';
import {validateBrowExclusion} from './side-brow-exclusion.js';

export const SHORT_HAIR_CHARACTER_PACK_URL = './assets/short-hair-v1/character-pack.json';
const MANIFESTS = Object.freeze({
  front: './assets/short-hair-gaze-v1/manifest.json',
  side: './assets/short-hair-side-brows-v1/manifest.json',
  pitch: './assets/short-hair-pitch-brows-v1/manifest.json',
  complete: './assets/short-hair-complete-poses-v1/manifest.json',
  extension: './assets/short-hair-frame-art-v1/manifest.json',
});
const DESIGN_APPROVAL = './assets/short-hair-v1/design-approval.json';
const POSES = Object.freeze([
  ['view-left-up', '左上', 'pitch'], ['view-up', '抬头', 'complete'], ['view-right-up', '右上', 'pitch'],
  ['view-left', '左转', 'side'], ['front', '正面', 'front'], ['view-right', '右转', 'side'],
  ['view-left-down', '左下', 'pitch'], ['view-down', '低头', 'complete'], ['view-right-down', '右下', 'complete'],
]);
const EYES = ['open', 'quarter', 'half', 'threeQuarter', 'closed'];
const MOUTHS = ['neutral', 'parted', 'openSmall', 'openMedium', 'openWide', 'pucker', 'press', 'shiftLeft', 'shiftRight'];
const GROUPS = ['eyeLeft', 'eyeRight', 'mouth', 'browLeft', 'browRight'];
const LAYERS = Object.freeze({kind: 'registered-portrait-crops', transform: 'translation-only',
  expressionMask: 'local-feather-and-clip', gaze: 'compiled-iris-and-sclera',
  separateBody: false, separateHair: false, separateBackground: false, fullCharacterAlpha: false});
const MISSING = ['continuous-head-turn', 'separate-body-hair-background', 'full-character-alpha'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const clone = value => JSON.parse(JSON.stringify(value));
function fail(where, reason) { throw new Error(`角色素材清单 ${where}：${reason}`); }
function keys(value, expected, where) {
  if (!object(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail(where, '字段不符合 schemaVersion 1。');
}
function string(value, where) { if (typeof value !== 'string' || !value.length) fail(where, '必须是非空文字。'); }
function rectangle(value, where) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite) || value[0] < 0 || value[1] < 0
    || value[2] <= 0 || value[3] <= 0 || value[0] + value[2] > 1122 || value[1] + value[3] > 1402) fail(where, '查看范围超出原生画布。');
}
function inside(point, rect) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && point[0] >= rect[0] && point[1] >= rect[1] && point[0] <= rect[0] + rect[2] && point[1] <= rect[1] + rect[3];
}
function validatePatch(patch, group, where) {
  const required = ['source', 'rect', 'destination', 'feather', 'transform'], optional = ['anchor', 'clip', 'exclude', 'excludeFeather'];
  if (required.some(key => !Object.hasOwn(patch, key)) || Object.keys(patch).some(key => ![...required, ...optional].includes(key))) fail(where, '裁切字段不符合 schemaVersion 1。');
  rectangle(patch.rect, where); rectangle(patch.destination, where);
  if (!equal(patch.rect.slice(2), patch.destination.slice(2)) || !Number.isFinite(patch.feather)
    || patch.feather < 0 || patch.feather * 2 >= Math.min(...patch.rect.slice(2))) fail(where, '裁切必须保持原生比例与有效羽化范围。');
  if (patch.anchor !== undefined) {
    keys(patch.anchor, ['kind', 'source', 'destination'], where);
    if (!['upper-lip', 'mouth-seam', 'directional-mouth-seam'].includes(patch.anchor.kind)
      || !inside(patch.anchor.source, patch.rect) || !inside(patch.anchor.destination, patch.destination)
      || !equal(patch.anchor.source.map((value, i) => value + patch.destination[i] - patch.rect[i]), patch.anchor.destination)) fail(where, '锚点与固定平移登记不一致。');
  } else if (group === 'mouth') fail(where, '嘴型缺少实际登记的锚点。');
  if (patch.clip !== undefined && (!Array.isArray(patch.clip) || patch.clip.length < 3
    || patch.clip.some(point => !inside(point, patch.destination)))) fail(where, '局部遮罩越出裁切范围。');
  validateBrowExclusion(patch, group);
}
/** Reject URLs, traversal, encoded separators, query strings and noncanonical paths. */
export function validateCharacterPackPath(path) {
  if (typeof path !== 'string' || !/^\.\/assets\/short-hair-[a-z0-9-]+\/[A-Za-z0-9_-]+\.(?:json|png)$/.test(path)) {
    fail(String(path), '只允许项目内规范的 ./assets/short-hair-…/ 文件路径；不能越界或使用网络地址。');
  }
  return path;
}
function stateNames(pose, group) {
  return group.startsWith('eye') ? EYES : group === 'mouth' ? MOUTHS
    : pose === 'front' ? ['neutral', 'up', 'down'] : ['neutral', 'innerUp', 'outerUp', 'down'];
}
function gaps(pose) { return ['pucker-with-mouth-shift', 'one-sided-lip-press', ...(pose === 'front' ? ['independent-inner-outer-brow'] : [])]; }
function validateApproval(approval, where, indexed) {
  keys(approval, ['status', 'record', 'acceptedScope', 'pendingScope'], where);
  if (!['approved', 'candidate'].includes(approval.status)) fail(where, '批准状态无效。');
  if (approval.status === 'approved') {
    if (!indexed.has(validateCharacterPackPath(approval.record))) fail(where, '批准记录缺少文件登记。');
    string(approval.acceptedScope, where);
  } else if (approval.record !== null || approval.acceptedScope !== null) fail(where, '候选素材不能伪造批准记录。');
  string(approval.pendingScope, where);
}

/** Structural validation never fetches or changes files. Full verification also
 * compares these entries with hashed source manifests and, optionally, PNG bytes. */
export function validateShortHairCharacterPack(pack) {
  keys(pack, ['schemaVersion', 'characterId', 'kind', 'artBaseline', 'coordinateSystem', 'layers', 'missingCapabilities', 'files', 'poses'], '根节点');
  if (pack.schemaVersion !== 1 || pack.characterId !== 'short-hair-v1' || pack.kind !== 'existing-painted-character-inventory'
    || pack.artBaseline !== '0.15.0' || pack.coordinateSystem !== 'native-1122x1402-character-left-right') fail('根节点', '版本、角色或坐标约定不匹配。');
  if (!equal(pack.layers, LAYERS) || !equal(pack.missingCapabilities, MISSING)) fail('图层能力', '当前实际素材尚未分离身体、头发、背景或提供角色 alpha。');
  if (!Array.isArray(pack.files) || !pack.files.length) fail('files', '没有文件登记。');
  const indexed = new Map();
  for (const file of pack.files) {
    keys(file, ['path', 'kind', 'bytes', 'sha256'], 'files'); validateCharacterPackPath(file.path);
    if (indexed.has(file.path)) fail(file.path, '文件重复登记。');
    if (!['manifest', 'approval', 'provenance', 'artwork'].includes(file.kind)
      || (file.kind === 'artwork') !== file.path.endsWith('.png') || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) fail(file.path, '文件类型、长度或 SHA256 无效。');
    indexed.set(file.path, file);
  }
  for (const path of Object.values(MANIFESTS)) if (indexed.get(path)?.kind !== 'manifest') fail(path, '缺少来源清单。');
  if (indexed.get(DESIGN_APPROVAL)?.kind !== 'approval') fail(DESIGN_APPROVAL, '缺少设计批准记录。');
  if (!Array.isArray(pack.poses) || pack.poses.length !== POSES.length) fail('poses', '必须登记九个现有姿态。');
  const seen = new Set();
  for (const pose of pack.poses) {
    keys(pose, ['id', 'label', 'family', 'baseManifest', 'extensionManifest', 'reference', 'viewports', 'mouthReference', 'states', 'gaze', 'approval', 'gaps'], 'pose');
    const descriptor = POSES.find(([id]) => id === pose.id);
    if (!descriptor || seen.has(pose.id)) fail(pose.id, '姿态不存在或重复。');
    seen.add(pose.id);
    if (pose.label !== descriptor[1] || pose.family !== descriptor[2] || pose.baseManifest !== MANIFESTS[pose.family]
      || pose.extensionManifest !== (pose.id === 'front' ? null : MANIFESTS.extension)) fail(pose.id, '来源系列与姿态不匹配。');
    keys(pose.reference, ['source', 'path'], `${pose.id}/reference`); string(pose.reference.source, pose.id);
    if (indexed.get(validateCharacterPackPath(pose.reference.path))?.kind !== 'artwork') fail(pose.id, '原画没有文件登记。');
    keys(pose.viewports, ['face', 'full'], `${pose.id}/viewports`); rectangle(pose.viewports.face, pose.id);
    if (!equal(pose.viewports.full, [0, 0, 1122, 1402])) fail(pose.id, '全幅范围必须保持原画尺寸。');
    if (!Array.isArray(pose.mouthReference) || pose.mouthReference.length !== 2 || !pose.mouthReference.every(Number.isFinite)) fail(pose.id, '上唇锚点无效。');
    keys(pose.states, GROUPS, `${pose.id}/states`);
    for (const group of GROUPS) {
      const expected = stateNames(pose.id, group), entries = pose.states[group];
      if (!Array.isArray(entries) || entries.length !== expected.length) fail(`${pose.id}/${group}`, '实际画稿状态数量不符。');
      const states = new Set();
      for (const state of entries) {
        keys(state, ['id', 'originManifest', 'source', 'path', 'patch'], `${pose.id}/${group}`);
        if (!expected.includes(state.id) || states.has(state.id)) fail(`${pose.id}/${group}/${state.id}`, '状态不存在或重复。');
        states.add(state.id); string(state.source, state.id);
        if (![pose.baseManifest, pose.extensionManifest].includes(state.originManifest) || state.originManifest === null) fail(state.id, '状态来源不是此姿态的素材包。');
        if (indexed.get(validateCharacterPackPath(state.path))?.kind !== 'artwork') fail(state.id, '状态画稿缺少文件登记。');
        if (state.id === expected[0]) {
          if (state.patch !== null || state.source !== pose.reference.source || state.path !== pose.reference.path || state.originManifest !== pose.baseManifest) fail(state.id, '中性状态必须使用本姿态底图。');
        } else {
          if (!object(state.patch) || state.patch.source !== state.source || state.patch.transform !== 'translation-only') fail(state.id, '缺少原生裁切登记。');
          validatePatch(state.patch, group, `${pose.id}/${group}/${state.id}`);
        }
      }
    }
    if (!equal(pose.gaze, {independentEyes: true, clippedToPaintedAperture: true, hiddenWhenClosed: true})) fail(pose.id, '视线能力登记无效。');
    keys(pose.approval, ['base', 'extension'], `${pose.id}/approval`); validateApproval(pose.approval.base, pose.id, indexed);
    if (pose.id === 'front') { if (pose.approval.extension !== null) fail(pose.id, '正面没有新中间稿扩展。'); }
    else validateApproval(pose.approval.extension, `${pose.id}/extension`, indexed);
    if (!equal(pose.gaps, gaps(pose.id))) fail(pose.id, '不能宣称缺失的复合口型或眉形已经具备。');
  }
  return pack;
}

function documentAt(documents, path) {
  const result = documents instanceof Map ? documents.get(path) : documents?.[path];
  if (!object(result)) fail(path, '来源文档缺失或不是 JSON 对象。');
  return result;
}
function sourceDocuments(documents) {
  const manifests = Object.fromEntries(Object.entries(MANIFESTS).map(([family, path]) => [family, documentAt(documents, path)]));
  validateExpressionManifest(manifests.front);
  for (const family of ['side', 'pitch', 'complete']) validateSideExpressionManifest(manifests[family]);
  validateFrameArtManifest(manifests.extension);
  return manifests;
}
function approvalFor(manifest, documents) {
  if (manifest.status === 'approved') {
    const record = documentAt(documents, manifest.approval);
    return {status: 'approved', record: manifest.approval, acceptedScope: record.acceptedScope, pendingScope: record.pendingScope};
  }
  if (manifest.status !== 'candidate') fail(manifest.id, '来源包的批准状态无效。');
  return {status: 'candidate', record: null, acceptedScope: null, pendingScope: '未记录本素材的用户逐稿批准；内部验证不替代用户视觉确认。'};
}
function poseFromDocuments(descriptor, manifests, documents) {
  const [id, label, family] = descriptor, base = manifests[family], record = id === 'front' ? base : base.poses[id];
  if (!record) fail(id, '来源包中不存在此姿态。');
  const extension = id === 'front' ? null : manifests.extension.poses[id];
  if (extension && extension.baseFamily !== family) fail(id, '扩展画稿属于其他姿态系列。');
  const states = Object.fromEntries(GROUPS.map(group => [group, stateNames(id, group).map((state, index) => {
    const extra = extension?.patches?.[group]?.[state], patch = index === 0 ? null : extra || record.patches[group][state];
    if (index !== 0 && !patch) fail(`${id}/${group}/${state}`, '来源包缺少实际状态画稿。');
    const origin = extra ? manifests.extension : base, source = patch?.source || record.reference;
    if (!origin.sources[source]) fail(source, '来源包缺少源图。');
    return {id: state, originManifest: extra ? MANIFESTS.extension : MANIFESTS[family], source, path: origin.sources[source].src, patch: clone(patch)};
  })]));
  return {id, label, family, baseManifest: MANIFESTS[family], extensionManifest: id === 'front' ? null : MANIFESTS.extension,
    reference: {source: record.reference, path: base.sources[record.reference].src},
    viewports: {face: clone(record.faceView), full: [0, 0, base.width, base.height]}, mouthReference: clone(record.mouthReference), states,
    gaze: {independentEyes: true, clippedToPaintedAperture: true, hiddenWhenClosed: true},
    approval: {base: approvalFor(base, documents), extension: extension ? approvalFor(manifests.extension, documents) : null}, gaps: gaps(id)};
}

/** Compile inventory facts from the same manifests used by the unchanged studio.
 * Detects copied coordinates, invented states and approval changes, even if the
 * inventory is valid JSON. It does not compile or alter any image canvas. */
export function compileShortHairCharacterPack(pack, documents) {
  validateShortHairCharacterPack(pack);
  const manifests = sourceDocuments(documents), indexed = new Map(pack.files.map(file => [file.path, file]));
  const requiredFiles = new Set([...Object.values(MANIFESTS), DESIGN_APPROVAL]);
  for (const manifest of Object.values(manifests)) {
    for (const source of Object.values(manifest.sources)) {
      const file = indexed.get(validateCharacterPackPath(source.src)); requiredFiles.add(source.src);
      if (!file || file.kind !== 'artwork') fail(source.src, '来源画稿未登记。');
      if (source.sha256 && source.sha256 !== file.sha256) fail(source.src, '源图指纹与来源清单不一致。');
    }
    for (const [field, kind] of [['approval', 'approval'], ['provenance', 'provenance']]) if (manifest[field]) {
      if (indexed.get(validateCharacterPackPath(manifest[field]))?.kind !== kind) fail(manifest[field], '来源记录未登记。');
      requiredFiles.add(manifest[field]);
    }
  }
  for (const path of indexed.keys()) if (!requiredFiles.has(path)) fail(path, '文件不属于当前采用的来源包。');
  for (const descriptor of POSES) {
    const actual = pack.poses.find(pose => pose.id === descriptor[0]), expected = poseFromDocuments(descriptor, manifests, documents);
    if (actual.extensionManifest) {
      const extension = manifests.extension, base = manifests[actual.family];
      if (extension.bases[actual.family].id !== base.id
        || Object.values(extension.poses[actual.id].patches.mouth).some(patch => !equal(patch.anchor.destination, expected.mouthReference))) {
        fail(actual.id, '中间稿与基础包的标识或固定上唇锚点不匹配。');
      }
    }
    if (!equal(actual, expected)) fail(descriptor[0], '登记内容与来源清单漂移；请核对状态、裁切、视口、锚点和批准范围。');
  }
  return summarizeShortHairCharacterPack(pack);
}

/** Optional loaded assets establish that registered states really compiled.
 * Without assets, the summary explicitly remains an inventory-level report. */
export function summarizeShortHairCharacterPack(pack, assets) {
  validateShortHairCharacterPack(pack);
  if (assets) for (const pose of pack.poses) {
    const family = assets[pose.family], record = pose.id === 'front' ? family?.manifest : family?.manifest?.poses?.[pose.id];
    const compiled = pose.id === 'front' ? family?.compiled : family?.compiled?.[pose.id];
    if (!record || !compiled || record.reference !== pose.reference.source || family.manifest.sources?.[record.reference]?.src !== pose.reference.path) fail(pose.id, '当前工作台缺少已载入的本姿态底图或图层。');
    for (const group of GROUPS) for (const state of pose.states[group]) if (state.patch !== null
      && (!compiled[group]?.[state.id] || !equal(record.patches?.[group]?.[state.id], state.patch))) fail(`${pose.id}/${group}/${state.id}`, '登记画稿与当前已编译图层不一致。');
    const gaze = pose.id === 'front' ? family.gazeLayers : family.gazeLayers?.[pose.id];
    if (!gaze?.eyeLeft || !gaze?.eyeRight) fail(pose.id, '当前工作台缺少独立视线图层。');
  }
  return {schemaVersion: 1, characterId: pack.characterId, verificationLevel: assets ? 'compiled-studio-assets' : 'registered-inventory',
    poseCount: pack.poses.length, artworkFileCount: pack.files.filter(file => file.kind === 'artwork').length,
    fullCharacterAlpha: false, separateBodyHairBackground: false, continuousHeadTurn: false,
    poses: pack.poses.map(pose => ({id: pose.id, label: pose.label, family: pose.family,
      eyeStages: pose.states.eyeLeft.length, jawStages: pose.states.mouth.filter(state => ['neutral', 'parted', 'openSmall', 'openMedium', 'openWide'].includes(state.id)).length,
      specialMouths: pose.states.mouth.filter(state => ['pucker', 'press', 'shiftLeft', 'shiftRight'].includes(state.id)).map(state => state.id),
      browStates: pose.states.browLeft.map(state => state.id), viewports: clone(pose.viewports), gaps: [...pose.gaps],
      baseStatus: pose.approval.base.status, extensionStatus: pose.approval.extension?.status || null})),
    limitations: ['五官来自实际画稿；五档不是连续变形。', '身体、头发和背景仍画在同一底图，不能直接导出干净透明角色。',
      '噘嘴与左右移嘴没有复合画稿，抿嘴为整嘴近似。', '正面眉头与眉尾抬起仍共用整眉稿。', '候选稿保持候选状态；登记或测试通过不新增用户批准。']};
}
async function bytesAt(readBytes, path) {
  validateCharacterPackPath(path);
  let value;
  try { value = await readBytes(path); } catch (error) { fail(path, `文件缺失或无法读取（${error?.message || error}）。`); }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail(path, '读取器必须返回文件字节。');
}
async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) fail('SHA256', '此环境无法执行内容完整性核验。');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function parseDocument(bytes, path) {
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { fail(path, '不是有效的 UTF-8 JSON 文档。'); }
}
/** Sequential reads bound memory usage. Metadata is always verified; artwork
 * verification is opt-in for the browser because it rereads the full portraits. */
export async function verifyShortHairCharacterPackFiles(pack, {readBytes, verifyArtwork = true} = {}) {
  validateShortHairCharacterPack(pack);
  if (typeof readBytes !== 'function') fail('readBytes', '需要明确的文件读取器。');
  const documents = new Map(); let verifiedFiles = 0, verifiedArtwork = 0;
  for (const file of pack.files) {
    if (file.kind === 'artwork' && !verifyArtwork) continue;
    const bytes = await bytesAt(readBytes, file.path);
    if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) fail(file.path, '文件内容已漂移，长度或 SHA256 与登记不一致。');
    if (file.kind !== 'artwork') documents.set(file.path, parseDocument(bytes, file.path));
    else verifiedArtwork += 1;
    verifiedFiles += 1;
  }
  const summary = compileShortHairCharacterPack(pack, documents);
  return {summary, verification: {verifiedFiles, verifiedArtwork, artworkBytesVerified: verifyArtwork, metadataVerified: true}};
}

export async function loadShortHairCharacterPack({fetcher = globalThis.fetch, verifyArtwork = false} = {}) {
  if (typeof fetcher !== 'function') fail('fetch', '没有可用的本地文件加载器。');
  const readBytes = async path => {
    const response = await fetcher(path, {cache: 'no-store', redirect: 'error'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  };
  const pack = validateShortHairCharacterPack(parseDocument(await bytesAt(readBytes, SHORT_HAIR_CHARACTER_PACK_URL), SHORT_HAIR_CHARACTER_PACK_URL));
  const result = await verifyShortHairCharacterPackFiles(pack, {readBytes, verifyArtwork});
  return {pack, ...result};
}

/** Maintenance helper: reads existing selected manifests and their files, never
 * rewrites source art/approval data. Callers explicitly choose where to save. */
export async function buildShortHairCharacterPack({readBytes} = {}) {
  if (typeof readBytes !== 'function') fail('readBytes', '需要明确的文件读取器。');
  const documents = new Map(), files = new Map();
  async function register(path, kind) {
    validateCharacterPackPath(path);
    if (files.has(path)) { if (files.get(path).kind !== kind) fail(path, '文件角色冲突。'); return; }
    const bytes = await bytesAt(readBytes, path);
    files.set(path, {path, kind, bytes: bytes.byteLength, sha256: await sha256(bytes)});
    if (kind !== 'artwork') documents.set(path, parseDocument(bytes, path));
  }
  for (const path of Object.values(MANIFESTS)) await register(path, 'manifest');
  await register(DESIGN_APPROVAL, 'approval');
  const manifests = sourceDocuments(documents);
  for (const manifest of Object.values(manifests)) {
    for (const field of ['approval', 'provenance']) if (manifest[field]) await register(manifest[field], field);
    for (const source of Object.values(manifest.sources)) await register(source.src, 'artwork');
  }
  const pack = {schemaVersion: 1, characterId: 'short-hair-v1', kind: 'existing-painted-character-inventory', artBaseline: '0.15.0',
    coordinateSystem: 'native-1122x1402-character-left-right', layers: {...LAYERS}, missingCapabilities: [...MISSING],
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), poses: POSES.map(pose => poseFromDocuments(pose, manifests, documents))};
  compileShortHairCharacterPack(pack, documents);
  return pack;
}
