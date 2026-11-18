import {loadFeatureGeometry,featureChartsForState} from './short-hair-feature-geometry.js';
import {loadShortHairStudioAssets,renderShortHairStudio,selectShortHairStudioState} from './short-hair-studio-renderer.js';
import {loadShortHairAlphaAssets,applyShortHairAlpha} from './short-hair-alpha.js';
import {loadShortHairMotionFields} from './short-hair-motion-fields.js';
import {ShortHairFlowRenderer} from './short-hair-flow-renderer.js';
import {loadShortHairFringeAssets} from './short-hair-fringe-assets.js';
import {ShortHairFringeRenderer} from './short-hair-fringe-renderer.js';
import {locateHeadTriangle,continuousViewport} from './short-hair-continuous-model.js';
import {poseHeadCoordinates,validateHeadPose,nearestStudioPoseId} from './short-hair-pose-motion.js';
import {validateSecondaryFrame} from './short-hair-secondary-motion.js';
import {gazeOffset} from './expression-gaze.js';
import {sideGazeOffset} from './side-gaze.js';
import {ARTICULATION_GROUPS,articulationFromState,articulationState,validateArticulation} from './short-hair-articulation.js';

const makeCanvas=()=>document.createElement('canvas');
/** Rectangular binary dilation in O(width*height), independent of radius.
 * Input is the verified opaque grayscale ownership PNG; output is alpha only.
 * Neither the original RGBA bytes nor the runtime ownership canvas is changed. */
export function dilateBinaryHairMask(rgba,width,height,radiusX=7,radiusY=3){
  if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1
    ||!Number.isSafeInteger(width*height)||!Number.isSafeInteger(radiusX)||radiusX<0
    ||!Number.isSafeInteger(radiusY)||radiusY<0||!ArrayBuffer.isView(rgba)||rgba.BYTES_PER_ELEMENT!==1
    ||rgba.length!==width*height*4)throw new TypeError('头发保护遮罩尺寸或膨胀范围无效。');
  const count=width*height;
  for(let i=0;i<count;i++){
    const k=i*4,v=rgba[k];
    if((v!==0&&v!==255)||rgba[k+1]!==v||rgba[k+2]!==v||rgba[k+3]!==255)throw new TypeError('头发保护需要不透明的二值灰度遮罩。');
  }
  const horizontal=new Uint8Array(count),alpha=new Uint8ClampedArray(count);
  for(let y=0;y<height;y++){
    const row=y*width;let running=0;
    for(let x=0;x<=Math.min(radiusX,width-1);x++)running+=rgba[(row+x)*4]===255?1:0;
    for(let x=0;x<width;x++){
      horizontal[row+x]=running>0?1:0;
      const remove=x-radiusX,add=x+radiusX+1;
      if(remove>=0)running-=rgba[(row+remove)*4]===255?1:0;
      if(add<width)running+=rgba[(row+add)*4]===255?1:0;
    }
  }
  for(let x=0;x<width;x++){
    let running=0;for(let y=0;y<=Math.min(radiusY,height-1);y++)running+=horizontal[y*width+x];
    for(let y=0;y<height;y++){
      alpha[y*width+x]=running>0?255:0;
      const remove=y-radiusY,add=y+radiusY+1;
      if(remove>=0)running-=horizontal[remove*width+x];
      if(add<height)running+=horizontal[add*width+x];
    }
  }
  return alpha;
}
/** Preserve the entire binary protection core and taper only its exterior.
 * A one-pixel hard gate can kink the corrected UV field beside a hair strand. */
