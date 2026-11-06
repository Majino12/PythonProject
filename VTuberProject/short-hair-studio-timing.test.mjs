import test from 'node:test';
import assert from 'node:assert/strict';
import {StudioFrameClock,createStudioMotion,advanceStudioMotion,STUDIO_RENDER_FPS,STUDIO_RECORDING_FPS,STUDIO_MOTION_PROFILES} from './short-hair-studio-timing.js';

test('60 is an unmeasured scheduling/recording target, never a fabricated result',()=>{
  const clock=new StudioFrameClock();assert.equal(STUDIO_RENDER_FPS,60);assert.equal(STUDIO_RECORDING_FPS,60);
  for(let i=0;i<120;i++)clock.advance(i*1000/60);
  assert.equal(clock.snapshot(2000).measuredFps,null);assert.equal(clock.snapshot(2000).sampleCount,0);
});
test('60 Hz and 120 Hz callbacks each schedule 60 draws per second with no double scheduling',()=>{
  for(const hz of [60,120]){
    const clock=new StudioFrameClock();let renders=0,updates=0;
    for(let i=0;i<hz;i++){const now=i*1000/hz,result=clock.advance(now);renders+=result.render;updates+=result.updateUi;assert.equal(clock.advance(now).render,false);}
    assert.equal(renders,60);assert.equal(updates,10);
  }
});
test('fractional RAF jitter does not halve the render rate or cause catch-up bursts',()=>{
  const clock=new StudioFrameClock();let renders=0;
  for(let i=0;i<120;i++)renders+=clock.advance(i*1000/60+(i%2?.3:0)).render;
  assert.equal(renders,120);
  assert.deepEqual(clock.advance(10000),{render:true,dt:.1,updateUi:true});
  assert.equal(clock.advance(10000.1).render,false);assert.equal(clock.advance(10001).render,false);
});
test('30 target works on a 60 Hz callback stream and changing target resets timing and measurements',()=>{
  const clock=new StudioFrameClock({targetFps:30});let renders=0;
  for(let i=0;i<60;i++){const now=i*1000/60;if(clock.advance(now).render){renders++;clock.recordFrame(now,2);}}
  assert.equal(renders,30);assert.ok(Math.abs(clock.snapshot(990).measuredFps-30)<1e-9);
  assert.equal(clock.setTargetFps(60),true);assert.equal(clock.snapshot(990).measuredFps,null);
  assert.equal(clock.advance(1000).dt,1/60);assert.throws(()=>clock.setTargetFps(120));
});
test('slow successful output is measured as slow, not as the requested target',()=>{
  const clock=new StudioFrameClock();
  for(let i=0;i<21;i++){const now=i*50;clock.advance(now);clock.recordFrame(now,i===20?18:2);}
  const stats=clock.snapshot(1000);assert.equal(stats.targetFps,60);assert.equal(stats.measuredFps,20);
  assert.equal(stats.sampleCount,21);assert.equal(stats.averageRenderMs,58/21);assert.equal(stats.p95RenderMs,2);
  assert.equal(clock.snapshot(1500).measuredFps,null);assert.equal(clock.snapshot(1500).averageRenderMs,null);
});
test('measurement needs an observation window and ignores duplicate/invalid draws',()=>{
  const clock=new StudioFrameClock();
  assert.equal(clock.recordFrame(0,2),true);assert.equal(clock.recordFrame(0,2),false);
  assert.equal(clock.recordFrame(1,NaN),false);assert.equal(clock.recordFrame(-1,2),false);
  for(let i=1;i<12;i++)clock.recordFrame(i,2);
  assert.equal(clock.snapshot(11).measuredFps,null);
  clock.reset();for(let i=0;i<16;i++)clock.recordFrame(i*1000/60,3);
  assert.ok(Math.abs(clock.snapshot(250).measuredFps-60)<1e-9);
  assert.equal(clock.snapshot(3000).sampleCount,0);assert.equal(clock.snapshot(3000).measuredFps,null);
});
test('reset and clock rollback start a fresh interval; invalid callbacks do not mutate cadence',()=>{
  const clock=new StudioFrameClock();clock.advance(100);clock.recordFrame(100,2);
  assert.equal(clock.advance(NaN).render,false);assert.equal(clock.advance(-1).render,false);
  assert.deepEqual(clock.advance(50),{render:true,dt:1/60,updateUi:true});assert.equal(clock.snapshot(50).sampleCount,0);
  clock.reset();assert.deepEqual(clock.advance(1000),{render:true,dt:1/60,updateUi:true});
});

