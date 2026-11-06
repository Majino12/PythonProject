import test from 'node:test';
import assert from 'node:assert/strict';
import {STUDIO_CHANNELS, STUDIO_POSES, selectStudioPose, gazeChannels, applyStudioPreset, parseStudioFrame,
  createStudioProject, parseStudioProject, sampleStudioDemo, STUDIO_DEMO_DURATION} from './short-hair-studio-model.js';

test('studio head selection covers nine independently painted directions and retains a hysteresis band',()=>{
  assert.equal(STUDIO_POSES.length,9);
  for(const pose of STUDIO_POSES)assert.equal(selectStudioPose(pose),pose.id);
  assert.equal(selectStudioPose({yaw:.41}),'front');
  assert.equal(selectStudioPose({yaw:.42}),'view-right');
  assert.equal(selectStudioPose({yaw:.3},'view-right'),'view-right');
  assert.equal(selectStudioPose({yaw:.28},'view-right'),'front');
  assert.equal(selectStudioPose({yaw:-.7,pitch:.8},'view-right'),'view-left-up');
  assert.equal(selectStudioPose({yaw:NaN,pitch:Infinity},'view-right-up'),'front');
});

test('studio gaze uses screen direction and always clears opposite eye signals',()=>{
  const g=gazeChannels(-.75,.5);
  assert.equal(g.eyeLookInLeft,.75);assert.equal(g.eyeLookOutRight,.75);
  assert.equal(g.eyeLookOutLeft,0);assert.equal(g.eyeLookInRight,0);
  assert.equal(g.eyeLookDownLeft,.5);assert.equal(g.eyeLookUpLeft,0);
  assert.ok(Object.values(gazeChannels(Infinity,NaN)).every(v=>v===0));
});

test('quick actions preserve independently chosen groups while replacing conflicts in their own group',()=>{
  let c=applyStudioPreset({},'pucker');c=applyStudioPreset(c,'winkLeft');c=applyStudioPreset(c,'asymmetric');
  assert.equal(c.mouthPucker,1);assert.equal(c.eyeBlinkLeft,1);assert.equal(c.browOuterUpLeft,1);assert.equal(c.browDownRight,1);
  c=applyStudioPreset(c,'press');assert.equal(c.mouthPucker,0);assert.equal(c.mouthPressLeft,1);assert.equal(c.eyeBlinkLeft,1);
  c=applyStudioPreset(c,'browNeutral');assert.equal(c.browOuterUpLeft,0);assert.equal(c.browDownRight,0);assert.equal(c.mouthPressLeft,1);
  c=applyStudioPreset(c,'neutral');assert.equal(c.eyeBlinkLeft,0);assert.equal(c.eyeBlinkRight,0);assert.equal(c.mouthPressLeft,1);
  assert.throws(()=>applyStudioPreset(c,'__proto__'));
});

test('studio frame import accepts real ARKit envelopes but refuses invalid known values atomically',()=>{
  for(const data of [{jawOpen:.7},{coefficients:{jawOpen:.7}},{blendshapes:{jawOpen:.7}}]) {
    const parsed=parseStudioFrame(JSON.stringify(data));assert.equal(parsed.coefficients.jawOpen,.7);
    assert.equal(Object.keys(parsed.coefficients).length,22);assert.equal(parsed.coefficients.browInnerUp,0);
  }
  const frame=parseStudioFrame('{"mouthLeft":1,"tongueOut":0.5,"__proto__":{"jawOpen":1}}');
  assert.deepEqual(frame.ignored,['tongueOut','__proto__']);assert.equal(frame.coefficients.jawOpen,0);
  for(const input of ['{','null','[]','{"coefficients":null}','{"tongueOut":1}','{"browInnerUp":null}',
    '{"jawOpen":1.1}','{"jawOpen":-0.1}','{"jawOpen":"1"}','{"jawOpen":1e999}'])assert.throws(()=>parseStudioFrame(input),input);
  assert.throws(()=>parseStudioFrame(' '.repeat(65537)));
});

test('project round trips keep manual settings and exclude camera state, permission, image paths and credentials',()=>{
  const project=createStudioProject({name:'  自己的角色  ',poseId:'view-down',coefficients:{mouthRight:.8},faceOnly:false,followHead:true,
    source:'camera',cameraActive:true,apiKey:'not-a-real-key',imageUrl:'https://example.invalid'});
  assert.deepEqual(parseStudioProject(JSON.stringify(project)),project);assert.equal(project.name,'自己的角色');
  for(const key of ['source','cameraActive','apiKey','imageUrl'])assert.equal(project[key],undefined);
  assert.equal(project.poseId,'view-down');assert.equal(project.faceOnly,false);assert.equal(project.followHead,true);
  for(const mutation of [p=>p.schemaVersion=2,p=>p.characterId='old-luna',p=>p.poseId='unsupported',p=>p.coefficients.jawOpen='1']) {
    const broken=structuredClone(project);mutation(broken);assert.throws(()=>parseStudioProject(JSON.stringify(broken)));
  }
});

