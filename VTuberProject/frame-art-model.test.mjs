import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectSideBrowExpression} from './side-brow-model.js';
import {selectFrameArtExpression, FRAME_EYE_STATES, FRAME_JAW_STATES} from './frame-art-model.js';
import {getStudioPaintStates, selectShortHairStudioState, renderShortHairStudio} from './short-hair-studio-renderer.js';

const available = {mouthArt: true, browArt: true, extendedEyes: true, extendedJaw: true};
const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)));
function family(file, front = false) {
  const manifest = read(file), compiled = {}, images = {};
  const fill = patches => Object.fromEntries(Object.entries(patches).map(([group, states]) => [group,
    Object.fromEntries(Object.entries(states).map(([state, patch]) => [state, {paintedSource: patch.source, group, state}]))]));
  if (front) Object.assign(compiled, fill(manifest.patches));
  else for (const [id, pose] of Object.entries(manifest.poses)) compiled[id] = fill(pose.patches);
  for (const key of Object.keys(manifest.sources)) images[key] = {portrait: key};
  return {manifest, compiled, images, gazeLayers: null, available: {shiftLeft: true, shiftRight: true, extendedEyes: true, extendedJaw: true, gaze: false}};
}
function assets() {
  return {front: family('./assets/short-hair-gaze-v1/manifest.json', true),
    side: family('./assets/short-hair-side-brows-v1/manifest.json'),
    pitch: family('./assets/short-hair-pitch-brows-v1/manifest.json'),
    complete: family('./assets/short-hair-complete-poses-v1/manifest.json')};
}

test('explicit frame capability exposes five eye and speaking targets with the accepted front thresholds', () => {
  const eyes = [0, .25, .5, .75, 1].map(value => selectFrameArtExpression({eyeBlinkLeft: value, eyeBlinkRight: 1 - value}, {}, available));
  assert.deepEqual(eyes.map(state => state.eyeLeft), [...FRAME_EYE_STATES]);
  assert.deepEqual(eyes.map(state => state.eyeRight), [...FRAME_EYE_STATES].reverse());
  assert.deepEqual([0, .2, .4, .68, .95].map(jawOpen => selectFrameArtExpression({jawOpen}, {}, available).mouth), [...FRAME_JAW_STATES]);
});

test('five-frame thresholds keep hysteresis while unknown or malformed channel values stay neutral', () => {
  assert.equal(selectFrameArtExpression({eyeBlinkLeft: .14}, {eyeLeft: 'open'}, available).eyeLeft, 'open');
  assert.equal(selectFrameArtExpression({eyeBlinkLeft: .16}, {eyeLeft: 'open'}, available).eyeLeft, 'quarter');
  assert.equal(selectFrameArtExpression({eyeBlinkLeft: .11}, {eyeLeft: 'quarter'}, available).eyeLeft, 'quarter');
  assert.equal(selectFrameArtExpression({eyeBlinkLeft: .09}, {eyeLeft: 'quarter'}, available).eyeLeft, 'open');
  const result = selectFrameArtExpression(Object.assign(Object.create({jawOpen: 1}), {eyeBlinkLeft: '1', eyeBlinkRight: NaN}), {}, available);
  assert.equal(result.eyeLeft, 'open'); assert.equal(result.eyeRight, 'open'); assert.equal(result.mouth, 'neutral');
});

test('frozen side priorities and independent brows survive the extra eye and jaw paintings', () => {
  for (const channels of [{mouthClose: 1, mouthPressLeft: 1, jawOpen: 1}, {mouthPressLeft: 1, mouthPucker: 1},
    {mouthPucker: 1, mouthLeft: 1}, {mouthLeft: 1}, {mouthRight: 1}, {browInnerUp: 1, browDownRight: 1}, {browOuterUpLeft: 1}]) {
    const expected = selectSideBrowExpression(channels, {}, available), actual = selectFrameArtExpression(channels, {}, available);
    assert.deepEqual(actual, expected);
  }
  for (const input of [{}, {eyeBlinkLeft: .7, jawOpen: .7}, {mouthClose: 1, mouthPucker: 1}, {eyeBlinkRight: 1, browDownLeft: 1}]) {
    const legacy = {mouthArt: true, browArt: true};
    assert.deepEqual(selectFrameArtExpression(input, {}, legacy), selectSideBrowExpression(input, {}, legacy));
  }
});

test('studio paint sequences reflect both the actual pose registration and its compiled images', () => {
  const data = assets();
  assert.deepEqual(getStudioPaintStates(data, 'front'), {eyes: [...FRAME_EYE_STATES], mouth: [...FRAME_JAW_STATES]});
  assert.deepEqual(getStudioPaintStates(data, 'view-left').eyes, ['open', 'half', 'closed']);
  delete data.front.compiled.eyeLeft.quarter;
  assert.deepEqual(getStudioPaintStates(data, 'front').eyes, ['open', 'half', 'closed']);
  delete data.side.compiled['view-left'].mouth.openSmall;
  assert.throws(() => getStudioPaintStates(data, 'view-left'), /基础眼口/);
});

test('displaying an intermediate painting does not alter the selected target or claim a missing side painting', () => {
  const data = assets(), selection = selectShortHairStudioState(data, 'front', {eyeBlinkLeft: 1, jawOpen: .95});
  assert.equal(selection.targetState.eyeLeft, 'closed'); assert.equal(selection.targetState.mouth, 'openWide');
  const drawn = [], context = {setTransform(){},clearRect(){},save(){},translate(){},restore(){},drawImage(...args){drawn.push(args[0]);}};
  const canvas = {width: 0, height: 0, getContext: () => context};
  const stateOverride = {...selection.targetState, eyeLeft: 'quarter', mouth: 'parted'};
  const result = renderShortHairStudio(canvas, data, 'front', {eyeBlinkLeft: 1, jawOpen: .95}, {}, {stateOverride});
  assert.equal(result.targetState.eyeLeft, 'closed'); assert.equal(result.targetState.mouth, 'openWide');
  assert.deepEqual(result.state, stateOverride); assert.equal(result.didDraw, true);
  assert.ok(drawn.includes(data.front.compiled.eyeLeft.quarter)); assert.ok(drawn.includes(data.front.compiled.mouth.parted));
  assert.ok(!drawn.includes(data.front.compiled.eyeLeft.closed));
  const sideState = selectShortHairStudioState(data, 'view-left', {}).targetState;
  assert.throws(() => renderShortHairStudio(canvas, data, 'view-left', {}, {}, {stateOverride: {...sideState, eyeLeft: 'quarter'}}), /实际画稿/);
});
