import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {ARTICULATION_GROUPS,articulationFromState,articulationState,validateArticulation} from './short-hair-articulation.js';
import {STUDIO_HEAD_POSES,poseHeadCoordinates,validateHeadPose,nearestStudioPoseId} from './short-hair-pose-motion.js';
import {locateHeadTriangle,continuousViewport} from './short-hair-continuous-model.js';
import {validateSecondaryFrame} from './short-hair-secondary-motion.js';
import {gazeOffset} from './expression-gaze.js';
import {sideGazeOffset} from './side-gaze.js';
import {shortHairPatchOwners,validateContinuousShortHairSources,dilateBinaryHairMask,addForegroundProtection,featherHairProtection} from './short-hair-continuous-renderer.js';

const code=readFileSync(new URL('./short-hair-continuous-renderer.js',import.meta.url),'utf8').replace(/^import .*?;\n/gm,'').replace(/export /g,'');
const plain=value=>JSON.parse(JSON.stringify(value));
const baseline={eyeLeft:'open',eyeRight:'open',mouth:'neutral',browLeft:'neutral',browRight:'neutral'};
const state=(overrides={})=>({...baseline,...overrides});
const part=(from,to,t)=>({from,to,t});
function mixed(overrides={}){return {...articulationFromState(),...overrides};}
function harness(){
  const calls={paint:[],flow:[],alpha:[],draw:[],clear:0,created:0};
  const eyes=['quarter','half','threeQuarter','closed'],mouth=['parted','openSmall','openMedium','openWide','pucker','press','shiftLeft','shiftRight'];
  const rectangles={eyeLeft:[600,440,160,120],eyeRight:[340,440,175,120],mouth:[470,640,195,105],browLeft:[590,395,160,70],browRight:[365,395,145,70]};
  const record=front=>({patches:Object.fromEntries(ARTICULATION_GROUPS.map(group=>[group,Object.fromEntries((group.startsWith('eye')?eyes:group==='mouth'?mouth:front?['up','down']:['innerUp','outerUp','down']).map(name=>[name,{destination:rectangles[group]}]))]))});
  const selected=(assets,id,channels)=>({targetState:state(channels.target),targetGaze:{eyeLeft:{x:channels.look||0,y:0},eyeRight:{x:0,y:0}},availableSequences:{}});
  const featureChartsForState=(manifest,id,s)=>['nose',...ARTICULATION_GROUPS].map(group=>({pose:id,group,state:group==='nose'?'neutral':s[group],axis:0,range:[0,10],upper:Array(9).fill(0),lower:Array(9).fill(2),pads:[1,1,1,1]}));
  const assets={poses:STUDIO_HEAD_POSES.map(p=>({...p,sourceFamily:p.id==='front'?'front':'side'})),continuousBuffers:new Map(),alpha:{},featureGeometry:{poses:{}},
    front:{manifest:{...record(true),gaze:{maxShift:{x:10,up:6,down:5}}},gazeLayers:{eyeLeft:{open:{},quarter:{},half:{},threeQuarter:{}},eyeRight:{open:{},quarter:{},half:{},threeQuarter:{}}}},
    side:{manifest:{poses:Object.fromEntries(STUDIO_HEAD_POSES.map(p=>[p.id,record(false)])),gaze:{poses:Object.fromEntries(STUDIO_HEAD_POSES.map(p=>[p.id,{eyes:{eyeLeft:{maxShift:{x:10,up:6,down:5}},eyeRight:{maxShift:{x:10,up:6,down:5}}}}]))}},gazeLayers:{}},
    flowRenderer:{lost:false,render(...args){calls.flow.push(args);return {gpu:true};}}};
  const context=vm.createContext({document:{createElement(){return {id:++calls.created,getContext(){return this.context ||= {createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData(image){this.savedImage=image;}};}};}},selectShortHairStudioState:selected,
    renderShortHairStudio(canvas,a,id,channels,previous,options){const target=selected(a,id,options.original?{}:channels);canvas.pixels=JSON.stringify(options.stateOverride);calls.paint.push({id,canvas,state:plain(options.stateOverride),options});return {state:options.stateOverride,gaze:target.targetGaze};},
    applyShortHairAlpha(canvas){calls.alpha.push(canvas);},featureChartsForState,locateHeadTriangle,continuousViewport,poseHeadCoordinates,validateHeadPose,nearestStudioPoseId,validateSecondaryFrame,gazeOffset,sideGazeOffset,
    ARTICULATION_GROUPS,articulationFromState,articulationState,validateArticulation});
  vm.runInContext(code,context);
  const canvas={width:1122,height:1402,getContext:()=>({setTransform(){},clearRect(){calls.clear++;},drawImage(...args){calls.draw.push(args);}})};
  return {assets,calls,canvas,context,render:(options={},channels={},pose='front')=>context.renderContinuousShortHairStudio(canvas,assets,pose,channels,{}, {faceOnly:false,headPose:poseHeadCoordinates(pose),...options})};
}

