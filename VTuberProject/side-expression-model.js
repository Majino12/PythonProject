/** Finite painted expressions for either registered side pose. Anatomical
 * Left / Right remain the character's sides, independent of the selected pose.
 * This module does not rotate a head, move gaze, or synthesize artwork. */
export const SIDE_CHANNELS = Object.freeze([
  {key: 'eyeBlinkLeft', group: 'eyes', groupLabel: '眼睛', label: '角色左眼闭合'},
  {key: 'eyeBlinkRight', group: 'eyes', groupLabel: '眼睛', label: '角色右眼闭合'},
  {key: 'jawOpen', group: 'mouth', groupLabel: '嘴部', label: '张嘴'},
  {key: 'mouthClose', group: 'mouth', groupLabel: '嘴部', label: '闭合嘴巴'},
].map(Object.freeze));

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Unknown, inherited, string, and non-finite coefficients are not consumed. */
export function sanitizeSideChannels(input) {
  const source = object(input) ? input : {};
  return Object.fromEntries(SIDE_CHANNELS.map(({key}) => [key, Object.hasOwn(source, key) ? bounded(source[key]) : 0]));
}

function staged(value, previous, states, boundaries, margin) {
  let index = states.indexOf(previous);
  if (index < 0) return states[boundaries.filter(boundary => value >= boundary).length];
  while (index < boundaries.length && value > boundaries[index] + margin) index += 1;
  while (index > 0 && value < boundaries[index - 1] - margin) index -= 1;
  return states[index];
}

/** Select only the three authored eye / jaw states. Hysteresis prevents tiny
 * coefficient changes from flickering between drawings. mouthClose >= .6
 * overrides jawOpen, selecting the exact neutral mouth in the approved pose. */
export function selectSideExpression(channels, previous = {}) {
  const c = sanitizeSideChannels(channels), old = object(previous) ? previous : {};
  const eyes = ['open', 'half', 'closed'];
  return {
    eyeLeft: staged(c.eyeBlinkLeft, old.eyeLeft, eyes, [.3, .8], .04),
    eyeRight: staged(c.eyeBlinkRight, old.eyeRight, eyes, [.3, .8], .04),
    mouth: c.mouthClose >= .6 ? 'neutral' : staged(c.jawOpen, old.mouth, ['neutral', 'openSmall', 'openWide'], [.15, .65], .03),
  };
}

/** Ten seconds of held poses, deliberately slow enough to inspect individual
 * drawings. The selected head pose never changes and no camera is used. */
export const SIDE_DEMO = Object.freeze({
  duration: 10,
  steps: Object.freeze([
    {start: 0, end: 1, id: 'neutral', label: '中性', channels: {}},
    {start: 1, end: 2, id: 'halfBlink', label: '半闭眼', channels: {eyeBlinkLeft: .5, eyeBlinkRight: .5}},
    {start: 2, end: 3, id: 'blink', label: '闭眼', channels: {eyeBlinkLeft: 1, eyeBlinkRight: 1}},
    {start: 3, end: 4, id: 'openSmall', label: '小幅张嘴', channels: {jawOpen: .4}},
    {start: 4, end: 5, id: 'openWide', label: '大幅张嘴', channels: {jawOpen: .95}},
    {start: 5, end: 6, id: 'mouthClose', label: '张嘴信号下闭合嘴巴', channels: {jawOpen: .95, mouthClose: 1}},
    {start: 6, end: 7, id: 'winkLeft', label: '角色左眼闭合', channels: {eyeBlinkLeft: 1}},
    {start: 7, end: 8, id: 'winkRight', label: '角色右眼闭合', channels: {eyeBlinkRight: 1}},
    {start: 8, end: 9, id: 'combination', label: '半闭眼、小幅张嘴', channels: {eyeBlinkLeft: .5, eyeBlinkRight: .5, jawOpen: .4}},
    {start: 9, end: 10, id: 'rest', label: '回到中性', channels: {}},
  ].map(step => Object.freeze({...step, channels: Object.freeze(sanitizeSideChannels(step.channels))}))),
});

export function sampleSideDemo(seconds) {
  const phase = (Number.isFinite(seconds) ? Math.max(0, seconds) : 0) % SIDE_DEMO.duration;
  const step = SIDE_DEMO.steps.find(({start, end}) => phase >= start && phase < end);
  return {...step.channels};
}
