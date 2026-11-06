import {loadShortHairStudioAssets,renderShortHairStudio,selectShortHairStudioState} from './short-hair-studio-renderer.js';
import {loadShortHairAlphaAssets,applyShortHairAlpha} from './short-hair-alpha.js';
import {loadShortHairMotionFields} from './short-hair-motion-fields.js';
import {ShortHairFlowRenderer} from './short-hair-flow-renderer.js';
import {locateHeadTriangle,continuousViewport} from './short-hair-continuous-model.js';
import {poseHeadCoordinates,validateHeadPose,nearestStudioPoseId} from './short-hair-pose-motion.js';

const makeCanvas=()=>document.createElement('canvas');
export async function loadContinuousShortHairAssets(){
  const [assets,alpha,motionFields]=await Promise.all([loadShortHairStudioAssets(),loadShortHairAlphaAssets(),loadShortHairMotionFields()]);
  for(const pose of assets.poses){
    const family=assets[pose.sourceFamily],record=pose.id==='front'?family.manifest:family.manifest.poses[pose.id];
    const source=family.manifest.sources[record.reference].src,field=motionFields.manifest.sources[pose.id],matte=alpha.manifest.poses[pose.id];
    if(source!==field.path||source!==matte.source||field.sha256!==matte.sourceSha256)throw new Error('透明遮罩、运动场与当前原画来源不一致。');
  }
  const flowRenderer=new ShortHairFlowRenderer(motionFields);
  return {...assets,alpha,motionFields,flowRenderer,continuousBuffers:new Map()};
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

/** Runtime reprojects current painted expressions using offline neural flow.
 * No face/pose inference, image generation or external requests occur here. */
export function renderContinuousShortHairStudio(canvas,assets,poseId,channels,previous={},options={}){
  const headPose=validateHeadPose(options.headPose||poseHeadCoordinates(poseId));
  const {vertices}=locateHeadTriangle(headPose),view=continuousViewport(headPose,{faceOnly:options.faceOnly!==false});
  const selected=selectShortHairStudioState(assets,poseId,channels,previous);
  const active=vertices.filter(vertex=>vertex.weight>0),original=options.original===true;
  const actualVertices=original?[{poseId:nearestStudioPoseId(headPose),weight:1}]:vertices;
  const sources=[],signatures=[];let exactResult;
  for(const vertex of actualVertices){
    const state=compatibleState(assets,vertex.poseId,channels,options.stateOverride);
    const signature=JSON.stringify([vertex.poseId,channels,state,original,options.transparent===true]);
    let buffer=assets.continuousBuffers.get(vertex.poseId);
    if(!buffer){buffer={canvas:makeCanvas(),signature:null};assets.continuousBuffers.set(vertex.poseId,buffer);}
    if(buffer.signature!==signature){
      buffer.result=renderShortHairStudio(buffer.canvas,assets,vertex.poseId,channels,{},
        {faceOnly:false,original,stateOverride:state});
      if(options.transparent===true)applyShortHairAlpha(buffer.canvas,assets.alpha,vertex.poseId);
      buffer.signature=signature;
    }
    sources.push(buffer.canvas);signatures.push(signature);if(vertex.weight===1)exactResult=buffer.result;
  }
  const source=original?sources[0]:active.length===1?sources[vertices.findIndex(vertex=>vertex.weight===1)]
    :assets.flowRenderer.render(vertices,sources,signatures);
  if(canvas.width!==view[2])canvas.width=view[2];if(canvas.height!==view[3])canvas.height=view[3];
  const c=canvas.getContext('2d');c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,canvas.width,canvas.height);
  c.drawImage(source,...view,0,0,view[2],view[3]);
  const state=original?exactResult.state:options.stateOverride||selected.targetState;
  return {...selected,state,gaze:original?exactResult.gaze:selected.targetGaze,headPose:original?poseHeadCoordinates(actualVertices[0].poseId):headPose,transparent:options.transparent===true,
    vertices:actualVertices.map(vertex=>({...vertex})),didDraw:true};
}
