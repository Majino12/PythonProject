import {SIDE_MOUTH_CHANNELS, selectSideMouthExpression} from './side-mouth-model.js';

export const SIDE_BROW_STATES = Object.freeze(['innerUp', 'outerUp', 'down']);
export const SIDE_BROW_CHANNELS = Object.freeze([
  ...SIDE_MOUTH_CHANNELS,
  {key: 'browInnerUp', group: 'brows', groupLabel: '眉毛', label: '双侧眉头抬起', mode: 'frame'},
  {key: 'browOuterUpLeft', group: 'brows', groupLabel: '眉毛', label: '角色左眉尾抬起', mode: 'frame'},
  {key: 'browOuterUpRight', group: 'brows', groupLabel: '眉毛', label: '角色右眉尾抬起', mode: 'frame'},
  {key: 'browDownLeft', group: 'brows', groupLabel: '眉毛', label: '角色左眉压低', mode: 'frame'},
  {key: 'browDownRight', group: 'brows', groupLabel: '眉毛', label: '角色右眉压低', mode: 'frame'},
].map(Object.freeze));

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Fourteen painted-expression channels; independent gaze is not consumed here. */
export function sanitizeSideBrowChannels(input) {
  const source = object(input) ? input : {};
  return Object.fromEntries(SIDE_BROW_CHANNELS.map(({key}) => [key,
    Object.hasOwn(source, key) && Number.isFinite(source[key]) ? Math.max(0, Math.min(1, source[key])) : 0,
  ]));
}

function selectBrow(inner, outer, down, previous) {
  const active = (value, state) => value >= (previous === state ? .35 : .5);
  if (active(down, 'down')) return 'down';
  if (active(inner, 'innerUp')) return 'innerUp';
  if (active(outer, 'outerUp')) return 'outerUp';
  return 'neutral';
}

/** Independent finite drawings per anatomical brow. One shared ARKit inner-up
 * signal affects both eyebrows; outer-up and down remain left/right specific.
 * Each brow resolves conflicts as down > innerUp > outerUp and retains its
 * current drawing through a .35–.5 hysteresis band. No combined or interpolated
 * brow painting is implied. Without brow artwork, the approved mouth selector
 * is returned unchanged, including its independently gated mouth capability. */
export function selectSideBrowExpression(channels, previous = {}, available = {}) {
  const c = sanitizeSideBrowChannels(channels), old = object(previous) ? previous : {};
  const state = selectSideMouthExpression(c, old, available);
  if (available?.browArt !== true) return state;
  return {
    ...state,
    browLeft: selectBrow(c.browInnerUp, c.browOuterUpLeft, c.browDownLeft, old.browLeft),
    browRight: selectBrow(c.browInnerUp, c.browOuterUpRight, c.browDownRight, old.browRight),
  };
}