test('fractional face and brows use four exact painter corners with independent unquantized progress',()=>{
  const h=harness(),art=mixed({eyeLeft:part('quarter','half',.2),eyeRight:part('threeQuarter','closed',.8),mouth:part('openSmall','openMedium',.25),browLeft:part('neutral','up',.4),browRight:part('neutral','down',.7)});
  const result=h.render({articulation:art},{target:state({mouth:'pucker'}),look:.3});
  assert.equal(h.calls.paint.length,4);assert.equal(h.calls.flow.length,1);assert.equal(new Set(h.calls.paint.map(p=>p.canvas)).size,4);
  assert.deepEqual(h.calls.paint[0].state,state({eyeLeft:'quarter',eyeRight:'threeQuarter',mouth:'openSmall'}));
  assert.deepEqual(h.calls.paint[1].state,state({eyeLeft:'half',eyeRight:'closed',mouth:'openMedium'}));
  assert.deepEqual(h.calls.paint[2].state,state({eyeLeft:'quarter',eyeRight:'threeQuarter',mouth:'openSmall',browLeft:'up',browRight:'down'}));
  assert.deepEqual(h.calls.paint[3].state,state({eyeLeft:'half',eyeRight:'closed',mouth:'openMedium',browLeft:'up',browRight:'down'}));
  const [vertices,sources,,secondary,descriptor]=h.calls.flow[0];assert.equal(vertices.length,1);assert.deepEqual(plain(secondary),{breath:0,sway:0,hair:0});
  assert.strictEqual(sources[0],h.calls.paint[0].canvas);assert.strictEqual(descriptor.secondSources[0],h.calls.paint[1].canvas);
  assert.strictEqual(descriptor.browSources[0],h.calls.paint[2].canvas);assert.strictEqual(descriptor.browSecondSources[0],h.calls.paint[3].canvas);
  assert.equal(descriptor.from[0][4].state,'neutral');assert.equal(descriptor.to[0][4].state,'neutral');
  assert.deepEqual(plain(descriptor.progress),[0,.2,.8,.25,.4,.7]);assert.equal(descriptor.from[0][1].state,'quarter');assert.equal(descriptor.to[0][1].state,'half');
  assert.deepEqual(plain(result.articulation),art);assert.notStrictEqual(result.articulation,art);assert.equal(result.gaze.eyeLeft.x,.3);
});

test('changing only progress across the nearest-label threshold reuses both endpoint canvases',()=>{
  const h=harness();h.render({articulation:mixed({mouth:part('neutral','parted',.49)})});const first=h.calls.flow[0];
  const result=h.render({articulation:mixed({mouth:part('neutral','parted',.51)})},{unused:123});
  assert.equal(h.calls.paint.length,2);assert.equal(h.calls.created,2);assert.strictEqual(h.calls.flow[1][1][0],first[1][0]);
  assert.strictEqual(h.calls.flow[1][4].secondSources[0],first[4].secondSources[0]);assert.equal(h.calls.flow[1][4].progress[3],.51);
  assert.equal(result.state.mouth,'parted');assert.equal(h.calls.paint[0].state.mouth,'neutral');
});

test('a reversed interior retains the actual reversed pair and complementary progress',()=>{
  const h=harness();h.render({articulation:mixed({mouth:part('neutral','pucker',.35)})});
  h.render({articulation:mixed({mouth:part('pucker','neutral',.65)})});
  const descriptor=h.calls.flow.at(-1)[4];assert.equal(descriptor.from[0][3].state,'pucker');assert.equal(descriptor.to[0][3].state,'neutral');
  assert.equal(descriptor.progress[3],.65);assert.equal(JSON.parse(h.calls.flow.at(-1)[1][0].pixels).mouth,'pucker');
});

