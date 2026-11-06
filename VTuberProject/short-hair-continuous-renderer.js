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

const makeCanvas=()=>document.createElement('canvas');
/** Join independently verified asset families by the exact native source and
 * matte identities. A valid fringe-file digest alone does not establish that
 * its support was authored against the currently loaded silhouette. */
export function validateContinuousShortHairSources(assets,alpha,motionFields,fringe){
  for(const pose of assets.poses){
    const family=assets[pose.sourceFamily],record=pose.id==='front'?family.manifest:family.manifest.poses[pose.id];
    const source=family.manifest.sources[record.reference].src,field=motionFields.manifest.sources[pose.id],matte=alpha.manifest.poses[pose.id];
    if(!field||!matte||source!==field.path||source!==matte.source||field.sha256!==matte.sourceSha256)throw new Error('透明遮罩、运动场与当前原画来源不一致。');
    const binding=fringe.poses[pose.id]?.binding,registration=fringe.manifest.poses[pose.id];
    if(!binding||!registration||binding.poseId!==pose.id||binding.sourceSha256!==field.sha256
      ||registration.source?.path!==source||registration.source?.sha256!==field.sha256
      ||registration.alphaSha256!==matte.matteSha256)throw new Error('前发绑定、透明遮罩与当前姿态原画来源不一致。');
  }
  return true;
}
export async function loadContinuousShortHairAssets(){
  const [assets,alpha,motionFields,fringe]=await Promise.all([loadShortHairStudioAssets(),loadShortHairAlphaAssets(),loadShortHairMotionFields(),loadShortHairFringeAssets()]);
  validateContinuousShortHairSources(assets,alpha,motionFields,fringe);
  let flowRenderer,fringeRenderer;
  try{flowRenderer=new ShortHairFlowRenderer(motionFields);fringeRenderer=new ShortHairFringeRenderer(fringe);
    return {...assets,alpha,motionFields,fringe,flowRenderer,fringeRenderer,continuousBuffers:new Map()};
  }catch(error){try{fringeRenderer?.dispose();}finally{flowRenderer?.dispose();}throw error;}
}

function compatibleState(assets,poseId,channels,override){
  const selected=selectShortHairStudioState(assets,poseId,channels,{});
  if(!override)return selected.targetState;
  const front=poseId==='front',family=assets.poses.find(pose=>pose.id===poseId).sourceFamily;
  const record=front?assets.front.manifest:assets[family].manifest.poses[poseId];
  return Object.fromEntries(Object.entries(selected.targetState).map(([group,value])=>{
    const wanted=override[group],neutral=group.startsWith('eye')?'open':'neutral';
    return [group,wanted===neutral||record.patches[group]?.[wanted]?wanted:value];
  }));
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
  const secondary=validateSecondaryFrame(original?{breath:0,sway:0,hair:0}:options.secondary||{breath:0,sway:0,hair:0});
  const useFringe=!original&&Boolean(assets.fringeRenderer)&&secondary.hair!==0;
  if(useFringe&&assets.fringeRenderer.restoreError)throw assets.fringeRenderer.restoreError;
  if(useFringe&&(assets.fringeRenderer.lost||assets.fringeRenderer.disposed))return {didDraw:false};
  // Once true foreground layers exist, the old whole-image exterior hair warp
  // is disabled. Breathing/sway still run once after per-pose layer assembly.
  const flowSecondary=assets.fringeRenderer?{...secondary,hair:0}:secondary;
  const hasSecondary=Object.values(flowSecondary).some(value=>value!==0);
  const actualVertices=original?[{poseId:nearestStudioPoseId(headPose),weight:1}]:active.length===1?active:vertices;
  const sources=[],signatures=[];let exactResult;
  for(const vertex of actualVertices){
    const selectedSource=selectShortHairStudioState(assets,vertex.poseId,original?{}:channels,{});
    const state=original?selectedSource.targetState:compatibleState(assets,vertex.poseId,channels,options.stateOverride);
    const signature=shortHairPaintSignature(assets,vertex.poseId,state,selectedSource.targetGaze,
      {original,transparent:options.transparent===true});
    let buffer=assets.continuousBuffers.get(vertex.poseId);
    if(!buffer){buffer={canvas:makeCanvas(),signature:null};assets.continuousBuffers.set(vertex.poseId,buffer);}
    if(buffer.signature!==signature){
      buffer.result=renderShortHairStudio(buffer.canvas,assets,vertex.poseId,channels,{},
        {faceOnly:false,original,stateOverride:state});
      if(options.transparent===true)applyShortHairAlpha(buffer.canvas,assets.alpha,vertex.poseId);
      buffer.signature=signature;
    }
    const painted=useFringe?assets.fringeRenderer.render(buffer.canvas,vertex.poseId,{x:secondary.hair,y:.18*secondary.hair},{signature}):buffer.canvas;
    if(!painted)return {didDraw:false};
    sources.push(painted);signatures.push(useFringe?JSON.stringify([signature,'fringe',secondary.hair]):signature);if(vertex.weight===1)exactResult=buffer.result;
  }
  // Zero-secondary endpoints retain the original direct 2D pixel path.
  const source=actualVertices.length===1&&!hasSecondary?sources[0]
    :assets.flowRenderer.render(actualVertices,sources,signatures,flowSecondary);
  if(!source||assets.flowRenderer.lost||useFringe&&assets.fringeRenderer.lost)return {didDraw:false};
  if(canvas.width!==view[2])canvas.width=view[2];if(canvas.height!==view[3])canvas.height=view[3];
  const c=canvas.getContext('2d');c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,canvas.width,canvas.height);
  c.drawImage(source,...view,0,0,view[2],view[3]);
  const state=original?exactResult.state:options.stateOverride||selected.targetState;
  return {...selected,state,gaze:original?exactResult.gaze:selected.targetGaze,headPose:original?poseHeadCoordinates(actualVertices[0].poseId):headPose,transparent:options.transparent===true,secondary,
    vertices:actualVertices.map(vertex=>({...vertex})),didDraw:true};
}
