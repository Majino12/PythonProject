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

test('uncapped tracking and turn paths agree at 30 and 60 Hz and settle without overshoot',()=>{
  const target={yaw:.3,pitch:-.2};
  function atRate(rate,mode) {
    let motion=targetStudioPoseMotion(createStudioPoseMotion(),target);
    for(let i=0;i<rate/2;i++) {
      const proposal=advanceStudioPoseMotion(motion,1000/rate,{mode});
      assert.ok(proposal.headPose.yaw>=motion.current.yaw && proposal.headPose.yaw<=target.yaw);
      assert.ok(proposal.headPose.pitch<=motion.current.pitch && proposal.headPose.pitch>=target.pitch);
      motion=proposal.motion;
    }
    return motion;
  }
  for(const mode of ['tracking','turn']){
    const slow=atRate(30,mode),fast=atRate(60,mode);
    for(const key of ['yaw','pitch'])assert.ok(Math.abs(slow.current[key]-fast.current[key])<1e-12);
    let motion=fast,result;
    for(let i=0;i<120;i++){result=advanceStudioPoseMotion(motion,1000/60,{mode});motion=result.motion;}
    assert.equal(result.moving,false);assert.deepEqual(result.headPose,target);
  }
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
  assert.throws(()=>advanceStudioPoseMotion(motion,16,{mode:'other'}));
  assert.throws(()=>targetStudioPoseMotion(motion,{yaw:3,pitch:0}));
});

test('stable and responsive presets have distinct bounded motion without nine-step thresholds',()=>{
  const motion=targetStudioPoseMotion(createStudioPoseMotion(),{yaw:.37,pitch:.19});
  const fast=advanceStudioPoseMotion(motion,33,{preset:'responsive'}),slow=advanceStudioPoseMotion(motion,33,{preset:'stable'});
  assert.ok(fast.headPose.yaw>slow.headPose.yaw && fast.headPose.yaw<.37);
  assert.ok(slow.headPose.yaw>0);
});

const headDistance=(a,b)=>Math.hypot(a.yaw-b.yaw,a.pitch-b.pitch);

test('manual turns have a deliberate pace independent of the camera sensitivity preset',()=>{
  const initial=targetStudioPoseMotion(createStudioPoseMotion(),'view-right');
  let tracking=initial,turn=initial,turnStable=initial;
  for(let i=0;i<12;i++){
    tracking=advanceStudioPoseMotion(tracking,1000/60).motion;
    turn=advanceStudioPoseMotion(turn,1000/60,{mode:'turn',preset:'responsive'}).motion;
    turnStable=advanceStudioPoseMotion(turnStable,1000/60,{mode:'turn',preset:'stable'}).motion;
  }
  assert.deepEqual(turn,turnStable);
  assert.ok(turn.current.yaw>.4&&turn.current.yaw<.55,'200 ms still shows the middle of the turn');
  assert.ok(tracking.current.yaw>.85,'ordinary tracking keeps its responsive preset');
  assert.deepEqual(advanceStudioPoseMotion(initial,16),advanceStudioPoseMotion(initial,16,{mode:'tracking'}));
});

test('turns retain intermediate displayed angles at 60, 30, 15 and 10 Hz',()=>{
  const paths=[['front','view-right'],['view-left','view-right'],['view-left-down','view-right-up'],
    [{yaw:-.63,pitch:.27},{yaw:.347,pitch:-.219}]];
  for(const mode of ['tracking','turn'])for(const preset of ['responsive','balanced','stable'])for(const hz of [60,30,15,10]){
    const limit=mode==='turn'?.10:.14;
    for(const [from,to] of paths){
      const destination=typeof to==='string'?poseHeadCoordinates(to):to;
      const initial=targetStudioPoseMotion(createStudioPoseMotion(from),destination);
      let motion=initial,result,frames=0;
      const intermediate=[];
      do{
        result=advanceStudioPoseMotion(motion,1000/hz,{mode,preset});
        assert.ok(headDistance(result.headPose,motion.current)<=limit+1e-12,`${mode}/${preset}/${hz} Hz skips an intermediate`);
        for(const axis of ['yaw','pitch']){
          assert.ok(result.headPose[axis]>=Math.min(initial.current[axis],destination[axis])-1e-12);
          assert.ok(result.headPose[axis]<=Math.max(initial.current[axis],destination[axis])+1e-12);
        }
        if(result.moving)intermediate.push(result.headPose);
        motion=result.motion;
        assert.ok(++frames<400,'all targets must actually settle');
      }while(result.moving);
      assert.deepEqual(result.headPose,destination);
      assert.ok(intermediate.length>=Math.ceil(headDistance(initial.current,destination)/limit)-1);
      assert.ok(intermediate.some(head=>Math.abs(head.yaw)>.01&&Math.abs(head.yaw)<.99),'intermediates are not authored-direction labels');
    }
  }
});

