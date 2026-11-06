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
  assert.equal(manifest.id,'short-hair-rife-v4.25-fields-v1');
  assert.equal(manifest.model.name,'RIFE v4.25');
  assert.equal(manifest.model.implementation,'hzwer/Practical-RIFE');
  assert.equal(manifest.model.commit,'bbfd2ea90910789a860ea3e2b32a240cd577b75e');
  assert.equal(manifest.model.weights['train_log/flownet.pkl'],'6615790efd627772917205db291f51cd392528a157ecbb2ecaeec3bff8eb6de2');
  assert.equal(manifest.model.weights['train_log/IFNet_HDv3.py'],'655b4c772b037967b86c2dd31c8fa3b5323b79dd9a0e0088708d89149bbc8a32');
  assert.equal(manifest.model.weights['model/warplayer.py'],'feb3af9475b724749b023d1913c3b135431eff13d0045b8efb472a699058385f');
  assert.equal(manifest.model.weightArchiveSha256,'e63d481b7ae5d4a4e6ad7ac5b410ff78f3bf7be3b51b2e38ca8152747abde5b4');
  assert.equal(manifest.model.flowOutput,'flow_list[-1]');assert.equal(manifest.model.maskOutput,'sigmoid(mask_logits)');
  assert.deepEqual(manifest.model.scaleList,[16,8,4,2,1]);
  assert.match(await readFile(new URL('LICENSE-RIFE.txt',directory),'utf8'),/Copyright \(c\) 2021 hzwer/);
  const receipt=JSON.parse(await readFile(new URL('provenance.json',directory),'utf8'));
  assert.equal(hash(await readFile(new URL('manifest.json',directory))),receipt.manifestSha256);
  for(const key of ['compiler','dependencyLock','validation','license'])
    assert.equal(hash(await readFile(new URL(receipt[key].path,root))),receipt[key].sha256,`${key} must match the reviewed receipt`);
  assert.equal(receipt.sourceArtModified,false);assert.equal(receipt.weightsShipped,false);assert.equal(receipt.runtimeModelInference,false);
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
  const report=JSON.parse(await readFile(new URL('validation/v0.19-rife-model.json',root),'utf8'));
  assert.equal(report.cases.length,112);assert.equal(report.allFinite,true);assert.equal(report.originalsStillUnchanged,true);
  assert.equal(report.fieldBytes,26127360);
  assert.equal(report.manifestSha256,hash(await readFile(new URL('manifest.json',directory))));
  assert.deepEqual(new Set(report.cases.map(value=>`${value.from}__${value.to}`)),new Set(manifest.edges.map(value=>value.id)));
  for(const [pose,source] of Object.entries(manifest.sources))assert.equal(report.sourceHashes[pose],source.sha256);
  for(const edge of manifest.edges){
    const cases=report.cases.filter(value=>value.from===edge.from&&value.to===edge.to);
    assert.deepEqual(cases.map(value=>value.time),manifest.times);
    for(const item of cases){
      const current=item.models.rife425;
      assert.ok(current.fullFieldInteriorMAE<.000001,'four-channel flow and mask must reproduce network output');
      assert.ok(current.nativeCompressionFacePremulRGBMAE<.009,'stored fields must stay within the visually reviewed native-resolution compression budget');
      assert.ok(current.nativeCompressionAlphaMAE<.0015,'native alpha compression must stay within the reviewed budget');
      assert.equal(current.finite,true);
    }
  }
  assert.equal(report.edges.length,16);
  for(const edge of report.edges)for(const name of ['rife46','rife425']){
    const distribution=edge.models[name].reverseSubjectRGBMAE;
    assert.ok(distribution.worst.value>=distribution.mean);
    assert.ok(manifest.times.includes(distribution.worst.time));
  }
});
