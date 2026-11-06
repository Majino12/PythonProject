import test from 'node:test';
import assert from 'node:assert/strict';
import {decomposeRegisteredFringeLayers,describeRegisteredFringeLayers,createShortHairFringeLayerInspection,FRINGE_LAYER_README} from './short-hair-fringe-layer-export.js';
function sample(){return {width:5,height:1,
 source:new Uint8ClampedArray([80,90,110,255,90,95,110,127,190,150,140,255,212,190,180,255,10,20,30,100]),
 underpaint:new Uint8ClampedArray([240,220,210,255,0,0,0,0,240,220,210,255,240,220,210,255,0,0,0,0]),
 ownership:new Uint8Array([255,0,0,0,0]),weight:new Uint8Array([255,0,255,127,0]),hairOwnership:new Uint8Array([255,255,0,0,0]),headOwnership:new Uint8Array([255,255,255,255,0])};}
const pixel=(a,i)=>Array.from(a.slice(i*4,i*4+4));
test('registered W separates front, remaining hair, contact and soft edge with exact reconstruction',()=>{
 const input=sample(),before=Object.fromEntries(Object.entries(input).filter(([,v])=>ArrayBuffer.isView(v)).map(([k,v])=>[k,Array.from(v)]));
 const {layers,statistics}=decomposeRegisteredFringeLayers(input);
 assert.deepEqual(pixel(layers.face,0),[240,220,210,255]);assert.deepEqual(pixel(layers.frontHair,0),pixel(input.source,0));
 assert.deepEqual(pixel(layers.backHair,1),pixel(input.source,1));assert.equal(layers.face[7],0);
 assert.ok(layers.contact[11]>0);assert.equal(layers.edgeCorrection[11],0);assert.ok(layers.edgeCorrection[15]>0);assert.equal(layers.contact[15],0);
 for(const key of ['face','backHair','frontHair','contact','edgeCorrection'])assert.equal(layers[key][19],0,'torso stays outside head layers');
 assert.deepEqual(layers.recomposed,input.source);assert.equal(statistics.reconstructionMismatchPixels,0);assert.equal(statistics.maxReconstructionChannelError,0);
 for(const [key,value]of Object.entries(before))assert.deepEqual(Array.from(input[key]),value);
});
test('all 256 quantized weights and extreme colors remain reconstructable',()=>{
 const count=4096,source=new Uint8ClampedArray(count*4),underpaint=new Uint8ClampedArray(count*4),ownership=new Uint8Array(count),weight=new Uint8Array(count),hairOwnership=new Uint8Array(count),headOwnership=new Uint8Array(count).fill(255);
 for(let i=0;i<count;i++){const k=i*4;source.set([i%256,(i*17)%256,(i*73)%256,255],k);weight[i]=i%256;if(weight[i])underpaint.set([(i*31)%256,255-i%256,(i*137)%256,255],k);if(i%256===255)ownership[i]=hairOwnership[i]=255;}
 const result=decomposeRegisteredFringeLayers({width:64,height:64,source,underpaint,ownership,weight,hairOwnership,headOwnership});
 assert.deepEqual(result.layers.recomposed,source);assert.equal(result.statistics.reconstructionMismatchPixels,0);
});
test('invalid support, partial-alpha reveal and inconsistent ownership fail',()=>{
 for(const [change,message]of [[v=>v.weight[0]=254,/不一致/],[v=>v.hairOwnership[0]=0,/不一致/],[v=>v.headOwnership[0]=0,/不一致/],[v=>v.source[11]=254,/不透明/],[v=>v.underpaint[11]=0,/不透明/],[v=>v.underpaint[7]=255,/越出/],[v=>v.ownership[0]=128,/二值/]]){const value=sample();change(value);assert.throws(()=>decomposeRegisteredFringeLayers(value),message);}
 assert.equal(createShortHairFringeLayerInspection({},'front',null,null),null);
 assert.throws(()=>createShortHairFringeLayerInspection({fringe:{manifest:{poses:{front:{}}}}},'front',null,null),/尚未通过/);
});
test('metadata distinguishes generated support and fixed visible hair from approved complete artwork',()=>{
 const record={path:'./mask.png',sha256:'a'.repeat(64),bytes:100},manifest={model:{name:'SAM 2.1 Hiera Large'},poses:{front:{source:{path:'./source.png',sha256:'b'.repeat(64)},alphaSha256:'c'.repeat(64),ownership:record,weight:record,underpaint:record,hairOwnership:record}}};
 const {descriptor,descriptors}=describeRegisteredFringeLayers(manifest,'front',{reconstructionMismatchPixels:0});
 assert.equal(descriptor.manuallyApproved,false);assert.equal(descriptor.artworkApprovalChanged,false);assert.equal(descriptors.face.completeBareFace,false);assert.equal(descriptors.backHair.completeBackHair,false);assert.equal(descriptors.backHair.hiddenPixelsReconstructed,false);assert.equal(descriptors.underpaint.manuallyApproved,false);
 assert.deepEqual(descriptor.stackBottomToTop,['torso.png','face.png','backHair.png','frontHair.png','contact.png','edgeCorrection.png']);
 assert.ok(descriptor.maskFilesAreNotPaintLayers.includes('weight.png'));assert.ok(descriptor.alternateReferenceOnly.includes('underpaint.png'));
 assert.match(FRINGE_LAYER_README,/不是完整无发裸脸/);assert.match(FRINGE_LAYER_README,/原位重组必须包含二者/);
});
