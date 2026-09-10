const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const safeNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};
const average = (...values) => values.reduce((sum, value) => sum + safeNumber(value), 0) / values.length;
const mix = (a, b, amount) => a + (b - a) * amount;
const finitePoint = (point) => Boolean(point) && Number.isFinite(point.x) && Number.isFinite(point.y)
  && (point.z === undefined || Number.isFinite(point.z));

function score(blends, name) {
  return clamp(safeNumber(blends[name]));
}

function scoresFromResult(result) {
  const categories = result?.faceBlendshapes?.[0]?.categories || [];
  return Object.fromEntries(categories.map(({ categoryName, score: value }) => [categoryName, value]));
}

function landmarkHeadPose(landmarks) {
  const screenLeftEye = landmarks[33];
  const screenRightEye = landmarks[263];
  const nose = landmarks[1];
  const leftCheek = landmarks[234];
  const rightCheek = landmarks[454];
  if (![screenLeftEye, screenRightEye, nose, leftCheek, rightCheek].every(finitePoint)) return null;
  const eyeMidX = (screenLeftEye.x + screenRightEye.x) / 2;
  const eyeMidY = (screenLeftEye.y + screenRightEye.y) / 2;
  const rawEyeDistance = Math.hypot(screenRightEye.x - screenLeftEye.x, screenRightEye.y - screenLeftEye.y);
  if (!Number.isFinite(rawEyeDistance) || rawEyeDistance < 1e-4) return null;
  const eyeDistance = rawEyeDistance;
  const faceMidX = (leftCheek.x + rightCheek.x) / 2;
  const faceWidth = Math.hypot(rightCheek.x - leftCheek.x, rightCheek.y - leftCheek.y);
  if (!Number.isFinite(faceWidth) || faceWidth < 1e-4) return null;
  const eyeYaw = (nose.x - eyeMidX) / eyeDistance * 2.3;
  const cheekYaw = (nose.x - faceMidX) / faceWidth * 5.2;
  return {
    // tanh preserves direction changes all the way into profile view instead of
    // hitting a hard clamp early and making the avatar appear to stop turning.
    x: Math.tanh((eyeYaw * .38 + cheekYaw * .62) * .9),
    y: clamp((nose.y - eyeMidY) / eyeDistance * 2.8 - 1.05, -1, 1),
    roll: clamp(Math.atan2(screenRightEye.y - screenLeftEye.y, screenRightEye.x - screenLeftEye.x) / .48, -1, 1),
  };
}

function matrixHeadPose(result, fallback) {
  const matrix = result?.facialTransformationMatrixes?.[0];
  const data = matrix?.data || matrix;
  if (!data || data.length < 16) return null;
  if (![0, 1, 2, 4, 5, 6, 8, 9, 10].every((index) => Number.isFinite(Number(data[index])))) return null;
  const sx = Math.hypot(data[0], data[1], data[2]);
  const sy = Math.hypot(data[4], data[5], data[6]);
  const sz = Math.hypot(data[8], data[9], data[10]);
  if (Math.min(sx, sy, sz) < 1e-6) return null;
  const xAxis = [data[0] / sx, data[1] / sx, data[2] / sx];
  const yAxis = [data[4] / sy, data[5] / sy, data[6] / sy];
  const zAxis = [data[8] / sz, data[9] / sz, data[10] / sz];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const determinant = xAxis[0] * (yAxis[1] * zAxis[2] - yAxis[2] * zAxis[1])
    - xAxis[1] * (yAxis[0] * zAxis[2] - yAxis[2] * zAxis[0])
    + xAxis[2] * (yAxis[0] * zAxis[1] - yAxis[1] * zAxis[0]);
  if (Math.max(Math.abs(dot(xAxis, yAxis)), Math.abs(dot(xAxis, zAxis)), Math.abs(dot(yAxis, zAxis))) > .35
    || Math.abs(determinant) < .4) return null;
  const yaw = Math.atan2(data[8] / sz, data[10] / sz);
  const pitch = Math.asin(clamp(-(data[9] / sz), -1, 1));
  const roll = Math.atan2(data[1] / sx, data[5] / sy);
  const orientLikeFallback = (value, reference) => {
    if (Math.abs(reference) < .035 || Math.abs(value) < .015) return value;
    return Math.abs(value) * Math.sign(reference);
  };
  return {
    x: clamp(orientLikeFallback(yaw / 1.13, fallback.x), -1, 1),
    y: clamp(orientLikeFallback(pitch / .7, fallback.y), -1, 1),
    roll: clamp(orientLikeFallback(roll / .62, fallback.roll), -1, 1),
  };
}

function stabilizePair(left, right, sideAmount) {
  const amount = clamp((Math.abs(sideAmount) - .42) / .5) * .58;
  const center = (left + right) / 2;
  return [mix(left, center, amount), mix(right, center, amount)];
}

