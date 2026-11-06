import test from 'node:test';
import assert from 'node:assert/strict';
import {STUDIO_HEAD_POSES, poseHeadCoordinates,validateHeadPose,normalizeHeadPose,normalizeCameraHeadPose,
  nearestStudioPoseId,createStudioPoseMotion,targetStudioPoseMotion,advanceStudioPoseMotion,freezeStudioPoseMotion}
  from './short-hair-pose-motion.js';

test('the nine authored vertices share one continuous coordinate grid',()=>{
  for(const pose of STUDIO_HEAD_POSES) {
    assert.deepEqual(poseHeadCoordinates(pose.id),{yaw:pose.yaw,pitch:pose.pitch});
    assert.equal(nearestStudioPoseId(poseHeadCoordinates(pose.id)),pose.id);
  }
  assert.throws(()=>poseHeadCoordinates('other'));
  assert.deepEqual(normalizeHeadPose({yaw:99,pitch:NaN},{yaw:0,pitch:-.2}),{yaw:1,pitch:-.2});
});

test('untrusted coordinates reject extra fields, partial data, strings and nonfinite numbers',()=>{
  for(const value of [null,[],{yaw:0},{yaw:0,pitch:0,model:'url'},{yaw:'0',pitch:0},
    {yaw:NaN,pitch:0},{yaw:Infinity,pitch:0},{yaw:1.0001,pitch:0}])assert.throws(()=>validateHeadPose(value));
  const input={yaw:.234,pitch:-.789},valid=validateHeadPose(input);input.yaw=1;
  assert.equal(valid.yaw,.234);
});

test('camera range reaches actual side paintings without quantizing intermediate coordinates',()=>{
  assert.deepEqual(normalizeCameraHeadPose({yaw:.42,pitch:-.42}),{yaw:1,pitch:-1});
  assert.ok(Math.abs(normalizeCameraHeadPose({yaw:.22}).yaw-.5)<1e-12);
  assert.equal(normalizeCameraHeadPose({yaw:.019}).yaw,0);
  assert.ok(normalizeCameraHeadPose({yaw:.02001}).yaw>0);
  const samples=Array.from({length:39},(_,i)=>normalizeCameraHeadPose({yaw:.03+i*.01}).yaw);
  assert.equal(new Set(samples).size,samples.length);
  for(const options of [{fullScale:0},{fullScale:NaN},{deadzone:-1},{deadzone:.5}])
    assert.throws(()=>normalizeCameraHeadPose({},options));
});

test('damping yields the same path at 30 and 60 Hz and settles without overshoot',()=>{
  function atRate(rate) {
    let motion=targetStudioPoseMotion(createStudioPoseMotion(),{yaw:.87,pitch:-.64});
    for(let i=0;i<rate/2;i++) {
      const proposal=advanceStudioPoseMotion(motion,1000/rate);
      assert.ok(proposal.headPose.yaw>=motion.current.yaw && proposal.headPose.yaw<=.87);
      assert.ok(proposal.headPose.pitch<=motion.current.pitch && proposal.headPose.pitch>=-.64);
      motion=proposal.motion;
    }
    return motion;
  }
  const slow=atRate(30),fast=atRate(60);
  for(const key of ['yaw','pitch'])assert.ok(Math.abs(slow.current[key]-fast.current[key])<1e-12);
  let motion=fast,result;
  for(let i=0;i<120;i++){result=advanceStudioPoseMotion(motion,1000/60);motion=result.motion;}
  assert.equal(result.moving,false);assert.deepEqual(result.headPose,{yaw:.87,pitch:-.64});
});

test('a failed draw leaves the committed frame unchanged and repeats the identical proposal',()=>{
  const committed=targetStudioPoseMotion(createStudioPoseMotion(),{yaw:1,pitch:.8});
  const first=advanceStudioPoseMotion(committed,16),retry=advanceStudioPoseMotion(committed,16);
  assert.deepEqual(retry,first);assert.deepEqual(committed.current,{yaw:0,pitch:0});
  assert.notDeepEqual(first.headPose,committed.current);
  assert.ok(Object.isFrozen(first.motion.current));
});

test('mid-turn reversal replans from the displayed frame and freeze cancels residual velocity',()=>{
  let motion=targetStudioPoseMotion(createStudioPoseMotion(),{yaw:1,pitch:1});
  for(let i=0;i<6;i++)motion=advanceStudioPoseMotion(motion,16).motion;
  const before={...motion.current};
  motion=targetStudioPoseMotion(motion,{yaw:-1,pitch:-.2});
  assert.deepEqual(motion.current,before);
  for(let i=0;i<120;i++)motion=advanceStudioPoseMotion(motion,16).motion;
  assert.deepEqual(motion.current,{yaw:-1,pitch:-.2});
  const frozen=freezeStudioPoseMotion(motion),result=advanceStudioPoseMotion(frozen,100);
  assert.equal(result.moving,false);assert.deepEqual(result.headPose,frozen.current);
  assert.deepEqual(frozen.target,frozen.current);
});

test('stalls are bounded, zero elapsed cannot advance and invalid proposals throw',()=>{
  const motion=targetStudioPoseMotion(createStudioPoseMotion('view-left'),{yaw:1,pitch:1});
  assert.deepEqual(advanceStudioPoseMotion(motion,10000),advanceStudioPoseMotion(motion,100));
  assert.strictEqual(advanceStudioPoseMotion(motion,0).motion,motion);
  for(const dt of [-1,NaN,Infinity])assert.throws(()=>advanceStudioPoseMotion(motion,dt));
  assert.throws(()=>advanceStudioPoseMotion(motion,16,{preset:'other'}));
  assert.throws(()=>targetStudioPoseMotion(motion,{yaw:3,pitch:0}));
});

test('stable and responsive presets have distinct bounded motion without nine-step thresholds',()=>{
  const motion=targetStudioPoseMotion(createStudioPoseMotion(),{yaw:.37,pitch:.19});
  const fast=advanceStudioPoseMotion(motion,33,{preset:'responsive'}),slow=advanceStudioPoseMotion(motion,33,{preset:'stable'});
  assert.ok(fast.headPose.yaw>slow.headPose.yaw && fast.headPose.yaw<.37);
  assert.ok(slow.headPose.yaw>0);
});
