import test from 'node:test';
import assert from 'node:assert/strict';
import {FaceSession} from './face-session.js';
import {STUDIO_CHANNELS} from './short-hair-studio-model.js';
import {mapBlendshapeValue} from './arkit-blendshapes.js';
import {validateTrackingSettings} from './short-hair-tracking-settings.js';
import {TRACKING_PRESETS, normalizeTrackingSettings, createFaceSessionSettings, StudioPoseStabilizer,
  TRACKING_CLIP_LIMITS, validateTrackingClip, parseTrackingClip, TrackingClipRecorder, TrackingClipPlayer,
  TrackingInferenceMetrics} from './short-hair-studio-tracking.js';

const coefficients = overrides => Object.fromEntries(STUDIO_CHANNELS.map(({key}) => [key,overrides?.[key] ?? 0]));
const frame = (overrides,poseId = 'front') => ({coefficients:coefficients(overrides),poseId});
const clip = () => ({schemaVersion:1,kind:'moemotion-short-hair-tracking-clip',characterId:'short-hair-v1',durationMs:200,
  samples:[{t:0,...frame()},{t:80,...frame({jawOpen:.8},'view-left')},{t:160,...frame({eyeBlinkLeft:1})}]});

test('short-hair presets normalize hostile settings without changing legacy defaults',()=>{
  assert.deepEqual(normalizeTrackingSettings(null),{preset:'balanced',eyeSensitivity:1,mouthSensitivity:1,eyeInputMax:.85,mouthInputMax:.85});
  assert.deepEqual(normalizeTrackingSettings({preset:'unknown',eyeSensitivity:99,mouthSensitivity:NaN}),
    {preset:'balanced',eyeSensitivity:1.4,mouthSensitivity:1,eyeInputMax:.85,mouthInputMax:.85});
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
test('legacy defaults preserve the original effective maximum at every preset and sensitivity',()=>{
  for(const preset of ['balanced','responsive','stable'])for(const sensitivity of [.7,1,1.4]){
    const config=createFaceSessionSettings({preset,eyeSensitivity:sensitivity,mouthSensitivity:sensitivity}).channels;
    assert.equal(config.eyeBlinkLeft.inputMax,Math.min(1,.85/sensitivity));
    assert.equal(config.jawOpen.inputMax,Math.min(1,.85/sensitivity));
  }
});
test('effective maximum maps modest observed eye and jaw input to full output without changing gaze or shared defaults',()=>{
  const session=new FaceSession();session.setSettings(createFaceSessionSettings({eyeInputMax:.44,mouthInputMax:.4}));
  session.neutral.eyeBlinkLeft=session.neutral.eyeBlinkRight=.1;session.neutral.jawOpen=.1;
  session.cameraFrame.eyeBlinkLeft=session.cameraFrame.eyeBlinkRight=.5;session.cameraFrame.jawOpen=.46;session.cameraTime=0;
  const output=session.update({},'camera',0,1);
  assert.equal(output.eyeBlinkLeft,1);assert.equal(output.eyeBlinkRight,1);assert.ok(Math.abs(output.jawOpen-1)<1e-12);
  assert.deepEqual(new FaceSession().settings,{channels:{}});
  assert.deepEqual(createFaceSessionSettings({eyeInputMax:.2,mouthInputMax:.2}).channels.eyeLookOutLeft,
    createFaceSessionSettings().channels.eyeLookOutLeft);
});
test('effective maximum accepts old saved settings and rejects malformed imported maxima',()=>{
  assert.deepEqual(validateTrackingSettings({preset:'stable',eyeSensitivity:1,mouthSensitivity:1}),
    {preset:'stable',eyeSensitivity:1,mouthSensitivity:1,eyeInputMax:.85,mouthInputMax:.85});
  for(const value of [null,NaN,Infinity,.19,1.01,'0.5'])for(const key of ['eyeInputMax','mouthInputMax'])
    assert.throws(()=>validateTrackingSettings({[key]:value}));
  assert.throws(()=>validateTrackingSettings({other:1}));
  assert.deepEqual(normalizeTrackingSettings({eyeInputMax:0,mouthInputMax:2}),
    {preset:'balanced',eyeSensitivity:1,mouthSensitivity:1,eyeInputMax:.2,mouthInputMax:1});
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

test('new recordings preserve fractional head coordinates in v3 and default omitted micro-motion to zero',()=>{
  const recorder=new TrackingClipRecorder();recorder.start(0);
  const headPose={yaw:.125,pitch:-.375};
  recorder.capture({...frame(),headPose},0);headPose.yaw=1;
  recorder.capture({...frame({jawOpen:1}),headPose:{yaw:.875,pitch:.625}},100);
  const saved=recorder.stop(120);
  assert.equal(saved.schemaVersion,3);
  assert.deepEqual(saved.samples[0].headPose,{yaw:.125,pitch:-.375});
  assert.deepEqual(saved.samples[0].secondary,{breath:0,sway:0,hair:0});
  assert.deepEqual(parseTrackingClip(JSON.stringify(saved)),saved);
  const player=new TrackingClipPlayer();player.start(saved,1000);
  const middle=player.sample(1050);
  assert.deepEqual(middle.headPose,{yaw:.5,pitch:.125});
  assert.equal(middle.coefficients.jawOpen,0);
  const final=player.sample(1100);
  assert.deepEqual(final.headPose,{yaw:.875,pitch:.625});assert.equal(final.poseId,'view-right-up');
});

test('v1 clips remain readable and replay maps exact old pose timing to continuous vertices',()=>{
  const value=clip(),parsed=parseTrackingClip(JSON.stringify(value));
  assert.equal(parsed.schemaVersion,1);assert.equal(parsed.samples[0].headPose,undefined);
  const player=new TrackingClipPlayer();player.start(parsed,0);
  assert.deepEqual(player.sample(79).headPose,{yaw:0,pitch:0});
  assert.deepEqual(player.sample(80).headPose,{yaw:-1,pitch:0});
});

test('v2 recordings preserve continuous interpolation and replay with neutral secondary motion',()=>{
  const valid={...clip(),schemaVersion:2,samples:clip().samples.map((sample,index)=>({...sample,headPose:{yaw:index*.3,pitch:0}}))};
  assert.deepEqual(parseTrackingClip(JSON.stringify(valid)),valid);
  const player=new TrackingClipPlayer();player.start(valid,1000);const middle=player.sample(1040);
  assert.deepEqual(middle.headPose,{yaw:.15,pitch:0});assert.deepEqual(middle.secondary,{breath:0,sway:0,hair:0});
  assert.equal(player.sample(1200).done,true);
});

test('v3 records exactly displayed secondary values and replays their timestamp interpolation',()=>{
  const recorder=new TrackingClipRecorder();recorder.start(100);
  const secondary={breath:-.4,sway:.1,hair:.8};
  recorder.capture({...frame(),headPose:{yaw:-.5,pitch:0},secondary},100);secondary.breath=1;
  recorder.capture({...frame({jawOpen:.7}),headPose:{yaw:.5,pitch:.4},secondary:{breath:.6,sway:-.3,hair:-.4}},200);
  const saved=recorder.stop(240);
  assert.equal(saved.schemaVersion,3);assert.equal(saved.samples[0].secondary.breath,-.4);
  assert.deepEqual(parseTrackingClip(JSON.stringify(saved)),saved);
  const player=new TrackingClipPlayer();player.start(saved,1000);saved.samples[1].secondary.hair=1;
  const middle=player.sample(1050);
  assert.deepEqual(middle.headPose,{yaw:0,pitch:.2});
  assert.ok(Math.abs(middle.secondary.breath-.1)<1e-12);
  assert.ok(Math.abs(middle.secondary.sway+.1)<1e-12);
  assert.ok(Math.abs(middle.secondary.hair-.2)<1e-12);
  assert.equal(middle.coefficients.jawOpen,0);
  const final=player.sample(1200);assert.equal(final.done,true);assert.equal(final.elapsedMs,140);
  assert.deepEqual(final.headPose,{yaw:.5,pitch:.4});
  assert.deepEqual(final.secondary,{breath:.6,sway:-.3,hair:-.4});assert.equal(final.coefficients.jawOpen,.7);
  final.secondary.hair=1;assert.equal(player.clip.samples.at(-1).secondary.hair,-.4);assert.equal(player.sample(1300),null);
});

test('v3 single-frame clips return the exact secondary endpoint without restarting a simulation',()=>{
  const recorder=new TrackingClipRecorder();recorder.start(0);
  recorder.capture({...frame(),secondary:{breath:1,sway:-1,hair:0}},0);
  const player=new TrackingClipPlayer();player.start(recorder.stop(0),100);
  const last=player.sample(100);assert.equal(last.done,true);assert.deepEqual(last.secondary,{breath:1,sway:-1,hair:0});
  assert.equal(player.sample(101),null);
});

test('v3 strictly requires head and secondary data while old versions reject new fields',()=>{
  const valid={...clip(),schemaVersion:3,samples:clip().samples.map(sample=>({...sample,
    headPose:{yaw:.2,pitch:0},secondary:{breath:0,sway:.3,hair:-.2}}))};
  assert.deepEqual(validateTrackingClip(valid),valid);
  for(const secondary of [null,undefined,[],{breath:0,sway:0},{breath:0,sway:0,hair:NaN},
    {breath:1.01,sway:0,hair:0},{breath:0,sway:0,hair:'0'},{breath:0,sway:0,hair:0,url:'remote'}]) {
    const bad=structuredClone(valid);bad.samples[0].secondary=secondary;assert.throws(()=>validateTrackingClip(bad));
  }
  for(const key of ['headPose','secondary']){const bad=structuredClone(valid);delete bad.samples[0][key];assert.throws(()=>validateTrackingClip(bad));}
  for(const schemaVersion of [1,2])assert.throws(()=>validateTrackingClip({...valid,schemaVersion}));
});

test('recording rejects malformed explicit secondary data rather than silently dropping it',()=>{
  const recorder=new TrackingClipRecorder();recorder.start(0);
  for(const secondary of [null,{breath:0},{breath:0,sway:0,hair:Infinity},{breath:0,sway:0,hair:0,extra:1}]) {
    assert.throws(()=>recorder.capture({...frame(),secondary},0));
  }
  assert.equal(recorder.samples.length,0);
});

test('v2 clips strictly require bounded coordinates and v1 does not silently accept v2 fields',()=>{
  const valid={...clip(),schemaVersion:2,samples:clip().samples.map(sample=>({...sample,headPose:{yaw:.2,pitch:0}}))};
  assert.deepEqual(validateTrackingClip(valid),valid);
  for(const headPose of [null,undefined,{yaw:.2},{yaw:1.01,pitch:0},{yaw:NaN,pitch:0},{yaw:0,pitch:0,url:'remote'}]) {
    const broken=structuredClone(valid);broken.samples[0].headPose=headPose;
    assert.throws(()=>validateTrackingClip(broken));
  }
  const missing=structuredClone(valid);delete missing.samples[0].headPose;
  assert.throws(()=>validateTrackingClip(missing));
  assert.throws(()=>validateTrackingClip({...valid,schemaVersion:1}));
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
