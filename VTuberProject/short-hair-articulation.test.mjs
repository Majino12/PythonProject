import test from 'node:test';
import assert from 'node:assert/strict';
import {ARTICULATION_DEFAULT_STATE,ARTICULATION_EYES,ARTICULATION_JAW,ARTICULATION_SPECIAL_MOUTHS,
  ARTICULATION_MAX_STEP,ARTICULATION_MAX_FRAME_MS,articulationFromState,articulationState,
  validateArticulation,validateArticulationState,interpolateArticulation,
  createArticulationMotion,restoreArticulationMotion,targetArticulationMotion,
  freezeArticulationMotion,advanceArticulationMotion,advanceAuthoredGaze,authoredGazeChannels} from './short-hair-articulation.js';

const target=changes=>({...ARTICULATION_DEFAULT_STATE,...changes});
const frame=changes=>({...articulationFromState(),...changes});
const eyePosition=part=>ARTICULATION_EYES.indexOf(part.from)*(1-part.t)+ARTICULATION_EYES.indexOf(part.to)*part.t;
const near=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
function run(initial,goal,rate=60,profile='natural'){
  let motion=targetArticulationMotion(createArticulationMotion(initial),goal),result,frames=[];
  for(let i=0;i<600;i++){
    result=advanceArticulationMotion(motion,1000/rate,{profile});motion=result.motion;frames.push(result.articulation);
    if(!result.moving)return {result,frames,duration:frames.length*1000/rate};
  }
  assert.fail('did not reach exact endpoint');
}

test('articulation canonicalizes endpoints and owns independent validated copies',()=>{
  const input=frame({eyeLeft:{from:'open',to:'quarter',t:1},mouth:{from:'neutral',to:'pucker',t:.3}});
  const checked=validateArticulation(input);assert.deepEqual(checked.eyeLeft,{from:'quarter',to:'quarter',t:0});
  input.mouth.t=.9;assert.equal(checked.mouth.t,.3);
  assert.deepEqual(articulationState(checked),target({eyeLeft:'quarter'}));
  assert.deepEqual(articulationFromState(),frame({}));
  assert.deepEqual(validateArticulationState(target({mouth:'press'})),target({mouth:'press'}));
});

test('invalid descriptors cannot invent artwork, graph edges or hidden protocol fields',()=>{
  for(const bad of [null,[],{}, {...frame({}),unknown:{}},frame({eyeLeft:{from:'open',to:'closed',t:.5}}),
    frame({mouth:{from:'pucker',to:'press',t:.5}}),frame({browLeft:{from:'up',to:'down',t:.5}}),
    frame({mouth:{from:'neutral',to:'neutral',t:.1}}),frame({mouth:{from:'neutral',to:'pucker',t:NaN}}),
    frame({mouth:{from:'neutral',to:'pucker',t:Infinity}}),frame({mouth:{from:'neutral',to:'pucker',t:'0.2'}}),
    frame({mouth:{from:'neutral',to:'pucker',t:1.01}}),frame({mouth:{from:'neutral',to:'pucker',t:.2,src:'remote'}})])
    assert.throws(()=>validateArticulation(bad));
  assert.throws(()=>createArticulationMotion(target({eyeLeft:'missing'})));
  assert.throws(()=>validateArticulationState({...target({}),unknown:'neutral'}));
});

test('a full blink has genuine fractional positions and precise endpoints at 60 and 30 Hz',()=>{
  for(const rate of [30,60]){
    const closed=run(target({}),target({eyeLeft:'closed',eyeRight:'closed'}),rate);
    let previous=0;
    for(const art of closed.frames){const position=eyePosition(art.eyeLeft);
      assert.ok(position>=previous);assert.ok(position-previous<=ARTICULATION_MAX_STEP+1e-10);
      assert.deepEqual(art.eyeRight,art.eyeLeft);previous=position;
    }
    assert.equal(previous,4);assert.ok(closed.frames.filter(a=>a.eyeLeft.t>0).length>=4);
    assert.deepEqual(closed.result.state,target({eyeLeft:'closed',eyeRight:'closed'}));
    const opened=run(closed.result.state,target({}),rate);
    assert.deepEqual(opened.result.articulation,articulationFromState());
    assert.ok(closed.duration>=140&&closed.duration<=300);
    assert.ok(opened.duration>=190&&opened.duration<=300);
  }
});

