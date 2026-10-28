import test from 'node:test';
import assert from 'node:assert/strict';
import {SIDE_MOUTH_CHANNELS, selectSideMouthExpression} from './side-mouth-model.js';
import {SIDE_GAZE_CHANNELS} from './side-gaze.js';
import {SIDE_BROW_STATES, SIDE_BROW_CHANNELS, sanitizeSideBrowChannels, selectSideBrowExpression} from './side-brow-model.js';

const available = Object.freeze({mouthArt: true, browArt: true});
const select = (c, old) => selectSideBrowExpression(c, old, available);
const neutral = {eyeLeft: 'open', eyeRight: 'open', mouth: 'neutral', browLeft: 'neutral', browRight: 'neutral'};

test('side brows add the five ARKit brow channels without duplicating existing mouth or gaze channels', () => {
  assert.deepEqual(SIDE_BROW_CHANNELS.slice(0, 9), SIDE_MOUTH_CHANNELS);
  assert.deepEqual(SIDE_BROW_CHANNELS.slice(9).map(c => c.key), ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'browDownLeft', 'browDownRight']);
  assert.equal(new Set([...SIDE_BROW_CHANNELS, ...SIDE_GAZE_CHANNELS].map(c => c.key)).size, 22);
  assert.deepEqual(SIDE_BROW_STATES, ['innerUp', 'outerUp', 'down']);
});

test('without explicit brow capability the approved mouth selector and return shape are unchanged', () => {
  for (const browArt of [undefined, false, 1, 'true']) for (const mouthArt of [false, true]) {
    for (const c of [{}, {mouthLeft: 1, browInnerUp: 1}, {jawOpen: 1, mouthClose: 1, browDownLeft: 1}, {eyeBlinkRight: .5, mouthPucker: .6, browOuterUpRight: 1}]) {
      const old = {eyeRight: 'half', mouth: 'pucker', browLeft: 'down', browRight: 'outerUp'};
      assert.deepEqual(selectSideBrowExpression(c, old, {browArt, mouthArt}), selectSideMouthExpression(c, old, {mouthArt}));
    }
  }
  const state = selectSideBrowExpression({browInnerUp: 1, mouthPucker: 1}, {}, {browArt: true});
  assert.equal(state.mouth, 'neutral'); assert.equal(state.browLeft, 'innerUp'); assert.equal(state.browRight, 'innerUp');
});

test('brow inputs reject inherited, nonfinite and coerced values and never consume independent gaze', () => {
  for (const input of [undefined, null, [], 1, '1', Object.create({browInnerUp: 1}), {browInnerUp: '1', browDownLeft: Infinity, browOuterUpRight: NaN}]) assert.deepEqual(select(input), neutral);
  const input = Object.freeze({browDownLeft: 2, browDownRight: -.1, jawOpen: .4, eyeLookInLeft: 1, unknown: 1});
  const clean = sanitizeSideBrowChannels(input);
  assert.equal(clean.browDownLeft, 1); assert.equal(clean.browDownRight, 0); assert.equal(clean.jawOpen, .4);
  assert.equal(clean.eyeLookInLeft, undefined); assert.equal(clean.unknown, undefined);
});

test('inner-up affects both brows while unilateral outer-up and down retain anatomical left/right', () => {
  assert.deepEqual(select({browInnerUp: 1}), {...neutral, browLeft: 'innerUp', browRight: 'innerUp'});
  for (const [key, output, state] of [['browOuterUpLeft', 'browLeft', 'outerUp'], ['browOuterUpRight', 'browRight', 'outerUp'], ['browDownLeft', 'browLeft', 'down'], ['browDownRight', 'browRight', 'down']]) {
    assert.deepEqual(select({[key]: 1}), {...neutral, [output]: state});
  }
  assert.deepEqual(select({browOuterUpLeft: 1, browDownRight: 1}), {...neutral, browLeft: 'outerUp', browRight: 'down'});
  assert.deepEqual(select({browDownLeft: 1, browOuterUpRight: 1}), {...neutral, browLeft: 'down', browRight: 'outerUp'});
});

test('each brow independently resolves conflicting coefficients as down then inner-up then outer-up', () => {
  const all = {browInnerUp: 1, browOuterUpLeft: 1, browOuterUpRight: 1, browDownLeft: 1, browDownRight: 1};
  assert.deepEqual(select(all), {...neutral, browLeft: 'down', browRight: 'down'});
  assert.deepEqual(select({...all, browDownLeft: 0}), {...neutral, browLeft: 'innerUp', browRight: 'down'});
  assert.deepEqual(select({...all, browDownLeft: 0, browInnerUp: 0}), {...neutral, browLeft: 'outerUp', browRight: 'down'});
});

test('independent hysteresis holds actual painted states through boundary noise and releases below .35', () => {
  for (const [key, state] of [['browInnerUp', 'innerUp'], ['browOuterUpLeft', 'outerUp'], ['browDownLeft', 'down']]) {
    assert.equal(select({[key]: .49}).browLeft, 'neutral');
    assert.equal(select({[key]: .5}).browLeft, state);
    assert.equal(select({[key]: .36}, {browLeft: state}).browLeft, state);
    assert.equal(select({[key]: .34}, {browLeft: state}).browLeft, 'neutral');
  }
  assert.deepEqual(select({browOuterUpLeft: .4, browOuterUpRight: .4}, {browLeft: 'outerUp', browRight: 'neutral'}), {...neutral, browLeft: 'outerUp'});
  assert.equal(select({browDownLeft: .5, browOuterUpLeft: 1}, {browLeft: 'outerUp'}).browLeft, 'down');
  assert.equal(select({browDownLeft: .4, browInnerUp: 1}, {browLeft: 'down'}).browLeft, 'down');
});

test('brow selection preserves approved eye and mouth behavior and does not mutate input or prior state', () => {
  const c = Object.freeze({eyeBlinkLeft: .28, eyeBlinkRight: 1, mouthLeft: 1, mouthRight: 1, jawOpen: .95, browInnerUp: 1, browDownRight: 1});
  const old = Object.freeze({eyeLeft: 'half', eyeRight: 'open', mouth: 'shiftRight', browLeft: 'outerUp', browRight: 'innerUp'});
  const state = select(c, old), {browLeft, browRight, ...original} = state;
  assert.deepEqual(original, selectSideMouthExpression(c, old, available));
  assert.equal(browLeft, 'innerUp'); assert.equal(browRight, 'down'); assert.equal(state.mouth, 'openWide');
  assert.equal(old.browLeft, 'outerUp'); assert.equal(c.mouthLeft, 1);
  for (const name of ['__proto__', 'constructor', 'missing']) assert.deepEqual(select({}, {browLeft: name, browRight: name}), neutral);
});