export function featherHairProtection(alpha,width,height,radius=8){
  if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1
    ||!ArrayBuffer.isView(alpha)||alpha.BYTES_PER_ELEMENT!==1||alpha.length!==width*height
    ||!Number.isFinite(radius)||radius<=0||radius>32)throw new TypeError('头发保护羽化范围无效。');
  const distance=new Float32Array(alpha.length),diagonal=Math.SQRT2;
  for(let i=0;i<alpha.length;i++){
    if(alpha[i]!==0&&alpha[i]!==255)throw new TypeError('羽化需要二值保护核心。');
    distance[i]=alpha[i]?0:radius;
  }
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;let d=distance[i];
    if(x)d=Math.min(d,distance[i-1]+1);
    if(y){d=Math.min(d,distance[i-width]+1);if(x)d=Math.min(d,distance[i-width-1]+diagonal);if(x+1<width)d=Math.min(d,distance[i-width+1]+diagonal);}
    distance[i]=d;
  }
  for(let y=height-1;y>=0;y--)for(let x=width-1;x>=0;x--){
    const i=y*width+x;let d=distance[i];
    if(x+1<width)d=Math.min(d,distance[i+1]+1);
    if(y+1<height){d=Math.min(d,distance[i+width]+1);if(x)d=Math.min(d,distance[i+width-1]+diagonal);if(x+1<width)d=Math.min(d,distance[i+width+1]+diagonal);}
    distance[i]=d;
  }
  return Uint8ClampedArray.from(distance,d=>{const t=Math.min(1,d/radius);return 255*(1-t*t*(3-2*t));});
}
/** Add source-reviewed missed strand footprints to a COPY of the ownership
 * mask. This changes protection only; no source painting is erased or repainted. */
export function addForegroundProtection(rgba,width,height,polygons=[]){
  if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1
    ||!ArrayBuffer.isView(rgba)||rgba.BYTES_PER_ELEMENT!==1||rgba.length!==width*height*4
    ||!Array.isArray(polygons)||polygons.length>12)throw new TypeError('前景保护区域无效。');
  const output=new Uint8ClampedArray(rgba);
  for(const polygon of polygons){
    if(!Array.isArray(polygon)||polygon.length<3||polygon.length>32||polygon.some(p=>!Array.isArray(p)||p.length!==2
      ||!p.every(Number.isFinite)||p[0]<0||p[0]>width||p[1]<0||p[1]>height))throw new TypeError('前景保护轮廓越界或无效。');
    const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]);
    const left=Math.max(0,Math.floor(Math.min(...xs))),right=Math.min(width,Math.ceil(Math.max(...xs)));
    const top=Math.max(0,Math.floor(Math.min(...ys))),bottom=Math.min(height,Math.ceil(Math.max(...ys)));
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
      const px=x+.5,py=y+.5;let inside=false;
      for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
        const a=polygon[i],b=polygon[j];
        if((a[1]>py)!==(b[1]>py)&&px<(b[0]-a[0])*(py-a[1])/(b[1]-a[1])+a[0])inside=!inside;
      }
      if(inside){const k=(y*width+x)*4;output[k]=output[k+1]=output[k+2]=output[k+3]=255;}
    }
  }
  return output;
}
function featureHairProtection(assets,poseId,buffer){
  const pose=assets.fringe.poses[poseId],mask=pose?.hairOwnership;
  if(!mask)throw new Error(`${poseId} 缺少已登记的头发保护遮罩。`);
  const hash=assets.fringe.manifest?.poses?.[poseId]?.hairOwnership?.sha256,pixels=pose.maskPixels?.hairOwnership;
  if(!hash&&!pose.signature)throw new Error(`${poseId} 的头发保护遮罩缺少来源签名。`);
  const polygons=assets.featureGeometry?.poses?.[poseId]?.foregroundProtection?.polygons||[];
  const signature=JSON.stringify([poseId,hash||null,pose.signature||null,'conservative-x7y3-strands-feather8-v3',Boolean(pixels),polygons]);
  if(polygons.length&&!pixels)throw new Error(`${poseId} 缺少可校验的前景保护像素。`);
  const cached=buffer.featureHairProtection;
  if(cached?.signature===signature&&cached.sourcePixels===pixels)return cached;
  let canvas=mask;
  if(pixels){
    const width=mask.width??1122,height=mask.height??1402;
    const protectedPixels=polygons.length?addForegroundProtection(pixels,width,height,polygons):pixels;
    const alpha=featherHairProtection(dilateBinaryHairMask(protectedPixels,width,height),width,height);
    canvas=makeCanvas();canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d'),image=context.createImageData(width,height);
    for(let i=0;i<alpha.length;i++){
      const k=i*4;image.data[k]=image.data[k+1]=image.data[k+2]=255;image.data[k+3]=alpha[i];
    }
    context.putImageData(image,0,0);
  }
  return buffer.featureHairProtection={canvas,signature,sourcePixels:pixels};
}

