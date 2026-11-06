import test from 'node:test';
import assert from 'node:assert/strict';
import {squaredDistanceToOwnership,createFringeSupport,decomposeOpaqueColor,decomposeFringeLayers} from './short-hair-fringe-decomposition.js';
const rgba=(w,h,fn)=>Uint8ClampedArray.from(Array.from({length:w*h},(_,i)=>fn(i%w,Math.floor(i/w))).flat());
function fixture(){const width=13,height=11,count=width*height,ownership=new Uint8Array(count),contactAllowed=new Uint8Array(count).fill(255),characterAlpha=new Uint8Array(count).fill(255);ownership[5*width+6]=255;return {width,height,ownership,contactAllowed,characterAlpha,source:rgba(width,height,(x,y)=>[40+x*9,70+y*8,96,255]),underpaint:rgba(width,height,()=>[232,194,178,255]),supportRadius:5,solidRadius:1};}

test('distance transform uses exact Euclidean distance through empty rows and multiple disconnected ownership seeds',()=>{
 const width=9,height=7,mask=new Uint8Array(width*height);mask[2*width+3]=255;mask[5*width+7]=255;const distance=squaredDistanceToOwnership(mask,width,height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)assert.equal(distance[y*width+x],Math.min((x-3)**2+(y-2)**2,(x-7)**2+(y-5)**2));
 assert.throws(()=>squaredDistanceToOwnership(new Uint8Array(9),3,3),/不能为空/);
});

test('support keeps hair ownership, rejects semitransparent ownership and excludes guarded or outer-alpha contact pixels',()=>{
 const f=fixture(),center=5*f.width+6;f.contactAllowed[center]=0;f.contactAllowed[center+1]=0;f.characterAlpha[center-1]=254;const r=createFringeSupport(f);
 assert.equal(r.support[center],255);assert.equal(r.weights[center],1);assert.equal(r.support[center+1],0);assert.equal(r.support[center-1],0);
 assert.equal(r.weights[center+f.width],1);assert.ok(r.weights[center+3]>0&&r.weights[center+3]<1);assert.equal(r.support[center+5],0);
 f.characterAlpha[center]=254;assert.throws(()=>createFringeSupport(f),/不透明内侧/);
});

test('minimum-alpha decomposition stays in gamut and rounds back exactly for every 8-bit grayscale pair',()=>{
 for(let s=0;s<256;s++)for(let u=0;u<256;u++){
  const p=decomposeOpaqueColor([s,s,s],[u,u,u]);assert.ok(p.every(v=>Number.isInteger(v)&&v>=0&&v<=255));const a=p[3]/255;
  assert.equal(Math.round((1-a)*u+a*p[0]),s);
  if(s===u)assert.deepEqual(p,[0,0,0,0]);
 }
});

test('exported Uint8 W is the only mixing coefficient and every support pixel has nonzero W',()=>{
 const f=fixture(),r=decomposeFringeLayers(f);assert.ok(r.weight instanceof Uint8Array);
 for(let i=0;i<f.width*f.height;i++){
  assert.equal(r.support[i]>0,r.weight[i]>0);
  assert.equal(r.weights[i],Math.fround(r.weight[i]/255));
  if(f.ownership[i])assert.equal(r.weight[i],255);
  for(let c=0;c<3;c++)assert.equal(r.base[i*4+c],Math.round(f.source[i*4+c]+(f.underpaint[i*4+c]-f.source[i*4+c])*r.weight[i]/255));
 }
});

test('one shared alpha satisfies RGB channels moving in opposite directions, including zero and white endpoints',()=>{
 const cases=[[[0,255,80],[230,0,120]],[[145,45,220],[70,180,230]],[[20,80,160],[0,120,255]],[[255,0,128],[128,255,128]]];
 let seed=357;for(let i=0;i<10000;i++){const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};cases.push([[next(),next(),next()],[next(),next(),next()]]);}
 for(const [s,u]of cases){const p=decomposeOpaqueColor(s,u),a=p[3]/255;for(let c=0;c<3;c++){assert.ok(p[c]>=0&&p[c]<=255);assert.equal(Math.round((1-a)*u[c]+a*p[c]),s[c]);}}
});

test('native layer decomposition preserves untouched bytes and reconstructs original RGB with disjoint hair/contact ownership',()=>{
 const f=fixture(),sourceBefore=f.source.slice(),underpaintBefore=f.underpaint.slice(),r=decomposeFringeLayers(f);let visibleContact=0;
 for(let i=0;i<f.width*f.height;i++){
  const k=i*4;assert.equal(r.hair[k+3]>0&&r.contact[k+3]>0,false);
  if(!r.support[i]){assert.deepEqual(r.base.slice(k,k+4),f.source.slice(k,k+4));assert.deepEqual(r.foreground.slice(k,k+4),new Uint8ClampedArray(4));}
  if(f.ownership[i]){assert.deepEqual(r.base.slice(k,k+4),f.underpaint.slice(k,k+4));assert.deepEqual(r.hair.slice(k,k+4),f.source.slice(k,k+4));}
  if(r.contact[k+3])visibleContact++;
  const a=r.foreground[k+3]/255;for(let c=0;c<3;c++)assert.equal(Math.round((1-a)*r.base[k+c]+a*r.foreground[k+c]),f.source[k+c]);
 }
 assert.ok(visibleContact>0);assert.equal(r.statistics.roundedReconstructionMismatchPixels,0);assert.ok(r.statistics.maxFloatReconstructionError<.5);
 assert.deepEqual(f.source,sourceBefore);assert.deepEqual(f.underpaint,underpaintBefore);
});

test('contact feature guards preserve active painted pixels and never punch actual pinned hair out of its layer',()=>{
 const f=fixture(),center=5*f.width+6,feature=center+1;f.contactAllowed[feature]=0;f.contactAllowed[center]=0;f.source.set([14,19,37,255],feature*4);
 const r=decomposeFringeLayers(f);assert.deepEqual(r.base.slice(feature*4,feature*4+4),f.source.slice(feature*4,feature*4+4));assert.equal(r.contact[feature*4+3],0);assert.equal(r.hair[center*4+3],255);
});

test('missing hidden alpha, wrong array size, nonbinary masks and invalid radius fail without coercion or resizing',()=>{
 const f=fixture();f.underpaint[(5*f.width+6)*4+3]=253;assert.throws(()=>decomposeFringeLayers(f),/不透明/);f.underpaint[(5*f.width+6)*4+3]=255;
 assert.throws(()=>decomposeFringeLayers({...f,source:new Uint8Array(2)}));assert.throws(()=>decomposeFringeLayers({...f,supportRadius:3,solidRadius:3}));assert.throws(()=>decomposeFringeLayers({...f,supportRadius:NaN}));
 const wrong=f.ownership.slice();wrong[0]=1;assert.throws(()=>decomposeFringeLayers({...f,ownership:wrong}),/二值/);assert.throws(()=>decomposeOpaqueColor([0,255,NaN],[1,2,3]));
});
