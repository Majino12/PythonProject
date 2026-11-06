import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {validateShortHairFringeManifest} from './short-hair-fringe-assets.js';
import {createHairMeshBinding,deformHairMesh,sampleHairMeshDisplacement,HAIR_MESH_POSES} from './short-hair-mesh-model.js';
import {squaredDistanceToOwnership} from './short-hair-fringe-decomposition.js';
const manifest=validateShortHairFringeManifest(JSON.parse(await readFile(new URL('./assets/short-hair-fringe-v1/manifest.json',import.meta.url),'utf8')));
const alpha=JSON.parse(await readFile(new URL('./assets/short-hair-alpha-v1/manifest.json',import.meta.url),'utf8'));
const motion=JSON.parse(await readFile(new URL('./assets/short-hair-motion-v1/manifest.json',import.meta.url),'utf8'));
const sha=data=>createHash('sha256').update(data).digest('hex');
const authored=Object.fromEntries(await Promise.all(Object.entries({front:'short-hair-gaze-v1',side:'short-hair-side-brows-v1',pitch:'short-hair-pitch-brows-v1',complete:'short-hair-complete-poses-v1',frames:'short-hair-frame-art-v1'}).map(async([family,folder])=>[family,JSON.parse(await readFile(new URL(`./assets/${folder}/manifest.json`,import.meta.url),'utf8'))])));
const poseFamily={front:'front','view-left':'side','view-right':'side','view-left-up':'pitch','view-right-up':'pitch','view-left-down':'pitch','view-up':'complete','view-down':'complete','view-right-down':'complete'};
function authoredFeaturePolygons(id){
 const family=authored[poseFamily[id]],base=id==='front'?family:family.poses[id],records=[base,...(authored.frames.poses[id]?[authored.frames.poses[id]]:[])],unique=new Map();
 for(const record of records)for(const group of ['eyeLeft','eyeRight','browLeft','browRight'])for(const patch of Object.values(record.patches[group]||{})){
  const [x,y,w,h]=patch.destination,polygon=patch.clip||[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];unique.set(JSON.stringify(polygon),polygon);
 }
 return [...unique.values()];
}

/** Small local PNG decoder for immutable release fixtures: 8-bit, noninterlaced
 * grayscale/RGB/gray-alpha/RGBA only. No image tooling or native dependency. */
function pngRGBA(bytes){
 assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),channels=({0:1,2:3,4:2,6:4})[bytes[25]];
 assert.equal(bytes[24],8);assert.ok(channels,'unsupported PNG color type');assert.equal(bytes[26],0);assert.equal(bytes[27],0);assert.equal(bytes[28],0,'interlaced fixtures are not allowed');assert.equal(width,1122);assert.equal(height,1402);
 let offset=8;const chunks=[];while(offset<bytes.length){assert.ok(offset+12<=bytes.length);const size=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8);assert.ok(offset+size+12<=bytes.length);if(kind==='IDAT')chunks.push(bytes.subarray(offset+8,offset+8+size));offset+=size+12;}
 const raw=inflateSync(Buffer.concat(chunks)),stride=width*channels,decoded=Buffer.alloc(stride*height),rgba=Buffer.alloc(width*height*4);assert.equal(raw.length,(stride+1)*height);
 const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
 for(let y=0;y<height;y++){const f=raw[y*(stride+1)];assert.ok(f<=4);for(let x=0;x<stride;x++){const a=x>=channels?decoded[y*stride+x-channels]:0,b=y?decoded[(y-1)*stride+x]:0,c=y&&x>=channels?decoded[(y-1)*stride+x-channels]:0;decoded[y*stride+x]=(raw[y*(stride+1)+1+x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][f])&255;}}
 for(let i=0;i<width*height;i++){const k=i*channels,j=i*4;if(channels<=2){rgba[j]=rgba[j+1]=rgba[j+2]=decoded[k];rgba[j+3]=channels===2?decoded[k+1]:255;}else{rgba[j]=decoded[k];rgba[j+1]=decoded[k+1];rgba[j+2]=decoded[k+2];rgba[j+3]=channels===4?decoded[k+3]:255;}}
 return{width,height,data:rgba};
}
async function image(path,expectedHash,expectedBytes){const bytes=await readFile(new URL(path,import.meta.url));if(expectedBytes!==undefined)assert.equal(bytes.length,expectedBytes,`${path} bytes`);assert.equal(sha(bytes),expectedHash,`${path} SHA-256`);return pngRGBA(bytes);}
const inside=(x,y,p)=>{let result=false;for(let i=0,j=p.length-1;i<p.length;j=i++)if((p[i][1]>y)!==(p[j][1]>y)&&x<(p[j][0]-p[i][0])*(y-p[i][1])/(p[j][1]-p[i][1])+p[i][0])result=!result;return result;};