test('brow aliases map both endpoint paintings for each pose while preserving global articulation',()=>{
  const h=harness(),art=mixed({browLeft:part('neutral','up',.35),browRight:part('innerUp','neutral',.25)});
  const result=h.render({headPose:{yaw:.3,pitch:.2},articulation:art});assert.equal(h.calls.paint.length,6);
  for(const paint of h.calls.paint){
    const expectedUp=paint.id==='front'?'up':'innerUp';
    if(paint.state.browLeft!=='neutral')assert.equal(paint.state.browLeft,expectedUp);
    if(paint.state.browRight!=='neutral')assert.equal(paint.state.browRight,expectedUp);
  }
  assert.deepEqual(plain(result.articulation),art);
  const outer=harness();outer.render({articulation:mixed({browLeft:part('neutral','outerUp',.2)})});assert.equal(outer.calls.paint[1].state.browLeft,'up');
});

test('legacy state-only and canonical articulation endpoints preserve the direct native pixel path',()=>{
  for(const options of [{stateOverride:state({mouth:'openSmall'})},{articulation:mixed({mouth:part('parted','openSmall',1)})},{articulation:undefined}]){
    const h=harness(),result=h.render(options);assert.equal(h.calls.paint.length,1);assert.equal(h.calls.flow.length,0);
    assert.strictEqual(h.calls.draw[0][0],h.assets.continuousBuffers.get('front').canvas);assert.equal(result.articulation.mouth.from,result.state.mouth);
    assert.equal(result.articulation.mouth.from,result.articulation.mouth.to);assert.equal(result.articulation.mouth.t,0);
  }
});

test('featureCorrection=false disables registration while retaining dual textures and geometry for ownership',()=>{
  const h=harness();h.render({featureCorrection:false,articulation:mixed({mouth:part('neutral','parted',.3)})});
  const descriptor=h.calls.flow[0][4];assert.equal(descriptor.enabled,false);assert.equal(descriptor.from[0].length,6);
  assert.equal(descriptor.progress[3],.3);assert.notStrictEqual(descriptor.secondSources[0],h.calls.flow[0][1][0]);
});

test('original comparison overrides all expression, motion and fractional display changes',()=>{
  const h=harness(),result=h.render({original:true,headPose:{yaw:.2,pitch:.3},secondary:{breath:1,sway:1,hair:1},articulation:mixed({mouth:part('neutral','pucker',.7)})},{target:state({mouth:'openWide'}),look:1});
  assert.equal(h.calls.paint.length,1);assert.equal(h.calls.flow.length,0);assert.deepEqual(plain(result.state),baseline);assert.deepEqual(plain(result.articulation),articulationFromState());
  assert.equal(result.gaze.eyeLeft.x,0);assert.deepEqual(plain(result.secondary),{breath:0,sway:0,hair:0});
});

test('malformed or unauthored articulation is rejected before display or source painting',()=>{
  for(const articulation of [null,{},mixed({eyeLeft:part('open','closed',.5)}),mixed({mouth:part('neutral','parted',NaN)}),mixed({mouth:part('neutral','parted',1.1)}),mixed({browLeft:part('neutral','imaginary',.5)})]){
    const h=harness();assert.throws(()=>h.render({articulation}));assert.equal(h.calls.paint.length,0);assert.equal(h.calls.clear,0);
  }
  const h=harness();delete h.assets.front.manifest.patches.mouth.parted;
  assert.throws(()=>h.render({articulation:mixed({mouth:part('neutral','parted',.4)})}),/缺少实际画稿/);assert.equal(h.calls.paint.length,0);
});

test('both endpoint alpha preparations are cached, and changing gaze only repaints visible eye sources',()=>{
  const h=harness(),art=mixed({eyeLeft:part('threeQuarter','closed',.3),eyeRight:part('closed','closed',0)});
  h.render({articulation:art,transparent:true},{look:.2});assert.equal(h.calls.alpha.length,2);
  h.render({articulation:art,transparent:true},{look:.4});assert.equal(h.calls.paint.length,3);assert.equal(h.calls.alpha.length,3);
  assert.equal(h.calls.paint.at(-1).state.eyeLeft,'threeQuarter');
  h.render({articulation:{...art,eyeLeft:part('threeQuarter','closed',.5)},transparent:true},{look:.4});assert.equal(h.calls.paint.length,3);
});