test('the displayed step bound follows the two-axis trajectory instead of clipping each axis',()=>{
  const start={yaw:-1,pitch:-.4},target={yaw:1,pitch:.37},dx=2,dy=.77;
  for(const mode of ['tracking','turn']){
    const limit=mode==='turn'?.10:.14;
    let motion=targetStudioPoseMotion(createStudioPoseMotion(start),target),bounded=0;
    for(let i=0;i<12;i++){
      const result=advanceStudioPoseMotion(motion,1000,{mode});
      const step=headDistance(result.headPose,motion.current);
      if(step>limit-1e-9)bounded++;
      assert.ok(Math.abs((result.headPose.yaw-start.yaw)*dy-(result.headPose.pitch-start.pitch)*dx)<1e-12);
      motion=result.motion;
    }
    assert.ok(bounded>0,'exercise the time reduction, not only an uncapped small turn');
  }
});

test('stalls discard elapsed debt and leave enough poses for later successful draws',()=>{
  for(const mode of ['tracking','turn']){
    const initial=targetStudioPoseMotion(createStudioPoseMotion('view-left-down'),'view-right-up');
    const delayed=advanceStudioPoseMotion(initial,10000,{mode});
    assert.deepEqual(delayed,advanceStudioPoseMotion(initial,1000/30,{mode}));
    assert.equal(delayed.moving,true);
    assert.deepEqual(advanceStudioPoseMotion(delayed.motion,0,{mode}).headPose,delayed.headPose);
    assert.deepEqual(advanceStudioPoseMotion(initial,10000,{mode}),delayed,'failed draw can retry without consuming state');
    const resumed=advanceStudioPoseMotion(delayed.motion,1000/60,{mode});
    assert.ok(headDistance(resumed.headPose,delayed.headPose)<=(mode==='turn'?.10:.14)+1e-12);
  }
});

test('rapid reversals and a mode change stay bounded and settle at the latest arbitrary angle',()=>{
  const finalTarget={yaw:-.273,pitch:.618};
  let motion=createStudioPoseMotion(),last;
  for(let i=0;i<80;i++){
    motion=targetStudioPoseMotion(motion,{yaw:i%3===0?-1:1,pitch:i%5===0?-1:.7});
    const mode=i%2?'turn':'tracking';
    last=advanceStudioPoseMotion(motion,i%4===0?400:16,{mode,preset:'responsive'});
    assert.ok(headDistance(last.headPose,motion.current)<=(mode==='turn'?.10:.14)+1e-12);
    motion=last.motion;
  }
  motion=targetStudioPoseMotion(motion,finalTarget);
  for(let i=0;i<300;i++){
    last=advanceStudioPoseMotion(motion,1000/60,{mode:'turn'});
    assert.ok(headDistance(last.headPose,motion.current)<=.10+1e-12);
    motion=last.motion;
    if(!last.moving)break;
  }
  assert.equal(last.moving,false);
  assert.deepEqual(last.headPose,finalTarget);
  const frozen=freezeStudioPoseMotion(motion);
  assert.deepEqual(advanceStudioPoseMotion(frozen,1000,{mode:'turn'}).headPose,finalTarget);
});