const sequences={eyeLeft:['open','quarter','half','threeQuarter','closed'],eyeRight:['open','quarter','half','threeQuarter','closed'],mouth:['neutral','parted','openSmall','openMedium','openWide']};
const neutral={eyeLeft:'open',eyeRight:'open',mouth:'neutral',browLeft:'neutral',browRight:'neutral'};
const target={...neutral,eyeLeft:'closed',eyeRight:'closed',mouth:'openWide'};

test('every prepared eyelid and jaw painting is visited in order even after long frame gaps',()=>{
  for(const gap of [1000/60,1000/30,100,10000]){
    let motion=createStudioMotion(neutral),done=false;const visited={eyeLeft:[],mouth:[]};
    for(let i=0;i<20&&!done;i++){
      const next=advanceStudioMotion(motion,target,gap,sequences);
      for(const group of Object.keys(visited))if(next.frameState[group]!==motion.frameState[group])visited[group].push(next.frameState[group]);
      motion=next.motion;done=!next.moving;
    }
    assert.equal(done,true);assert.deepEqual(visited,{eyeLeft:['quarter','half','threeQuarter','closed'],mouth:['parted','openSmall','openMedium','openWide']});
  }
});
test('uncommitted proposals cannot skip paintings and reverse inputs replan from the displayed frame',()=>{
  const shown=createStudioMotion(neutral),first=advanceStudioMotion(shown,target,20,sequences);
  assert.equal(first.frameState.eyeLeft,'quarter');assert.equal(shown.frameState.eyeLeft,'open');
  assert.equal(advanceStudioMotion(shown,target,200,sequences).frameState.eyeLeft,'quarter');
  const reverse=advanceStudioMotion(first.motion,neutral,40,sequences);
  assert.equal(reverse.frameState.eyeLeft,'open');assert.equal(reverse.frameState.mouth,'neutral');assert.equal(reverse.moving,false);
});
test('sub-frame callbacks hold their current art until the minimum interval elapses',()=>{
  const first=advanceStudioMotion(createStudioMotion(neutral),target,0,sequences);
  const waiting=advanceStudioMotion(first.motion,target,5,sequences);assert.equal(waiting.frameState.eyeLeft,'quarter');assert.equal(waiting.moving,true);
  const second=advanceStudioMotion(waiting.motion,target,19,sequences);assert.equal(second.frameState.eyeLeft,'half');
  const noDebt=advanceStudioMotion(advanceStudioMotion(second.motion,target,10000,sequences).motion,target,0,sequences);
  assert.equal(noDebt.frameState.eyeLeft,'threeQuarter');
});
test('eye and jaw timing are independent and 30/60 Hz do not double action duration',()=>{
  const durations=[];
  for(const fps of [30,60]){
    let motion=createStudioMotion(neutral),duration=0;
    // The first adjacent painting can be shown immediately; subsequent ones
    // hold their own eye/jaw interval independently of the chosen RAF target.
    motion=advanceStudioMotion(motion,target,0,sequences).motion;
    for(let i=0;i<30;i++){
      duration+=1000/fps;const next=advanceStudioMotion(motion,target,1000/fps,sequences);motion=next.motion;
      if(!next.moving)break;
    }
    durations.push(duration);
  }
  assert.ok(Math.abs(durations[0]-durations[1])<=1000/30);
  const initial=advanceStudioMotion(createStudioMotion(neutral),target,0,sequences);
  const timed=advanceStudioMotion(initial.motion,target,24,sequences);
  assert.equal(timed.frameState.eyeLeft,'half');assert.equal(timed.frameState.mouth,'parted');
});
test('eyes travel independently; special mouths and brows use their actual direct paintings',()=>{
  const goal={...neutral,eyeLeft:'closed',mouth:'pucker',browLeft:'innerUp',browRight:'down'};
  const next=advanceStudioMotion(createStudioMotion(neutral),goal,17,sequences);
  assert.deepEqual(next.frameState,{...goal,eyeLeft:'quarter'});assert.equal(next.frameState.eyeRight,'open');
  const jaw=advanceStudioMotion(next.motion,{...goal,mouth:'openWide'},17,sequences);assert.equal(jaw.frameState.mouth,'openWide');
});
test('old three-stage poses use only registered frames and reset boundaries snap exactly',()=>{
  const old={eyeLeft:['open','half','closed'],eyeRight:['open','half','closed'],mouth:['neutral','openSmall','openWide']};
  const first=advanceStudioMotion(createStudioMotion(neutral),target,17,old);assert.equal(first.frameState.eyeLeft,'half');assert.equal(first.frameState.mouth,'openSmall');
  const snapped=advanceStudioMotion(createStudioMotion(),target,0,sequences);assert.deepEqual(snapped.frameState,target);assert.equal(snapped.moving,false);
  assert.ok(Object.isFrozen(first.motion));assert.ok(Object.isFrozen(first.motion.frameState));
});
test('invalid timing or duplicate source stages fail explicitly',()=>{
  assert.throws(()=>new StudioFrameClock({targetFps:59}));assert.throws(()=>new StudioFrameClock({uiIntervalMs:1}));
  assert.throws(()=>advanceStudioMotion(createStudioMotion(neutral),target,NaN,sequences));
  assert.throws(()=>advanceStudioMotion(createStudioMotion(neutral),target,20,{eyeLeft:['open','open']}));
});

