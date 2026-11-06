import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {validateShortHairFringeManifest,loadShortHairFringeAssets} from './short-hair-fringe-assets.js';
import {validateContinuousShortHairSources} from './short-hair-continuous-renderer.js';
const WIDTH=1122,HEIGHT=1402,N=WIDTH*HEIGHT,DIR='./assets/short-hair-fringe-v1/',SOURCE='./assets/short-hair-v1/front.png',SHA='a'.repeat(64),ALPHA='b'.repeat(64);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function manifestFixture(){
 const files=Object.fromEntries(['ownership','weight','underpaint','hairOwnership'].map((name,i)=>{const bytes=Uint8Array.of(137,80,78,71,i+1);return[name,{bytes,record:{path:`${DIR}front-${name}.png`,bytes:bytes.length,sha256:digest(bytes)}}];}));
 const binding={schemaVersion:1,kind:'short-hair-mesh-binding',poseId:'front',sourceSha256:SHA,bounds:[100,100,800,600],grid:{columns:8,rows:8},rootLine:[[100,100],[900,100]],tipLine:[[100,700],[900,700]],travel:{x:6,y:1},revealMarginPx:12,runtimeValidated:true,protectedRegions:[]};
 const manifest={schemaVersion:1,id:'short-hair-fringe-v1',status:'derived-candidate',width:WIDTH,height:HEIGHT,model:{name:'SAM 2.1 Hiera Large',weightsSha256:'2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318',commit:'2b90b9f5ceec907a1c18123530e92e794ad901a4'},poses:{front:{source:{path:SOURCE,sha256:SHA},alphaSha256:ALPHA,binding,supportRadius:24,solidRadius:12,...Object.fromEntries(Object.entries(files).map(([k,f])=>[k,f.record]))}}};return {manifest,files};
}
function imageFixture(){
 const fixture=manifestFixture(),images={};for(const key of Object.keys(fixture.files)){const data=new Uint8ClampedArray(N*4);if(key!=='underpaint')for(let i=0;i<N;i++)data[i*4+3]=255;images[key]={naturalWidth:WIDTH,naturalHeight:HEIGHT,data};}
 const set=(name,x,y,values)=>images[name].data.set(values,(y*WIDTH+x)*4);
 for(let x=400;x<464;x++){for(const key of ['ownership','weight','hairOwnership'])set(key,x,300,[255,255,255,255]);set('underpaint',x,300,[240,200,180,255]);}
 // A fractional contact pixel exercises grayscale-to-alpha, not binary H.
 set('weight',464,300,[96,96,96,255]);set('underpaint',464,300,[232,192,172,255]);
 return {...fixture,images,set};
}
async function withBrowser(fixture,run,{httpFail=null,corrupt=null,decodeFail=null}={}){
 const saved={document:globalThis.document,Image:globalThis.Image,fetch:globalThis.fetch,crypto:Object.getOwnPropertyDescriptor(globalThis,'crypto'),create:URL.createObjectURL,revoke:URL.revokeObjectURL};
 const urls=new Map(),created=[],revoked=[];let nextUrl=0;
 const canvas=()=>{const c={width:0,height:0,data:null};const ctx={globalCompositeOperation:'source-over',drawImage(image){if(!c.data)c.data=new Uint8ClampedArray(image.data);else if(this.globalCompositeOperation==='destination-in'){for(let i=0;i<N;i++)c.data[i*4+3]=Math.round(c.data[i*4+3]*image.data[i*4+3]/255);}else c.data.set(image.data);},getImageData(){return{data:c.data};},createImageData(w,h){return{data:new Uint8ClampedArray(w*h*4)};},putImageData(image){c.data=image.data;}};c.getContext=()=>ctx;return c;};
 globalThis.document={createElement(tag){assert.equal(tag,'canvas');return canvas();}};
 Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
 URL.createObjectURL=blob=>{const url=`blob:fringe-test-${++nextUrl}`;urls.set(url,blob);created.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);urls.delete(url);};
 globalThis.Image=class{set src(url){const blob=urls.get(url);blob.arrayBuffer().then(bytes=>{const key=Object.keys(fixture.files).find(k=>fixture.files[k].bytes[4]===new Uint8Array(bytes)[4]);if(key===decodeFail){this.onerror();return;}Object.assign(this,fixture.images[key]);this.onload();});}};
 globalThis.fetch=async path=>{if(path===DIR+'manifest.json')return{ok:httpFail!=='manifest',json:async()=>fixture.manifest};const entry=Object.entries(fixture.files).find(([,f])=>f.record.path===path);assert.ok(entry,`unexpected external resource ${path}`);const[key,file]=entry;return{ok:key!==httpFail,arrayBuffer:async()=>{const bytes=file.bytes.slice();if(key===corrupt)bytes[0]^=255;return bytes.buffer;}};};
 try{return await run({created,revoked});}finally{globalThis.document=saved.document;globalThis.Image=saved.Image;globalThis.fetch=saved.fetch;if(saved.crypto)Object.defineProperty(globalThis,'crypto',saved.crypto);else delete globalThis.crypto;URL.createObjectURL=saved.create;URL.revokeObjectURL=saved.revoke;}
}
function sourceJoin(){const {manifest}=manifestFixture();return {assets:{poses:[{id:'front',sourceFamily:'front'}],front:{manifest:{reference:'neutral',sources:{neutral:{src:SOURCE}}}}},alpha:{manifest:{poses:{front:{source:SOURCE,sourceSha256:SHA,matteSha256:ALPHA}}}},motion:{manifest:{sources:{front:{path:SOURCE,sha256:SHA}}}},fringe:{manifest,poses:{front:{binding:manifest.poses.front.binding}}}};}
const join=f=>validateContinuousShortHairSources(f.assets,f.alpha,f.motion,f.fringe);

