import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateMotionFieldsManifest,loadShortHairMotionFields,findMotionField,MOTION_FIELDS_URL} from './short-hair-motion-fields.js';

const directory=new URL('assets/short-hair-motion-v1/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
const copy=()=>structuredClone(manifest);
function rejects(change,message){const value=copy();change(value);assert.throws(()=>validateMotionFieldsManifest(value),message);}

test('motion manifest rejects missing, duplicate, unrelated and mislabeled edges',()=>{
  rejects(value=>value.edges.pop());
  rejects(value=>value.edges[1]=structuredClone(value.edges[0]));
  rejects(value=>value.edges[0].to='view-right-down');
  rejects(value=>value.edges[0].id='wrong-edge');
  rejects(value=>value.edges[0]=null);
});

test('motion manifest rejects path traversal and external fetch targets in fields or source references',()=>{
  for(const path of ['../outside.flow.bin','./../outside.flow.bin','https://outside.invalid/flow.bin','/absolute.flow.bin','file:///tmp/flow.bin'])
    rejects(value=>value.edges[0].flow.path=path);
  for(const path of ['./assets/../outside.png','./assets/%2e%2e/outside.png','./assets/back\\outside.png','https://outside.invalid/source.png','./assets/source.png?other'])
    rejects(value=>value.sources.front.path=path);
});

test('motion manifest rejects incorrect field lengths and malformed checksums before loading any binary',()=>{
  for(const kind of ['flow','mask']){
    for(const bytes of [0,-1,1,NaN,Infinity,'1451520'])rejects(value=>value.edges[0][kind].bytes=bytes);
    rejects(value=>value.edges[0][kind].bytes++);
    for(const sha256 of [null,'','0'.repeat(63),'z'.repeat(64),'A'.repeat(64)])
      rejects(value=>value.edges[0][kind].sha256=sha256);
  }
});

test('motion manifest requires the exact neural time samples and field dimensions',()=>{
  for(const times of [null,[],[0,.5,1],[.125,.25,.375,.5,.625,.75],[.125,.25,.375,.5,.625,.75,.75],[.125,.25,.375,.5,.625,.75,.875,1]])
    rejects(value=>value.times=times);
  rejects(value=>value.times.reverse());rejects(value=>value.times[0]='.125');
  for(const fieldSize of [[180,144],[144,181],[144,180,7],null])rejects(value=>value.fieldSize=fieldSize);
});

test('motion manifest refuses substituted model name, commit, license or pinned weights',()=>{
  rejects(value=>delete value.model);
  for(const [key,replacement] of [['name','RIFE v99'],['commit','0'.repeat(40)],['license','unknown']])
    rejects(value=>value.model[key]=replacement);
  for(const name of ['flownet.bin','flownet.param']){
    rejects(value=>delete value.model.weights[name]);
    rejects(value=>value.model.weights[name]='0'.repeat(64));
  }
});

test('motion manifest refuses incomplete source metadata and non-SHA256 source hashes',()=>{
  rejects(value=>delete value.sources.front);
  rejects(value=>value.sources.front=null);
  rejects(value=>value.sources=[]);
  for(const sha256 of [null,{},'','not-a-hash','a'.repeat(63),'A'.repeat(64)])
    rejects(value=>value.sources.front.sha256=sha256);
});

test('motion loader rejects actual truncated and modified bytes even with valid metadata',async()=>{
  const originalFetch=globalThis.fetch;
  try{
    for(const failure of ['length','checksum']){
      globalThis.fetch=async url=>{
        if(url===MOTION_FIELDS_URL)return {ok:true,json:async()=>copy()};
        const name=String(url).slice(String(url).lastIndexOf('/')+1);
        const bytes=await readFile(new URL(name,directory));
        if(failure==='length')return {ok:true,arrayBuffer:async()=>new ArrayBuffer(bytes.length-1)};
        const changed=Uint8Array.from(bytes);changed[0]^=1;
        return {ok:true,arrayBuffer:async()=>changed.buffer};
      };
      await assert.rejects(loadShortHairMotionFields(),failure==='length'?/长度不匹配/:/校验失败/);
    }
  }finally{globalThis.fetch=originalFetch;}
});

test('valid field manifest loads verified typed arrays and finds either direction without duplicating assets',async()=>{
  assert.equal(validateMotionFieldsManifest(manifest),manifest);
  const originalFetch=globalThis.fetch,requests=[];
  try{
    globalThis.fetch=async url=>{
      requests.push(url);
      if(url===MOTION_FIELDS_URL)return {ok:true,json:async()=>copy()};
      const bytes=await readFile(new URL(String(url).slice(String(url).lastIndexOf('/')+1),directory));
      return {ok:true,arrayBuffer:async()=>Uint8Array.from(bytes).buffer};
    };
    const fields=await loadShortHairMotionFields();assert.equal(requests.length,33);
    assert.equal(fields.edges.length,16);
    for(const edge of fields.edges){
      assert.ok(edge.flowData instanceof Uint16Array);assert.equal(edge.flowData.length,725760);
      assert.ok(edge.maskData instanceof Uint8Array);assert.equal(edge.maskData.length,181440);
      assert.equal(findMotionField(fields,edge.from,edge.to).reversed,false);
      const reversed=findMotionField(fields,edge.to,edge.from);assert.equal(reversed.edge,edge);assert.equal(reversed.reversed,true);
    }
    assert.throws(()=>findMotionField(fields,'front','unregistered'));
  }finally{globalThis.fetch=originalFetch;}
});