/** Join independently verified asset families by the exact native source and
 * matte identities. A valid fringe-file digest alone does not establish that
 * its support was authored against the currently loaded silhouette. */
export function validateContinuousShortHairSources(assets,alpha,motionFields,fringe,featureGeometry=null){
  for(const pose of assets.poses){
    const family=assets[pose.sourceFamily],record=pose.id==='front'?family.manifest:family.manifest.poses[pose.id];
    const source=family.manifest.sources[record.reference].src,field=motionFields.manifest.sources[pose.id],matte=alpha.manifest.poses[pose.id];
    if(!field||!matte||source!==field.path||source!==matte.source||field.sha256!==matte.sourceSha256)throw new Error('透明遮罩、运动场与当前原画来源不一致。');
    const binding=fringe.poses[pose.id]?.binding,registration=fringe.manifest.poses[pose.id];
    if(!binding||!registration||binding.poseId!==pose.id||binding.sourceSha256!==field.sha256
      ||registration.source?.path!==source||registration.source?.sha256!==field.sha256
      ||registration.alphaSha256!==matte.matteSha256)throw new Error('前发绑定、透明遮罩与当前姿态原画来源不一致。');
    if(featureGeometry){
      const geometry=featureGeometry.poses?.[pose.id];
      if(!geometry||geometry.source!==source||geometry.sourceSha256!==field.sha256)throw new Error('五官几何与当前姿态原画来源不一致。');
      for(const [group,feature] of Object.entries(geometry.features))for(const [state,chart] of Object.entries(feature.states)){
        const neutral=group==='nose'||state===(group.startsWith('eye')?'open':'neutral');
        const sourceId=neutral?record.reference:record.patches[group]?.[state]?.source;
        const authored=family.manifest.sources[sourceId];
        const expectedHash=neutral?field.sha256:authored?.sha256;
        if(!authored||chart.source!==authored.src||expectedHash&&chart.sourceSha256!==expectedHash)throw new Error(`五官 ${pose.id}/${group}/${state} 与当前表情画稿来源不一致。`);
      }
    }
  }
  return true;
}
export async function loadContinuousShortHairAssets(){
  const [assets,alpha,motionFields,fringe,featureGeometry]=await Promise.all([loadShortHairStudioAssets(),loadShortHairAlphaAssets(),loadShortHairMotionFields(),loadShortHairFringeAssets(),loadFeatureGeometry()]);
  validateContinuousShortHairSources(assets,alpha,motionFields,fringe,featureGeometry);
  const prepared={...assets,alpha,motionFields,fringe,featureGeometry,continuousBuffers:new Map()};
  // Pay the linear mask preparation cost while loading, not on the first live
  // turn into each pose. Legacy fixtures without decoded pixels remain lazy.
  for(const pose of assets.poses)if(fringe.poses[pose.id]?.maskPixels?.hairOwnership){
    const buffer={canvas:makeCanvas(),signature:null};prepared.continuousBuffers.set(pose.id,buffer);
    featureHairProtection(prepared,pose.id,buffer);
  }
  let flowRenderer,fringeRenderer;
  try{flowRenderer=new ShortHairFlowRenderer(motionFields);fringeRenderer=new ShortHairFringeRenderer(fringe,{retainedFrames:4});
    return {...prepared,flowRenderer,fringeRenderer};
  }catch(error){try{fringeRenderer?.dispose();}finally{flowRenderer?.dispose();}throw error;}
}