test('a failed second fringe composition keeps the committed display untouched',()=>{
  const h=harness();h.render();const count=h.calls.draw.length;let rendered=0;
  h.assets.fringeRenderer={lost:false,render(){return ++rendered===2?null:{};}};
  const result=h.render({faceOnly:true,secondary:{breath:0,sway:0,hair:.4},articulation:mixed({mouth:part('neutral','parted',.5)})});
  assert.equal(result.didDraw,false);assert.equal(h.calls.draw.length,count);assert.equal(h.canvas.width,1122);assert.equal(h.calls.flow.length,0);
});

test('fixed patch owners preserve face/brow overlap in independent paint planes',()=>{
  const h=harness(),owners=shortHairPatchOwners(h.assets,'front');
  assert.deepEqual(owners[0],[600,440,760,560]);assert.deepEqual(owners[3],[590,395,750,465]);assert.deepEqual(owners[2],[470,640,665,745]);
  h.render({articulation:mixed({mouth:part('neutral','parted',.2)})});const first=h.calls.flow[0][4].patchOwners;
  h.render({articulation:mixed({mouth:part('neutral','pucker',.7)})});assert.strictEqual(h.calls.flow[1][4].patchOwners[0],first[0]);
  assert.deepEqual(plain(first[0]),owners);
});

test('head triangles retain per-pose source pair and owner identities including zero-weight seam vertices',()=>{
  const h=harness();h.render({headPose:{yaw:.5,pitch:.5},articulation:mixed({mouth:part('neutral','parted',.6)})});
  const [vertices,sources,, ,descriptor]=h.calls.flow[0];assert.equal(vertices.length,3);assert.ok(vertices.some(v=>v.weight===0));
  assert.equal(new Set([...sources,...descriptor.secondSources]).size,6);
  vertices.forEach((v,i)=>{assert.strictEqual(sources[i],h.assets.continuousBuffers.get(v.poseId).canvas);assert.strictEqual(descriptor.secondSources[i],h.assets.continuousBuffers.get(v.poseId).second.canvas);assert.equal(descriptor.from[i][0].pose,v.poseId);});
});

function sourceFixture(){
  const hash='1'.repeat(64),patchHash='2'.repeat(64),matteHash='3'.repeat(64),source='./assets/test/front.png',patch='./assets/test/parted.png';
  const assets={poses:[{id:'front',sourceFamily:'front'}],front:{manifest:{reference:'neutral',sources:{neutral:{src:source},parted:{src:patch,sha256:patchHash}},patches:{mouth:{parted:{source:'parted'}}}}}};
  const alpha={manifest:{poses:{front:{source,sourceSha256:hash,matteSha256:matteHash}}}},motion={manifest:{sources:{front:{path:source,sha256:hash}}}},fringe={poses:{front:{binding:{poseId:'front',sourceSha256:hash}}},manifest:{poses:{front:{source:{path:source,sha256:hash},alphaSha256:matteHash}}}},geometry={poses:{front:{source,sourceSha256:hash,features:{nose:{states:{neutral:{source,sourceSha256:hash}}},mouth:{states:{parted:{source:patch,sourceSha256:patchHash}}}}}}};
  return {assets,alpha,motion,fringe,geometry,check(){return validateContinuousShortHairSources(assets,alpha,motion,fringe,geometry);}};
}

test('feature provenance joins exact neutral and actual patch identities rather than any valid asset path',()=>{
  const good=sourceFixture();assert.equal(good.check(),true);
  for(const change of [f=>{f.geometry.poses.front.source='./assets/test/other.png';},f=>{f.geometry.poses.front.sourceSha256='4'.repeat(64);},f=>{f.geometry.poses.front.features.mouth.states.parted.source=f.geometry.poses.front.source;},f=>{f.geometry.poses.front.features.mouth.states.parted.sourceSha256='5'.repeat(64);},f=>{f.geometry.poses.front.features.mouth.states.unpainted=f.geometry.poses.front.features.mouth.states.parted;}]){
    const f=sourceFixture();change(f);assert.throws(()=>f.check(),/五官/);
  }
});