export function extractFaceMotion(result) {
  const landmarks = result?.faceLandmarks?.[0];
  if (!landmarks) return null;
  const landmarkPose = landmarkHeadPose(landmarks);
  if (!landmarkPose) return null;
  const matrixPose = matrixHeadPose(result, landmarkPose);
  const pose = matrixPose ? {
    x: clamp(matrixPose.x * .78 + landmarkPose.x * .22, -1, 1),
    y: clamp(matrixPose.y * .72 + landmarkPose.y * .28, -1, 1),
    roll: clamp(matrixPose.roll * .72 + landmarkPose.roll * .28, -1, 1),
  } : landmarkPose;
  const blends = scoresFromResult(result);
  let [blinkL, blinkR] = stabilizePair(score(blends, "eyeBlinkLeft"), score(blends, "eyeBlinkRight"), pose.x);
  let [eyeWideL, eyeWideR] = stabilizePair(score(blends, "eyeWideLeft"), score(blends, "eyeWideRight"), pose.x);
  let [browDownL, browDownR] = stabilizePair(score(blends, "browDownLeft"), score(blends, "browDownRight"), pose.x);
  const squintL = score(blends, "eyeSquintLeft");
  const squintR = score(blends, "eyeSquintRight");
  eyeWideL = clamp(eyeWideL - squintL * .35);
  eyeWideR = clamp(eyeWideR - squintR * .35);
  blinkL = clamp(blinkL + squintL * .12);
  blinkR = clamp(blinkR + squintR * .12);
  const lookX = clamp(average(score(blends, "eyeLookOutLeft"), score(blends, "eyeLookInRight"))
    - average(score(blends, "eyeLookInLeft"), score(blends, "eyeLookOutRight")), -1, 1);
  const lookY = clamp(average(score(blends, "eyeLookUpLeft"), score(blends, "eyeLookUpRight"))
    - average(score(blends, "eyeLookDownLeft"), score(blends, "eyeLookDownRight")), -1, 1);
  const smile = average(score(blends, "mouthSmileLeft"), score(blends, "mouthSmileRight"));
  const frown = average(score(blends, "mouthFrownLeft"), score(blends, "mouthFrownRight"));
  const expressions = {
    blinkL,
    blinkR,
    eyeWideL,
    eyeWideR,
    lookX,
    lookY,
    mouth: clamp(score(blends, "jawOpen") * 1.22),
    mouthX: clamp(score(blends, "mouthRight") - score(blends, "mouthLeft"), -1, 1),
    smile,
    frown,
    pucker: Math.max(score(blends, "mouthPucker"), score(blends, "mouthFunnel") * .82),
    browUp: Math.max(score(blends, "browInnerUp"), average(score(blends, "browOuterUpLeft"), score(blends, "browOuterUpRight")) * .72),
    browDownL,
    browDownR,
    cheek: Math.max(score(blends, "cheekPuff"), average(squintL, squintR) * .55),
  };
  return { pose, expressions };
}

export function normalizeExpressions(raw, neutral = {}) {
  const signed = new Set(["lookX", "lookY", "mouthX"]);
  const gain = {
    blinkL: 1.45, blinkR: 1.45, eyeWideL: 1.55, eyeWideR: 1.55,
    mouth: 1.28, smile: 1.38, frown: 1.45, pucker: 1.35,
    browUp: 1.42, browDownL: 1.45, browDownR: 1.45, cheek: 1.35,
  };
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    const centered = safeNumber(value) - safeNumber(neutral[key]);
    if (signed.has(key)) return [key, clamp(centered * 1.3, -1, 1)];
    return [key, clamp(centered * (gain[key] || 1))];
  }));
}

function visible(point, threshold = .32) {
  return finitePoint(point) && (point.visibility ?? 1) >= threshold && (point.presence ?? 1) >= threshold;
}

function elbowFlex(shoulder, elbow, wrist) {
  const a = { x: shoulder.x - elbow.x, y: shoulder.y - elbow.y, z: (shoulder.z || 0) - (elbow.z || 0) };
  const b = { x: wrist.x - elbow.x, y: wrist.y - elbow.y, z: (wrist.z || 0) - (elbow.z || 0) };
  const la = Math.hypot(a.x, a.y, a.z) || 1;
  const lb = Math.hypot(b.x, b.y, b.z) || 1;
  const angle = Math.acos(clamp((a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb), -1, 1));
  return clamp((Math.PI - angle) / 2.35);
}

function upperArmAngle(shoulder, elbow, side) {
  const dx = elbow.x - shoulder.x;
  const dy = elbow.y - shoulder.y;
  return Math.atan2(side * dx, dy);
}