test('retargeting or reversing preserves the exact displayed mixture without switching its source pair',()=>{
  let motion=targetArticulationMotion(createArticulationMotion(),target({eyeLeft:'closed'}));
  motion=advanceArticulationMotion(motion,12).motion;
  const before=structuredClone(motion.current),reversed=targetArticulationMotion(motion,target({}));
  assert.deepEqual(reversed.current,before);assert.equal(reversed.current.eyeLeft.from,'open');
  const result=advanceArticulationMotion(reversed,8);
  assert.equal(result.articulation.eyeLeft.from,'open');assert.equal(result.articulation.eyeLeft.to,'quarter');
  assert.ok(result.articulation.eyeLeft.t>0&&result.articulation.eyeLeft.t<before.eyeLeft.t);
});

test('mouth branches visibly route through neutral and can change direction midway',()=>{
  let motion=targetArticulationMotion(createArticulationMotion(target({mouth:'press'})),target({mouth:'pucker'}));
  const samples=[];
  for(let i=0;i<30;i++){
    const result=advanceArticulationMotion(motion,15);motion=result.motion;samples.push(result.articulation.mouth);
    if(!result.moving)break;
  }
  assert.ok(samples.some(part=>part.from==='neutral'&&part.to==='neutral'));
  assert.ok(samples.some(part=>part.from==='press'&&part.to==='neutral'&&part.t>0));
  assert.ok(samples.some(part=>part.from==='neutral'&&part.to==='pucker'&&part.t>0));
  assert.deepEqual(samples.at(-1),{from:'pucker',to:'pucker',t:0});
  motion=restoreArticulationMotion(frame({mouth:{from:'neutral',to:'pucker',t:.4}}));
  motion=targetArticulationMotion(motion,target({mouth:'shiftLeft'}));
  const reversed=advanceArticulationMotion(motion,15);
  assert.deepEqual(reversed.articulation.mouth,{from:'neutral',to:'pucker',t:.30000000000000004});
});

test('brow changes are continuous and contrary states pass through neutral',()=>{
  const motion=targetArticulationMotion(createArticulationMotion(target({browLeft:'up'})),target({browLeft:'down'}));
  const first=advanceArticulationMotion(motion,16);
  assert.equal(first.articulation.browLeft.from,'up');assert.equal(first.articulation.browLeft.to,'neutral');
  near(first.articulation.browLeft.t,.1);assert.equal(first.moving,true);
  const halfway=interpolateArticulation(articulationFromState(target({browLeft:'up'})),articulationFromState(target({browLeft:'down'})),.5);
  assert.deepEqual(halfway.browLeft,{from:'neutral',to:'neutral',t:0});
});

test('failed draws can retry the same immutable proposal; freezing/restoring never completes a hidden transition',()=>{
  const committed=targetArticulationMotion(createArticulationMotion(),target({mouth:'openWide'}));
  const first=advanceArticulationMotion(committed,16),retry=advanceArticulationMotion(committed,16);
  assert.deepEqual(first,retry);assert.deepEqual(committed.current,articulationFromState());
  assert.ok(Object.isFrozen(first.motion.current.mouth));
  for(const motion of [freezeArticulationMotion(first.motion),restoreArticulationMotion(first.articulation)]){
    const frozen=advanceArticulationMotion(motion,10000);
    assert.deepEqual(frozen.articulation,first.articulation);assert.equal(frozen.moving,false);
  }
  const resumed=targetArticulationMotion(freezeArticulationMotion(first.motion),target({mouth:'openWide'}));
  assert.ok(advanceArticulationMotion(resumed,16).articulation.mouth.t>first.articulation.mouth.t);
});

test('stalls remain bounded, leave no elapsed debt and invalid times/options fail',()=>{
  const motion=targetArticulationMotion(createArticulationMotion(),target({eyeLeft:'closed',mouth:'openWide'}));
  assert.deepEqual(advanceArticulationMotion(motion,10000),advanceArticulationMotion(motion,ARTICULATION_MAX_FRAME_MS));
  const frame=advanceArticulationMotion(motion,10000);
  assert.ok(eyePosition(frame.articulation.eyeLeft)<=.5);
  assert.strictEqual(advanceArticulationMotion(frame.motion,0).motion,frame.motion);
  for(const dt of [-1,NaN,Infinity,'16'])assert.throws(()=>advanceArticulationMotion(motion,dt));
  assert.throws(()=>advanceArticulationMotion(motion,16,{profile:'invalid'}));
  assert.throws(()=>advanceArticulationMotion({...motion,paused:1},16));
});

test('clip interpolation respects same and reversed edge coordinates with exact endpoints',()=>{
  const a=frame({eyeLeft:{from:'quarter',to:'half',t:.2}}),b=frame({eyeLeft:{from:'half',to:'quarter',t:.2}});
  near(interpolateArticulation(a,b,.5).eyeLeft.t,.5);
  assert.deepEqual(interpolateArticulation(a,b,0),a);assert.deepEqual(interpolateArticulation(a,b,1),b);
  const identical=frame({eyeLeft:{from:'half',to:'quarter',t:.8}});
  for(const t of [0,.2,.5,.9,1])near(eyePosition(interpolateArticulation(a,identical,t).eyeLeft),1.2);
});

