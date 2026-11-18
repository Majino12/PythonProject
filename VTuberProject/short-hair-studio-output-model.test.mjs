import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOutputFrame,validateOutputEnvelope} from './short-hair-studio-output-model.js';
import {sanitizeChannels} from './expression-model.js';

const state={eyeLeft:'open',eyeRight:'open',mouth:'neutral',browLeft:'neutral',browRight:'neutral'};
const articulation=()=>Object.fromEntries(Object.entries(state).map(([key,name])=>[key,{from:name,to:name,t:0}]));
const frame=()=>({poseId:'front',coefficients:sanitizeChannels({}),state:{...state},faceOnly:true,original:false});

test('live output preserves the actual in-between artwork independently of legacy nearest-state labels',()=>{
  const value={...frame(),articulation:articulation()};
  value.articulation.eyeLeft={from:'quarter',to:'half',t:.375};
  value.articulation.mouth={from:'neutral',to:'pucker',t:.625};
  const copy=validateOutputFrame(value);
  assert.deepEqual(copy,value);assert.notStrictEqual(copy.articulation,value.articulation);
  value.articulation.eyeLeft.t=1;
  assert.equal(copy.articulation.eyeLeft.t,.375);
  assert.deepEqual(copy.state,state,'labels remain metadata; transport must not quantize the in-between');
  const packet=validateOutputEnvelope({senderId:'articulation-sender',sequence:1,frame:copy});
  assert.equal(packet.frame.articulation.mouth.t,.625);
  packet.frame.articulation.mouth.t=0;assert.equal(copy.articulation.mouth.t,.625);
});

test('explicit invalid live articulation is rejected instead of falling back to legacy state',()=>{
  const make=part=>({...articulation(),eyeLeft:part});
  for(const value of [null,undefined,[],{}, {...articulation(),unknown:{from:'open',to:'open',t:0}},
    make({from:'open',to:'closed',t:.5}),make({from:'open',to:'quarter',t:-.01}),
    make({from:'open',to:'quarter',t:1.01}),make({from:'open',to:'quarter',t:'0.5'}),
    make({from:'open',to:'quarter',t:NaN}),make({from:'open',to:'quarter',t:Infinity}),
    make({from:'open',to:'quarter',t:.5,url:'remote'}),make({from:'unknown',to:'quarter',t:0})])
    assert.throws(()=>validateOutputFrame({...frame(),articulation:value}));
});

test('old live output frames remain exactly readable with no invented articulation',()=>{
  const old=frame();assert.deepEqual(validateOutputFrame(old),old);
  assert.equal(Object.hasOwn(validateOutputFrame(old),'articulation'),false);
});
