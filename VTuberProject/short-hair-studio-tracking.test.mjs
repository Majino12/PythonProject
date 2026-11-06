import test from 'node:test';
import assert from 'node:assert/strict';
import {FaceSession} from './face-session.js';
import {STUDIO_CHANNELS} from './short-hair-studio-model.js';
import {mapBlendshapeValue} from './arkit-blendshapes.js';
import {TRACKING_PRESETS, normalizeTrackingSettings, createFaceSessionSettings, StudioPoseStabilizer,
  TRACKING_CLIP_LIMITS, validateTrackingClip, parseTrackingClip, TrackingClipRecorder, TrackingClipPlayer,
  TrackingInferenceMetrics} from './short-hair-studio-tracking.js';

const coefficients = overrides => Object.fromEntries(STUDIO_CHANNELS.map(({key}) => [key,overrides?.[key] ?? 0]));
const frame = (overrides,poseId = 'front') => ({coefficients:coefficients(overrides),poseId});
const clip = () => ({schemaVersion:1,kind:'moemotion-short-hair-tracking-clip',characterId:'short-hair-v1',durationMs:200,
  samples:[{t:0,...frame()},{t:80,...frame({jawOpen:.8},'view-left')},{t:160,...frame({eyeBlinkLeft:1})}]});

test('short-hair presets normalize hostile settings without changing legacy defaults',()=>{
  assert.deepEqual(normalizeTrackingSettings(null),{preset:'balanced',eyeSensitivity:1,mouthSensitivity:1});
  assert.deepEqual(normalizeTrackingSettings({preset:'unknown',eyeSensitivity:99,mouthSensitivity:NaN}),
    {preset:'balanced',eyeSensitivity:1.4,mouthSensitivity:1});
  const session = new FaceSession();
  assert.deepEqual(session.settings,{channels:{}});
  const settings = createFaceSessionSettings({preset:'responsive'});
  assert.equal(Object.keys(settings.channels).length,22);
  assert.equal(settings.channels.eyeBlinkLeft.smoothing,12);
  assert.equal(settings.channels.jawOpen.smoothing,24);
  assert.equal(settings.channels.eyeLookOutLeft.smoothing,35);
});

test('sensitivity responds monotonically, preserves full closure and does not amplify gaze',()=>{
  const low = createFaceSessionSettings({eyeSensitivity:.7,mouthSensitivity:.7}).channels;
  const high = createFaceSessionSettings({eyeSensitivity:1.4,mouthSensitivity:1.4}).channels;
  for (const key of ['eyeBlinkLeft','eyeBlinkRight','jawOpen','mouthPucker']) {
    assert.ok(mapBlendshapeValue(.4,high[key]) > mapBlendshapeValue(.4,low[key]));
    assert.equal(mapBlendshapeValue(1,low[key]),1);
    assert.equal(mapBlendshapeValue(1,high[key]),1);
    assert.equal(mapBlendshapeValue(0,high[key]),0);
  }
  assert.deepEqual(low.eyeLookOutLeft,high.eyeLookOutLeft);
});

test('presets use the single existing FaceSession filter and preserve neutral calibration',()=>{
  const results = [];
  for (const preset of ['responsive','balanced','stable']) {
    const session = new FaceSession(); session.neutral.jawOpen = .1;
    session.setSettings(createFaceSessionSettings({preset}));
    assert.equal(session.neutral.jawOpen,.1);
    session.cameraFrame = coefficients(); session.cameraTime = 0;
    session.update({},'camera',0,.016);
    session.cameraFrame = coefficients({jawOpen:.7,eyeBlinkLeft:.8}); session.cameraTime = 16;
    results.push(session.update({},'camera',16,.016));
    session.beginCalibration();
    assert.equal(session.neutral.jawOpen,0);
    assert.equal(session.filter.initialized,false);
  }
  assert.ok(results[0].jawOpen > results[1].jawOpen && results[1].jawOpen > results[2].jawOpen);
  assert.ok(results[0].eyeBlinkLeft > results[1].eyeBlinkLeft && results[1].eyeBlinkLeft > results[2].eyeBlinkLeft);
});