test('registered manifest and exact source/matte identities join successfully',()=>{const f=manifestFixture();assert.strictEqual(validateShortHairFringeManifest(f.manifest),f.manifest);assert.equal(join(sourceJoin()),true);});
test('manifest rejects unregistered model, pose, coordinates, paths, digest, support and binding identity',()=>{
 const cases=[m=>m.model.commit='c'.repeat(40),m=>m.model.weightsSha256='c'.repeat(64),m=>m.poses.unknown=m.poses.front,m=>m.width=1024,m=>m.poses.front.source.path='./assets/../wrong.png',m=>m.poses.front.alphaSha256='bad',m=>m.poses.front.ownership.path='./assets/other.png',m=>m.poses.front.weight.bytes=16777217,m=>m.poses.front.underpaint.sha256='0',m=>m.poses.front.binding.sourceSha256='c'.repeat(64),m=>m.poses.front.binding.runtimeValidated=false,m=>m.poses.front.supportRadius=25];
 for(const mutate of cases){const {manifest}=manifestFixture();mutate(manifest);assert.throws(()=>validateShortHairFringeManifest(manifest));}
});
test('source join rejects stale matte, changed path, changed source hash and absent binding before GPU allocation',()=>{
 const cases=[f=>f.fringe.manifest.poses.front.alphaSha256='c'.repeat(64),f=>f.fringe.manifest.poses.front.source.path='./assets/short-hair-v1/view-left.png',f=>f.fringe.manifest.poses.front.source.sha256='c'.repeat(64),f=>f.fringe.poses.front.binding.sourceSha256='c'.repeat(64),f=>delete f.fringe.poses.front,f=>delete f.fringe.manifest.poses.front,f=>f.alpha.manifest.poses.front.sourceSha256='c'.repeat(64),f=>f.motion.manifest.sources.front.path='./assets/other.png'];
 for(const mutate of cases){const f=sourceJoin();mutate(f);assert.throws(()=>join(f));}
});
test('verified images convert grayscale W/H to alpha and preweight U once; all object URLs are revoked',async()=>{
 const f=imageFixture();await withBrowser(f,async({created,revoked})=>{const result=await loadShortHairFringeAssets(),pose=result.poses.front,k=(300*WIDTH+464)*4;
  assert.equal(pose.weight.data[k+3],96);assert.deepEqual(Array.from(pose.weight.data.slice(k,k+3)),[255,255,255]);assert.equal(pose.ownership.data[k+3],0);assert.equal(pose.weightedUnderpaint.data[k+3],96);assert.equal(pose.underpaint.data[k+3],255);assert.equal(pose.ownership.data[(300*WIDTH+400)*4+3],255);assert.equal(created.length,4);assert.deepEqual(new Set(revoked),new Set(created));
 });
});
test('HTTP, byte-length and digest failures reject before accepting unverified pixel content',async()=>{
 await withBrowser(imageFixture(),()=>assert.rejects(loadShortHairFringeAssets(),/无法读取/),{httpFail:'manifest'});
 const short=imageFixture();short.manifest.poses.front.weight.bytes++;await withBrowser(short,()=>assert.rejects(loadShortHairFringeAssets(),/长度不匹配/));
 await withBrowser(imageFixture(),()=>assert.rejects(loadShortHairFringeAssets(),/校验失败/),{corrupt:'weight'});
});
test('decode errors revoke blob URLs and native dimensions are mandatory',async()=>{
 const f=imageFixture();await withBrowser(f,async({created,revoked})=>{await assert.rejects(loadShortHairFringeAssets(),/无法解码/);assert.deepEqual(new Set(revoked),new Set(created));},{decodeFail:'ownership'});
 const wrong=imageFixture();wrong.images.weight.naturalWidth=1024;await withBrowser(wrong,()=>assert.rejects(loadShortHairFringeAssets(),/原生画稿尺寸/));
});
test('colored, translucent, or fractional ownership masks are rejected',async()=>{
 for(const mutate of [f=>f.set('weight',0,0,[0,1,0,255]),f=>f.set('weight',0,0,[0,0,0,254]),f=>f.set('ownership',400,300,[128,128,128,255]),f=>f.set('hairOwnership',400,300,[127,127,127,255])]){const f=imageFixture();mutate(f);await withBrowser(f,()=>assert.rejects(loadShortHairFringeAssets(),/遮罩编码/));}
});
test('H must have full W and be contained in registered whole-hair ownership',async()=>{
 for(const key of ['weight','hairOwnership']){const f=imageFixture();f.set(key,400,300,[0,0,0,255]);await withBrowser(f,()=>assert.rejects(loadShortHairFringeAssets(),/归属不一致/));}
});
test('U must be opaque on W, transparent outside W, and all support must fit mesh bounds',async()=>{
 for(const mutate of [f=>f.set('underpaint',400,300,[240,200,180,254]),f=>f.set('underpaint',0,0,[240,200,180,255]),f=>{f.set('weight',99,300,[1,1,1,255]);f.set('underpaint',99,300,[240,200,180,255]);}]){const f=imageFixture();mutate(f);await withBrowser(f,()=>assert.rejects(loadShortHairFringeAssets(),/补画|覆盖/));}
});
test('nonempty W cannot substitute for an empty real hair ownership region',async()=>{
 const f=imageFixture();for(let x=400;x<464;x++)f.set('ownership',x,300,[0,0,0,255]);await withBrowser(f,()=>assert.rejects(loadShortHairFringeAssets(),/前发区域/));
});
