const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const rotation = (x = 0, y = 0, z = 0) => [x, y, z].map((value) => {
  const result = finite(value);
  return Object.is(result, -0) ? 0 : result;
});

function intensityValue(intensity, key, fallback) {
  return clamp(finite(intensity?.[key], fallback), 0, 1.5);
}

function solveArm(motion, suffix, side, bodyAmount) {
  const sine = finite(motion?.[`armSin${suffix}`]);
  const cosine = finite(motion?.[`armCos${suffix}`], 1);
  const trackedAngle = clamp(Math.atan2(sine, cosine), -.32, 2.72) * clamp(bodyAmount / .85, 0, 1.18);
  const depth = clamp(finite(motion?.[`armDepth${suffix}`]), -.7, .7) * bodyAmount;
  const bend = clamp(finite(motion?.[`elbow${suffix}`])) * clamp(bodyAmount / .85, 0, 1.12);
  const elbowDirection = clamp(finite(motion?.[`elbowSide${suffix}`], 1), -1, 1);

  // This asset's normalized left arm extends +X and its right arm -X in the
  // rest T-pose (the raw child translations confirm it). Therefore -Z lowers
  // the left arm and +Z lowers the right. Keep a small 11 degree opening so
  // forearms and hands remain visible beside the wide shirt and long hair.
  const relaxedDrop = 1.38;
  return {
    upper: rotation(-depth * .28, side * depth * .11, -side * relaxedDrop + side * trackedAngle),
    lower: rotation(-Math.abs(depth) * .09 - bend * .055, 0, -side * bend * elbowDirection * 1.56),
    hand: rotation(bend * .035, side * .035, -side * bend * elbowDirection * .055),
  };
}

function solveExpressions(motion, intensity) {
  const expressionAmount = intensityValue(intensity, "expression", 1);
  const blinkAmount = intensityValue(intensity, "blink", .85);
  const mouthAmount = intensityValue(intensity, "mouth", .9);
  const blinkLeft = clamp(finite(motion?.blinkL) * blinkAmount * 1.08);
  const blinkRight = clamp(finite(motion?.blinkR) * blinkAmount * 1.08);
  const mouthOpen = clamp(finite(motion?.mouth) * mouthAmount);
  const smile = clamp(finite(motion?.smile) * expressionAmount);
  const frown = clamp(finite(motion?.frown) * expressionAmount);
  const pucker = clamp(finite(motion?.pucker) * expressionAmount);
  const browUp = clamp(finite(motion?.browUp) * expressionAmount);
  const eyeWide = clamp(Math.max(finite(motion?.eyeWideL), finite(motion?.eyeWideR)) * expressionAmount);
  const browDown = clamp(Math.max(finite(motion?.browDownL), finite(motion?.browDownR)) * expressionAmount);

  // The bundled VRM uses blend overrides on its emotion presets. Keeping the
  // emotion weights modest preserves explicit blinks and vowel mouth shapes.
  const restingSmile = .055 * (1 - clamp(frown * 1.6 + browDown * .7));
  let happy = restingSmile + smile * .52;
  let sad = Math.max(frown * .48, browDown * frown * .24);
  let surprised = Math.max(eyeWide * .30, browUp * .22) * (1 - smile * .25);
  let angry = browDown * .20 * (1 - smile);
  const moodTotal = happy + sad + surprised + angry;
  if (moodTotal > .72) {
    const scale = .72 / moodTotal;
    happy *= scale;
    sad *= scale;
    surprised *= scale;
    angry *= scale;
  }
  const vowelBudget = clamp(1 - Math.max(happy, sad, surprised) * .45);
  const ou = clamp((pucker * .86 + mouthOpen * pucker * .18) * vowelBudget);
  const aa = clamp(mouthOpen * (1 - pucker * .82) * (1 - smile * .24) * vowelBudget);
  const ih = clamp(mouthOpen * smile * .18 * vowelBudget);

  return {
    blinkLeft,
    blinkRight,
    happy,
    sad,
    surprised,
    angry,
    relaxed: clamp(finite(motion?.cheek) * expressionAmount * .12),
    aa,
    ih,
    ou,
  };
}

/**
 * Convert MoeMotion's renderer-neutral flat motion bus into a VRM normalized
 * humanoid pose. The result is data-only so it can be tested without WebGL.
 */
export function solveStudioMotion(motion = {}, intensity = {}) {
  const headAmount = intensityValue(intensity, "head", .7);
  const bodyAmount = intensityValue(intensity, "body", .75);
  const yaw = clamp(finite(motion.x), -1, 1) * .62 * headAmount;
  const pitch = -clamp(finite(motion.y), -1, 1) * .25 * headAmount;
  const roll = -clamp(finite(motion.roll), -1, 1) * .20 * headAmount;
  const bodyTurn = clamp(finite(motion.bodyTurn), -1, 1) * bodyAmount;
  const bodyLean = clamp(finite(motion.bodyLean), -1, 1) * bodyAmount;
  const hipSway = clamp(finite(motion.hipSway), -1, 1) * bodyAmount;
  const bodyBob = clamp(finite(motion.bodyBob), -1, 1) * bodyAmount;
  const leftArm = solveArm(motion, "L", 1, bodyAmount);
  const rightArm = solveArm(motion, "R", -1, bodyAmount);

  return {
    // No root translation is emitted: feet remain planted while torso bones
    // absorb the tracked bob/lean/turn motion.
    bones: {
      hips: rotation(bodyBob * .018, -bodyTurn * .035, bodyLean * .024 + hipSway * .025),
      spine: rotation(bodyBob * -.018, bodyTurn * .055, -bodyLean * .035),
      chest: rotation(bodyBob * -.026, bodyTurn * .105, -bodyLean * .060),
      upperChest: rotation(bodyBob * -.018, bodyTurn * .075, -bodyLean * .038),
      neck: rotation(pitch * .18, yaw * .16, roll * .18),
      head: rotation(pitch * .82, yaw * .84, roll * .82),
      leftShoulder: rotation(0, 0, bodyLean * -.025),
      rightShoulder: rotation(0, 0, bodyLean * -.025),
      leftUpperArm: leftArm.upper,
      leftLowerArm: leftArm.lower,
      leftHand: leftArm.hand,
      rightUpperArm: rightArm.upper,
      rightLowerArm: rightArm.lower,
      rightHand: rightArm.hand,
    },
    expressions: solveExpressions(motion, intensity),
    look: {
      x: clamp(finite(motion.lookX), -1, 1),
      y: clamp(finite(motion.lookY), -1, 1),
    },
  };
}

