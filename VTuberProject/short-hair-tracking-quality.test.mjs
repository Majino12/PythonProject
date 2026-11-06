import test from 'node:test';
import assert from 'node:assert/strict';
import {StudioTrackingSignalGate,StudioCalibrationQuality} from './short-hair-tracking-quality.js';
const pose=(x=0,y=0,roll=0)=>({x,y,roll});
const channels=(extra={})=>({eyeBlinkLeft:.04,eyeBlinkRight:.05,jawOpen:.025,...extra});
function acquired() {const gate=new StudioTrackingSignalGate();gate.push(pose(),0);gate.push(pose(.01),40);return gate;}
function calibration({start=0,count=31,step=100,makePose=()=>pose(.03,-.02),makeChannels=()=>channels()}={}) {
  const quality=new StudioCalibrationQuality();quality.begin(start);
  for(let i=0;i<count;i++)quality.add({pose:makePose(i),channels:makeChannels(i)},start+i*step);
  return quality;
}

test('camera acquisition needs two independent samples, never repeated rendering frames',()=>{
  const gate=new StudioTrackingSignalGate();
  assert.equal(gate.push(pose(.2),100).accepted,false);
  for(const now of [110,120,130])assert.equal(gate.snapshot(now).pose,null);
  assert.equal(gate.push(pose(.2),100).accepted,false);
  const accepted=gate.push(pose(.21),140);
  assert.equal(accepted.accepted,true);assert.equal(accepted.status,'tracking');assert.equal(accepted.pose.x,.21);
});
test('small natural changes pass immediately without another smoothing filter',()=>{
  const gate=acquired();const sample=gate.push(pose(.09,-.04),80);
  assert.equal(sample.accepted,true);assert.deepEqual(sample.pose,pose(.09,-.04));
});
test('an isolated large wrong angle never becomes the retained head target',()=>{
  const gate=acquired();const spike=gate.push(pose(.8),80);
  assert.equal(spike.accepted,false);assert.equal(spike.reason,'jump-confirmation');assert.equal(spike.pose.x,.01);
  assert.equal(gate.snapshot(240).pose.x,.01);
  const normal=gate.push(pose(.02),120);assert.equal(normal.accepted,true);assert.equal(normal.pose.x,.02);
});
test('a real large turn is accepted on the next independent consistent sample',()=>{
  const gate=acquired();assert.equal(gate.push(pose(.7),80).accepted,false);
  const accepted=gate.push(pose(.76,.03),120);assert.equal(accepted.accepted,true);assert.equal(accepted.pose.x,.76);
});
test('alternating impossible jumps and stale confirmations cannot move the head',()=>{
  const gate=acquired();assert.equal(gate.push(pose(.9),80).accepted,false);
  assert.equal(gate.push(pose(-.9),120).accepted,false);
  assert.equal(gate.push(pose(.91),160).accepted,false);
  assert.equal(gate.push(pose(.92),400).accepted,false);assert.equal(gate.snapshot(400).pose,null);
});
test('loss returns no target, then reacquisition waits for fresh confirmation and restores status',()=>{
  const gate=acquired();assert.equal(gate.snapshot(280).signalFresh,true);
  assert.equal(gate.snapshot(281).pose,null);assert.equal(gate.snapshot(700).status,'lost');
  const first=gate.push(pose(.6),720);assert.equal(first.status,'recovering');assert.equal(first.pose,null);
  const recovered=gate.push(pose(.62),760);assert.equal(recovered.status,'tracking');assert.equal(recovered.accepted,true);
  assert.equal(recovered.pose.x,.62);
});
test('initial missing face has a lost state and regains tracking from two samples',()=>{
  const gate=new StudioTrackingSignalGate();gate.reset(1000);
  assert.equal(gate.snapshot(1500).status,'acquiring');assert.equal(gate.snapshot(1601).status,'lost');
  assert.equal(gate.push(pose(),1700).status,'recovering');assert.equal(gate.push(pose(),1740).status,'tracking');
});
test('invalid, duplicate and out-of-order detector samples cannot refresh a stale signal',()=>{
  const gate=acquired();
  assert.equal(gate.push(pose(NaN),100).reason,'invalid-pose');
  assert.equal(gate.push(pose(Infinity),120).reason,'invalid-pose');
  assert.equal(gate.push(pose(1.01),140).reason,'invalid-pose');
  assert.equal(gate.push(pose(.2),100).reason,'duplicate-or-old-time');
  assert.equal(gate.push(pose(.2),NaN).accepted,false);
  assert.equal(gate.snapshot(281).pose,null);assert.equal(gate.snapshot(281).lastAcceptedAt,40);
});
test('a new camera session cannot inherit an earlier accepted pose or pending jump',()=>{
  const gate=acquired();gate.push(pose(.9),80);gate.reset(1000);
  assert.equal(gate.snapshot(1000).pose,null);assert.equal(gate.snapshot(1000).lastAcceptedAt,null);
  assert.equal(gate.push(pose(.91),1040).accepted,false);assert.equal(gate.push(pose(.91),1080).accepted,true);
});
test('gate snapshots and returned poses cannot mutate retained detector state',()=>{
  const gate=acquired();const sample=gate.snapshot(50);sample.pose.x=1;
  assert.equal(gate.snapshot(60).pose.x,.01);
});
test('stable calibration accepts normal brief blinks and returns measured neutral position',()=>{
  const quality=calibration({makeChannels:i=>channels(i===4||i===5?{eyeBlinkLeft:.95,eyeBlinkRight:.97}:{})});
  const result=quality.finish(3000);assert.equal(result.ok,true);assert.equal(result.reason,'ready');
  assert.deepEqual(result.neutralPose,{x:.03,y:-.02});assert.equal(result.sampleCount,31);assert.equal(result.spanMs,3000);
});
test('five early frames followed by loss cannot produce a successful calibration',()=>{
  const quality=calibration({count:5,step:40});const result=quality.finish(3000);
  assert.equal(result.ok,false);assert.equal(result.reason,'too-few-samples');assert.equal(result.neutralPose,null);
});
test('many samples must cover real time and remain fresh at the end of calibration',()=>{
  assert.equal(calibration({count:20,step:10}).finish(200).reason,'too-short');
  assert.equal(calibration({count:20,step:100}).finish(3000).reason,'stale');
});
test('interrupted calibration cannot hide a long tracking gap behind sufficient frame count',()=>{
  const quality=calibration({count:15,step:50});
  for(let i=0;i<15;i++)quality.add({pose:pose(),channels:channels()},2000+i*50);
  assert.equal(quality.finish(2700).reason,'interrupted');
});
test('head motion across calibration rejects a misleading averaged center',()=>{
  const quality=calibration({makePose:i=>pose(i/30*.4,-.02)});
  const result=quality.finish(3000);assert.equal(result.reason,'moving');assert.equal(result.neutralPose,null);
});
test('calibration reads normalized pose.roll from the real motion extractor rather than a missing z',()=>{
  const quality=calibration({makePose:i=>({x:.1,y:.03,roll:i/30})});
  assert.equal(quality.finish(3000).reason,'moving');
  assert.equal(calibration({makePose:()=>({x:.1,y:.03,roll:.2})}).finish(3000).ok,true);
  const gate=new StudioTrackingSignalGate();
  assert.equal(gate.push({x:0,y:0,roll:NaN},0).reason,'invalid-pose');
  assert.equal(gate.push({x:0,y:0,roll:null},40).reason,'invalid-pose');
});
test('persistent closed eyes or open mouth cannot erase future expressions',()=>{
  assert.equal(calibration({makeChannels:()=>channels({eyeBlinkLeft:.9,eyeBlinkRight:.9})}).finish(3000).reason,'eyes-closed');
  assert.equal(calibration({makeChannels:()=>channels({eyeBlinkLeft:.8})}).finish(3000).reason,'eyes-closed');
  assert.equal(calibration({makeChannels:()=>channels({jawOpen:.6})}).finish(3000).reason,'mouth-open');
});
test('calibration rejects malformed data and duplicates without counting render ticks',()=>{
  const quality=new StudioCalibrationQuality();quality.begin(100);
  assert.equal(quality.add({pose:pose(),channels:channels()},100),true);
  assert.equal(quality.add({pose:pose(),channels:channels()},100),false);
  assert.equal(quality.add({pose:pose(),channels:channels()},90),false);
  assert.equal(quality.add({pose:pose(NaN),channels:channels()},200),false);
  assert.equal(quality.add({pose:pose(),channels:{}},200),false);
  assert.equal(quality.add({pose:pose(),channels:channels({jawOpen:Infinity})},200),false);
  assert.equal(quality.finish(300).sampleCount,1);
});
test('quality assessment is bounded and has no authority to replace an existing calibration',()=>{
  const previous={x:.12,y:.03},quality=calibration({count:130,step:20});
  assert.equal(quality.samples.length,120);
  const failed=quality.finish(5000);assert.equal(failed.ok,false);assert.equal(failed.neutralPose,null);
  assert.deepEqual(previous,{x:.12,y:.03});assert.equal(quality.finish(5000).reason,'not-started');
  quality.begin(6000);assert.equal(quality.samples.length,0);
});
