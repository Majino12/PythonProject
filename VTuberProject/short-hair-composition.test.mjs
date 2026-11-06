import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_OUTPUT_COMPOSITION,validateOutputComposition,normalizeOutputComposition,layoutOutputComposition} from './short-hair-composition.js';
import {validateOutputFrame,drawOutputFrame} from './short-hair-studio-output-model.js';
import {sanitizeChannels} from './expression-model.js';

test('composition validates only complete bounded typed framing state and returns a copy',()=>{
  for(const scale of [.5,1,2.5])for(const x of [-1,0,1])for(const y of [-1,0,1])for(const mirror of [false,true]) {
    const value={scale,x,y,mirror};assert.deepEqual(validateOutputComposition(value),value);assert.notEqual(validateOutputComposition(value),value);
  }
  for(const value of [null,[],{}, {...DEFAULT_OUTPUT_COMPOSITION,scale:.49},{...DEFAULT_OUTPUT_COMPOSITION,scale:2.51},
    {...DEFAULT_OUTPUT_COMPOSITION,x:-1.01},{...DEFAULT_OUTPUT_COMPOSITION,y:Infinity},{...DEFAULT_OUTPUT_COMPOSITION,scale:NaN},
    {...DEFAULT_OUTPUT_COMPOSITION,x:'0'},{...DEFAULT_OUTPUT_COMPOSITION,mirror:1},{...DEFAULT_OUTPUT_COMPOSITION,rotate:0},
    {scale:1,x:0,y:0}])assert.throws(()=>validateOutputComposition(value));
});

test('composition normalization defaults partial UI state and clamps every numeric edge',()=>{
  for(const value of [undefined,null,[],{},'bad'])assert.deepEqual(normalizeOutputComposition(value),DEFAULT_OUTPUT_COMPOSITION);
  assert.deepEqual(normalizeOutputComposition({scale:8,x:-3,y:2,mirror:true}),{scale:2.5,x:-1,y:1,mirror:true});
  assert.deepEqual(normalizeOutputComposition({scale:-1,x:NaN,y:'1',mirror:'true'}),{scale:.5,x:0,y:0,mirror:false});
  assert.deepEqual(normalizeOutputComposition({x:.3}),{scale:1,x:.3,y:0,mirror:false});
});

test('composition translates by half the target dimensions and keeps native aspect ratio',()=>{
  const target={width:1280,height:720},source={width:630,height:460};
  const result=layoutOutputComposition(target,source,{scale:1.5,x:.25,y:-.5,mirror:true});
  assert.equal(result.centerX,800);assert.equal(result.centerY,180);assert.equal(result.height,1080);
  assert.ok(Math.abs(result.width/result.height-630/460)<1e-12);assert.equal(result.mirror,true);
});

test('composition mirrors around the chosen center and always restores the caller transform',()=>{
  const operations=[],context={clearRect:(...args)=>operations.push(['clear',...args]),fillRect:(...args)=>operations.push(['fill',...args]),
    save:()=>operations.push(['save']),restore:()=>operations.push(['restore']),translate:(...args)=>operations.push(['translate',...args]),
    scale:(...args)=>operations.push(['scale',...args]),drawImage:(...args)=>operations.push(['draw',...args])};
  const target={width:1280,height:720,getContext:()=>context},source={width:1280,height:720};
  drawOutputFrame(target,source,{transparent:true,composition:{scale:2,x:-.5,y:1,mirror:true}});
  assert.deepEqual(operations,[['clear',0,0,1280,720],['save'],['translate',320,720],['scale',-1,1],['draw',source,-1280,-720,2560,1440],['restore']]);
  operations.length=0;context.drawImage=()=>{throw new Error('draw failed');};
  assert.throws(()=>drawOutputFrame(target,source,{composition:{...DEFAULT_OUTPUT_COMPOSITION,mirror:true}}));
  assert.deepEqual(operations.at(-1),['restore']);
});

test('output protocol keeps optional composition compatible with older frames and rejects partial imports',()=>{
  const frame={poseId:'front',coefficients:sanitizeChannels({}),state:{eyeLeft:'open',eyeRight:'open',mouth:'neutral',browLeft:'neutral',browRight:'neutral'},faceOnly:true,original:false};
  assert.equal(Object.hasOwn(validateOutputFrame(frame),'composition'),false);
  const composition={scale:1.4,x:-.2,y:.3,mirror:true};const result=validateOutputFrame({...frame,composition});
  assert.deepEqual(result.composition,composition);assert.notEqual(result.composition,composition);
  assert.throws(()=>validateOutputFrame({...frame,composition:{scale:1}}));
});