function compatibleState(assets,poseId,state){
  const front=poseId==='front',family=assets.poses.find(pose=>pose.id===poseId).sourceFamily;
  const record=front?assets.front.manifest:assets[family].manifest.poses[poseId];
  return Object.fromEntries(ARTICULATION_GROUPS.map(group=>{
    let wanted=state[group];
    // Brow families name their actually authored raised poses differently.
    // Apply the same mapping to BOTH endpoints, never to the fractional mix.
    if(group.startsWith('brow')){
      if(front&&(wanted==='innerUp'||wanted==='outerUp'))wanted='up';
      if(!front&&wanted==='up')wanted='innerUp';
    }
    const neutral=group.startsWith('eye')?'open':'neutral';
    if(wanted!==neutral&&!Object.hasOwn(record.patches[group]||{},wanted))throw new Error(`${poseId}/${group}/${wanted} 缺少实际画稿。`);
    return [group,wanted];
  }));
}

/** Fixed ownership within each independent face/brow paint plane. Bounds include EVERY authored
 * state and native feature chart, so crossing an articulation edge cannot move
 * the owner boundary. These are source-pixel [left,top,right,bottom] bounds. */
export function shortHairPatchOwners(assets,poseId){
  const family=assets.poses.find(pose=>pose.id===poseId).sourceFamily;
  const record=poseId==='front'?assets.front.manifest:assets[family].manifest.poses[poseId];
  const boxes=ARTICULATION_GROUPS.map(group=>{
    const rectangles=Object.values(record.patches[group]||{}).flatMap(p=>Array.isArray(p.destination)?[[p.destination[0],p.destination[1],p.destination[0]+p.destination[2],p.destination[1]+p.destination[3]]]:[]);
    const feature=assets.featureGeometry?.poses?.[poseId]?.features?.[group];
    for(const chart of Object.values(feature?.states||{}))if(chart.range?.length===2&&chart.upper?.length===9&&chart.lower?.length===9){
      const cross=[Math.min(...chart.upper),Math.max(...chart.lower)];
      rectangles.push(feature.axis===1?[cross[0],chart.range[0],cross[1],chart.range[1]]:[chart.range[0],cross[0],chart.range[1],cross[1]]);
    }
    return rectangles.length?[Math.min(...rectangles.map(r=>r[0])),Math.min(...rectangles.map(r=>r[1])),Math.max(...rectangles.map(r=>r[2])),Math.max(...rectangles.map(r=>r[3]))]:[0,0,0,0];
  });
  const overlap=(a,b)=>Math.min(a[2],b[2])>Math.max(a[0],b[0])&&Math.min(a[3],b[3])>Math.max(a[1],b[1]);
  for(const [left,right] of [[0,1],[3,4]])if(overlap(boxes[left],boxes[right])){
    const boundary=(Math.max(boxes[left][0],boxes[right][0])+Math.min(boxes[left][2],boxes[right][2]))/2;
    // Character left is screen right in every registered pose.
    boxes[left][0]=boundary;boxes[right][2]=boundary;
  }
  return boxes;
}

/** Cache only pixels the painter actually uses. Unchanged expression steps,
 * unrelated tracking coefficients and closed-eye gaze cannot repaint sources. */
export function shortHairPaintSignature(assets,poseId,state,gaze,{original=false,transparent=false}={}){
  const front=poseId==='front',family=assets.poses.find(pose=>pose.id===poseId).sourceFamily;
  const source=assets[family];
  const offsets=Object.fromEntries(['eyeLeft','eyeRight'].map(eye=>{
    if(original)return [eye,null];
    const visible=front?source.gazeLayers?.[eye]?.[state[eye]]:source.gazeLayers?.[poseId]?.[eye]?.frames?.[state[eye]];
    if(!visible)return [eye,null];
    return [eye,front?gazeOffset(gaze?.[eye],source.manifest.gaze.maxShift)
      :sideGazeOffset(gaze?.[eye],source.manifest.gaze.poses[poseId].eyes[eye])];
  }));
  return JSON.stringify([poseId,state,offsets,original,transparent]);
}

/** Runtime reprojects current painted expressions using offline neural flow.
 * No face/pose inference, image generation or external requests occur here. */