function playMouth(from,to,{profile='natural',fps=60,gap=1000/fps,paintings=sequences}={}) {
  let motion=createStudioMotion({...neutral,mouth:from}),duration=0,complete=false;
  const visits=[];
  for(let frame=0;frame<120;frame++) {
    const dt=frame===0?0:gap;
    const next=advanceStudioMotion(motion,{...neutral,mouth:to},dt,paintings,{profile});
    duration+=dt;
    if(next.frameState.mouth!==motion.frameState.mouth) visits.push(next.frameState.mouth);
    motion=next.motion;
    if(!next.moving) {complete=true;break;}
  }
  assert.equal(complete,true,'mouth transition must finish without a pending destination queue');
  return {visits,duration,motion};
}

test('natural and quick close all available jaw paintings before each special mouth',()=>{
  for(const profile of Object.keys(STUDIO_MOTION_PROFILES)) {
    for(const mouth of ['pucker','press','shiftLeft','shiftRight']) {
      assert.deepEqual(playMouth('openWide',mouth,{profile}).visits,
        ['openMedium','openSmall','parted','neutral',mouth]);
    }
  }
});

test('special mouths return through the real neutral painting before jaw or another special',()=>{
  for(const profile of Object.keys(STUDIO_MOTION_PROFILES)) {
    for(const mouth of ['pucker','press','shiftLeft','shiftRight']) {
      assert.deepEqual(playMouth(mouth,'openWide',{profile}).visits,
        ['neutral','parted','openSmall','openMedium','openWide']);
      assert.deepEqual(playMouth(mouth,'neutral',{profile}).visits,['neutral']);
      const other=mouth==='pucker'?'press':'pucker';
      assert.deepEqual(playMouth(mouth,other,{profile}).visits,['neutral',other]);
      assert.deepEqual(playMouth(mouth,mouth,{profile}).visits,[]);
    }
  }
});

test('neutral bridge has a visible dwell, including after a very long frame stall',()=>{
  for(const profile of Object.keys(STUDIO_MOTION_PROFILES)) {
    const options={profile},goal={...neutral,mouth:'shiftRight'};
    const bridge=advanceStudioMotion(createStudioMotion({...neutral,mouth:'pucker'}),goal,10000,sequences,options);
    assert.equal(bridge.frameState.mouth,'neutral');assert.equal(bridge.moving,true);
    const hold=advanceStudioMotion(bridge.motion,goal,0,sequences,options);
    assert.equal(hold.frameState.mouth,'neutral');
    const half=STUDIO_MOTION_PROFILES[profile].neutralHoldMs/2;
    const waiting=advanceStudioMotion(hold.motion,goal,half,sequences,options);
    assert.equal(waiting.frameState.mouth,'neutral');assert.equal(waiting.moving,true);
    const arrived=advanceStudioMotion(waiting.motion,goal,half,sequences,options);
    assert.equal(arrived.frameState.mouth,'shiftRight');assert.equal(arrived.moving,false);
  }
});

