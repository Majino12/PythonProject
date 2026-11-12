import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeTurnSamples} from './short-hair-turn-review.js';

const frame=(yaw,at,pitch=0)=>({headPose:{yaw,pitch},at,costMs:4});
test('actual drawing samples must include intermediate poses and an exact endpoint',()=>{
  const samples=Array.from({length:21},(_,i)=>frame(i/20,i*16));
  const result=summarizeTurnSamples(samples,{goal:{yaw:1,pitch:0}});
  assert.equal(result.passed,true);assert.equal(result.distinctIntermediatePoses,19);
  assert.equal(result.completedDraws,21);assert.equal(result.measuredDrawFps,62.5);
  assert.equal(result.maximumFrameIntervalMs,16);assert.equal(result.meanDrawCostMs,4);
});
test('high requested cadence cannot disguise a pose switch',()=>{
  const samples=[frame(0,0),frame(0,16),frame(0,32),frame(1,48)];
  const result=summarizeTurnSamples(samples,{goal:{yaw:1,pitch:0}});
  assert.equal(result.passed,false);assert.equal(result.endpointExact,true);
  assert.equal(result.largestStep,1);assert.equal(result.distinctIntermediatePoses,0);
});
test('smooth coordinate steps report long real frame gaps without claiming 60 fps',()=>{
  const samples=Array.from({length:21},(_,i)=>frame(i/20,i*100));
  const result=summarizeTurnSamples(samples,{goal:{yaw:1,pitch:0}});
  assert.equal(result.passed,true);assert.equal(result.measuredDrawFps,10);
  assert.equal(result.p95FrameIntervalMs,100);assert.equal(result.maximumFrameIntervalMs,100);
});
test('diagonal movement is measured in vector distance rather than each axis independently',()=>{
  const result=summarizeTurnSamples([frame(0,0),frame(.1,16,.1)],{goal:{yaw:.1,pitch:.1},minIntermediate:0});
  assert.equal(result.passed,false);assert.ok(result.largestStep>.14);
});
test('a paused intermediate pose is not an exact final target',()=>{
  const samples=Array.from({length:21},(_,i)=>frame(i/25,i*16));
  const result=summarizeTurnSamples(samples,{goal:{yaw:1,pitch:0}});
  assert.equal(result.passed,false);assert.equal(result.endpointExact,false);
});
test('malformed and backward-time measurements fail explicitly',()=>{
  for(const samples of [[],[frame(0,0)],[frame(0,100),frame(.1,90)],[frame(0,0),frame(NaN,16)],
    [frame(0,0),{...frame(.1,16),costMs:-1}]])assert.throws(()=>summarizeTurnSamples(samples,{goal:{yaw:1,pitch:0}}));
});