export function renderContinuousShortHairStudio(canvas,assets,poseId,channels,previous={},options={}){
  // Never resize or clear the displayed canvas while GPU resources recover.
  // A failed restoration is terminal until the user retries loading: don't
  // silently spin forever while claiming that recovery is still in progress.
  if(assets.flowRenderer.restoreError)throw assets.flowRenderer.restoreError;
  if(assets.flowRenderer.lost||assets.flowRenderer.disposed)return {didDraw:false};
  const headPose=validateHeadPose(options.headPose||poseHeadCoordinates(poseId));
  const {vertices}=locateHeadTriangle(headPose),view=continuousViewport(headPose,{faceOnly:options.faceOnly!==false});
  const selected=selectShortHairStudioState(assets,poseId,channels,previous);
  const active=vertices.filter(vertex=>vertex.weight>0),original=options.original===true;
  const requested=options.articulation===undefined?null:validateArticulation(options.articulation);
  const articulation=original?null:requested||articulationFromState(options.stateOverride||selected.targetState);
  const fractional=!original&&ARTICULATION_GROUPS.some(group=>articulation[group].from!==articulation[group].to);
  const endpointState=endpoint=>Object.fromEntries(ARTICULATION_GROUPS.map(group=>[group,articulation[group][endpoint]]));
  const fromState=original?null:endpointState('from'),toState=original?null:endpointState('to');
  const secondary=validateSecondaryFrame(original?{breath:0,sway:0,hair:0}:options.secondary||{breath:0,sway:0,hair:0});
  const useFringe=!original&&Boolean(assets.fringeRenderer)&&secondary.hair!==0;
  if(useFringe&&assets.fringeRenderer.restoreError)throw assets.fringeRenderer.restoreError;
  if(useFringe&&(assets.fringeRenderer.lost||assets.fringeRenderer.disposed))return {didDraw:false};
  // Once true foreground layers exist, the old whole-image exterior hair warp
  // is disabled. Breathing/sway still run once after per-pose layer assembly.
  const flowSecondary=assets.fringeRenderer?{...secondary,hair:0}:secondary;
  const hasSecondary=Object.values(flowSecondary).some(value=>value!==0);
  const actualVertices=original?[{poseId:nearestStudioPoseId(headPose),weight:1}]:active.length===1?active:vertices;
  // Static ownership is conservatively expanded for the accepted six-pixel
  // fringe travel plus sampling margin, once per pose and verified source.
  const hairSources=!original&&assets.fringe?[]:null,hairSignatures=hairSources?[]:null;
  const sources=[],signatures=[],features=[],secondSources=[],secondSignatures=[],secondFeatures=[],browSources=[],browSecondSources=[],browSignatures=[],browSecondSignatures=[],patchOwners=[];let exactResult;
  for(const vertex of actualVertices){
    const selectedSource=selectShortHairStudioState(assets,vertex.poseId,original?{}:channels,{});
    const state=original?selectedSource.targetState:compatibleState(assets,vertex.poseId,fromState);
    const endState=fractional?compatibleState(assets,vertex.poseId,toState):state;
    // Independent face and brow planes require four painter combinations at
    // their overlap. Two full portraits cannot encode both progress values.
    const faceEnd={...endState,browLeft:state.browLeft,browRight:state.browRight};
    const browEnd={...state,browLeft:endState.browLeft,browRight:endState.browRight};
    const cornerStates=[state,faceEnd,browEnd,endState];
    features.push(assets.featureGeometry?featureChartsForState(assets.featureGeometry,vertex.poseId,state):Array(6).fill(null));
    secondFeatures.push(fractional&&assets.featureGeometry?featureChartsForState(assets.featureGeometry,vertex.poseId,faceEnd):features.at(-1));
    let buffer=assets.continuousBuffers.get(vertex.poseId);
    if(!buffer){buffer={canvas:makeCanvas(),signature:null};assets.continuousBuffers.set(vertex.poseId,buffer);}
    buffer.patchOwners ||= shortHairPatchOwners(assets,vertex.poseId);patchOwners.push(buffer.patchOwners);
    if(hairSources){const protection=featureHairProtection(assets,vertex.poseId,buffer);hairSources.push(protection.canvas);hairSignatures.push(protection.signature);}
    buffer.paintPool ||= [{canvas:buffer.canvas,signature:buffer.signature,result:buffer.result}];
    const cornerSignatures=cornerStates.map(paintState=>shortHairPaintSignature(assets,vertex.poseId,paintState,selectedSource.targetGaze,
      {original,transparent:options.transparent===true}));
    const unique=new Map();cornerSignatures.forEach((signature,index)=>{if(!unique.has(signature))unique.set(signature,{state:cornerStates[index],record:null});});
    const reserved=new Set();
    // Reserve every reusable corner BEFORE selecting a spare. A reversed edge
    // may need the old B as new A and old A as new B without either repainting.
    for(const [signature,entry] of unique){
      entry.record=buffer.paintPool.find(record=>record.signature===signature)||null;
      if(entry.record)reserved.add(entry.record);
    }
    for(const entry of unique.values())if(!entry.record){
      entry.record=buffer.paintPool.find(record=>!reserved.has(record));
      if(!entry.record){entry.record={canvas:makeCanvas(),signature:null};buffer.paintPool.push(entry.record);}
      reserved.add(entry.record);
    }
    const painted=new Map();
    for(const [signature,entry] of unique){
      const record=entry.record;
      if(record.signature!==signature){
        // A failed painter cannot leave a valid signature on partially changed pixels.
        record.signature=null;
        record.result=renderShortHairStudio(record.canvas,assets,vertex.poseId,channels,{},
          {faceOnly:false,original,stateOverride:entry.state});
        if(options.transparent===true)applyShortHairAlpha(record.canvas,assets.alpha,vertex.poseId);
        record.signature=signature;
      }
      const image=useFringe?assets.fringeRenderer.render(record.canvas,vertex.poseId,{x:secondary.hair,y:.18*secondary.hair},{signature}):record.canvas;
      if(!image)return {didDraw:false};
      painted.set(signature,{canvas:image,signature:useFringe?JSON.stringify([signature,'fringe',secondary.hair]):signature});
    }
    const records=cornerSignatures.map(signature=>unique.get(signature).record),corners=cornerSignatures.map(signature=>painted.get(signature));
    buffer.canvas=records[0].canvas;buffer.signature=records[0].signature;buffer.result=records[0].result;
    [buffer.second,buffer.brow,buffer.browSecond]=records.slice(1);
    sources.push(corners[0].canvas);signatures.push(corners[0].signature);
    secondSources.push(corners[1].canvas);secondSignatures.push(corners[1].signature);
    browSources.push(corners[2].canvas);browSignatures.push(corners[2].signature);
    browSecondSources.push(corners[3].canvas);browSecondSignatures.push(corners[3].signature);
    if(vertex.weight===1)exactResult=records[0].result;
  }
  const descriptor=!original&&(assets.featureGeometry||fractional)?{
    from:features,to:secondFeatures,
    progress:[0,...ARTICULATION_GROUPS.map(group=>articulation[group].t)],
    secondSources,secondSignatures,browSources,browSecondSources,browSignatures,browSecondSignatures,patchOwners,hairSources,hairSignatures,enabled:Boolean(assets.featureGeometry)&&options.featureCorrection!==false,
  }:null;
  // An authored endpoint retains its direct 2D pixels. A fractional expression
  // still needs per-feature GPU composition even at an exact head vertex.
  const source=actualVertices.length===1&&!hasSecondary&&!fractional?sources[0]
    :assets.flowRenderer.render(actualVertices,sources,signatures,flowSecondary,descriptor,options.renderFullFrame===true?null:view);
  if(!source||assets.flowRenderer.lost||useFringe&&assets.fringeRenderer.lost)return {didDraw:false};
  if(canvas.width!==view[2])canvas.width=view[2];if(canvas.height!==view[3])canvas.height=view[3];
  const c=canvas.getContext('2d');c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,canvas.width,canvas.height);
  c.drawImage(source,...view,0,0,view[2],view[3]);
  const state=original?exactResult.state:articulationState(articulation);
  const displayedArticulation=original?articulationFromState(state):articulation;
  return {...selected,state,articulation:displayedArticulation,gaze:original?exactResult.gaze:selected.targetGaze,headPose:original?poseHeadCoordinates(actualVertices[0].poseId):headPose,transparent:options.transparent===true,secondary,
    vertices:actualVertices.map(vertex=>({...vertex})),didDraw:true};
}
