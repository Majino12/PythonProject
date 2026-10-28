import test from 'node:test';
import assert from 'node:assert/strict';
import {SIDE_CHANNELS, sanitizeSideChannels, selectSideExpression, SIDE_DEMO, sampleSideDemo} from './side-expression-model.js';

const neutral = {eyeLeft: 'open', eyeRight: 'open', mouth: 'neutral'};

test('side sample consumes exactly four declared ARKit channels without coercion', () => {
  assert.deepEqual(SIDE_CHANNELS.map(c => c.key), ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthClose']);
  const input = {eyeBlinkLeft: 3, eyeBlinkRight: -.5, jawOpen: '1', mouthClose: Infinity, eyeLookUpLeft: 1};
  assert.deepEqual(sanitizeSideChannels(input), {eyeBlinkLeft: 1, eyeBlinkRight: 0, jawOpen: 0, mouthClose: 0});
  assert.deepEqual(selectSideExpression(input), {eyeLeft: 'closed', eyeRight: 'open', mouth: 'neutral'});
  assert.equal(input.jawOpen, '1');
});

test('missing, inherited and malformed channel inputs cannot accidentally activate a drawing', () => {
  for (const input of [undefined, null, 'blink', 1, [], Object.create({eyeBlinkLeft: 1, jawOpen: 1}), {jawOpen: NaN}]) {
    assert.deepEqual(selectSideExpression(input), neutral);
  }
});

test('left and right blinking is independent in anatomical channel space', () => {
  assert.deepEqual(selectSideExpression({eyeBlinkLeft: 1, eyeBlinkRight: .5}), {eyeLeft: 'closed', eyeRight: 'half', mouth: 'neutral'});
  assert.deepEqual(selectSideExpression({eyeBlinkRight: 1, eyeBlinkLeft: .5}), {eyeLeft: 'half', eyeRight: 'closed', mouth: 'neutral'});
  for (const [coefficient, frame] of [[0, 'open'], [.5, 'half'], [1, 'closed']]) {
    assert.equal(selectSideExpression({eyeBlinkLeft: coefficient}).eyeLeft, frame);
  }
});

test('blink boundaries retain the prior drawing for small noise and can jump directly to closed', () => {
  assert.equal(selectSideExpression({eyeBlinkLeft: .32}, neutral).eyeLeft, 'open');
  assert.equal(selectSideExpression({eyeBlinkLeft: .35}, neutral).eyeLeft, 'half');
  assert.equal(selectSideExpression({eyeBlinkLeft: .28}, {eyeLeft: 'half'}).eyeLeft, 'half');
  assert.equal(selectSideExpression({eyeBlinkLeft: .25}, {eyeLeft: 'half'}).eyeLeft, 'open');
  assert.equal(selectSideExpression({eyeBlinkLeft: .82}, {eyeLeft: 'half'}).eyeLeft, 'half');
  assert.equal(selectSideExpression({eyeBlinkLeft: .78}, {eyeLeft: 'closed'}).eyeLeft, 'closed');
  assert.equal(selectSideExpression({eyeBlinkLeft: .75}, {eyeLeft: 'closed'}).eyeLeft, 'half');
  assert.equal(selectSideExpression({eyeBlinkLeft: 1}, neutral).eyeLeft, 'closed');
});

test('mouthClose selects the original mouth even with full jawOpen', () => {
  assert.equal(selectSideExpression({jawOpen: .4}).mouth, 'openSmall');
  assert.equal(selectSideExpression({jawOpen: .95}).mouth, 'openWide');
  assert.equal(selectSideExpression({jawOpen: 1, mouthClose: .6}, {mouth: 'openWide'}).mouth, 'neutral');
  assert.equal(selectSideExpression({jawOpen: 1, mouthClose: .59}).mouth, 'openWide');
  assert.equal(selectSideExpression({jawOpen: 0, mouthPucker: 1, mouthLeft: 1}).mouth, 'neutral');
});

test('jaw hysteresis does not alter previous state and rejects unknown previous state names', () => {
  const previous = Object.freeze({mouth: 'openSmall', eyeLeft: 'half', eyeRight: 'open'});
  assert.equal(selectSideExpression({jawOpen: .13}, previous).mouth, 'openSmall');
  assert.equal(selectSideExpression({jawOpen: .1}, previous).mouth, 'neutral');
  assert.equal(selectSideExpression({jawOpen: .67}, previous).mouth, 'openSmall');
  assert.equal(selectSideExpression({jawOpen: .69}, previous).mouth, 'openWide');
  assert.deepEqual(previous, {mouth: 'openSmall', eyeLeft: 'half', eyeRight: 'open'});
  assert.deepEqual(selectSideExpression({}, {mouth: 'constructor', eyeLeft: 'missing', eyeRight: 'closed'}), neutral);
});

test('side demo is ten seconds of contiguous held drawings and never changes pose or gaze', () => {
  assert.equal(SIDE_DEMO.duration, 10);
  let cursor = 0;
  for (const step of SIDE_DEMO.steps) {
    assert.equal(step.start, cursor); assert.ok(step.end > step.start); cursor = step.end;
    assert.deepEqual(Object.keys(step.channels), SIDE_CHANNELS.map(c => c.key));
    assert.deepEqual(sampleSideDemo(step.start), step.channels);
  }
  assert.equal(cursor, SIDE_DEMO.duration);
  assert.equal(selectSideExpression(sampleSideDemo(5.1)).mouth, 'neutral');
  assert.deepEqual(selectSideExpression(sampleSideDemo(8.5)), {eyeLeft: 'half', eyeRight: 'half', mouth: 'openSmall'});
});

test('side demo handles invalid time, loops and returns independent coefficient objects', () => {
  for (const time of [undefined, NaN, Infinity, -20, '2', 10, 20]) assert.deepEqual(selectSideExpression(sampleSideDemo(time)), neutral);
  assert.deepEqual(sampleSideDemo(12.5), sampleSideDemo(2.5));
  const channels = sampleSideDemo(2.5); channels.eyeBlinkLeft = 0;
  assert.equal(sampleSideDemo(2.5).eyeBlinkLeft, 1);
});
