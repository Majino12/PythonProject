import {loadExpressionAssets, drawExpression} from './expression-renderer.js';
import {selectExpression, selectGaze} from './expression-model.js';
import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';
import {selectSideGaze} from './side-gaze.js';
import {selectFrameArtExpression, FRAME_EYE_STATES, FRAME_JAW_STATES, LEGACY_EYE_STATES, LEGACY_JAW_STATES} from './frame-art-model.js';
import {loadFrameArtManifest, extendFrameArtAssets} from './frame-art-renderer.js';

const POSES = Object.freeze([
  {id: 'view-left-up', shortLabel: '左上', sourceFamily: 'pitch'},
  {id: 'view-up', shortLabel: '抬头', sourceFamily: 'complete'},
  {id: 'view-right-up', shortLabel: '右上', sourceFamily: 'pitch'},
  {id: 'view-left', shortLabel: '左转', sourceFamily: 'side'},
  {id: 'front', shortLabel: '正面', sourceFamily: 'front'},
  {id: 'view-right', shortLabel: '右转', sourceFamily: 'side'},
  {id: 'view-left-down', shortLabel: '左下', sourceFamily: 'pitch'},
  {id: 'view-down', shortLabel: '低头', sourceFamily: 'complete'},
  {id: 'view-right-down', shortLabel: '右下', sourceFamily: 'complete'},
].map(Object.freeze));
const own = (object, key) => object !== null && typeof object === 'object' && Object.hasOwn(object, key);

function retainReferences(assets) {
  const references = assets.manifest.poses ? Object.values(assets.manifest.poses).map(pose => pose.reference) : [assets.manifest.reference];
  // All expression pixels have already been copied to native local canvases
  // and gaze layers. Runtime drawing only needs the neutral full portraits.
  // Keep this optimization local to the studio; review loaders retain sources
  // for source inspection and asset diagnostics.
  return {...assets, images: Object.fromEntries(references.map(id => [id, assets.images[id]]))};
}

/** One set of prepared paintings serves both interactive previews and exports.
 * This loader never opens a camera or silently substitutes an older character.
 * A missing family is an explicit load error, not a partly functional studio. */
export async function loadShortHairStudioAssets() {
  // Compile one family at a time so over a hundred full-size decoded portraits
  // are not simultaneously retained while all four families are being built.
  const front = retainReferences(await loadExpressionAssets({variant: 'candidate'}));
  const extension = await loadFrameArtManifest();
  const side = retainReferences(await extendFrameArtAssets(await loadSideExpressionAssets('brows'), extension, 'side'));
  const pitch = retainReferences(await extendFrameArtAssets(await loadSideExpressionAssets('pitchBrows'), extension, 'pitch'));
  const complete = retainReferences(await extendFrameArtAssets(await loadSideExpressionAssets('completePitch'), extension, 'complete'));
  const assets = {front, side, pitch, complete};
  const poses = POSES.map(pose => {
    const manifest = assets[pose.sourceFamily].manifest;
    const record = pose.id === 'front' ? manifest : manifest.poses[pose.id];
    if (!record) throw new Error(`短发角色缺少 ${pose.id} 的独立画稿。`);
    return Object.freeze({...pose, label: pose.id === 'front' ? '正面' : record.label,
      assetStatus: manifest.status, assetId: manifest.id});
  });
  return {...assets, poses: Object.freeze(poses)};
}

function poseContext(assets, poseId) {
  const descriptor = POSES.find(pose => pose.id === poseId);
  if (!descriptor || !own(assets, descriptor.sourceFamily)) throw new Error('未知或尚未加载的短发角色姿态。');
  const source = assets[descriptor.sourceFamily];
  if (!source?.manifest || (poseId !== 'front' && !own(source.manifest.poses, poseId))) throw new Error('短发角色姿态缺少对应画稿。');
  const front = poseId === 'front';
  return {source, front, record: front ? source.manifest : source.manifest.poses[poseId],
    compiled: front ? source.compiled : source.compiled?.[poseId]};
}

/** Only actual registered and compiled paintings may enter a playback sequence. */
export function getStudioPaintStates(assets, poseId) {
  const {record, compiled} = poseContext(assets, poseId);
  const painted = (group, state) => own(record.patches?.[group], state) && own(compiled?.[group], state);
  if (!['eyeLeft', 'eyeRight'].every(group => ['half', 'closed'].every(state => painted(group, state)))
    || !['openSmall', 'openWide'].every(state => painted('mouth', state))) throw new Error('姿态缺少已编译的基础眼口画稿。');
  const eyes = ['eyeLeft', 'eyeRight'].every(group => ['quarter', 'threeQuarter'].every(state => painted(group, state)))
    ? FRAME_EYE_STATES : LEGACY_EYE_STATES;
  const mouth = ['parted', 'openMedium'].every(state => painted('mouth', state)) ? FRAME_JAW_STATES : LEGACY_JAW_STATES;
  return {eyes: [...eyes], mouth: [...mouth]};
}

export function selectShortHairStudioState(assets, poseId, channels, previousTargetState = {}) {
  const {source, front} = poseContext(assets, poseId), sequences = getStudioPaintStates(assets, poseId);
  const available = {...(front ? source.available : {mouthArt: Boolean(source.manifest.mouthArt), browArt: Boolean(source.manifest.browArt), gaze: Boolean(source.gazeLayers)}),
    extendedEyes: sequences.eyes.length === 5, extendedJaw: sequences.mouth.length === 5};
  const select = front ? selectExpression : selectFrameArtExpression;
  const look = front ? selectGaze : selectSideGaze;
  return {targetState: select(channels, previousTargetState, available), targetGaze: look(channels, available),
    availableSequences: {eyeLeft: [...sequences.eyes], eyeRight: [...sequences.eyes], mouth: [...sequences.mouth]}};
}

function validatedDisplayState(override, target, record, compiled) {
  if (!override || typeof override !== 'object' || Array.isArray(override)
    || Object.keys(override).length !== Object.keys(target).length) throw new Error('显示状态必须完整指定当前角色的五官。');
  const result = {};
  for (const group of Object.keys(target)) {
    const state = own(override, group) ? override[group] : null;
    const neutral = group.startsWith('eye') ? 'open' : 'neutral';
    if (state !== neutral && !(own(record.patches?.[group], state) && own(compiled?.[group], state))) {
      throw new Error(`${group} 的 ${String(state)} 没有此姿态的实际画稿。`);
    }
    result[group] = state;
  }
  return result;
}

/** Selection and drawing remain separate: a display sequence can visit real
 * intermediate paintings without changing coefficient targets or their hysteresis.
 * Head poses and painting pixels remain discrete; no alpha/geometry morphing. */
export function renderShortHairStudio(canvas, assets, poseId, channels, previousState = {}, options = {}) {
  const {source, front, record, compiled} = poseContext(assets, poseId);
  const selected = selectShortHairStudioState(assets, poseId, channels, previousState);
  const {targetState, targetGaze} = selected;
  const neutral = options.original ? selectShortHairStudioState(assets, poseId, {}, {}) : null;
  const state = options.original ? neutral.targetState : own(options, 'stateOverride')
    ? validatedDisplayState(options.stateOverride, targetState, record, compiled) : targetState;
  const gaze = options.original ? neutral.targetGaze : targetGaze;
  const renderOptions = {faceOnly: true, ...options, gaze};
  if (front) drawExpression(canvas, source, state, renderOptions);
  else drawSideExpression(canvas, source, poseId, state, renderOptions);
  return {state, gaze, targetState, targetGaze, availableSequences: selected.availableSequences, didDraw: true};
}
