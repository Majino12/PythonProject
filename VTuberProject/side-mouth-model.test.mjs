import test from 'node:test';
import assert from 'node:assert/strict';
import {SIDE_CHANNELS, selectSideExpression} from './side-expression-model.js';
import {SIDE_GAZE_CHANNELS} from './side-gaze.js';
import {SIDE_MOUTH_CHANNELS, SIDE_MOUTH_STATES, sanitizeSideMouthChannels, selectSideMouthExpression} from './side-mouth-model.js';

const enabled = Object.freeze({mouthArt: true});
const mouth = (input, previous) => selectSideMouthExpression(input, previous, enabled).mouth;
const neutral = {eyeLeft: 'open', eyeRight: 'open', mouth: 'neutral'};

test('side mouth declares exactly five extra ARKit channels, whole-mouth press limitations and four painted states', () => {
  assert.deepEqual(SIDE_MOUTH_CHANNELS.slice(0, 4), SIDE_CHANNELS);
  assert.deepEqual(SIDE_MOUTH_CHANNELS.slice(4).map(c => c.key), ['mouthPucker', 'mouthPressLeft', 'mouthPressRight', 'mouthLeft', 'mouthRight']);
  assert.equal(new Set([...SIDE_MOUTH_CHANNELS, ...SIDE_GAZE_CHANNELS].map(c => c.key)).size, 17);
  assert.deepEqual(SIDE_MOUTH_STATES, ['pucker', 'press', 'shiftLeft', 'shiftRight']);
  assert.ok(SIDE_MOUTH_CHANNELS.filter(c => c.key.startsWith('mouthPress')).every(c => c.mode === 'approximate' && c.label.includes('整嘴近似')));
});

test('unavailable artwork returns the approved selector for every old eye/jaw combination', () => {
  for (const eyeBlinkLeft of [0, .29, .5, .81, 1]) for (const jawOpen of [0, .15, .4, .65, 1]) for (const mouthClose of [0, .59, .6, 1]) {
    const input = {eyeBlinkLeft, eyeBlinkRight: .5, jawOpen, mouthClose, mouthPucker: 1, mouthPressLeft: 1, mouthLeft: 1};
    const previous = {eyeLeft: 'half', eyeRight: 'closed', mouth: 'openSmall'};
    for (const available of [undefined, {}, {mouthArt: false}, {mouthArt: 1}, {mouthArt: 'true'}]) assert.deepEqual(selectSideMouthExpression(input, previous, available), selectSideExpression(input, previous));
  }
});

test('new mouth coefficients reject inherited, nonfinite and coerced values and leave input untouched', () => {
  for (const input of [undefined, null, [], 'mouth', 1, Object.create({mouthPucker: 1, mouthLeft: 1}), {mouthLeft: '1', mouthPucker: NaN, mouthPressRight: Infinity}]) {
    assert.deepEqual(selectSideMouthExpression(input, null, enabled), neutral);
  }
  const input = Object.freeze({mouthPucker: 2, mouthLeft: -.1, jawOpen: .7, eyeLookUpLeft: 1, unknown: 1});
  const clean = sanitizeSideMouthChannels(input);
  assert.equal(clean.mouthPucker, 1); assert.equal(clean.mouthLeft, 0); assert.equal(clean.jawOpen, .7);
  assert.equal(clean.eyeLookUpLeft, undefined); assert.equal(clean.unknown, undefined);
});

test('single left/right mouth inputs choose distinct anatomical directions and opposing coefficients cancel', () => {
  assert.equal(mouth({mouthLeft: 1}), 'shiftLeft');
  assert.equal(mouth({mouthRight: 1}), 'shiftRight');
  for (const previous of [{}, {mouth: 'shiftLeft'}, {mouth: 'shiftRight'}]) {
    assert.equal(mouth({mouthLeft: 1, mouthRight: 1}, previous), 'neutral');
    assert.equal(mouth({mouthLeft: .8, mouthRight: .8, jawOpen: .95}, previous), 'openWide');
    assert.equal(mouth({mouthLeft: .9, mouthRight: .85}, previous), 'neutral');
  }
  for (const left of [0, .1, .4, .75, 1]) for (const right of [0, .1, .4, .75, 1]) {
    const actual = mouth({mouthLeft: left, mouthRight: right});
    const expected = left - right >= .35 ? 'shiftLeft' : right - left >= .35 ? 'shiftRight' : 'neutral';
    assert.equal(actual, expected);
  }
});

test('mouthClose overrides all authored mouth actions and priority is press, pucker, shift, then jaw', () => {
  const all = {mouthClose: .6, mouthPressLeft: 1, mouthPressRight: 1, mouthPucker: 1, mouthLeft: 1, jawOpen: 1};
  assert.equal(mouth(all, {mouth: 'press'}), 'neutral');
  assert.equal(mouth({...all, mouthClose: .59}), 'press');
  assert.equal(mouth({...all, mouthClose: 0, mouthPressLeft: 0, mouthPressRight: 0}), 'pucker');
  assert.equal(mouth({...all, mouthClose: 0, mouthPressLeft: 0, mouthPressRight: 0, mouthPucker: 0}), 'shiftLeft');
  assert.equal(mouth({jawOpen: 1}), 'openWide');
  assert.equal(mouth({mouthPucker: 1, mouthRight: 1}), 'pucker', 'there is no pucker-plus-shift drawing');
});

test('either press input chooses the documented whole-mouth approximation, without inventing unilateral frames', () => {
  assert.equal(mouth({mouthPressLeft: 1}), 'press');
  assert.equal(mouth({mouthPressRight: 1}), 'press');
  assert.equal(mouth({mouthPressLeft: .4, mouthPressRight: .4}), 'neutral', 'two weak signals do not add into a strong press');
  assert.equal(mouth({mouthPressLeft: .55, mouthPressRight: .1}), 'press');
});

test('mouth state hysteresis tolerates boundary noise while direction reversal remains explicit', () => {
  for (const [key, state, enter, leave] of [['mouthPucker', 'pucker', .45, .3], ['mouthPressLeft', 'press', .55, .4], ['mouthLeft', 'shiftLeft', .35, .22], ['mouthRight', 'shiftRight', .35, .22]]) {
    assert.equal(mouth({[key]: enter - .01}), 'neutral');
    assert.equal(mouth({[key]: enter}), state);
    assert.equal(mouth({[key]: leave + .01}, {mouth: state}), state);
    assert.equal(mouth({[key]: leave - .01}, {mouth: state}), 'neutral');
  }
  assert.equal(mouth({mouthRight: .8}, {mouth: 'shiftLeft'}), 'shiftRight');
  assert.equal(mouth({mouthLeft: .8}, {mouth: 'shiftRight'}), 'shiftLeft');
  assert.equal(mouth({mouthLeft: .3}, {mouth: 'shiftRight'}), 'neutral', 'retention does not leak into the opposite direction');
});

test('new mouths preserve independent blinking and never mutate or trust unknown previous state names', () => {
  const previous = Object.freeze({eyeLeft: 'half', eyeRight: 'open', mouth: 'pucker'});
  assert.deepEqual(selectSideMouthExpression({eyeBlinkLeft: .28, eyeBlinkRight: 1, mouthPucker: .32}, previous, enabled), {eyeLeft: 'half', eyeRight: 'closed', mouth: 'pucker'});
  assert.deepEqual(previous, {eyeLeft: 'half', eyeRight: 'open', mouth: 'pucker'});
  for (const name of ['constructor', '__proto__', 'missing']) assert.deepEqual(selectSideMouthExpression({}, {eyeLeft: name, eyeRight: name, mouth: name}, enabled), neutral);
});
