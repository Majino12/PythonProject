import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root=new URL('./',import.meta.url),directory=new URL('assets/short-hair-motion-v1/',root);
const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const grid=[['view-left-up','view-up','view-right-up'],['view-left','front','view-right'],['view-left-down','view-down','view-right-down']];
const expected=[...grid.flatMap(row=>row.slice(0,2).map((v,x)=>[v,row[x+1]])),
  ...grid.slice(0,2).flatMap((row,y)=>row.map((v,x)=>[v,grid[y+1][x]])),
  ...grid.slice(0,2).flatMap((row,y)=>row.slice(0,2).map((v,x)=>[v,grid[y+1][x+1]]))];

test('RIFE field package covers every edge of the four consistently triangulated cells',()=>{
  assert.equal(manifest.schemaVersion,1);
  assert.deepEqual(manifest.fieldSize,[144,180]);
  assert.deepEqual(manifest.times,[.125,.25,.375,.5,.625,.75,.875]);
  assert.deepEqual(manifest.edges.map(e=>[e.from,e.to]),expected);
  assert.equal(new Set(manifest.edges.map(e=>e.id)).size,16);
});

test('neural provenance pins official network and weights, with an offline compiler',async()=>{
  assert.equal(manifest.model.name,'RIFE v4.6');
  assert.equal(manifest.model.commit,'a7532fc3f9f8f008cd6eecd6f2ffe2a9698e0cf7');
  assert.equal(manifest.model.weights['flownet.bin'],'f334ed2260149ce0188a6dcf049844e8b0cdd912e01cbcfb63553157d2508958');
  assert.equal(manifest.model.weights['flownet.param'],'724569596bcd1e7b9fa50455c604777ebed99746d2ef40aa86e31b5725f1053c');
  assert.equal(manifest.model.flowBlob,'327');assert.equal(manifest.model.maskBlob,'332');
  assert.match(await readFile(new URL('tools/compile-rife-fields.py',root),'utf8'),/ex\.extract\(name\)/);
  assert.match(await readFile(new URL('LICENSE-RIFE.txt',directory),'utf8'),/Copyright \(c\) 2020 nihui/);
});

for(const [pose,source] of Object.entries(manifest.sources)) test(`RIFE motion fields reference the unchanged ${pose} painting`,async()=>{
  assert.ok(grid.flat().includes(pose));
  assert.equal(hash(await readFile(new URL(source.path,root))),source.sha256);
});

function half(bits){
  const sign=bits&0x8000?-1:1,exponent=(bits>>>10)&31,fraction=bits&1023;
  return exponent===31?(fraction?NaN:sign*Infinity):sign*(exponent?2**(exponent-15)*(1+fraction/1024):2**-14*fraction/1024);
}

for(const edge of manifest.edges) test(`RIFE ${edge.id} contains seven bounded nontrivial neural fields and intact bytes`,async()=>{
  assert.equal(edge.id,`${edge.from}__${edge.to}`);
  const flow=await readFile(new URL(edge.flow.path,directory)),mask=await readFile(new URL(edge.mask.path,directory));
  assert.equal(flow.length,7*180*144*4*2);assert.equal(mask.length,7*180*144);
  assert.equal(flow.length,edge.flow.bytes);assert.equal(mask.length,edge.mask.bytes);
  assert.equal(hash(flow),edge.flow.sha256);assert.equal(hash(mask),edge.mask.sha256);
  let nonzero=0,nonconstantMask=0;
  for(let i=0;i<flow.length;i+=2){
    const value=half(flow.readUInt16LE(i));
    assert.ok(Number.isFinite(value)&&Math.abs(value)<2,'UV flow must be finite and bounded');
    if(Math.abs(value)>.001)nonzero++;
  }
  for(const value of mask)if(value>8&&value<247)nonconstantMask++;
  assert.ok(nonzero>flow.length/2*.05,'package must contain spatial motion, not zero-flow dissolves');
  assert.ok(nonconstantMask>100,'occlusion weights must include fractional contributions');
  assert.equal(edge.inferenceSeconds.length,7);
  assert.ok(edge.inferenceSeconds.every(value=>Number.isFinite(value)&&value>0));
});

test('exported motion-field reconstruction was compared against actual network RGB outputs',async()=>{
  const report=JSON.parse(await readFile(new URL('validation/v0.17-rife-model.json',root),'utf8'));
  assert.equal(report.evaluationsForValidation,48);assert.equal(report.cases.length,48);
  assert.ok(report.maxFullFieldInteriorMeanError<.0001,'exported blob semantics must match model output');
  assert.ok(report.worstCaseMeanAbsoluteRGBError<.006,'compressed fields must stay within the measured image error budget');
  assert.deepEqual(new Set(report.cases.map(value=>value.edge)),new Set(manifest.edges.map(value=>value.id)));
});
