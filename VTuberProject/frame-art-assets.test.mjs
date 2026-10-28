import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateFrameArtManifest,frameBaseConfiguration,extendFrameArtAssets} from './frame-art-renderer.js';
const root=path.dirname(fileURLToPath(import.meta.url)),dir=path.join(root,'assets/short-hair-frame-art-v1');
const read=file=>JSON.parse(fs.readFileSync(file)),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const manifest=read(path.join(dir,'manifest.json')),provenance=read(path.join(dir,'provenance.json'));
const bases=Object.fromEntries(Object.entries(manifest.bases).map(([family,b])=>[family,read(path.join(root,b.manifest))]));
const area=p=>Math.abs(p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-a[1]*b[0]},0)/2);
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;};
function baseAssets(family){
 const m=structuredClone(bases[family]),compiled={},gazeLayers={},images={};
 for(const[id,p]of Object.entries(m.poses)){
  compiled[id]=Object.fromEntries(Object.entries(p.patches).map(([g,states])=>[g,Object.fromEntries(Object.keys(states).map(s=>[s,{tag:`${id}/${g}/${s}`}]))]));
  gazeLayers[id]=Object.fromEntries(Object.entries(m.gaze.poses[id].eyes).map(([eye,meta])=>[eye,{bounds:meta.bounds,canvas:{tag:`${id}/${eye}/iris`},frames:Object.fromEntries(Object.keys(meta.frames).map(s=>[s,{clean:{tag:`${id}/${eye}/${s}/clean`}}]))}]));
  images[m.gaze.poses[id].whiteSource]={tag:`${id}/white`};
 }
 return{manifest:m,compiled,gazeLayers,images};
}
test('sixteen selected full-size source paintings match preserved generation provenance and hashes',()=>{
 validateFrameArtManifest(manifest);
 assert.equal(Object.keys(manifest.sources).length,16);
 for(const[id,s]of Object.entries(manifest.sources)){
  const bytes=fs.readFileSync(path.join(root,s.src)),p=provenance.assets.find(a=>a.file===path.basename(s.src));
  assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a');assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[1122,1402]);
  assert.equal(sha(bytes),s.sha256,id);assert.equal(p?.sha256,s.sha256,id);assert.equal(p.pose,s.pose);assert.ok(p.prompt.length>100);assert.ok(p.references.length>0);
 }
 for(const p of provenance.assets)assert.equal(sha(fs.readFileSync(path.join(dir,p.file))),p.sha256,p.file);
 assert.equal(path.basename(manifest.sources['view-right-quarter-parted'].src),'view-right-quarter-parted-v4.png');
 assert.equal(path.basename(manifest.sources['view-right-down-quarter-parted'].src),'view-right-down-quarter-parted-v2.png');
});
test('extension is bound to exact accepted base art and geometry, with unchanged upper-lip destinations',()=>{
 for(const[family,b]of Object.entries(bases)){
  assert.equal(sha(JSON.stringify(frameBaseConfiguration(b))),manifest.bases[family].configurationSha256);
  validateFrameArtManifest(manifest,baseAssets(family),family);
 }
 for(const[id,p]of Object.entries(manifest.poses))for(const patch of Object.values(p.patches.mouth)){
  assert.deepEqual(patch.anchor.destination,bases[p.baseFamily].poses[id].mouthReference);
  assert.deepEqual(patch.anchor.source.map((v,i)=>v+patch.destination[i]-patch.rect[i]),patch.anchor.destination);
  assert.deepEqual(patch.rect.slice(2),patch.destination.slice(2));
 }
});
test('source-traced apertures decrease strictly through five stages for both eyes of every new pose',()=>{
 for(const[id,p]of Object.entries(manifest.poses))for(const eye of ['eyeLeft','eyeRight']){
  const old=bases[p.baseFamily].gaze.poses[id].eyes[eye].frames;
  const values=[old.open.aperture,p.gaze[eye].quarter.aperture,old.half.aperture,p.gaze[eye].threeQuarter.aperture].map(area).concat(0);
  assert.ok(values.every((v,i)=>!i||v<values[i-1]),`${id}/${eye}: ${values}`);
 }
});
test('registration rejects missing actual frames, cross-pose sources, moving eyes, and false upper-lip anchors',()=>{
 const changed=edit=>{const m=structuredClone(manifest);edit(m);assert.throws(()=>validateFrameArtManifest(m));};
 changed(m=>delete m.poses['view-up'].gaze.eyeLeft.quarter);
 changed(m=>m.poses['view-up'].patches.eyeLeft.quarter.source='view-down-quarter-parted');
 changed(m=>m.poses['view-up'].patches.eyeLeft.quarter.destination[0]++);
 changed(m=>m.poses['view-up'].patches.mouth.parted.anchor.source[1]++);
 changed(m=>m.sources['view-up-quarter-parted'].sha256=m.sources['view-up-three-quarter-medium'].sha256);
});
test('extension compiles only added states, preserving every old patch, gaze clean frame and iris by identity',async()=>{
 const originalImage=globalThis.Image,originalDocument=globalThis.document;let created=0;
 const noop=()=>{},context=()=>({beginPath:noop,lineTo:noop,moveTo:noop,closePath:noop,clip:noop,drawImage:noop,fillRect:noop,fill:noop,stroke:noop,translate:noop,createLinearGradient:()=>({addColorStop:noop})});
 globalThis.Image=class{naturalWidth=1122;naturalHeight=1402;decode=async()=>{};set src(value){this.url=value;queueMicrotask(()=>this.onload());}};
 globalThis.document={createElement:tag=>{assert.equal(tag,'canvas');created++;return{width:0,height:0,getContext:context};}};
 try{
  for(const family of Object.keys(bases)){
   const old=freeze(baseAssets(family)),before=JSON.stringify(old.manifest),next=await extendFrameArtAssets(old,manifest,family);
   assert.equal(JSON.stringify(old.manifest),before);assert.notEqual(next.manifest,old.manifest);
   for(const[id,p]of Object.entries(old.manifest.poses)){
    for(const[g,states]of Object.entries(p.patches))for(const s of Object.keys(states)){
     assert.equal(next.compiled[id][g][s],old.compiled[id][g][s]);assert.equal(next.manifest.poses[id].patches[g][s],old.manifest.poses[id].patches[g][s]);
    }
    for(const eye of ['eyeLeft','eyeRight']){
     assert.equal(next.gazeLayers[id][eye].canvas,old.gazeLayers[id][eye].canvas);
     for(const s of Object.keys(old.gazeLayers[id][eye].frames))assert.equal(next.gazeLayers[id][eye].frames[s],old.gazeLayers[id][eye].frames[s]);
     for(const s of ['quarter','threeQuarter'])assert.ok(next.gazeLayers[id][eye].frames[s].clean);
    }
   }
  }
  assert.equal(created,80); // 8 poses × (6 new local patches + 4 new gaze clean masks).
  const drift=baseAssets('side');drift.manifest.poses['view-left'].mouthReference[1]++;
  await assert.rejects(extendFrameArtAssets(drift,manifest,'side'));
 }finally{globalThis.Image=originalImage;globalThis.document=originalDocument;}
});
