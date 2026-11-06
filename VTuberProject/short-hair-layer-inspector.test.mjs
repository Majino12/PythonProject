import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createShortHairLayerInspection} from './short-hair-layer-inspector.js';
import {createShortHairLayerFrame} from './short-hair-alpha.js';

const groups=['eyeLeft','eyeRight','browLeft','browRight','mouth'];
const dimensions=[1122,1402];
const neutral={eyeLeft:'open',eyeRight:'open',browLeft:'neutral',browRight:'neutral',mouth:'neutral'};
const plain=value=>JSON.parse(JSON.stringify(value));

function harness({withFringe=false}={}) {
  const renders=[],selections=[],canvases=[];
  function canvas() {
    const result={width:0,height:0,pixels:null,operations:[],matteApplications:0};
    const context={globalCompositeOperation:'source-over',save(){this.saved=this.globalCompositeOperation;},restore(){this.globalCompositeOperation=this.saved;},setTransform(){},
      drawImage(source,...rect){result.operations.push({source,rect});
        if(source.matte){result.matteApplications++;if(result.pixels)for(let i=3;i<result.pixels.length;i+=4)result.pixels[i]=Math.round(result.pixels[i]/2);}
        else if(source.pixels)result.pixels=new Uint8ClampedArray(source.pixels);},
      getImageData(){return {data:result.pixels||new Uint8ClampedArray(result.width*result.height*4)};},
      createImageData(width,height){return {data:new Uint8ClampedArray(width*height*4)};},putImageData(image){result.pixels=image.data;}};
    result.getContext=()=>context;result.toBlob=callback=>callback(new Blob([JSON.stringify({width:result.width,height:result.height})],{type:'image/png'}));
    canvases.push(result);return result;
  }
  const raw=readFileSync(new URL('./short-hair-alpha.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'');
  const context=vm.createContext({document:{createElement:canvas},Blob,TextEncoder,Uint8Array,Uint8ClampedArray,Uint32Array,DataView,FRINGE_LAYER_README:'fringe reconstruction instructions',
    createShortHairFringeLayerInspection(assets,poseId,character,head){
      assert.equal(character.matteApplications,1);assert.equal(head.matteApplications,0);
      const layers={},descriptors={};for(const key of ['face','backHair','frontHair','contact','edgeCorrection','recomposed','ownership','weight','hairOwnership','underpaint']){layers[key]=Object.assign(canvas(),{width:1122,height:1402});descriptors[key]={kind:key,manuallyApproved:false};}
      return {layers,descriptors,binding:{poseId,runtimeValidated:true},descriptor:{status:'derived-candidate',manuallyApproved:false,compositing:'registered source-over stack',limitations:['Generated support is not a complete approved bare face.']}};
    },
    selectShortHairStudioState(assets,poseId,coefficients,previous){selections.push({poseId,coefficients,previous});return {targetState:{...neutral,browLeft:poseId==='front'?'up':'innerUp'}};},
    renderShortHairStudio(target,assets,poseId,coefficients,previous,options){renders.push({target,poseId,coefficients,previous,options});
      target.pixels=new Uint8ClampedArray(target.width*target.height*4);
      target.pixels.set([12,34,56,255],(100*target.width+500)*4);target.pixels.set([78,90,12,100],(1200*target.width+500)*4);
      return {state:{...options.stateOverride}};}});
  vm.runInContext(raw+'\nglobalThis.api={createShortHairLayerFrame,exportShortHairLayers};',context);
  const entry={source:'./assets/portrait.png',neckline:[[0,800],[1122,800]]};
  function family(poseId) {
    const patches={},compiled={};
    for(const [i,group] of groups.entries()) {
      const state=group.startsWith('eye')?'half':group.startsWith('brow')?poseId==='front'?'up':'innerUp':'parted';
      patches[group]={[state]:{source:'painting',destination:[100+i*50,300,40,20]}};
      compiled[group]={[state]:{label:`${poseId}-${group}-${state}`}};
    }
    const record={reference:'portrait',patches},sources={portrait:{src:'./assets/portrait.png'},painting:{src:'./assets/painting.png'}};
    return poseId==='front'?{manifest:{...record,sources},compiled}:{manifest:{poses:{[poseId]:record},sources},compiled:{[poseId]:compiled}};
  }
  const assets={alpha:{manifest:{poses:{front:entry,'view-left':entry}},mattes:{front:{matte:true},'view-left':{matte:true}}},front:family('front'),side:family('view-left')};
  if(withFringe)assets.fringe={poses:{front:{}},manifest:{poses:{front:{}}}};
  return {...context.api,renders,selections,canvases,assets};
}

function zipEntries(bytes) {
  const entries={},view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=0;
  while(view.getUint32(offset,true)===0x04034b50) {
    const size=view.getUint32(offset+18,true),nameSize=view.getUint16(offset+26,true),extraSize=view.getUint16(offset+28,true);
    const name=new TextDecoder().decode(bytes.slice(offset+30,offset+30+nameSize)),start=offset+30+nameSize+extraSize;
    entries[name]=bytes.slice(start,start+size);offset=start+size;
  }
  return entries;
}

test('layer inspector exposes the synchronous shared ZIP builder without another rendering implementation',()=>{
  assert.equal(createShortHairLayerInspection,createShortHairLayerFrame);
});

test('inspection creates all eight native-coordinate transparent layers once without mutating source assets',()=>{
  const h=harness(),before=JSON.stringify(h.assets),coefficients=Object.freeze({jawOpen:.3,eyeLookOutLeft:.5});
  const displayed=Object.freeze({...neutral,eyeLeft:'half',mouth:'parted',browLeft:'innerUp'});
  const result=h.createShortHairLayerFrame(h.assets,'front',coefficients,{state:displayed});
  assert.equal(result instanceof Promise,false);assert.equal(h.renders.length,1);assert.equal(h.selections.length,1);
  assert.equal(h.renders[0].coefficients,coefficients);assert.equal(h.renders[0].options.faceOnly,false);
  assert.deepEqual(plain(result.state),{...neutral,eyeLeft:'half',mouth:'parted',browLeft:'up'});
  assert.deepEqual(Object.keys(result.layers),['character','head','torso',...groups]);
  assert.deepEqual(Object.keys(result.descriptors),Object.keys(result.layers));
  for(const layer of Object.values(result.layers))assert.deepEqual([layer.width,layer.height],dimensions);
  assert.equal(result.layers.character.matteApplications,1,'apply character matte exactly once');
  for(const layer of [result.layers.head,result.layers.torso])assert.equal(layer.matteApplications,0);
  const upper=(100*1122+500)*4+3,lower=(1200*1122+500)*4+3;
  assert.equal(result.layers.character.pixels[upper],128);assert.equal(result.layers.character.pixels[lower],50);
  for(const index of [upper,lower])assert.equal(result.layers.head.pixels[index]+result.layers.torso.pixels[index],result.layers.character.pixels[index]);
  assert.equal(result.layers.head.pixels[upper],128);assert.equal(result.layers.torso.pixels[lower],50);
  assert.equal(result.descriptors.eyeLeft.kind,'authored-replacement-patch');assert.equal(result.descriptors.eyeRight.kind,'displayed-neutral-crop');
  assert.deepEqual(plain(result.descriptors.head.includes),['hair','face']);assert.equal(result.descriptors.head.hiddenPixelsReconstructed,false);
  assert.equal(result.layers.eyeLeft.operations[0].source,h.renders[0].target,'eye painting includes the native current gaze');
  assert.equal(JSON.stringify(h.assets),before);assert.deepEqual(displayed,{...neutral,eyeLeft:'half',mouth:'parted',browLeft:'innerUp'});
});

test('inspection resolves displayed states against the selected authored endpoint and rejects unavailable assets',()=>{
  const h=harness(),result=h.createShortHairLayerFrame(h.assets,'view-left',{}, {state:{...neutral,browLeft:'up'}});
  assert.equal(result.poseId,'view-left');assert.equal(result.state.browLeft,'innerUp');assert.equal(result.descriptors.browLeft.state,'innerUp');
  assert.throws(()=>h.createShortHairLayerFrame({},'front',{}),/尚未加载/);
  assert.throws(()=>h.createShortHairLayerFrame(h.assets,'unknown',{}),/未知/);
  assert.throws(()=>h.createShortHairLayerFrame(h.assets,'front',{}, {state:[]}),/状态无效/);
});

test('ZIP uses the same inspection state and eight native layers while retaining its five-feature manifest contract',async()=>{
  const h=harness(),state={...neutral,eyeLeft:'half',mouth:'parted',browLeft:'innerUp'};
  const inspection=h.createShortHairLayerFrame(h.assets,'front',{}, {state});
  const exported=await h.exportShortHairLayers(h.assets,'front',{}, {state});
  assert.equal(exported.filename,'short-hair-front-layers.zip');assert.equal(exported.blob.type,'application/zip');assert.equal(h.renders.length,2);
  const entries=zipEntries(new Uint8Array(await exported.blob.arrayBuffer()));
  assert.deepEqual(Object.keys(entries),[...Object.keys(inspection.layers).map(name=>`${name}.png`),'layers.json','README.txt']);
  for(const name of Object.keys(inspection.layers))assert.deepEqual(JSON.parse(new TextDecoder().decode(entries[`${name}.png`])),{width:1122,height:1402});
  const descriptor=JSON.parse(new TextDecoder().decode(entries['layers.json']));
  assert.deepEqual(descriptor.state,plain(inspection.state));assert.deepEqual(Object.keys(descriptor.features),groups);
  for(const group of groups)assert.deepEqual(descriptor.features[group],plain(inspection.descriptors[group]));
  assert.ok(descriptor.limitations.some(value=>value.includes('Hair and face')));
});

test('registered fringe ZIP includes all decomposition layers, masks and binding without marking generated art approved',async()=>{
  const h=harness({withFringe:true}),result=await h.exportShortHairLayers(h.assets,'front',{});
  assert.equal(result.hasFringe,true);
  const entries=zipEntries(new Uint8Array(await result.blob.arrayBuffer()));
  assert.equal(Object.keys(entries).length,21);
  for(const key of ['face','backHair','frontHair','contact','edgeCorrection','recomposed','ownership','weight','hairOwnership','underpaint'])assert.ok(entries[key+'.png']);
  const descriptor=JSON.parse(new TextDecoder().decode(entries['layers.json'])),binding=JSON.parse(new TextDecoder().decode(entries['binding.json']));
  assert.equal(descriptor.schemaVersion,2);assert.equal(descriptor.kind,'short-hair-fringe-layer-export');assert.equal(descriptor.fringe.manuallyApproved,false);
  assert.equal(binding.poseId,'front');assert.deepEqual(Object.keys(descriptor.features),groups);assert.equal(Object.keys(descriptor.layers).length,18);
  assert.equal(descriptor.compositing,'registered source-over stack');
  const legacy=await h.exportShortHairLayers(h.assets,'view-left',{});assert.equal(legacy.hasFringe,false);
  assert.equal(Object.keys(zipEntries(new Uint8Array(await legacy.blob.arrayBuffer()))).length,10);
});