test('a changed target reverses the displayed jaw immediately without completing an old bridge',()=>{
  for(const profile of Object.keys(STUDIO_MOTION_PROFILES)) {
    const options={profile},start=createStudioMotion({...neutral,mouth:'openWide'});
    const closing=advanceStudioMotion(start,{...neutral,mouth:'pucker'},0,sequences,options);
    assert.equal(closing.frameState.mouth,'openMedium');
    const reversed=advanceStudioMotion(closing.motion,{...neutral,mouth:'openWide'},100,sequences,options);
    assert.equal(reversed.frameState.mouth,'openWide');assert.equal(reversed.moving,false);
    const held=advanceStudioMotion(reversed.motion,{...neutral,mouth:'openWide'},10000,sequences,options);
    assert.equal(held.frameState.mouth,'openWide');assert.equal(held.moving,false);
  }
});

test('a new target at neutral cancels the prior special or jaw destination',()=>{
  const options={profile:'natural'};
  for(const abandoned of ['openWide','press']) {
    const bridge=advanceStudioMotion(createStudioMotion({...neutral,mouth:'pucker'}),{...neutral,mouth:abandoned},100,sequences,options);
    assert.equal(bridge.frameState.mouth,'neutral');
    const interrupted=advanceStudioMotion(bridge.motion,{...neutral,mouth:'shiftLeft'},32,sequences,options);
    assert.equal(interrupted.frameState.mouth,'shiftLeft');assert.equal(interrupted.moving,false);
  }
  const bridge=advanceStudioMotion(createStudioMotion({...neutral,mouth:'pucker'}),{...neutral,mouth:'openWide'},100,sequences,options);
  const cancelled=advanceStudioMotion(bridge.motion,neutral,0,sequences,options);
  assert.equal(cancelled.frameState.mouth,'neutral');assert.equal(cancelled.moving,false);
});

test('rapid special target changes share the current neutral dwell instead of restarting it',()=>{
  for(const profile of Object.keys(STUDIO_MOTION_PROFILES)) {
    const options={profile},hold=STUDIO_MOTION_PROFILES[profile].neutralHoldMs;
    let motion=advanceStudioMotion(createStudioMotion({...neutral,mouth:'pucker'}),{...neutral,mouth:'press'},100,sequences,options).motion;
    assert.equal(motion.frameState.mouth,'neutral');
    for(const mouth of ['shiftLeft','press','shiftRight']) {
      const waiting=advanceStudioMotion(motion,{...neutral,mouth},hold/4,sequences,options);
      assert.equal(waiting.frameState.mouth,'neutral');motion=waiting.motion;
    }
    const latest=advanceStudioMotion(motion,{...neutral,mouth:'shiftLeft'},hold/4,sequences,options);
    assert.equal(latest.frameState.mouth,'shiftLeft');assert.equal(latest.moving,false);
  }
});

test('profile eye timing is independent while a mouth bridge is pending and brows stay authored',()=>{
  const options={profile:'natural'},start=createStudioMotion({...neutral,mouth:'openWide'});
  const goal={...neutral,eyeLeft:'closed',mouth:'pucker',browLeft:'up'};
  const first=advanceStudioMotion(start,goal,0,sequences,options);
  assert.equal(first.frameState.eyeLeft,'quarter');assert.equal(first.frameState.eyeRight,'open');
  assert.equal(first.frameState.mouth,'openMedium');assert.equal(first.frameState.browLeft,'up');
  const second=advanceStudioMotion(first.motion,goal,24,sequences,options);
  assert.equal(second.frameState.eyeLeft,'half');assert.equal(second.frameState.eyeRight,'open');
  assert.equal(second.frameState.mouth,'openMedium');assert.equal(second.moving,true);
});