function addHairMasks(h){
  h.assets.fringe={poses:Object.fromEntries(h.assets.poses.map(p=>[p.id,{hairOwnership:{mask:p.id},signature:`pose-source:${p.id}`}])),
    manifest:{poses:Object.fromEntries(h.assets.poses.map(p=>[p.id,{hairOwnership:{sha256:`hair-mask:${p.id}`}}]))}};
}
test('hair protection passes each retained native alpha mask and source signature in vertex order',()=>{
  const h=harness();addHairMasks(h);h.render({headPose:{yaw:-.45,pitch:-.4},articulation:mixed({mouth:part('neutral','parted',.2)})});
  const [vertices,,,,descriptor]=h.calls.flow[0];assert.equal(descriptor.hairSources.length,3);
  vertices.forEach((vertex,i)=>{
    assert.strictEqual(descriptor.hairSources[i],h.assets.fringe.poses[vertex.poseId].hairOwnership);
    assert.deepEqual(JSON.parse(descriptor.hairSignatures[i]),[vertex.poseId,`hair-mask:${vertex.poseId}`,`pose-source:${vertex.poseId}`,'conservative-x7y3-strands-feather8-v3',false,[]]);
  });
  const previous=descriptor.hairSignatures.slice();h.render({headPose:{yaw:-.45,pitch:-.4},articulation:mixed({mouth:part('neutral','parted',.8)})});
  assert.deepEqual(plain(h.calls.flow[1][4].hairSignatures),plain(previous));
  const id=vertices[0].poseId;h.assets.fringe.manifest.poses[id].hairOwnership.sha256='updated-hair-mask';
  h.render({headPose:{yaw:-.45,pitch:-.4},articulation:mixed({mouth:part('neutral','parted',.8)})});assert.notEqual(h.calls.flow[2][4].hairSignatures[0],previous[0]);
});
test('no-fringe descriptors explicitly disable hair protection and original/native endpoints remain direct',()=>{
  const h=harness();h.render({articulation:mixed({mouth:part('neutral','parted',.4)})});
  assert.equal(h.calls.flow[0][4].hairSources,null);assert.equal(h.calls.flow[0][4].hairSignatures,null);
  const native=harness();addHairMasks(native);native.render();native.render({original:true,headPose:{yaw:.3,pitch:.2}});
  assert.equal(native.calls.flow.length,0);assert.equal(native.calls.draw.length,2);
});
test('hair protection supports verified pose-signature fallback and rejects incomplete registered masks',()=>{
  const h=harness();addHairMasks(h);delete h.assets.fringe.manifest;h.render({articulation:mixed({mouth:part('neutral','parted',.4)})});
  assert.deepEqual(JSON.parse(h.calls.flow[0][4].hairSignatures[0]),['front',null,'pose-source:front','conservative-x7y3-strands-feather8-v3',false,[]]);
  const missing=harness();addHairMasks(missing);delete missing.assets.fringe.poses.front.hairOwnership;
  assert.throws(()=>missing.render({articulation:mixed({mouth:part('neutral','parted',.4)})}),/头发保护遮罩/);assert.equal(missing.calls.paint.length,0);
  assert.equal(missing.render({original:true}).didDraw,true);assert.equal(missing.calls.flow.length,0);
});