test('clip interpolation traverses skipped authored nodes and the neutral mouth junction continuously',()=>{
  const a=frame({eyeLeft:{from:'open',to:'quarter',t:.2}}),b=frame({eyeLeft:{from:'threeQuarter',to:'closed',t:.8}});
  for(let i=0;i<=100;i++){const amount=i/100;near(eyePosition(interpolateArticulation(a,b,amount).eyeLeft),.2+3.6*amount);}
  const pucker=articulationFromState(target({mouth:'pucker'})),press=articulationFromState(target({mouth:'press'}));
  assert.deepEqual(interpolateArticulation(pucker,press,.5).mouth,{from:'neutral',to:'neutral',t:0});
  assert.deepEqual(interpolateArticulation(pucker,press,.25).mouth,{from:'pucker',to:'neutral',t:.5});
  assert.deepEqual(interpolateArticulation(pucker,press,.75).mouth,{from:'neutral',to:'press',t:.5});
  for(const t of [-.1,1.1,NaN,Infinity,'0.5'])assert.throws(()=>interpolateArticulation(a,b,t));
});

test('all authored mouth pairs reach their exact target and rapid changes remain valid and bounded',()=>{
  for(const from of [...ARTICULATION_JAW,...ARTICULATION_SPECIAL_MOUTHS])for(const to of [...ARTICULATION_JAW,...ARTICULATION_SPECIAL_MOUTHS]){
    const result=run(target({mouth:from}),target({mouth:to}));
    assert.deepEqual(result.result.articulation.mouth,{from:to,to,t:0});
  }
  let motion=createArticulationMotion();
  for(let i=0;i<300;i++){
    const before=eyePosition(motion.current.eyeLeft);
    motion=targetArticulationMotion(motion,target({eyeLeft:ARTICULATION_EYES[i%5],mouth:ARTICULATION_SPECIAL_MOUTHS[i%4],browRight:i%2?'up':'down'}));
    const result=advanceArticulationMotion(motion,[16,33,1000][i%3]);motion=result.motion;
    validateArticulation(result.articulation);assert.ok(Math.abs(eyePosition(motion.current.eyeLeft)-before)<=.5000000001);
  }
});

test('quick profile changes duration while preserving the same authored route',()=>{
  const goal=target({mouth:'openWide'}),normal=run(target({}),goal,60),quick=run(target({}),goal,60,'quick');
  assert.ok(quick.duration<normal.duration);assert.deepEqual(quick.result.articulation,normal.result.articulation);
});


test('manual gaze retargets from its visible per-eye coordinates with no skipped-frame debt',()=>{
  const current={eyeLeft:{x:0,y:0},eyeRight:{x:.2,y:-.3}},target={eyeLeft:{x:1,y:-1},eyeRight:{x:-1,y:1}};
  const before=structuredClone(current),first=advanceAuthoredGaze(current,target,10000);
  assert.deepEqual(current,before);assert.equal(first.moving,true);
  for(const eye of ['eyeLeft','eyeRight'])for(const axis of ['x','y'])assert.ok(Math.abs(first.gaze[eye][axis]-current[eye][axis])<=.25);
  assert.deepEqual(advanceAuthoredGaze(first.gaze,current,0).gaze,first.gaze);
  const reverse=advanceAuthoredGaze(first.gaze,current,1000/60);
  assert.ok(reverse.gaze.eyeLeft.x<first.gaze.eyeLeft.x);
  const channels=authoredGazeChannels(reverse.gaze);
  assert.equal(channels.eyeLookOutLeft-channels.eyeLookInLeft,reverse.gaze.eyeLeft.x);
  assert.equal(channels.eyeLookInRight-channels.eyeLookOutRight,reverse.gaze.eyeRight.x);
  assert.equal(channels.eyeLookDownLeft-channels.eyeLookUpLeft,reverse.gaze.eyeLeft.y);
  assert.equal(channels.eyeLookDownRight-channels.eyeLookUpRight,reverse.gaze.eyeRight.y);
  let displayed=first;
  for(let frame=0;frame<100&&displayed.moving;frame++)displayed=advanceAuthoredGaze(displayed.gaze,target,1000/60);
  assert.equal(displayed.moving,false);assert.deepEqual(displayed.gaze,target);
  assert.throws(()=>advanceAuthoredGaze(current,target,NaN));assert.throws(()=>advanceAuthoredGaze(current,{eyeLeft:{x:2,y:0},eyeRight:{x:0,y:0}},16));
});
