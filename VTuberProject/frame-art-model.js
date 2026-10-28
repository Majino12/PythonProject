import {selectSideBrowExpression, sanitizeSideBrowChannels} from './side-brow-model.js';

export const FRAME_EYE_STATES = Object.freeze(['open', 'quarter', 'half', 'threeQuarter', 'closed']);
export const FRAME_JAW_STATES = Object.freeze(['neutral', 'parted', 'openSmall', 'openMedium', 'openWide']);
export const LEGACY_EYE_STATES = Object.freeze(['open', 'half', 'closed']);
export const LEGACY_JAW_STATES = Object.freeze(['neutral', 'openSmall', 'openWide']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function staged(value, previous, states, boundaries) {
  let index = states.indexOf(previous);
  if (index < 0) return states[boundaries.filter(boundary => value >= boundary).length];
  while (index < boundaries.length && value > boundaries[index] + .025) index += 1;
  while (index > 0 && value < boundaries[index - 1] - .025) index -= 1;
  return states[index];
}

/** Add only the explicitly prepared intermediate eye and jaw paintings. The
 * frozen side selector retains its mouth-action priority and independent brows.
 * Without a complete extension, its original three-stage result is unchanged. */
export function selectFrameArtExpression(channels, previous = {}, available = {}) {
  const state = selectSideBrowExpression(channels, previous, available);
  const old = object(previous) ? previous : {}, c = sanitizeSideBrowChannels(channels);
  if (available.extendedEyes === true) {
    state.eyeLeft = staged(c.eyeBlinkLeft, old.eyeLeft, FRAME_EYE_STATES, [.125, .375, .625, .875]);
    state.eyeRight = staged(c.eyeBlinkRight, old.eyeRight, FRAME_EYE_STATES, [.125, .375, .625, .875]);
  }
  if (available.extendedJaw === true && c.mouthClose < .6 && LEGACY_JAW_STATES.includes(state.mouth)) {
    state.mouth = staged(c.jawOpen, old.mouth, FRAME_JAW_STATES, [.09, .29, .54, .815]);
  }
  return state;
}
