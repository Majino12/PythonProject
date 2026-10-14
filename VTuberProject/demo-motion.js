const TAU = Math.PI * 2;
const BLINK_PERIOD = 16;
const BLINK_CENTERS = [1.3, 5.1, 9.7, 13.3];

// A periodic Gaussian has no timer state or discontinuity at the loop seam.
// These four blinks are 3.6–4.6 seconds apart and visible for about 150 ms.
function blinkAt(t, delay = 0) {
  let open = 1;
  for (const center of BLINK_CENTERS) {
    const distance = Math.sin(Math.PI * (t - center - delay) / BLINK_PERIOD);
    const width = Math.PI * .03 / BLINK_PERIOD;
    open *= 1 - Math.exp(-.5 * (distance / width) ** 2);
  }
  return 1 - open;
}

const lobe = (angle) => Math.max(0, Math.sin(angle)) ** 2;

/**
 * Deterministic, normalized tracking channels for a calm presentation preview.
 * Times are milliseconds; callers can smooth a mode change just like tracking.
 * This is an idle/demo animation, not an attempt to synchronize speech to audio.
 */
export function createDemoMotion(nowMs, mode = "idle") {
  const t = Number.isFinite(nowMs) ? nowMs / 1000 : 0;
  const greeting = mode === "greeting";
  const speaking = mode === "speaking";
  const breath = Math.sin(TAU * t / 4.6);
  const shift = Math.sin(t * .23 + .7);
  // One short greeting every nine seconds, eased to almost motionless rest.
  const wave = greeting ? ((1 + Math.cos(TAU * (t - 2.6) / 9)) / 2) ** 8 : 0;
  const waveBeat = Math.sin(t * 7.6);
  const phrase = speaking ? lobe(TAU * t / 6.6 + .7) : 0;
  const syllable = .7 * lobe(t * 14.3) + .3 * lobe(t * 21.1 + .9);
  const mouth = phrase * (.04 + syllable * .53);
  const smile = .22 + Math.sin(t * .27 + .3) * .055 + wave * .1 + phrase * .07;
  const angleL = .105 + .012 * Math.sin(t * .47) + wave * (.78 + .06 * waveBeat);
  const angleR = .10 + .012 * Math.sin(t * .43 + 1.2) + phrase * .045;

  return {
    x: .105 * Math.sin(t * .31) + .055 * Math.sin(t * .13 + .9) - wave * .035,
    y: .035 * Math.sin(t * .37 + .8) + phrase * .018 * Math.sin(t * 1.4),
    roll: .025 * Math.sin(t * .29 + .4) - wave * .035,
    blinkL: blinkAt(t),
    blinkR: blinkAt(t, .011),
    eyeWideL: wave * .045,
    eyeWideR: wave * .045,
    lookX: .12 * Math.sin(t * .61 + .3) + .065 * Math.sin(t * .19 + 1.1),
    lookY: .045 * Math.sin(t * .41 + 1.3),
    mouth,
    mouthX: phrase * .018 * Math.sin(t * 1.2),
    smile,
    frown: 0,
    pucker: mouth * .11 * lobe(t * 9.1 + .4),
    browUp: .02 + wave * .07 + phrase * .055,
    browDownL: 0,
    browDownR: 0,
    cheek: smile * .24,
    bodyLean: shift * .025 - wave * .025,
    bodyBob: breath * .018,
    bodyTurn: .035 * Math.sin(t * .23 + .2) - wave * .035,
    hipSway: .018 * Math.sin(t * .23 - .1),
    armL: angleL / Math.PI,
    armR: angleR / Math.PI,
    elbowL: .09 + breath * .006 + wave * (.45 + .1 * waveBeat),
    elbowR: .085 - breath * .006 + phrase * .065,
    // Greeting bends the forearm up toward the head. Keep its direction fixed
    // within the mode; the caller smooths direction when changing modes.
    elbowSideL: greeting ? -1 : 1,
    elbowSideR: 1,
    armSinL: Math.sin(angleL),
    armSinR: Math.sin(angleR),
    armCosL: Math.cos(angleL),
    armCosR: Math.cos(angleR),
    armDepthL: .025 + wave * (.1 + .018 * Math.cos(t * 7.6)),
    armDepthR: .025 + phrase * .025,
    legL: 0,
    legR: 0,
  };
}
