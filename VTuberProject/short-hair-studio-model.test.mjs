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