function binaryRGBA(width,height,points=[]){
  const rgba=new Uint8ClampedArray(width*height*4);for(let i=0;i<width*height;i++)rgba[i*4+3]=255;
  for(const [x,y] of points){const k=(y*width+x)*4;rgba[k]=rgba[k+1]=rgba[k+2]=255;}return rgba;
}
function referenceDilate(rgba,width,height,rx,ry){
  const expected=new Uint8ClampedArray(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    for(let yy=Math.max(0,y-ry);yy<=Math.min(height-1,y+ry);yy++)for(let xx=Math.max(0,x-rx);xx<=Math.min(width-1,x+rx);xx++)if(rgba[(yy*width+xx)*4]===255)expected[y*width+x]=255;
  }return expected;
}
test('separable binary hair dilation equals a direct rectangle at borders, thin strands, and larger-than-image windows',()=>{
  for(const [width,height]of [[1,1],[1,7],[8,1],[9,7],[17,12]])for(const [rx,ry]of [[0,0],[1,2],[3,1],[7,3],[20,20]]){
    const points=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++)if((x*17+y*13)%11===0)points.push([x,y]);
    const rgba=binaryRGBA(width,height,points),before=rgba.slice();assert.deepEqual(dilateBinaryHairMask(rgba,width,height,rx,ry),referenceDilate(rgba,width,height,rx,ry));assert.deepEqual(rgba,before);
  }
  assert.deepEqual(dilateBinaryHairMask(binaryRGBA(7,5),7,5),new Uint8ClampedArray(35));
});
test('a single-pixel strand receives exactly the declared seven-by-three conservative margin',()=>{
  const width=23,height=13,alpha=dilateBinaryHairMask(binaryRGBA(width,height,[[11,6]]),width,height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)assert.equal(alpha[y*width+x],Math.abs(x-11)<=7&&Math.abs(y-6)<=3?255:0);
});
test('binary dilation rejects color, soft grayscale, translucent bytes and malformed dimensions',()=>{
  for(const change of [v=>{v[0]=1;v[1]=1;v[2]=1;},v=>{v[1]=255;},v=>{v[3]=0;}]){
    const rgba=binaryRGBA(2,2);change(rgba);assert.throws(()=>dilateBinaryHairMask(rgba,2,2),/二值灰度/);
  }
  for(const args of [[new Uint8ClampedArray(3),1,1],[binaryRGBA(2,2),2,2,-1,3],[binaryRGBA(2,2),2,2,7,.5],[[],2,2],[binaryRGBA(2,2),0,2]])assert.throws(()=>dilateBinaryHairMask(...args));
});
test('verified mask pixels build one private expanded canvas per pose and retain original ownership bytes',()=>{
  const h=harness();addHairMasks(h);const width=23,height=13,pixels=binaryRGBA(width,height,[[11,6]]),before=pixels.slice();
  const native=h.assets.fringe.poses.front.hairOwnership;Object.assign(native,{width,height});h.assets.fringe.poses.front.maskPixels={hairOwnership:pixels};
  h.render({articulation:mixed({mouth:part('neutral','parted',.3)})});
  const first=h.calls.flow[0][4],buffer=h.assets.continuousBuffers.get('front'),created=h.calls.created;
  assert.notStrictEqual(first.hairSources[0],native);assert.strictEqual(first.hairSources[0],buffer.featureHairProtection.canvas);
  assert.equal(first.hairSources[0].width,width);assert.equal(first.hairSources[0].height,height);assert.equal(JSON.parse(first.hairSignatures[0])[4],true);
  const image=first.hairSources[0].context.savedImage,expected=featherHairProtection(dilateBinaryHairMask(pixels,width,height),width,height);
  for(let i=0;i<expected.length;i++){assert.deepEqual(Array.from(image.data.slice(i*4,i*4+3)),[255,255,255]);assert.equal(image.data[i*4+3],expected[i]);}
  h.render({articulation:mixed({mouth:part('neutral','parted',.7)})});assert.equal(h.calls.created,created);assert.strictEqual(h.calls.flow[1][4].hairSources[0],first.hairSources[0]);
  assert.deepEqual(pixels,before);assert.strictEqual(h.assets.fringe.poses.front.hairOwnership,native);
});

