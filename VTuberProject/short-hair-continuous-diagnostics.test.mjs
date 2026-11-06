import test from 'node:test';
import assert from 'node:assert/strict';
import {compareDiagnosticPixels,CONTINUOUS_SEAM_CASES} from './short-hair-continuous-diagnostics.js';

test('browser pixel metrics distinguish exact matches, channel differences and alpha differences',()=>{
  const a=Uint8ClampedArray.from([10,20,30,255,40,50,60,128]),b=Uint8ClampedArray.from([10,20,30,255,44,50,60,120]);
  assert.equal(compareDiagnosticPixels(a,a).differentPixels,0);
  const result=compareDiagnosticPixels(a,b);
  assert.equal(result.pixels,2);assert.equal(result.differentPixels,1);
  assert.equal(result.meanAbsoluteDifference,1.5);assert.equal(result.meanAlphaDifference,4);assert.equal(result.maxDifference,8);
});
test('transparent comparison ignores hidden RGB but still counts alpha edges',()=>{
  const a=[255,0,0,0],b=[0,255,0,0];
  assert.equal(compareDiagnosticPixels(a,b,{premultiplied:true}).differentPixels,0);
  assert.equal(compareDiagnosticPixels(a,b).differentPixels,1);
  assert.ok(compareDiagnosticPixels([255,0,0,128],[255,0,0,0],{premultiplied:true}).meanAbsoluteDifference>0);
});
test('pixel metrics reject different image dimensions and seam cases span all three seam directions',()=>{
  for(const [a,b]of [[[],[]],[[1,2,3],[1,2,3]],[[0,0,0,0],[0,0,0,0,0,0,0,0]]])assert.throws(()=>compareDiagnosticPixels(a,b));
  assert.equal(CONTINUOUS_SEAM_CASES.filter(item=>item.name.startsWith('vertical')).length,2);
  assert.equal(CONTINUOUS_SEAM_CASES.filter(item=>item.name.startsWith('horizontal')).length,2);
  assert.equal(CONTINUOUS_SEAM_CASES.filter(item=>item.name.startsWith('diagonal')).length,4);
});
