import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {ShortHairFlowRenderer} from './short-hair-flow-renderer.js';
import {locateHeadTriangle,continuousViewport} from './short-hair-continuous-model.js';
import {STUDIO_HEAD_POSES,poseHeadCoordinates,validateHeadPose,nearestStudioPoseId} from './short-hair-pose-motion.js';
import {validateSecondaryFrame} from './short-hair-secondary-motion.js';
import {gazeOffset} from './expression-gaze.js';
import {sideGazeOffset} from './side-gaze.js';

function gpuHarness(){
  const calls={uploads:[],fields:[],draws:0,programs:0,deletedTextures:0,deletedBuffers:0,deletedPrograms:0,locations:0},events={};let lost=false;
  const gl={createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:()=>true,deleteShader(){},
    createProgram(){calls.programs++;return{};},attachShader(){},linkProgram(){},getProgramParameter:()=>true,useProgram(){},
    getUniformLocation(program,name){calls.locations++;return name;},createBuffer:()=>({}),bindBuffer(){},bufferData(){},
    getAttribLocation:()=>0,enableVertexAttribArray(){},vertexAttribPointer(){},createTexture:()=>({}),bindTexture(){},texParameteri(){},pixelStorei(){},
    texImage3D(...args){calls.fields.push(args.at(-1));},texImage2D(...args){calls.uploads.push(args.at(-1));},getError:()=>0,NO_ERROR:0,
    activeTexture(){},uniform1i(){},uniform3iv(){},uniform3fv(){},viewport(){},disable(){},clearColor(){},clear(){},
    drawArrays(){calls.draws++;},isContextLost:()=>lost,deleteTexture(){calls.deletedTextures++;},deleteBuffer(){calls.deletedBuffers++;},deleteProgram(){calls.deletedPrograms++;},
    getExtension:()=>({loseContext(){lost=true;}})};
  const canvas={width:0,height:0,getContext:()=>gl,addEventListener(type,fn){events[type]=fn;},removeEventListener(type){delete events[type];}};
  const previous=globalThis.document;globalThis.document={createElement:()=>canvas};
  const fields={edges:[['front','left'],['front','up'],['left','up']].map(([from,to])=>({id:from+'-'+to,from,to,flowData:new Uint16Array(1),maskData:new Uint8Array(1)}))};
  let renderer;try{renderer=new ShortHairFlowRenderer(fields);}finally{globalThis.document=previous;}
  return {renderer,calls,events,fields,setLost(value){lost=value;},canvas};
}

test('flow source uploads depend on paint signatures, while a single endpoint uploads only one canvas',()=>{
  const h=gpuHarness(),source={};
  h.renderer.render([{poseId:'front',weight:1}],[source],['front'],{breath:.2,sway:.1,hair:0});
  assert.equal(h.calls.uploads.length,1);assert.strictEqual(h.calls.uploads[0],source);
  const locations=h.calls.locations;
  h.renderer.render([{poseId:'front',weight:1}],[source],['front'],{breath:.3,sway:.2,hair:.5});
  assert.equal(h.calls.uploads.length,1);assert.equal(h.calls.locations,locations);
  h.renderer.render([{poseId:'front',weight:1}],[source],['changed']);assert.equal(h.calls.uploads.length,2);
  h.renderer.dispose();
});

