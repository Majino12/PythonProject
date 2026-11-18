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
import {ARTICULATION_GROUPS,articulationFromState,articulationState,validateArticulation} from './short-hair-articulation.js';
import {featureChartsForState,blendFeatureSets,packFeatureGeometry} from './short-hair-feature-geometry.js';

function gpuHarness(){
  const calls={uploads:[],fields:[],geometry:[],layerMaps:[],viewports:[],scissors:[],clears:[],drawStates:[],scissorEnabled:false,
    draws:0,programs:0,deletedTextures:0,deletedBuffers:0,deletedPrograms:0,locations:0},events={};let lost=false;
  const gl={createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:()=>true,deleteShader(){},
    createProgram(){calls.programs++;return{};},attachShader(){},linkProgram(){},getProgramParameter:()=>true,useProgram(){},
    getUniformLocation(program,name){calls.locations++;return name;},createBuffer:()=>({}),bindBuffer(){},bufferData(){},
    getAttribLocation:()=>0,enableVertexAttribArray(){},vertexAttribPointer(){},createTexture:()=>({}),bindTexture(){},texParameteri(){},pixelStorei(){},
    texImage3D(...args){if(args.at(-1)!==null)calls.fields.push(args.at(-1));},texSubImage3D(...args){calls.uploads.push(args.at(-1));},texImage2D(...args){if(args.length===6)calls.uploads.push(args.at(-1));},texSubImage2D(...args){calls.geometry.push(args.at(-1));},getError:()=>0,NO_ERROR:0,
    activeTexture(){},uniform1i(){},uniform3iv(){},uniform3fv(){},uniform1fv(){},uniform4fv(name,value){if(name==='sourceLayers[0]')calls.layerMaps.push([...value]);},
    viewport(...args){calls.viewports.push(args);},SCISSOR_TEST:'scissor',BLEND:'blend',
    enable(cap){if(cap===this.SCISSOR_TEST)calls.scissorEnabled=true;},disable(cap){if(cap===this.SCISSOR_TEST)calls.scissorEnabled=false;},
    scissor(...args){calls.scissors.push(args);},clearColor(){},clear(){calls.clears.push({scissorEnabled:calls.scissorEnabled});},
    drawArrays(){calls.draws++;calls.drawStates.push({scissorEnabled:calls.scissorEnabled});},isContextLost:()=>lost,deleteTexture(){calls.deletedTextures++;},deleteBuffer(){calls.deletedBuffers++;},deleteProgram(){calls.deletedPrograms++;},
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
  h.renderer.dispose();assert.equal(h.calls.deletedTextures,13);assert.equal(h.calls.deletedBuffers,1);assert.equal(h.calls.deletedPrograms,1);
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
  const select=(assets,id,channels)=>({targetState:{eyeLeft:channels.blink?'closed':'open',eyeRight:'open',mouth:channels.jaw>.5?'openSmall':'neutral',browLeft:'neutral',browRight:'neutral'},
    targetGaze:{eyeLeft:{x:channels.look||0,y:0},eyeRight:{x:0,y:0}},availableSequences:{}});
  const manifest={patches:{eyeLeft:{closed:{}},eyeRight:{},mouth:{openSmall:{}},browLeft:{},browRight:{}}},gaze={maxShift:{x:10,up:6,down:5}};
  const assets={poses:STUDIO_HEAD_POSES.map(p=>({...p,sourceFamily:p.id==='front'?'front':'side'})),
    front:{manifest:{...manifest,gaze},gazeLayers:{eyeLeft:{open:{}},eyeRight:{open:{}}}},
    side:{manifest:{poses:Object.fromEntries(STUDIO_HEAD_POSES.map(p=>[p.id,manifest])),gaze:{poses:Object.fromEntries(STUDIO_HEAD_POSES.map(p=>[p.id,{eyes:{eyeLeft:{},eyeRight:{}}}]))}},gazeLayers:{}},
    continuousBuffers:new Map(),alpha:{},flowRenderer:{lost:false,render(...args){calls.flow.push(args);return {gpu:true};}}};
  const context=vm.createContext({document:{createElement(){calls.created++;return{};}},selectShortHairStudioState:select,
    renderShortHairStudio(canvas,a,id,channels,prev,options){calls.paint.push({id,options});return {state:options.stateOverride,gaze:select(a,id,channels).targetGaze};},
    applyShortHairAlpha(){calls.alpha++;},locateHeadTriangle,continuousViewport,poseHeadCoordinates,validateHeadPose,nearestStudioPoseId,
    validateSecondaryFrame,gazeOffset,sideGazeOffset,ARTICULATION_GROUPS,articulationFromState,articulationState,validateArticulation});vm.runInContext(source,context);
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


function addFringe(h){const calls=[];h.assets.fringeRenderer={lost:false,disposed:false,restoreError:null,render(source,poseId,controls,options){const canvas={fringe:true,poseId,source,controls};calls.push({source,poseId,controls,options,canvas});return canvas;}};return calls;}
test('fringe meshes receive current per-pose expression pixels before RIFE and suppress duplicate old hair warping',()=>{
  const h=continuousHarness(),fringe=addFringe(h);h.render({jaw:.8,look:.3},{headPose:{yaw:.2,pitch:.3},secondary:{breath:.1,sway:.2,hair:.5}});
  assert.equal(fringe.length,3);assert.equal(h.calls.paint.length,3);assert.equal(h.calls.flow.length,1);
  assert.equal(new Set(fringe.map(c=>c.canvas)).size,3);assert.equal(new Set(h.calls.flow[0][1]).size,3);
  for(const call of fringe){assert.deepEqual({...call.controls},{x:.5,y:.09});assert.strictEqual(call.source,h.assets.continuousBuffers.get(call.poseId).canvas);}
  assert.deepEqual({...h.calls.flow[0][3]},{breath:.1,sway:.2,hair:0});
  const signatures=[...h.calls.flow[0][2]];
  h.render({jaw:.8,look:.3},{headPose:{yaw:.2,pitch:.3},secondary:{breath:.1,sway:.2,hair:-.5}});
  assert.equal(h.calls.paint.length,3);assert.equal(fringe.length,6);assert.notDeepEqual([...h.calls.flow[1][2]],signatures);
});

test('fringe-only endpoint uses its assembled 2D source directly and preserves published hair control',()=>{
  const h=continuousHarness(),fringe=addFringe(h),result=h.render({}, {secondary:{breath:0,sway:0,hair:.5}});
  assert.equal(fringe.length,1);assert.equal(h.calls.flow.length,0);assert.strictEqual(h.calls.draw[0][0],fringe[0].canvas);assert.equal(result.secondary.hair,.5);
});

test('zero and original frames retain the precise old source path even with fringe assets loaded',()=>{
  const h=continuousHarness(),fringe=addFringe(h);h.render();assert.equal(fringe.length,0);assert.equal(h.calls.flow.length,0);assert.strictEqual(h.calls.draw[0][0],h.assets.continuousBuffers.get('front').canvas);
  h.render({jaw:.8},{original:true,secondary:{breath:1,sway:1,hair:1},headPose:{yaw:.2,pitch:.3}});assert.equal(fringe.length,0);assert.equal(h.calls.flow.length,0);
});

test('fringe loss, mid-composition failure and restoration errors retain the last display without partial repaint',()=>{
  const h=continuousHarness();h.render();addFringe(h);const before={draw:h.calls.draw.length,clear:h.calls.clear,paint:h.calls.paint.length};
  h.assets.fringeRenderer.lost=true;assert.equal(h.render({jaw:1},{faceOnly:true,secondary:{breath:0,sway:0,hair:1}}).didDraw,false);assert.equal(h.calls.paint.length,before.paint);
  h.assets.fringeRenderer.lost=false;let count=0;h.assets.fringeRenderer.render=()=>++count===2?null:{};
  assert.equal(h.render({jaw:1},{faceOnly:true,headPose:{yaw:.2,pitch:.3},secondary:{breath:0,sway:0,hair:1}}).didDraw,false);
  assert.equal(h.calls.draw.length,before.draw);assert.equal(h.calls.clear,before.clear);assert.equal(h.canvas.width,1122);
  const failure=new Error('mesh rebuild failed');h.assets.fringeRenderer.restoreError=failure;assert.throws(()=>h.render({}, {secondary:{breath:0,sway:0,hair:1}}),e=>e===failure);
});

function assetLoadHarness({hashMismatch=false,fringeConstructionFails=false}={}){
  const calls={flow:0,fringe:0,flowDisposed:0},sha='1'.repeat(64),matteSha='3'.repeat(64),path='./assets/short-hair-v1/front.png';
  const art={poses:[{id:'front',sourceFamily:'front'}],front:{manifest:{reference:'front',sources:{front:{src:path}}}}};
  const alpha={manifest:{poses:{front:{source:path,sourceSha256:sha,matteSha256:matteSha}}}},motion={manifest:{sources:{front:{path,sha256:sha}}}},
    fringe={manifest:{poses:{front:{source:{path,sha256:sha},alphaSha256:matteSha}}},poses:{front:{binding:{poseId:'front',sourceSha256:hashMismatch?'2'.repeat(64):sha}}}};
  const context=vm.createContext({loadShortHairStudioAssets:async()=>art,loadShortHairAlphaAssets:async()=>alpha,loadShortHairMotionFields:async()=>motion,loadShortHairFringeAssets:async()=>fringe,loadFeatureGeometry:async()=>({poses:{front:{source:path,sourceSha256:sha,features:{}}}}),
    ShortHairFlowRenderer:class{constructor(){calls.flow++;}dispose(){calls.flowDisposed++;}},ShortHairFringeRenderer:class{constructor(value){calls.fringe++;assert.strictEqual(value,fringe);if(fringeConstructionFails)throw new Error('no second GPU');}}});
  vm.runInContext(source,context);return {calls,load:()=>context.loadContinuousShortHairAssets()};
}
test('source hash mismatch is rejected before allocating either renderer',async()=>{const h=assetLoadHarness({hashMismatch:true});await assert.rejects(h.load(),/前发绑定/);assert.equal(h.calls.flow,0);assert.equal(h.calls.fringe,0);});
test('failed fringe construction disposes the already-created flow context',async()=>{const h=assetLoadHarness({fringeConstructionFails:true});await assert.rejects(h.load(),/no second GPU/);assert.equal(h.calls.flowDisposed,1);});
test('successful asset loading owns both renderers and separate expression buffers',async()=>{const h=assetLoadHarness(),assets=await h.load();assert.ok(assets.flowRenderer&&assets.fringeRenderer&&assets.fringe);assert.equal(assets.continuousBuffers.size,0);});

test('four authored corners upload unique array layers and keep changing time independent of paint uploads',()=>{
  const h=gpuHarness(),a={},b={},c={},d={},sets=()=>Array(6).fill(null);
  const descriptor={from:[sets()],to:[sets()],progress:[0,.2,.4,.6,.3,.7],secondSources:[b],secondSignatures:['B'],
    browSources:[c],browSignatures:['C'],browSecondSources:[d],browSecondSignatures:['D']};
  h.renderer.render([{poseId:'front',weight:1}],[a],['A'],undefined,descriptor);
  assert.deepEqual(h.calls.uploads,[a,b,c,d]);assert.deepEqual(h.renderer.sourceSignatures,['A','B','C','D']);
  descriptor.progress=[0,.3,.5,.7,.4,.8];h.renderer.render([{poseId:'front',weight:1}],[a],['A'],undefined,descriptor);
  assert.equal(h.calls.uploads.length,4);
  descriptor.browSources=[a];descriptor.browSignatures=['A'];descriptor.browSecondSources=[b];descriptor.browSecondSignatures=['B'];
  h.renderer.render([{poseId:'front',weight:1}],[a],['A'],undefined,descriptor);assert.equal(h.calls.uploads.length,4);
  assert.deepEqual(h.calls.layerMaps.at(-1),[0,1,0,1,0,1,0,1,0,1,0,1]);
  h.renderer.dispose();
});

test('failed array uploads preserve the display and retry uncached signatures',()=>{
  const h=gpuHarness(),a={};h.renderer.gl.getError=()=>1285;
  assert.throws(()=>h.renderer.render([{poseId:'front',weight:1}],[a],['A']),/纹理上传失败/);
  assert.equal(h.calls.draws,0);assert.equal(h.renderer.sourceSignatures.length,0);
  h.renderer.gl.getError=()=>0;h.renderer.render([{poseId:'front',weight:1}],[a],['A']);
  assert.equal(h.calls.uploads.length,2);assert.equal(h.calls.draws,1);assert.equal(h.renderer.sourceSignatures[0],'A');h.renderer.dispose();
});

test('flow crop keeps native viewport, clears all pixels and maps top-left crop to GL scissor only for drawing',()=>{
  const h=gpuHarness(),vertices=[{poseId:'front',weight:1}],sources=[{}];
  h.renderer.render(vertices,sources,['A'],undefined,null,[200,270,780,600]);
  assert.deepEqual([h.canvas.width,h.canvas.height],[1122,1402]);
  assert.deepEqual(h.calls.viewports.at(-1),[0,0,1122,1402]);
  assert.deepEqual(h.calls.scissors,[[200,532,780,600]]);
  assert.deepEqual(h.calls.clears,[{scissorEnabled:false}]);
  assert.deepEqual(h.calls.drawStates,[{scissorEnabled:true}]);
  assert.equal(h.calls.scissorEnabled,false);
  // A later full-frame consumer cannot inherit the previous face-only clip.
  h.renderer.render(vertices,sources,['A']);
  assert.equal(h.calls.scissors.length,1);assert.deepEqual(h.calls.drawStates.at(-1),{scissorEnabled:false});
  assert.equal(h.calls.scissorEnabled,false);assert.equal(h.calls.uploads.length,1);
  for(const crop of [[0,0,1122,1402],[1121,1401,1,1]]){
    h.renderer.render(vertices,sources,['A'],undefined,null,crop);
    assert.deepEqual(h.calls.scissors.at(-1),[crop[0],1402-crop[1]-crop[3],crop[2],crop[3]]);
  }
  h.renderer.dispose();
});

test('invalid crops fail before source uploads, clearing, drawing or viewport changes',()=>{
  const h=gpuHarness();
  for(const crop of [false,{},[],[0,0,1],[0,0,1,1,0],[-1,0,1,1],[0,-1,1,1],[0,0,0,1],[0,0,1,-1],
    [1,0,1122,1402],[0,1,1122,1402],[0,0,1123,1],[0,0,1,1403],[.1,0,1,1],[0,0,NaN,1],[0,0,1,Infinity]]){
    assert.throws(()=>h.renderer.render([{poseId:'front',weight:1}],[{}],['A'],undefined,null,crop),/裁切/);
  }
  assert.equal(h.calls.uploads.length,0);assert.equal(h.calls.clears.length,0);assert.equal(h.calls.draws,0);assert.equal(h.calls.viewports.length,0);
  h.renderer.dispose();
});

test('crop state is reset after drawing throws or loses the context, and uploads still fail before clearing',()=>{
  const h=gpuHarness(),vertices=[{poseId:'front',weight:1}],source={},crop=[200,270,780,600],draw=h.renderer.gl.drawArrays;
  const failure=new Error('draw failed');h.renderer.gl.drawArrays=()=>{assert.equal(h.calls.scissorEnabled,true);throw failure;};
  assert.throws(()=>h.renderer.render(vertices,[source],['A'],undefined,null,crop),error=>error===failure);
  assert.equal(h.calls.scissorEnabled,false);
  const clears=h.calls.clears.length;
  h.renderer.gl.getError=()=>1285;
  assert.throws(()=>h.renderer.render(vertices,[source],['B'],undefined,null,crop),/纹理上传失败/);
  assert.equal(h.calls.clears.length,clears);assert.equal(h.calls.scissorEnabled,false);
  h.renderer.gl.getError=()=>0;h.renderer.gl.drawArrays=()=>{draw();h.setLost(true);};
  assert.equal(h.renderer.render(vertices,[source],['B'],undefined,null,crop),null);
  assert.equal(h.calls.scissorEnabled,false);
  h.setLost(false);h.events.webglcontextrestored();h.renderer.gl.drawArrays=draw;
  h.renderer.render(vertices,[source],['B']);assert.equal(h.calls.drawStates.at(-1).scissorEnabled,false);
  h.renderer.dispose();
});

test('per-feature geometry blending packs exactly the former whole-set result for real source charts',()=>{
  const h=gpuHarness(),manifest=JSON.parse(readFileSync(new URL('./assets/short-hair-features-v1/manifest.json',import.meta.url),'utf8'));
  const first={eyeLeft:'quarter',eyeRight:'half',mouth:'parted',browLeft:'neutral',browRight:'neutral'},last={...first,eyeLeft:'half',eyeRight:'threeQuarter',mouth:'openSmall'};
  const ids=['front','view-left','view-up'],from=ids.map(id=>featureChartsForState(manifest,id,first)),to=ids.map(id=>featureChartsForState(manifest,id,last));
  const vertices=[{poseId:'front',weight:.5},{poseId:'left',weight:.2},{poseId:'up',weight:.3}],weights=vertices.map(v=>v.weight);
  for(const progress of [[0,0,0,0,0,0],[0,1,1,1,0,0],[0,.27,.61,.43,.34,.79]]){
    const targets=from.map((set,i)=>set.map((chart,f)=>chart&&to[i][f]?blendFeatureSets([set,to[i]],[1-progress[f],progress[f]])[f]:null));
    const expected=packFeatureGeometry(blendFeatureSets(targets,weights),from.flatMap((set,i)=>[set,to[i]]));
    h.renderer.render(vertices,[{},{},{}],['A','B','C'],undefined,{from,to,progress});
    assert.deepEqual(h.calls.geometry.at(-1),expected);
  }
  h.renderer.dispose();
});