test('constant face or brow dimensions share corners without redundant canvases or paints',()=>{
  for(const [art,faceActive]of [[mixed({mouth:part('neutral','parted',.4)}),true],[mixed({browLeft:part('neutral','up',.7)}),false]]){
    const h=harness();h.render({articulation:art});const [,, , ,d]=h.calls.flow[0],a=h.calls.flow[0][1][0];
    assert.equal(h.calls.paint.length,2);assert.equal(h.assets.continuousBuffers.get('front').paintPool.length,2);
    if(faceActive){assert.strictEqual(d.browSources[0],a);assert.strictEqual(d.browSecondSources[0],d.secondSources[0]);}
    else{assert.strictEqual(d.secondSources[0],a);assert.strictEqual(d.browSecondSources[0],d.browSources[0]);}
  }
});
test('four-corner cache reserves all reused signatures before a reversal or partial retarget can overwrite them',()=>{
  const h=harness(),art=mixed({mouth:part('parted','openSmall',.3),browLeft:part('neutral','up',.7)});h.render({articulation:art});
  const old=h.calls.flow[0],d=old[4],corners=[old[1][0],d.secondSources[0],d.browSources[0],d.browSecondSources[0]];
  h.render({articulation:mixed({mouth:part('openSmall','parted',.7),browLeft:part('up','neutral',.3)})});
  const reversed=h.calls.flow[1],rd=reversed[4];assert.equal(h.calls.paint.length,4);
  assert.deepEqual([reversed[1][0],rd.secondSources[0],rd.browSources[0],rd.browSecondSources[0]],corners.slice().reverse());
  h.render({articulation:mixed({mouth:part('openSmall','openMedium',.4),browLeft:part('neutral','up',.5)})});
  const next=h.calls.flow[2],nd=next[4],nextCorners=[next[1][0],nd.secondSources[0],nd.browSources[0],nd.browSecondSources[0]];
  assert.equal(h.calls.paint.length,6);assert.equal(new Set(nextCorners).size,4);assert.equal(h.assets.continuousBuffers.get('front').paintPool.length,4);
  assert.strictEqual(nextCorners[0],corners[1]);assert.strictEqual(nextCorners[2],corners[3]);
  assert.deepEqual(nextCorners.map(c=>JSON.parse(c.pixels).mouth),['openSmall','openMedium','openSmall','openMedium']);
  assert.deepEqual(nextCorners.map(c=>JSON.parse(c.pixels).browLeft),['neutral','neutral','up','up']);
});
test('four alpha preparations and fringe requests are deduplicated by actual painter signature',()=>{
  const h=harness(),fringe=[];h.assets.fringeRenderer={lost:false,render(source,id,controls,options){const result={source,id,signature:options.signature};fringe.push(result);return result;}};
  const art=mixed({mouth:part('neutral','parted',.25),browRight:part('neutral','down',.75)});
  h.render({transparent:true,secondary:{breath:0,sway:0,hair:.5},articulation:art});const [vertices,sources,,,d]=h.calls.flow[0];
  assert.equal(vertices.length,1);assert.equal(h.calls.alpha.length,4);assert.equal(fringe.length,4);
  assert.equal(new Set([sources[0],d.secondSources[0],d.browSources[0],d.browSecondSources[0]]).size,4);
  h.render({transparent:true,secondary:{breath:0,sway:0,hair:.5},articulation:{...art,mouth:part('neutral','parted',.8)}});
  assert.equal(h.calls.paint.length,4);assert.equal(h.calls.alpha.length,4);assert.equal(fringe.length,8);
});
test('continuous asset loading requests a four-frame fringe retention pool',async()=>{
  const h=harness(),f=sourceFixture();let options;
  Object.assign(h.context,{loadShortHairStudioAssets:async()=>f.assets,loadShortHairAlphaAssets:async()=>f.alpha,loadShortHairMotionFields:async()=>f.motion,loadShortHairFringeAssets:async()=>f.fringe,loadFeatureGeometry:async()=>f.geometry,
    ShortHairFlowRenderer:class{dispose(){}},ShortHairFringeRenderer:class{constructor(assets,value){assert.strictEqual(assets,f.fringe);options=value;}}});
  await h.context.loadContinuousShortHairAssets();assert.equal(options.retainedFrames,4);
});


test('reviewed foreground polygons preserve original pixels and join dilation before any eye warp',()=>{
  const original=binaryRGBA(12,9,[[0,0]]),before=original.slice();
  const protectedPixels=addForegroundProtection(original,12,9,[[[5,2],[8,2],[8,5],[5,5]]]);
  assert.deepEqual(original,before);assert.equal(protectedPixels[(3*12+6)*4],255);
  assert.equal(protectedPixels[(3*12+4)*4],0);assert.equal(protectedPixels[0],255);
  const alpha=dilateBinaryHairMask(protectedPixels,12,9,1,1);
  assert.equal(alpha[3*12+4],255);assert.equal(alpha[3*12+3],0);
  assert.throws(()=>addForegroundProtection(original,12,9,[[[1,1],[2,1],[13,2]]]),/保护/);
  assert.throws(()=>addForegroundProtection(original,12,9,[[[1,1],[2,1]]]),/保护/);
});

// The fully protected core must not be blurred away to soften the boundary.
test('hair protection retains its core and tapers only outside, without changing source alpha',()=>{
  const input=new Uint8ClampedArray(31*5);input[2*31+15]=255;const copy=input.slice();
  const actual=featherHairProtection(input,31,5,10);
  assert.deepEqual(input,copy);assert.equal(actual[2*31+15],255);
  let previous=255;for(let x=16;x<=25;x++){const value=actual[2*31+x];assert.ok(value<previous);assert.equal(value,actual[2*31+30-x]);previous=value;}
  assert.equal(previous,0);assert.equal(actual[2*31+26],0);
  assert.throws(()=>featherHairProtection(input,31,5,0));
  input[0]=128;assert.throws(()=>featherHairProtection(input,31,5),/二值/);
});