test('lost GPU skips drawing, restored GPU reuses retained field bytes and refreshes textures',()=>{
  const h=gpuHarness(),vertices=[{poseId:'front',weight:.5},{poseId:'left',weight:.2},{poseId:'up',weight:.3}],sources=[{},{},{}];
  h.renderer.render(vertices,sources,['a','b','c']);assert.equal(h.calls.draws,1);
  let prevented=false;h.setLost(true);h.events.webglcontextlost({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(h.renderer.render(vertices,sources,['a','b','c']),null);assert.equal(h.calls.draws,1);
  const firstFields=h.calls.fields.slice();h.setLost(false);h.events.webglcontextrestored();
  assert.equal(h.renderer.lost,false);assert.equal(h.calls.programs,2);
  assert.deepEqual(h.calls.fields.slice(6),firstFields);
  h.renderer.render(vertices,sources,['a','b','c']);assert.equal(h.calls.uploads.length,6);
  h.renderer.dispose();assert.equal(h.calls.deletedTextures,9);assert.equal(h.calls.deletedBuffers,1);assert.equal(h.calls.deletedPrograms,1);
  const programs=h.calls.programs;h.renderer.onRestored();assert.equal(h.calls.programs,programs);
  assert.equal(h.events.webglcontextrestored,undefined);assert.equal(h.renderer.render(vertices,sources,['a','b','c']),null);
});

test('failed GPU restoration retains its cause for a user-visible reload path',()=>{
  const h=gpuHarness();h.events.webglcontextlost({preventDefault(){}});
  h.renderer.gl.getProgramParameter=()=>false;h.events.webglcontextrestored();
  assert.equal(h.renderer.lost,true);assert.match(h.renderer.restoreError.message,/程序无法连接/);
  assert.equal(h.renderer.render([{poseId:'front',weight:1}],[{}],['front']),null);
  h.renderer.dispose();
});

const source=readFileSync(new URL('./short-hair-continuous-renderer.js',import.meta.url),'utf8')
  .replace(/^import .*?;\n/gm,'').replace(/export /g,'');
function continuousHarness(){
  const calls={paint:[],flow:[],alpha:0,draw:[],clear:0,created:0};
  const select=(assets,id,channels)=>({targetState:{eyeLeft:channels.blink?'closed':'open',eyeRight:'open',mouth:channels.jaw>.5?'openSmall':'neutral'},
    targetGaze:{eyeLeft:{x:channels.look||0,y:0},eyeRight:{x:0,y:0}},availableSequences:{}});
  const manifest={patches:{eyeLeft:{closed:{}},eyeRight:{},mouth:{openSmall:{}}}},gaze={maxShift:{x:10,up:6,down:5}};
  const assets={poses:STUDIO_HEAD_POSES.map(p=>({...p,sourceFamily:p.id==='front'?'front':'side'})),
    front:{manifest:{...manifest,gaze},gazeLayers:{eyeLeft:{open:{}},eyeRight:{open:{}}}},
    side:{manifest:{poses:Object.fromEntries(STUDIO_HEAD_POSES.map(p=>[p.id,manifest])),gaze:{poses:Object.fromEntries(STUDIO_HEAD_POSES.map(p=>[p.id,{eyes:{eyeLeft:{},eyeRight:{}}}]))}},gazeLayers:{}},
    continuousBuffers:new Map(),alpha:{},flowRenderer:{lost:false,render(...args){calls.flow.push(args);return {gpu:true};}}};
  const context=vm.createContext({document:{createElement(){calls.created++;return{};}},selectShortHairStudioState:select,
    renderShortHairStudio(canvas,a,id,channels,prev,options){calls.paint.push({id,options});return {state:options.stateOverride,gaze:select(a,id,channels).targetGaze};},
    applyShortHairAlpha(){calls.alpha++;},locateHeadTriangle,continuousViewport,poseHeadCoordinates,validateHeadPose,nearestStudioPoseId,
    validateSecondaryFrame,gazeOffset,sideGazeOffset});vm.runInContext(source,context);
  const canvas={width:1122,height:1402,getContext:()=>({setTransform(){},clearRect(){calls.clear++;},drawImage(...args){calls.draw.push(args);}})};
  return {assets,calls,canvas,render:(channels={},options={})=>context.renderContinuousShortHairStudio(canvas,assets,'front',channels,{},
    {faceOnly:false,headPose:{yaw:0,pitch:0},...options})};
}

test('an exact neutral vertex prepares one source and preserves the direct 2D path when secondary is zero',()=>{
  const h=continuousHarness(),result=h.render();assert.equal(result.didDraw,true);
  assert.equal(h.calls.created,1);assert.equal(h.calls.paint.length,1);assert.equal(h.calls.flow.length,0);
  assert.strictEqual(h.calls.draw[0][0],h.assets.continuousBuffers.get('front').canvas);
  h.render({}, {secondary:{breath:0,sway:0,hair:0}});assert.equal(h.calls.paint.length,1);assert.equal(h.calls.flow.length,0);
  h.render({}, {secondary:{breath:.2,sway:0,hair:.4}});assert.equal(h.calls.created,1);assert.equal(h.calls.flow.length,1);
  assert.equal(h.calls.flow[0][0].length,1);assert.equal(h.calls.paint.length,1);
});

test('painting cache follows selected art and visible iris displacement, not unrelated channels',()=>{
  const h=continuousHarness();h.render({jaw:.1,look:.2,unused:1});h.render({jaw:.2,look:.2,unused:99});assert.equal(h.calls.paint.length,1);
  h.render({jaw:.6,look:.2});assert.equal(h.calls.paint.length,2);
  h.render({jaw:.6,look:.3});assert.equal(h.calls.paint.length,3);
  h.render({blink:1,look:.2});h.render({blink:1,look:.9});assert.equal(h.calls.paint.length,4);
  h.render({blink:1,look:.9},{transparent:true});assert.equal(h.calls.paint.length,5);assert.equal(h.calls.alpha,1);
});

test('GPU loss and a mid-render loss retain target dimensions and last visible frame',()=>{
  const h=continuousHarness();h.render();const before={draw:h.calls.draw.length,clear:h.calls.clear,paint:h.calls.paint.length};
  h.assets.flowRenderer.lost=true;
  assert.equal(h.render({}, {faceOnly:true}).didDraw,false);assert.equal(h.canvas.width,1122);assert.equal(h.canvas.height,1402);
  assert.equal(h.calls.paint.length,before.paint);assert.equal(h.calls.clear,before.clear);
  h.assets.flowRenderer.lost=false;h.assets.flowRenderer.render=()=>null;
  assert.equal(h.render({}, {headPose:{yaw:.2,pitch:.3},faceOnly:true}).didDraw,false);
  assert.equal(h.calls.draw.length,before.draw);assert.equal(h.calls.clear,before.clear);assert.equal(h.canvas.width,1122);
});

test('unrecoverable GPU restoration throws the original cause before touching the display',()=>{
  const h=continuousHarness();h.render();const before=h.calls.draw.length;
  const failure=new Error('rebuild failed');h.assets.flowRenderer.restoreError=failure;h.assets.flowRenderer.lost=true;
  assert.throws(()=>h.render({}, {faceOnly:true}),error=>error===failure);
  assert.equal(h.calls.draw.length,before);assert.equal(h.canvas.width,1122);assert.equal(h.canvas.height,1402);
});

test('original comparison stays unwarped and uses only its nearest authored painting',()=>{
  const h=continuousHarness(),result=h.render({jaw:1,look:1},{original:true,secondary:{breath:1,sway:1,hair:1},headPose:{yaw:.1,pitch:.1}});
  assert.equal(h.calls.created,1);assert.equal(h.calls.flow.length,0);assert.equal(result.secondary.breath,0);
  assert.equal(result.state.mouth,'neutral');
});