test('pose dwell suppresses a one-frame crossing and commits a sustained nine-direction turn',()=>{
  const pose = new StudioPoseStabilizer();
  assert.equal(pose.update({yaw:.8,pitch:.8},0,'front'),'front');
  assert.equal(pose.update({yaw:0,pitch:0},50,'front'),'front');
  assert.equal(pose.update({yaw:.8,pitch:.8},100,'front'),'front');
  assert.equal(pose.update({yaw:.8,pitch:.8},179,'front'),'front');
  assert.equal(pose.update({yaw:.8,pitch:.8},180,'front'),'view-right-up');
  assert.equal(pose.update({yaw:.35,pitch:.35},200,'view-right-up'),'view-right-up');
});

test('pose dwell respects preset, stale signal, interrupted candidate and clock discontinuities',()=>{
  for (const preset of TRACKING_PRESETS) {
    const pose = new StudioPoseStabilizer({preset:preset.id});
    pose.update({yaw:1},0);
    assert.equal(pose.update({yaw:1},preset.poseHoldMs - 1),'front');
    assert.equal(pose.update({yaw:1},preset.poseHoldMs),'view-right');
    assert.equal(pose.update({yaw:1},preset.poseHoldMs + 1,'view-right',{fresh:false}),'front');
  }
  const pose = new StudioPoseStabilizer();
  pose.update({yaw:1},100);
  assert.equal(pose.update({yaw:-1},179),'front');
  assert.equal(pose.update({yaw:-1},220),'front');
  assert.equal(pose.update({yaw:-1},1000),'front');
  assert.equal(pose.update({yaw:-1},900),'front');
});

test('render callbacks cannot turn a single unchanged inference sample into a confirmed pose',()=>{
  const pose = new StudioPoseStabilizer();
  assert.equal(pose.update({yaw:1},0,'front',{sampleTime:0}),'front');
  for (const now of [16,32,80,160]) assert.equal(pose.update({yaw:1},now,'front',{sampleTime:0}),'front');
  assert.equal(pose.update({yaw:1},170,'front',{sampleTime:170}),'view-right');
});

test('strict numeric clips round-trip and reject foreign metadata, missing channels and unknown directions',()=>{
  const valid = clip();
  assert.deepEqual(parseTrackingClip(JSON.stringify(valid)),valid);
  const bad = [
    {...valid,image:'data:image/png;base64,xxx'},
    {...valid,characterId:'luna'},
    {...valid,samples:[{...valid.samples[0],video:[]}]},
    {...valid,samples:[{...valid.samples[0],poseId:'sideways'}]},
    {...valid,samples:[{...valid.samples[0],coefficients:{jawOpen:1}}]},
    {...valid,samples:[{...valid.samples[0],coefficients:{...coefficients(),tongueOut:1}}]},
    {...valid,samples:[{...valid.samples[0],coefficients:coefficients({jawOpen:'1'})}]},
    {...valid,samples:[{...valid.samples[0],coefficients:coefficients({jawOpen:1.001})}]},
  ];
  for (const value of bad) assert.throws(()=>validateTrackingClip(value));
});

test('clip timestamps are bounded, start at zero, increase strictly and never exceed duration',()=>{
  const valid = clip();
  for (const times of [[1,80,160],[0,0,160],[0,120,80],[0,80,201],[0,NaN,160]]) {
    assert.throws(()=>validateTrackingClip({...valid,samples:valid.samples.map((s,i)=>({...s,t:times[i]}))}));
  }
  assert.throws(()=>validateTrackingClip({...valid,durationMs:60001}));
  assert.throws(()=>validateTrackingClip({...valid,samples:[]}));
  assert.throws(()=>parseTrackingClip('{bad'));
  assert.throws(()=>parseTrackingClip(' '.repeat(TRACKING_CLIP_LIMITS.maxBytes + 1)));
  assert.throws(()=>parseTrackingClip('汉'.repeat(Math.floor(TRACKING_CLIP_LIMITS.maxBytes / 3) + 1)),/2 MB/);
});

