import {STUDIO_HEAD_POSES,validateHeadPose} from './short-hair-pose-motion.js';

const byCoordinate = (yaw,pitch) => STUDIO_HEAD_POSES.find(pose => pose.yaw === yaw && pose.pitch === pitch).id;

/** One consistently oriented grid for learned pairwise motion fields. Axis
 * edges run screen-left to screen-right or screen-top to screen-bottom.
 * Each of the four cells is split from its screen top-left to bottom-right. */
export const CONTINUOUS_EDGES = Object.freeze([
  ...[1,0,-1].flatMap(pitch => [-1,0].map(yaw =>
    ({from:byCoordinate(yaw,pitch),to:byCoordinate(yaw+1,pitch)}))),
  ...[-1,0,1].flatMap(yaw => [1,0].map(pitch =>
    ({from:byCoordinate(yaw,pitch),to:byCoordinate(yaw,pitch-1)}))),
  ...[1,0].flatMap(pitch => [-1,0].map(yaw =>
    ({from:byCoordinate(yaw,pitch),to:byCoordinate(yaw+1,pitch-1)}))),
].map(Object.freeze));

export const CONTINUOUS_FACE_VIEW = Object.freeze([200,270,780,600]);
export const CONTINUOUS_FULL_VIEW = Object.freeze([0,0,1122,1402]);

/** Weights are barycentric in head-coordinate space, not image alpha. The
 * renderer must compensate motion before combining weighted source samples.
 * Retaining zero weights makes the result a three-vertex tuple even on edges;
 * neighboring triangles give identical effective vertices on every seam. */
export function locateHeadTriangle(headPose) {
  const {yaw,pitch} = validateHeadPose(headPose);
  const left = yaw >= 0 ? 0 : -1, top = pitch >= 0 ? 1 : 0;
  const u = yaw - left, v = top - pitch;
  const tl = byCoordinate(left,top), br = byCoordinate(left+1,top-1);
  const vertices = u >= v
    ? [{poseId:tl,weight:1-u},{poseId:byCoordinate(left+1,top),weight:u-v},{poseId:br,weight:v}]
    : [{poseId:tl,weight:1-v},{poseId:byCoordinate(left,top-1),weight:v-u},{poseId:br,weight:u}];
  return {vertices};
}

/** Crop only after interpolation in the common 1122×1402 source coordinates.
 * A fixed view avoids the old face-crop jump, especially at right-down. */
export function continuousViewport(headPose, {faceOnly = true} = {}) {
  validateHeadPose(headPose);
  if (typeof faceOnly !== 'boolean') throw new TypeError('连续画面查看范围无效。');
  return [...(faceOnly ? CONTINUOUS_FACE_VIEW : CONTINUOUS_FULL_VIEW)];
}
