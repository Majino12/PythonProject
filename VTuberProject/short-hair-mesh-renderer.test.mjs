import test from 'node:test';
import assert from 'node:assert/strict';
import {ShortHairMeshRenderer} from './short-hair-mesh-renderer.js';
import {createHairMeshBinding,HAIR_MESH_POSES} from './short-hair-mesh-model.js';
const binding=(extra={})=>createHairMeshBinding({schemaVersion:1,kind:'short-hair-mesh-binding',poseId:'front',sourceSha256:'1'.repeat(64),bounds:[200,200,700,500],grid:{columns:17,rows:13},rootLine:[[200,250],[900,250]],tipLine:[[200,580],[900,580]],travel:{x:5.8,y:1},revealMarginPx:8,runtimeValidated:true,protectedRegions:[],...extra});
const source=()=>({width:1122,height:1402});
function harness(){
  const calls={uploads:[],draws:0,programs:0,buffers:0,deletedTextures:0,deletedBuffers:0,deletedPrograms:0,subData:[],pixelStore:[]},events={};let lost=false;
  const gl={createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:()=>true,deleteShader(){},
    createProgram(){calls.programs++;return{};},attachShader(){},linkProgram(){},getProgramParameter:()=>true,useProgram(){},
    getUniformLocation:()=>({}),getAttribLocation:(p,name)=>name==='sourcePosition'?0:1,
    createBuffer(){calls.buffers++;return{};},bindBuffer(){},bufferData(){},bufferSubData(...args){calls.subData.push(args.at(-1));},
    enableVertexAttribArray(){},vertexAttribPointer(){},createTexture:()=>({}),bindTexture(){},texParameteri(){},
    pixelStorei(...args){calls.pixelStore.push(args);},texImage2D(...args){calls.uploads.push(args.at(-1));},getError:()=>0,NO_ERROR:0,
    activeTexture(){},uniform1i(){},viewport(){},disable(){},clearColor(){},clear(){},
    drawElements(){calls.draws++;},isContextLost:()=>lost,deleteTexture(){calls.deletedTextures++;},deleteBuffer(){calls.deletedBuffers++;},deleteProgram(){calls.deletedPrograms++;},
    getExtension:()=>({loseContext(){lost=true;}}),UNPACK_PREMULTIPLY_ALPHA_WEBGL:'premultiply',UNPACK_FLIP_Y_WEBGL:'flip',UNPACK_ALIGNMENT:'alignment'};
  const canvas={width:0,height:0,getContext:()=>gl,addEventListener(type,fn){events[type]=fn;},removeEventListener(type){delete events[type];}};
  const previous=globalThis.document;globalThis.document={createElement:()=>canvas};let renderer;
  try{renderer=new ShortHairMeshRenderer();}finally{globalThis.document=previous;}
  return {renderer,gl,canvas,calls,events,setLost(value){lost=value;}};
}

test('zero, original and unsupported hair meshes use source identity without GPU upload or drawing',()=>{
  const h=harness(),src=source(),b=binding();
  assert.strictEqual(h.renderer.render(src,b),src);assert.strictEqual(h.renderer.render(src,b,{x:1,y:1},{original:true}),src);
  assert.strictEqual(h.renderer.render(src,b,{x:1,y:1},{enabled:false}),src);assert.strictEqual(h.renderer.render(src,null,{x:1,y:1}),src);
  assert.strictEqual(h.renderer.render(src,binding({runtimeValidated:false,revealMarginPx:0}),{x:1,y:1}),src);
  assert.equal(h.calls.draws,0);assert.equal(h.calls.uploads.length,0);h.renderer.dispose();
});

test('a shared renderer retains per-pose textures and uploads changed source pixels only',()=>{
  const h=harness(),sources=HAIR_MESH_POSES.map(source),bindings=HAIR_MESH_POSES.map(poseId=>binding({poseId}));
  for(let i=0;i<9;i++)assert.strictEqual(h.renderer.render(sources[i],bindings[i],{x:.8,y:.1},{signature:'same'}),h.canvas);
  assert.equal(h.renderer.textures.size,9);assert.equal(h.renderer.geometry.size,9);assert.equal(h.calls.uploads.length,9);assert.equal(h.calls.buffers,27);
  for(let i=8;i>=0;i--)h.renderer.render(sources[i],bindings[i],{x:-.8,y:-.1},{signature:'same'});
  assert.equal(h.calls.uploads.length,9);assert.equal(h.calls.buffers,27);assert.equal(h.calls.draws,18);
  h.renderer.render(sources[0],bindings[0],{x:1,y:0},{signature:'changed'});assert.equal(h.calls.uploads.length,10);
  h.renderer.render(source(),bindings[0],{x:1,y:0},{signature:'changed'});assert.equal(h.calls.uploads.length,11);
  assert.ok(h.calls.pixelStore.some(([name,value])=>name==='premultiply'&&value===true));
  h.renderer.dispose();assert.equal(h.calls.deletedTextures,9);assert.equal(h.calls.deletedBuffers,27);assert.equal(h.calls.deletedPrograms,1);
});

test('replacing a pose binding releases its old buffers without accumulating another geometry record',()=>{
  const h=harness(),src=source();h.renderer.render(src,binding(),{x:1,y:0});h.renderer.render(src,binding({grid:{columns:20,rows:20}}),{x:1,y:0});
  assert.equal(h.renderer.geometry.size,1);assert.equal(h.calls.deletedBuffers,3);assert.equal(h.calls.buffers,6);assert.equal(h.calls.uploads.length,1);h.renderer.dispose();
});