test('demo spans every prepared pose only when touring is enabled and never emits unsupported coefficients',()=>{
  assert.equal(STUDIO_CHANNELS.length,22);
  const seen=new Set();
  for(let time=0;time<STUDIO_DEMO_DURATION;time+=2000) {
    const current=sampleStudioDemo(time,'view-right',true);seen.add(current.poseId);
    assert.equal(sampleStudioDemo(time,'view-right',false).poseId,'view-right');
    assert.equal(Object.keys(current.coefficients).length,22);
    assert.ok(Object.values(current.coefficients).every(v=>Number.isFinite(v)&&v>=0&&v<=1));
  }
  assert.equal(seen.size,9);assert.deepEqual(sampleStudioDemo(0),sampleStudioDemo(STUDIO_DEMO_DURATION));
});

test('continuous project coordinates survive save/load and older projects resolve to their painted vertex',()=>{
  const project=createStudioProject({headPose:{yaw:.347,pitch:-.693},coefficients:{jawOpen:.4}});
  assert.equal(project.poseId,'view-down');
  assert.deepEqual(parseStudioProject(JSON.stringify(project)).headPose,{yaw:.347,pitch:-.693});
  const legacy={...project,poseId:'view-right-up'};delete legacy.headPose;
  assert.deepEqual(parseStudioProject(JSON.stringify(legacy)).headPose,{yaw:1,pitch:1});
  for(const headPose of [null,{yaw:.5},{yaw:1.01,pitch:0},{yaw:'1',pitch:0},{yaw:0,pitch:0,url:'x'}])
    assert.throws(()=>parseStudioProject(JSON.stringify({...project,headPose})));
});

test('full frame imports restore fractional coordinates while plain coefficient input keeps pose unspecified',()=>{
  const parsed=parseStudioFrame(JSON.stringify({schemaVersion:2,kind:'moemotion-short-hair-frame',
    headPose:{yaw:-.321,pitch:.765},coefficients:{jawOpen:.4}}));
  assert.deepEqual(parsed.headPose,{yaw:-.321,pitch:.765});assert.equal(parsed.poseId,'view-up');
  assert.equal(parseStudioFrame('{"jawOpen":0.4}').headPose,undefined);
  assert.deepEqual(parseStudioFrame('{"poseId":"view-left","coefficients":{"jawOpen":0.4}}').headPose,{yaw:-1,pitch:0});
  for(const data of [{poseId:'missing',coefficients:{jawOpen:.4}},
    {headPose:{yaw:5,pitch:0},coefficients:{jawOpen:.4}},
    {headPose:{yaw:0,pitch:0,video:[]},coefficients:{jawOpen:.4}}])
    assert.throws(()=>parseStudioFrame(JSON.stringify(data)));
});

test('transparent projects default on, round-trip false and reject ambiguous imported flags',()=>{
  assert.equal(createStudioProject().transparent,true);
  const opaque=createStudioProject({transparent:false});
  assert.equal(parseStudioProject(JSON.stringify(opaque)).transparent,false);
  const legacy={...opaque};delete legacy.transparent;
  assert.equal(parseStudioProject(JSON.stringify(legacy)).transparent,true);
  for(const value of [null,0,1,'false',{}]) {
    assert.throws(()=>createStudioProject({transparent:value}));
    assert.throws(()=>parseStudioProject(JSON.stringify({...opaque,transparent:value})));
  }
});

test('v2 single-frame preview restores an explicit transparent flag without changing plain coefficient imports',()=>{
  const frame={schemaVersion:2,coefficients:{jawOpen:.3},headPose:{yaw:.2,pitch:.4},preview:{transparent:false}};
  assert.equal(parseStudioFrame(JSON.stringify(frame)).transparent,false);
  assert.equal(parseStudioFrame('{"jawOpen":0.3}').transparent,undefined);
  for(const transparent of [null,0,1,'false'])
    assert.throws(()=>parseStudioFrame(JSON.stringify({...frame,preview:{transparent}})));
});

test('v0.18 project saves composition and a frozen secondary frame but never auto-runs it',()=>{
  const composition={scale:1.4,x:.2,y:-.3,mirror:true},secondary={breath:.2,sway:-.1,hair:.5};
  const result=parseStudioProject(JSON.stringify(createStudioProject({composition,secondary,secondarySettings:{enabled:true,intensity:.8}})));
  assert.deepEqual(result.composition,composition);assert.deepEqual(result.secondary,secondary);
  assert.deepEqual(result.secondarySettings,{enabled:false,intensity:.8});
  const old=createStudioProject();assert.deepEqual(old.secondary,{breath:0,sway:0,hair:0});
  for(const value of [{scale:9,x:0,y:0,mirror:false},{scale:1,x:0,y:0},null])
    assert.throws(()=>parseStudioProject(JSON.stringify({...old,composition:value})));
  for(const value of [{breath:2,sway:0,hair:0},{breath:0,sway:0},null])
    assert.throws(()=>parseStudioProject(JSON.stringify({...old,secondary:value})));
});
test('single frame accepts strict secondary values without enabling movement',()=>{
  const secondary={breath:.1,sway:-.2,hair:.3};
  assert.deepEqual(parseStudioFrame(JSON.stringify({coefficients:{jawOpen:.5},secondary})).secondary,secondary);
  assert.throws(()=>parseStudioFrame(JSON.stringify({coefficients:{jawOpen:.5},secondary:{...secondary,hair:Infinity}})));
});
