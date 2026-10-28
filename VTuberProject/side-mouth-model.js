import {SIDE_CHANNELS, selectSideExpression} from './side-expression-model.js';

export const SIDE_MOUTH_STATES = Object.freeze(['pucker', 'press', 'shiftLeft', 'shiftRight']);
export const SIDE_MOUTH_CHANNELS = Object.freeze([
  ...SIDE_CHANNELS,
  {key: 'mouthPucker', group: 'mouth', groupLabel: '嘴部', label: '噘嘴', mode: 'frame'},
  {key: 'mouthPressLeft', group: 'mouth', groupLabel: '嘴部', label: '角色左抿嘴（整嘴近似）', mode: 'approximate'},
  {key: 'mouthPressRight', group: 'mouth', groupLabel: '嘴部', label: '角色右抿嘴（整嘴近似）', mode: 'approximate'},
  {key: 'mouthLeft', group: 'mouth', groupLabel: '嘴部', label: '角色左移嘴（画面右）', mode: 'frame'},
  {key: 'mouthRight', group: 'mouth', groupLabel: '嘴部', label: '角色右移嘴（画面左）', mode: 'frame'},
].map(Object.freeze));

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const threshold = (previous, state, enter, leave) => previous === state ? leave : enter;

/** The nine painted-expression channels only; gaze remains independently mapped. */
export function sanitizeSideMouthChannels(input) {
  const source = object(input) ? input : {};
  return Object.fromEntries(SIDE_MOUTH_CHANNELS.map(({key}) => [key,
    Object.hasOwn(source, key) && Number.isFinite(source[key]) ? Math.max(0, Math.min(1, source[key])) : 0,
  ]));
}

/** Select whole painted mouth states, never interpolate or transform their pixels.
 * Explicit priority: mouthClose >= .6 > press > pucker > signed shift > jaw.
 * Either press channel selects the same whole-mouth approximation. A pucker
 * combined with a shift selects pucker; no combined drawing is implied.
 * Left / Right are anatomical: shiftLeft appears on the viewer's right.
 * Missing artwork capability returns the unchanged approved side selector. */
export function selectSideMouthExpression(channels, previous = {}, available = {}) {
  const c = sanitizeSideMouthChannels(channels), old = object(previous) ? previous : {};
  const state = selectSideExpression(c, old);
  if (available?.mouthArt !== true || c.mouthClose >= .6) return state;
  const press = Math.max(c.mouthPressLeft, c.mouthPressRight);
  if (press >= threshold(old.mouth, 'press', .55, .4)) return {...state, mouth: 'press'};
  if (c.mouthPucker >= threshold(old.mouth, 'pucker', .45, .3)) return {...state, mouth: 'pucker'};
  const difference = c.mouthLeft - c.mouthRight;
  if (difference >= threshold(old.mouth, 'shiftLeft', .35, .22)) return {...state, mouth: 'shiftLeft'};
  if (-difference >= threshold(old.mouth, 'shiftRight', .35, .22)) return {...state, mouth: 'shiftRight'};
  return state;
}