test('context loss skips the active frame and restoration rebuilds buffers and textures before drawing',()=>{
  const h=harness(),src=source(),b=binding();h.renderer.render(src,b,{x:1,y:0},{signature:'retained'});
  let prevented=false;h.setLost(true);h.events.webglcontextlost({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(h.renderer.render(src,b,{x:1,y:0}),null);assert.equal(h.calls.draws,1);
  h.setLost(false);h.events.webglcontextrestored();assert.equal(h.renderer.lost,false);
  assert.strictEqual(h.renderer.render(src,b,{x:1,y:0},{signature:'retained'}),h.canvas);assert.equal(h.calls.programs,2);assert.equal(h.calls.uploads.length,2);assert.equal(h.calls.buffers,6);
  h.renderer.dispose();h.renderer.dispose();assert.equal(h.calls.deletedTextures,1);assert.equal(h.calls.deletedBuffers,3);assert.equal(h.calls.deletedPrograms,1);
  const programs=h.calls.programs;h.renderer.onRestored();assert.equal(h.calls.programs,programs);assert.equal(h.renderer.render(src,b,{x:0,y:0}),null);
  assert.equal(h.events.webglcontextrestored,undefined);
});

test('failed restoration retains a visible error while exact rest rendering remains possible',()=>{
  const h=harness(),src=source(),b=binding();h.events.webglcontextlost({preventDefault(){}});h.gl.getProgramParameter=()=>false;h.events.webglcontextrestored();
  assert.ok(h.renderer.restoreError);assert.throws(()=>h.renderer.render(src,b,{x:1,y:0}),/程序无法连接/);assert.strictEqual(h.renderer.render(src,b,{x:0,y:0}),src);h.renderer.dispose();
});

test('wrong canvas dimensions, malformed signatures and controls cannot populate caches',()=>{
  const h=harness(),b=binding();assert.throws(()=>h.renderer.render({width:1111,height:1402},b),/原生图层/);
  assert.throws(()=>h.renderer.render(source(),b,{x:1,y:0},{signature:{}}),/签名/);assert.throws(()=>h.renderer.render(source(),b,{x:NaN,y:0}));
  assert.equal(h.renderer.geometry.size,0);assert.equal(h.calls.uploads.length,0);h.renderer.dispose();
});


const material=()=>({underpaint:source(),weight:source(),ownership:source(),signature:'static-material'});
test('material mode uploads D by dynamic signature and caches U/W/H independently per pose',()=>{
  const h=harness(),b=binding(),d=source(),m=material();
  h.renderer.render(d,b,{x:1,y:0},{signature:'expression-a',material:m});assert.equal(h.calls.uploads.length,4);assert.equal(h.renderer.materials.size,1);
  h.renderer.render(d,b,{x:-1,y:0},{signature:'expression-a',material:m});assert.equal(h.calls.uploads.length,4);
  h.renderer.render(d,b,{x:1,y:0},{signature:'expression-b',material:m});assert.equal(h.calls.uploads.length,5);assert.strictEqual(h.calls.uploads.at(-1),d);
  h.renderer.render(d,b,{x:1,y:0},{signature:'expression-b',material:{...m,signature:'updated-material'}});assert.equal(h.calls.uploads.length,8);
  h.renderer.render(d,b,{x:1,y:0},{signature:'expression-b',material:{...m,weight:source(),signature:'updated-material'}});assert.equal(h.calls.uploads.length,9);
  h.renderer.render(d,b,{x:1,y:0},{signature:'expression-b'});assert.equal(h.calls.uploads.length,9);
  h.renderer.dispose();assert.equal(h.calls.deletedTextures,4);
});

test('material textures remain pose-specific and are all rebuilt after a real-context lifecycle event',()=>{
  const h=harness(),d=source(),m=material(),a=binding(),b=binding({poseId:'view-left'});
  h.renderer.render(d,a,{x:1,y:0},{signature:'D',material:m});h.renderer.render(d,b,{x:1,y:0},{signature:'D',material:m});assert.equal(h.calls.uploads.length,8);assert.equal(h.renderer.materials.size,2);
  h.setLost(true);h.events.webglcontextlost({preventDefault(){}});assert.equal(h.renderer.render(d,a,{x:1,y:0},{material:m}),null);
  h.setLost(false);h.events.webglcontextrestored();assert.equal(h.renderer.materials.size,0);
  h.renderer.render(d,a,{x:1,y:0},{signature:'D',material:m});assert.equal(h.calls.uploads.length,12);h.renderer.dispose();assert.equal(h.calls.deletedTextures,4);
});

test('zero path does not allocate material textures and incomplete material contracts are rejected',()=>{
  const h=harness(),d=source(),b=binding(),m=material();assert.strictEqual(h.renderer.render(d,b,{x:0,y:0},{material:m}),d);assert.equal(h.renderer.materials.size,0);
  for(const bad of [{...m,weight:{}},{...m,signature:1},{...m,extra:1},{underpaint:d,weight:d,signature:'a'}])assert.throws(()=>h.renderer.render(d,b,{x:1,y:0},{material:bad}),/材质/);
  assert.equal(h.calls.uploads.length,0);h.renderer.dispose();
});