function elbowDirection(shoulder, elbow, wrist, side, previous = 1) {
  const upperX = elbow.x - shoulder.x;
  const upperY = elbow.y - shoulder.y;
  const foreX = wrist.x - elbow.x;
  const foreY = wrist.y - elbow.y;
  const turn = (upperX * foreY - upperY * foreX)
    / (Math.hypot(upperX, upperY) * Math.hypot(foreX, foreY) + 1e-6);
  if (Math.abs(turn) < .06) return previous || 1;
  return Math.sign(side * turn) || previous || 1;
}

export function extractPoseMotion(result, neutral = {}, history = {}) {
  const landmarks = result?.landmarks?.[0];
  if (!landmarks) return null;
  const world = result?.worldLandmarks?.[0] || landmarks;
  const joint = (index) => finitePoint(world[index]) ? world[index] : landmarks[index];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  if (!visible(leftShoulder, .36) || !visible(rightShoulder, .36)) return null;
  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const shoulderX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderWidth = Math.max(.07, Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y));
  const lean = clamp(Math.atan2(rightShoulder.y - leftShoulder.y, Math.abs(rightShoulder.x - leftShoulder.x)) / .38, -1, 1);
  const worldLeftShoulder = joint(11);
  const worldRightShoulder = joint(12);
  const worldShoulderWidth = Math.max(.08, Math.hypot(
    worldRightShoulder.x - worldLeftShoulder.x,
    worldRightShoulder.y - worldLeftShoulder.y,
    (worldRightShoulder.z || 0) - (worldLeftShoulder.z || 0),
  ));
  const bodyTurn = clamp(((worldRightShoulder.z || 0) - (worldLeftShoulder.z || 0)) / worldShoulderWidth * 1.45, -1, 1);
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  const hipsVisible = visible(leftHip, .3) && visible(rightHip, .3);
  const hipX = hipsVisible ? (leftHip.x + rightHip.x) / 2 : shoulderX;
  const hipSway = clamp((hipX - shoulderX) / shoulderWidth * 1.3, -1, 1);
  const raw = { shoulderY, lean, bodyTurn, hipSway };
  const motion = {
    bodyLean: clamp(lean - (neutral.lean || 0), -1, 1),
    bodyBob: clamp(((neutral.shoulderY ?? shoulderY) - shoulderY) * 5.2, -1, 1),
    bodyTurn: clamp(bodyTurn - (neutral.bodyTurn || 0), -1, 1),
    hipSway: clamp(hipSway - (neutral.hipSway || 0), -1, 1),
  };

  for (const [suffix, shoulderIndex, elbowIndex, wristIndex] of [["L", 11, 13, 15], ["R", 12, 14, 16]]) {
    const side = suffix === "L" ? 1 : -1;
    const shoulder = landmarks[shoulderIndex];
    const elbow = landmarks[elbowIndex];
    const wrist = landmarks[wristIndex];
    if (!visible(elbow) || !visible(wrist)) continue;
    const angle = upperArmAngle(shoulder, elbow, side);
    raw[`arm${suffix}`] = angle;
    const neutralAngle = Number.isFinite(neutral[`arm${suffix}`]) ? neutral[`arm${suffix}`] : 0;
    const deltaAngle = angle - neutralAngle;
    motion[`arm${suffix}`] = Math.acos(clamp(Math.cos(deltaAngle), -1, 1)) / Math.PI;
    motion[`armSin${suffix}`] = Math.sin(deltaAngle);
    motion[`armCos${suffix}`] = Math.cos(deltaAngle);

    const worldShoulder = joint(shoulderIndex);
    const worldElbow = joint(elbowIndex);
    const worldWrist = joint(wristIndex);
    const bend = elbowFlex(worldShoulder, worldElbow, worldWrist);
    const directionKey = `elbowDirection${suffix}`;
    const direction = bend > .05
      ? elbowDirection(shoulder, elbow, wrist, side, history[directionKey])
      : history[directionKey] || 1;
    history[directionKey] = direction;
    motion[`elbow${suffix}`] = bend;
    motion[`elbowSide${suffix}`] = direction;
    const upperLength = Math.max(.06, Math.hypot(
      worldElbow.x - worldShoulder.x,
      worldElbow.y - worldShoulder.y,
      (worldElbow.z || 0) - (worldShoulder.z || 0),
    ));
    motion[`armDepth${suffix}`] = clamp(((worldShoulder.z || 0) - (worldElbow.z || 0)) / upperLength * 1.05, -1, 1);
  }

  if (hipsVisible) {
    const torsoHeight = Math.max(.1, ((leftHip.y + rightHip.y) / 2) - shoulderY);
    for (const [suffix, hipIndex, kneeIndex] of [["L", 23, 25], ["R", 24, 26]]) {
      const hip = landmarks[hipIndex];
      const knee = landmarks[kneeIndex];
      if (!visible(knee, .35)) continue;
      motion[`leg${suffix}`] = clamp((hip.y + torsoHeight * .92 - knee.y) / (torsoHeight * .75), 0, 1);
    }
  }
  return { raw, motion };
}