test('profile proposals never skip uncommitted paintings, even after stalls',()=>{
  for(const profile of Object.keys(STUDIO_MOTION_PROFILES)) {
    const options={profile},shown=createStudioMotion({...neutral,mouth:'openWide'}),goal={...neutral,mouth:'pucker'};
    const proposal=advanceStudioMotion(shown,goal,10000,sequences,options);
    assert.equal(proposal.frameState.mouth,'openMedium');
    assert.equal(advanceStudioMotion(shown,goal,20000,sequences,options).frameState.mouth,'openMedium');
    assert.equal(shown.frameState.mouth,'openWide');
    assert.equal(advanceStudioMotion(proposal.motion,goal,0,sequences,options).frameState.mouth,'openMedium');
    assert.deepEqual(playMouth('openWide','pucker',{profile,gap:10000}).visits,
      ['openMedium','openSmall','parted','neutral','pucker']);
  }
});

test('30 and 60 Hz profile playback preserve routes and comparable elapsed duration',()=>{
  for(const profile of Object.keys(STUDIO_MOTION_PROFILES)) {
    for(const [from,to] of [['neutral','openWide'],['openWide','pucker'],['pucker','openWide'],['shiftLeft','shiftRight']]) {
      const slow=playMouth(from,to,{profile,fps:30}),fast=playMouth(from,to,{profile,fps:60});
      assert.deepEqual(slow.visits,fast.visits);
      assert.ok(Math.abs(slow.duration-fast.duration)<=1000/30+.001,
        `${profile} ${from} to ${to}: ${slow.duration} / ${fast.duration} ms`);
      assert.ok(slow.duration<400&&fast.duration<400,'authored mouth route must not add an excessive wait');
    }
  }
  for(const fps of [30,60]) {
    assert.ok(playMouth('pucker','openWide',{profile:'quick',fps}).duration
      <playMouth('pucker','openWide',{profile:'natural',fps}).duration);
  }
});

test('switching speed profiles continues from the shown painting without snapping to the goal',()=>{
  const goal={...neutral,mouth:'pucker'};
  const natural=advanceStudioMotion(createStudioMotion({...neutral,mouth:'openWide'}),goal,0,sequences,{profile:'natural'});
  const quick=advanceStudioMotion(natural.motion,goal,30,sequences,{profile:'quick'});
  assert.equal(quick.frameState.mouth,'openSmall');assert.equal(quick.moving,true);
});

test('profile routes respect three-stage artwork and exact reset/export boundaries',()=>{
  const old={eyeLeft:['open','half','closed'],eyeRight:['open','half','closed'],mouth:['neutral','openSmall','openWide']};
  assert.deepEqual(playMouth('openWide','press',{paintings:old}).visits,['openSmall','neutral','press']);
  assert.deepEqual(playMouth('press','openWide',{paintings:old}).visits,['neutral','openSmall','openWide']);
  for(const profile of Object.keys(STUDIO_MOTION_PROFILES)) {
    const goal={...target,mouth:'pucker'};
    const snap=advanceStudioMotion(createStudioMotion(),goal,0,sequences,{profile});
    assert.deepEqual(snap.frameState,goal);assert.equal(snap.moving,false);
    assert.ok(Object.isFrozen(snap.motion));assert.ok(Object.isFrozen(snap.motion.elapsedMs));
  }
});

test('profiles reject unknown speed and cannot invent an unregistered neutral bridge',()=>{
  assert.throws(()=>advanceStudioMotion(createStudioMotion(neutral),target,0,sequences,{profile:'fastest'}));
  assert.throws(()=>advanceStudioMotion(createStudioMotion(neutral),target,0,sequences,null));
  const special={...neutral,mouth:'pucker'},withoutNeutral={...sequences,mouth:['parted','openSmall','openWide']};
  assert.throws(()=>advanceStudioMotion(createStudioMotion({...neutral,mouth:'openWide'}),special,0,withoutNeutral,{profile:'natural'}),/中性画稿/);
  assert.throws(()=>advanceStudioMotion(createStudioMotion(neutral),special,0,{}, {profile:'quick'}),/实际张嘴画稿/);
});
