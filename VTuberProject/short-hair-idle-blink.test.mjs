import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdleBlink,advanceIdleBlink,applyIdleBlink} from './short-hair-idle-blink.js';
test('idle blink runs a full closure and opens again at varied deterministic intervals',()=>{
 let state=createIdleBlink(2),closed=0,delays=new Set(),phases=new Set();
 for(let i=0;i<1200;i++){const next=advanceIdleBlink(state,1000/60);state=next.motion;phases.add(state.phase);delays.add(state.delayMs);if(next.closure===1)closed++;assert.ok(next.closure>=0&&next.closure<=1);}
 assert.ok(closed>6);assert.equal(phases.size,4);assert.ok(delays.size>3);
});
test('blink proposals are immutable and refresh-rate independent',()=>{
 const initial=createIdleBlink();assert.deepEqual(advanceIdleBlink(initial,16),advanceIdleBlink(initial,16));assert.equal(initial.elapsed,0);
 let a=initial,b=initial;for(let i=0;i<600;i++)a=advanceIdleBlink(a,1000/60).motion;for(let i=0;i<300;i++)b=advanceIdleBlink(b,1000/30).motion;
 assert.equal(a.phase,b.phase);assert.equal(a.seed,b.seed);assert.ok(Math.abs(a.elapsed-b.elapsed)<1e-8);assert.ok(Math.abs(a.closure-b.closure)<1e-8);
 assert.equal(advanceIdleBlink(initial,10000).motion.elapsed,100);
});
test('automatic blink cannot open a deliberate closed eye or change other facial groups',()=>{
 const base={eyeBlinkLeft:1,eyeBlinkRight:.4,jawOpen:.7,eyeLookUpLeft:.5};const output=applyIdleBlink(base,.8);
 assert.deepEqual(output,{eyeBlinkLeft:1,eyeBlinkRight:.8,jawOpen:.7,eyeLookUpLeft:.5});assert.equal(base.eyeBlinkRight,.4);
 assert.throws(()=>advanceIdleBlink(createIdleBlink(),-1));
});