test('fringe pack uses registered native poses and candidate art status',()=>{assert.equal(manifest.status,'derived-candidate');for(const id of Object.keys(manifest.poses))assert.ok(HAIR_MESH_POSES.includes(id));});
test('release gate requires all nine original pose registrations',()=>{assert.deepEqual(Object.keys(manifest.poses).sort(),[...HAIR_MESH_POSES].sort());});

for(const [id,p] of Object.entries(manifest.poses))test(`${id}: verified PNGs, opacity, mask ownership, no-fold mesh, feature pins and fixed outer alpha`,async t=>{
 const matteRecord=alpha.poses[id],motionRecord=motion.sources[id];assert.equal(p.source.path,matteRecord.source);assert.equal(p.source.path,motionRecord.path);assert.equal(p.source.sha256,matteRecord.sourceSha256);assert.equal(p.source.sha256,motionRecord.sha256);assert.equal(p.alphaSha256,matteRecord.matteSha256);assert.equal(p.binding.sourceSha256,p.source.sha256);
 const [source,matte,H,W,U,whole]=await Promise.all([image(p.source.path,p.source.sha256,matteRecord.sourceBytes),image(matteRecord.matte,p.alphaSha256,matteRecord.matteBytes),...['ownership','weight','underpaint','hairOwnership'].map(key=>image(p[key].path,p[key].sha256,p[key].bytes))]);
 const semantic=JSON.parse(await readFile(new URL(`./assets/short-hair-fringe-v1/segmentation/${id}-refinement.json`,import.meta.url),'utf8')).baselineRefinement;
 let protectedFeatureOwnership=0;
 for(const kind of ['Eye','Brow'])for(const polygon of semantic[`protected${kind}Polygons`]){
  const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]);
  for(let y=Math.floor(Math.min(...ys));y<=Math.ceil(Math.max(...ys));y++)for(let x=Math.floor(Math.min(...xs));x<=Math.ceil(Math.max(...xs));x++){
   if(!inside(x+.5,y+.5,polygon)||kind==='Brow'&&(semantic.protectedBrowHairExclusions||[]).some(p=>inside(x+.5,y+.5,p)))continue;
   if(H.data[(y*H.width+x)*4]!==0)protectedFeatureOwnership++;
  }
 }
 assert.equal(protectedFeatureOwnership,0,`${id}: moving ownership must not include visible brows or eye apertures`);
 const nonOpaque=new Uint8Array(matte.width*matte.height);for(let i=0;i<nonOpaque.length;i++)if(matte.data[i*4+3]!==255)nonOpaque[i]=255;
 const alphaDistanceSquared=squaredDistanceToOwnership(nonOpaque,matte.width,matte.height);
 const binding=createHairMeshBinding(p.binding),frames=[[-1,-1],[-1,1],[1,-1],[1,1]].map(([x,y])=>deformHairMesh(binding,{x,y}));
 assert.ok(frames.every(f=>f.minimumAreaRatio>=.49999999),'all four control corners preserve triangle orientation and at least half the original area');assert.ok(p.binding.revealMarginPx>=Math.hypot(p.binding.travel.x,p.binding.travel.y)+2);
 const counts={owned:0,support:0,badMask:0,badOwnership:0,badU:0,badOriginalAlpha:0,outsideBounds:0,outerAlphaLandings:0,insufficientContinuousAlphaMargin:0,movingHair:0,maxHairDisplacement:0,maxSupportDisplacement:0};const [bx,by,bw,bh]=binding.bounds;
 for(let i=0;i<source.width*source.height;i++){
  const k=i*4,h=H.data[k],w=W.data[k],wholeValue=whole.data[k],x=i%source.width+.5,y=Math.floor(i/source.width)+.5;
  for(const [im,binary]of [[H,true],[W,false],[whole,true]])if(im.data[k+1]!==im.data[k]||im.data[k+2]!==im.data[k]||im.data[k+3]!==255||(binary&&im.data[k]!==0&&im.data[k]!==255))counts.badMask++;
  if(h){counts.owned++;if(h!==255||w!==255||wholeValue!==255)counts.badOwnership++;}
  if(!w){if(U.data[k+3]!==0)counts.badU++;continue;}
  counts.support++;if(U.data[k+3]!==255)counts.badU++;if(source.data[k+3]!==255||matte.data[k+3]!==255)counts.badOriginalAlpha++;
  if(x-.5<bx||y-.5<by||x+.5>bx+bw||y+.5>by+bh)counts.outsideBounds++;
  let max=0;for(const frame of frames){const d=sampleHairMeshDisplacement(binding,frame,x,y);max=Math.max(max,Math.hypot(d.x,d.y));if(Math.hypot(d.x,d.y)<1e-7)continue;const xx=Math.floor(x+d.x),yy=Math.floor(y+d.y);if(xx<0||yy<0||xx>=matte.width||yy>=matte.height||matte.data[(yy*matte.width+xx)*4+3]!==255)counts.outerAlphaLandings++;}
  // Corner landing samples alone can miss a concave matte notch between
  // endpoints. Euclidean clearance proves every bounded control displacement
  // remains opaque, with two pixels for raster/filter support.
  if(max>1e-7&&Math.sqrt(alphaDistanceSquared[i])+1e-7<max+2)counts.insufficientContinuousAlphaMargin++;
  if(h){if(max>1e-7)counts.movingHair++;counts.maxHairDisplacement=Math.max(counts.maxHairDisplacement,max);}counts.maxSupportDisplacement=Math.max(counts.maxSupportDisplacement,max);
 }
 for(const key of ['badMask','badOwnership','badU','badOriginalAlpha','outsideBounds','outerAlphaLandings','insufficientContinuousAlphaMargin'])assert.equal(counts[key],0,`${id}: ${key}`);
 assert.ok(counts.owned>=32);assert.ok(counts.movingHair>0,`${id}: a registered rig must move actual hair pixels`);assert.ok(counts.maxSupportDisplacement<=p.binding.revealMarginPx-2+1e-7);
 assert.ok(binding.protectedRegions.length>=4,'each pose protects both complete eye and brow state supports');let pinSamples=0;
 // Derive supports from the actual current expression manifests as well as
 // the binding. A mistakenly shrunken rig guard cannot approve itself.
 const allGuards=[...new Map([...binding.protectedRegions.map(r=>r.polygon),...authoredFeaturePolygons(id)].map(p=>[JSON.stringify(p),p])).values()];
 for(const polygon of allGuards){const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]);for(let y=Math.floor(Math.min(...ys));y<Math.ceil(Math.max(...ys));y++)for(let x=Math.floor(Math.min(...xs));x<Math.ceil(Math.max(...xs));x++)if(inside(x+.5,y+.5,polygon)){pinSamples++;for(const f of frames){const d=sampleHairMeshDisplacement(binding,f,x+.5,y+.5);assert.ok(Math.hypot(d.x,d.y)<1e-7,`${id}: protected/authored sample ${x},${y} moved`);}}}
 assert.ok(pinSamples>0);for(let i=1;i<binding.rootLine.length;i++){const a=binding.rootLine[i-1],b=binding.rootLine[i];for(let s=0;s<=40;s++)for(const f of frames){const d=sampleHairMeshDisplacement(binding,f,a[0]+(b[0]-a[0])*s/40,a[1]+(b[1]-a[1])*s/40);assert.ok(Math.hypot(d.x,d.y)<1e-7,`${id}: root line moved`);}}
 t.diagnostic(JSON.stringify({...counts,pinSamples,minimumAreaRatio:Math.min(...frames.map(f=>f.minimumAreaRatio))}));
});