test('recording is explicit, rate-limited, independent from input mutation, and interruptible',()=>{
  const recorder = new TrackingClipRecorder(), input = frame({jawOpen:.2});
  assert.equal(recorder.capture(input,0),false);
  recorder.start(100); assert.equal(recorder.capture(input,110),true);
  input.coefficients.jawOpen = 1;
  assert.equal(recorder.capture(frame({jawOpen:.4}),120),false);
  assert.equal(recorder.capture(frame({jawOpen:.6}),150),true);
  const saved = recorder.stop(180);
  assert.equal(recorder.recording,false);
  assert.equal(saved.samples[0].coefficients.jawOpen,.2);
  assert.deepEqual(saved.samples.map(s=>s.t),[0,40]);
  assert.equal(saved.durationMs,70);
  assert.equal(recorder.capture(input,190),false);
  assert.deepEqual(recorder.stop(),saved);
  saved.samples[0].coefficients.jawOpen=.9;
  assert.equal(recorder.samples[0].coefficients.jawOpen,.2);
  recorder.start(200); assert.equal(recorder.stop(),null);
});

test('recording rejects malformed coefficients and backwards clocks and ends at 60-second limit',()=>{
  const recorder = new TrackingClipRecorder();
  assert.throws(()=>recorder.start(-1));
  recorder.start(0);
  assert.throws(()=>recorder.capture({poseId:'front',coefficients:{jawOpen:1}},0));
  recorder.capture(frame(),0); recorder.capture(frame({jawOpen:1}),100);
  assert.throws(()=>recorder.capture(frame(),90));
  assert.throws(()=>recorder.stop(99));
  assert.equal(recorder.capture(frame(),60001),false);
  assert.equal(recorder.stopReason,'limit');
  assert.equal(recorder.active,false);
  assert.equal(recorder.stop().durationMs,60000);
});

test('replay uses recorded time, keeps separate eye signals, returns final endpoint and stops on interruption',()=>{
  const player = new TrackingClipPlayer(), value = clip();
  player.start(value,1000); value.samples[1].coefficients.jawOpen=0;
  assert.equal(player.sample(1000).coefficients.jawOpen,0);
  assert.equal(player.sample(1079).poseId,'front');
  const middle = player.sample(1080);
  assert.equal(middle.poseId,'view-left'); assert.equal(middle.coefficients.jawOpen,.8);
  const final = player.sample(1300);
  assert.equal(final.done,true); assert.equal(final.elapsedMs,200);
  assert.equal(final.coefficients.eyeBlinkLeft,1); assert.equal(final.coefficients.eyeBlinkRight,0);
  assert.equal(player.sample(1400),null);
  player.start(clip(),2000); player.stop(); assert.equal(player.sample(2100),null);
});

test('invalid replay starts preserve an active clip; backwards replay clocks are rejected',()=>{
  const player = new TrackingClipPlayer(); player.start(clip(),100);
  assert.throws(()=>player.start({...clip(),kind:'wrong'},200));
  assert.equal(player.playing,true); assert.equal(player.startedAt,100);
  player.sample(110); assert.throws(()=>player.sample(109));
});

test('inference metrics distinguish completed detection, face freshness, failures, idle and sample insufficiency',()=>{
  const metrics = new TrackingInferenceMetrics();
  assert.equal(metrics.snapshot(0).inferenceFps,null);
  assert.equal(metrics.snapshot(0).signalStale,true);
  for(let now=0;now<=240;now+=40) metrics.record(now,8,now===0);
  const measured = metrics.snapshot(240);
  assert.equal(measured.inferenceFps,25); assert.equal(measured.meanInferenceMs,8);
  assert.equal(measured.signalAgeMs,240); assert.equal(measured.signalStale,false);
  metrics.record(280,4,false,true);
  const failed = metrics.snapshot(281);
  assert.equal(failed.sampleCount,7); assert.equal(failed.failedCount,1); assert.equal(failed.signalStale,true);
  assert.equal(metrics.snapshot(600).inferenceFps,null);
  assert.equal(metrics.snapshot(3000).meanInferenceMs,null);
  metrics.reset(); assert.equal(metrics.snapshot(4000).sampleCount,0);
});
