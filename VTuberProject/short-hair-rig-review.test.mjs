import test from 'node:test';
import assert from 'node:assert/strict';
import {compareRigPixels} from './short-hair-rig-review.js';

test('registered-material checks distinguish reconstruction tolerance from exact outer alpha',()=>{
 const a=new Uint8ClampedArray([100,120,130,255,50,60,70,128]);
 const b=new Uint8ClampedArray([101,119,130,255,50,60,70,127]);
 assert.deepEqual(compareRigPixels(a,b,{tolerance:2}),{maxError:1,overTolerance:0,alphaMismatch:1,comparedPixels:2});
 assert.equal(compareRigPixels(a,b).overTolerance,2);
});

test('protected checks include antialiased guard boundaries and ignore unguarded moving hair',()=>{
 const before=new Uint8ClampedArray([10,20,30,255,100,110,120,255,130,140,150,255]);
 const after=new Uint8ClampedArray([10,20,30,255,0,0,0,255,134,140,150,255]);
 const guard=new Uint8ClampedArray([255,255,255,255,0,0,0,0,255,255,255,1]);
 assert.deepEqual(compareRigPixels(after,before,{mask:guard,tolerance:2}),{maxError:4,overTolerance:1,alphaMismatch:0,comparedPixels:2});
 assert.equal(compareRigPixels(after,before,{tolerance:2}).overTolerance,2);
});

test('malformed buffers cannot produce an empty passing pixel report',()=>{
 for(const [a,b,options] of [[[],[],{}],[[1,2,3],[1,2,3],{}],[[1,2,3,4],[1,2,3,4],{mask:[]}],[[1,2,3,4],[1,2,3,4],{tolerance:NaN}]])assert.throws(()=>compareRigPixels(a,b,options));
});
