import {loadContinuousShortHairAssets,renderContinuousShortHairStudio} from './short-hair-continuous-renderer.js';
import {renderShortHairStudio} from './short-hair-studio-renderer.js';
import {applyShortHairAlpha} from './short-hair-alpha.js';
import {STUDIO_HEAD_POSES,poseHeadCoordinates,createStudioPoseMotion,targetStudioPoseMotion,advanceStudioPoseMotion} from './short-hair-pose-motion.js';
import {locateHeadTriangle,CONTINUOUS_FACE_VIEW} from './short-hair-continuous-model.js';
import {featureChartsForState,blendFeatureSets,chartPoint} from './short-hair-feature-geometry.js';
import {ARTICULATION_DEFAULT_STATE,ARTICULATION_EYES,ARTICULATION_JAW,ARTICULATION_SPECIAL_MOUTHS,articulationFromState,articulationState,validateArticulation,createArticulationMotion,targetArticulationMotion,advanceArticulationMotion} from './short-hair-articulation.js';
import {gazeChannels} from './short-hair-studio-model.js';
import {validateSecondaryFrame} from './short-hair-secondary-motion.js';

export const FEATURE_DIAGNOSTIC_EPSILON=1e-5;
export const FEATURE_DIAGNOSTIC_PIXEL_LIMIT=2;
export const FEATURE_DIAGNOSTIC_DRAW_LIMIT=999;
export const FEATURE_CONVERGENCE_EPSILONS=Object.freeze([1e-5,1e-6,1e-7]);
const neutral=()=>({...ARTICULATION_DEFAULT_STATE});
const frameState=(groups,value)=>({...neutral(),...Object.fromEntries(groups.map(group=>[group,value]))});
const stateKey=state=>JSON.stringify(state);

/** Every available non-neutral painting is compared to its native endpoint.
 * Bilateral cases exercise both eye / brow textures together, without multiplying
 * equivalent full-face draws. Front and side brows have different real names. */
export function featurePoseCases(assets,pose){
  const source=assets[pose.sourceFamily],record=pose.id==='front'?source?.manifest:source?.manifest?.poses?.[pose.id];
  if(!record?.patches)throw new Error(`缺少实际画稿清单：${pose.id}`);
  const brows=pose.id==='front'?['up','down']:['innerUp','outerUp','down'];
  const definitions=[{groups:['eyeLeft','eyeRight'],states:ARTICULATION_EYES,chain:true},
    {groups:['mouth'],states:ARTICULATION_JAW,chain:true},
    {groups:['mouth'],states:['neutral',...ARTICULATION_SPECIAL_MOUTHS],chain:false},
    {groups:['browLeft','browRight'],states:['neutral',...brows],chain:false}];
  const endpoints=new Map([[stateKey(neutral()),neutral()]]),edges=[];
  for(const definition of definitions){
    for(const name of definition.states.slice(1))for(const group of definition.groups){
      if(!record.patches[group]?.[name])throw new Error(`没有对应实际画稿：${pose.id}/${group}/${name}`);
    }
    for(const name of definition.states) {const state=frameState(definition.groups,name);endpoints.set(stateKey(state),state);}
    for(let index=1;index<definition.states.length;index++)edges.push({groups:definition.groups,
      from:definition.states[definition.chain?index-1:0],to:definition.states[index]});
  }
  return {poseId:pose.id,endpoints:[...endpoints.values()],edges};
}

/** The 4 diagonal seams and 4 interior axis segments cover all neighboring
 * triangles. Exterior grid edges have only one side and are covered by vertices. */
export function featureHeadSeams(epsilon=FEATURE_DIAGNOSTIC_EPSILON){
  if(!Number.isFinite(epsilon)||epsilon<=0||epsilon>=.01)throw new Error('接缝偏移无效。');
  const seams=[];
  for(const left of [-1,0])for(const top of [0,1])for(const t of [.25,.5,.75]){
    const center={yaw:left+t,pitch:top-t};
    seams.push({id:`diagonal:${left},${top}:${t}`,center,
      before:{yaw:center.yaw-epsilon,pitch:center.pitch},after:{yaw:center.yaw+epsilon,pitch:center.pitch}});
  }
  for(const segment of [-1,0])for(const t of [.25,.5,.75]){
    seams.push({id:`yaw-axis:${segment}:${t}`,center:{yaw:0,pitch:segment+t},before:{yaw:-epsilon,pitch:segment+t},after:{yaw:epsilon,pitch:segment+t}});
    seams.push({id:`pitch-axis:${segment}:${t}`,center:{yaw:segment+t,pitch:0},before:{yaw:segment+t,pitch:-epsilon},after:{yaw:segment+t,pitch:epsilon}});
  }
  return seams;
}
export function featureVertexApproaches(epsilon=FEATURE_DIAGNOSTIC_EPSILON){
  if(!Number.isFinite(epsilon)||epsilon<=0||epsilon>=.01)throw new Error('顶点偏移无效。');
  return STUDIO_HEAD_POSES.map(pose=>({poseId:pose.id,center:{yaw:pose.yaw,pitch:pose.pitch},approaches:
    [-1,0,1].flatMap(dx=>[-1,0,1].filter(dy=>(dx||dy)&&Math.abs(pose.yaw+dx*epsilon)<=1&&Math.abs(pose.pitch+dy*epsilon)<=1)
      .map(dy=>({yaw:pose.yaw+dx*epsilon,pitch:pose.pitch+dy*epsilon})))}));
}
export function buildFeatureDiagnosticPlan(assets){
  if(assets.poses?.length!==9||new Set(assets.poses.map(pose=>pose.id)).size!==9||assets.poses.some(pose=>!STUDIO_HEAD_POSES.some(known=>known.id===pose.id)))throw new Error('诊断需要九个独立画稿方向。');
  const poses=assets.poses.map(pose=>featurePoseCases(assets,pose));
  const seams=featureHeadSeams(),vertices=featureVertexApproaches();
  const staticStates=[neutral(),frameState(['eyeLeft','eyeRight'],'half'),
    {...frameState(['eyeLeft','eyeRight'],'closed'),mouth:'openWide',browLeft:'down',browRight:'down'}];
  const renderCalls=poses.reduce((sum,pose)=>sum+2*pose.endpoints.length+2*pose.edges.length,0)
    +staticStates.length*(seams.length*3+vertices.reduce((sum,vertex)=>sum+1+vertex.approaches.length,0))+2;
  if(renderCalls>FEATURE_DIAGNOSTIC_DRAW_LIMIT)throw new Error(`诊断绘制预算超限：${renderCalls}`);
  return {poses,seams,vertices,staticStates,renderCalls};
}

/** Raw RGBA differences are never hidden behind a visual threshold. Visible
 * RGB is additionally reported because fully transparent RGB is not visible. */
export function compareFeaturePixels(a,b){
  if(a?.width!==b?.width||a?.height!==b?.height||!a?.data||!b?.data||a.data.length!==b.data.length||a.data.length!==a.width*a.height*4||!a.data.length)throw new Error('像素比较需要相同尺寸的 RGBA 画面。');
  let maximum=0,sum=0,squares=0,changedPixels=0,aboveLimit=0,maxAlpha=0,maxVisibleRgb=0;
  let maxPremultiplied=0,premultipliedSum=0,premultipliedSquares=0,premultipliedAbove=0;
  let opaquePixels=0,maxOpaqueRgb=0,maxOpaqueRgba=0,opaqueAbove=0;
  const bounds={left:a.width,top:a.height,right:-1,bottom:-1};
  for(let offset=0;offset<a.data.length;offset+=4){
    let changed=false,over=false,premultipliedOver=false,opaqueOver=false;
    const alphaA=a.data[offset+3],alphaB=b.data[offset+3],opaque=alphaA>=250&&alphaB>=250;
    if(opaque)opaquePixels++;
    for(let channel=0;channel<4;channel++){
      const delta=Math.abs(a.data[offset+channel]-b.data[offset+channel]);maximum=Math.max(maximum,delta);sum+=delta;squares+=delta*delta;
      if(channel===3)maxAlpha=Math.max(maxAlpha,delta);else if(a.data[offset+3]||b.data[offset+3])maxVisibleRgb=Math.max(maxVisibleRgb,delta);
      changed ||= delta!==0;over ||= delta>FEATURE_DIAGNOSTIC_PIXEL_LIMIT;
      if(channel<3){
        const premultiplied=Math.abs(a.data[offset+channel]*alphaA-b.data[offset+channel]*alphaB)/255;
        maxPremultiplied=Math.max(maxPremultiplied,premultiplied);premultipliedSum+=premultiplied;premultipliedSquares+=premultiplied*premultiplied;
        premultipliedOver ||= premultiplied>FEATURE_DIAGNOSTIC_PIXEL_LIMIT;
        if(opaque)maxOpaqueRgb=Math.max(maxOpaqueRgb,delta);
      }
      if(opaque){maxOpaqueRgba=Math.max(maxOpaqueRgba,delta);opaqueOver ||= delta>FEATURE_DIAGNOSTIC_PIXEL_LIMIT;}
    }
    if(changed)changedPixels++;if(premultipliedOver)premultipliedAbove++;if(opaqueOver)opaqueAbove++;
    if(over){aboveLimit++;const pixel=offset/4,x=pixel%a.width,y=Math.floor(pixel/a.width);bounds.left=Math.min(bounds.left,x);bounds.right=Math.max(bounds.right,x);bounds.top=Math.min(bounds.top,y);bounds.bottom=Math.max(bounds.bottom,y);}
  }
  const pixels=a.width*a.height;
  return {maxAbsRgba:maximum,meanAbsRgba:sum/a.data.length,rmseRgba:Math.sqrt(squares/a.data.length),maxAlpha,maxVisibleRgb,
    changedPixels,changedFraction:changedPixels/pixels,pixelsAbove2:aboveLimit,fractionAbove2:aboveLimit/pixels,boundsAbove2:aboveLimit?bounds:null,
    exact:maximum===0,withinFixedTwoLevels:maximum<=FEATURE_DIAGNOSTIC_PIXEL_LIMIT,
    maxAbsPremultipliedRgb:maxPremultiplied,meanAbsPremultipliedRgb:premultipliedSum/(pixels*3),rmsePremultipliedRgb:Math.sqrt(premultipliedSquares/(pixels*3)),
    premultipliedPixelsAbove2:premultipliedAbove,premultipliedFractionAbove2:premultipliedAbove/pixels,
    withinFixedTwoPremultipliedRgbLevels:maxPremultiplied<=FEATURE_DIAGNOSTIC_PIXEL_LIMIT,
    withinFixedTwoPremultipliedRgbaLevels:maxPremultiplied<=FEATURE_DIAGNOSTIC_PIXEL_LIMIT&&maxAlpha<=FEATURE_DIAGNOSTIC_PIXEL_LIMIT,
    opaqueAlphaMinimum:250,opaquePixels,maxAbsOpaqueRgb:opaquePixels?maxOpaqueRgb:null,maxAbsOpaqueRgba:opaquePixels?maxOpaqueRgba:null,
    opaquePixelsAbove2:opaqueAbove,opaqueFractionAbove2:opaquePixels?opaqueAbove/opaquePixels:null,
    withinFixedTwoOpaqueLevels:opaquePixels?maxOpaqueRgba<=FEATURE_DIAGNOSTIC_PIXEL_LIMIT:null};
}
export function featureActionSample(elapsedMs){
  if(!Number.isFinite(elapsedMs)||elapsedMs<0)throw new Error('动作时间无效。');
  const t=(elapsedMs%8000)/1000,state=neutral();
  if(t>=.7&&t<1.2){state.eyeLeft='closed';state.eyeRight='closed';state.browLeft='up';state.browRight='down';}
  if(t>=1.8&&t<2.5){state.mouth='openWide';state.browLeft='down';state.eyeRight='closed';}
  else if(t>=2.5&&t<3.1)state.mouth='pucker';else if(t>=3.1&&t<3.8)state.mouth='press';
  else if(t>=3.8&&t<4.5)state.mouth='shiftLeft';else if(t>=4.5&&t<5.2)state.mouth='shiftRight';
  if(t>=5.2&&t<6)state.browLeft='down';else if(t>=6&&t<6.8)state.browRight='down';
  if(t>=6.8&&t<7.3){state.eyeLeft='closed';state.browRight='up';}
  return {state,headPose:{yaw:.85*Math.sin(t*Math.PI/4),pitch:.65*Math.sin(t*Math.PI/2)},
    coefficients:gazeChannels(.55*Math.sin(t*Math.PI/3),.25*Math.sin(t*Math.PI/2)),
    secondary:{breath:.3*Math.sin(t*Math.PI/2),sway:.2*Math.sin(t*Math.PI/4),hair:.6*Math.sin(t*Math.PI/4)}};
}

/** The four other parts stay at unequal, genuine interior progress while one
 * part approaches each canonical endpoint. These are independent multi-part
 * checks, not a claim that single-action endpoint tests cover joint motion. */
export function featureJointEndpointCases(){
  const initial={eyeLeft:{from:'open',to:'quarter',t:.23},eyeRight:{from:'half',to:'threeQuarter',t:.67},
    mouth:{from:'parted',to:'openSmall',t:.41},browLeft:{from:'neutral',to:'down',t:.34},browRight:{from:'neutral',to:'down',t:.79}};
  return ['front','view-left-up','view-right-down'].flatMap(poseId=>Object.keys(initial).flatMap(group=>[0,1].map(end=>{
    const near=Object.fromEntries(Object.entries(initial).map(([key,part])=>[key,{...part}]));
    const expected=Object.fromEntries(Object.entries(initial).map(([key,part])=>[key,{...part}]));
    near[group].t=end?1-FEATURE_DIAGNOSTIC_EPSILON:FEATURE_DIAGNOSTIC_EPSILON;
    const state=initial[group][end?'to':'from'];expected[group]={from:state,to:state,t:0};
    return {poseId,group,end,near,expected};
  })));
}
export function selectFeatureSeamConvergenceCases(cases,limit=8){
  if(!Array.isArray(cases)||!Number.isInteger(limit)||limit<1||limit>8)throw new Error('接缝收敛检查最多选择八组。');
  const unique=new Map();
  for(const entry of cases){
    if(entry.kind!=='triangle-seam')continue;
    const key=entry.seam.id+':'+stateKey(entry.state),score=Math.max(entry.metrics.maxAbsOpaqueRgba??0,entry.metrics.maxAbsPremultipliedRgb??0);
    const item=unique.get(key)||{seam:entry.seam,state:entry.state,score:0,originalCases:[]};
    item.score=Math.max(item.score,score);item.originalCases.push({id:entry.id,side:entry.side,metrics:entry.metrics});unique.set(key,item);
  }
  return [...unique.values()].sort((a,b)=>b.score-a.score).slice(0,limit);
}
export function featureSeamPointsAtEpsilon(seam,epsilon){
  if(!FEATURE_CONVERGENCE_EPSILONS.includes(epsilon))throw new Error('收敛检查只使用固定的三个 epsilon。');
  const delta={yaw:seam.before.yaw-seam.center.yaw,pitch:seam.before.pitch-seam.center.pitch};
  const magnitude=Math.max(Math.abs(delta.yaw),Math.abs(delta.pitch));
  if(!Number.isFinite(magnitude)||magnitude<=0)throw new Error('接缝偏移方向无效。');
  const center={...seam.center},before={},after={};
  for(const axis of ['yaw','pitch']){before[axis]=center[axis]+delta[axis]/magnitude*epsilon;after[axis]=center[axis]-delta[axis]/magnitude*epsilon;}
  return {center,before,after};
}

function summarizeCases(cases){
  return Object.fromEntries(['native-endpoint','articulation-limit','triangle-seam','pose-vertex'].map(kind=>{
    const entries=cases.filter(item=>item.kind===kind),exact=kind==='native-endpoint';
    return [kind,{comparisons:entries.length,failures:entries.filter(item=>exact?!item.metrics.exact:!item.metrics.withinFixedTwoLevels).length,
      maxAbsRgba:entries.length?Math.max(...entries.map(item=>item.metrics.maxAbsRgba)):null,
      largestFractionAbove2:entries.length?Math.max(...entries.map(item=>item.metrics.fractionAbove2)):null,
      maxAbsPremultipliedRgb:entries.length?Math.max(...entries.map(item=>item.metrics.maxAbsPremultipliedRgb)):null,
      premultipliedRgbaFailures:entries.filter(item=>!item.metrics.withinFixedTwoPremultipliedRgbaLevels).length,
      maxAbsOpaqueRgba:entries.some(item=>item.metrics.opaquePixels)?Math.max(...entries.map(item=>item.metrics.maxAbsOpaqueRgba??0)):null,
      opaqueRgbaFailures:entries.filter(item=>item.metrics.withinFixedTwoOpaqueLevels===false).length}];
  }));
}

function initializeFeatureDiagnostics(){
  const $=id=>document.getElementById(id),before=$('fd-before'),after=$('fd-after');
  let native=document.createElement('canvas');
  const reference=document.createElement('canvas'),probe=document.createElement('canvas'),composite=document.createElement('canvas');
  const [cropX,cropY,width,height]=CONTINUOUS_FACE_VIEW;
  // Both final crop/readback surfaces use the same backend from their first
  // context creation. Native painters retain default per-pose canvases, just
  // like the runtime's source buffers; no source rasterization is forced.
  for(const surface of [reference,probe]){surface.width=width;surface.height=height;surface.getContext('2d',{willReadFrequently:true});}
  let assets=null,loading=null,busy=false,disposed=false,token=0,raf=0,lastReport=null,recording=null,playbackFinish=null,lastPairLabel='yaw 0.4 · pitch 0.25 · closed';
  const status=(message,kind='')=>{$('fd-status').textContent=message;$('fd-status').className=`status ${kind}`;};
  const controls=()=>{for(const id of ['fd-run','fd-replay','fd-webm','fd-endpoint-check','fd-joint-check','fd-compare','fd-crop-check'])$(id).disabled=!assets||busy;for(const id of ['fd-json'])$(id).disabled=!lastReport;
    $('fd-seam-check').disabled=!assets||busy||!lastReport?.cases?.some(entry=>entry.kind==='triangle-seam');
    $('fd-load').disabled=Boolean(loading)||busy;$('fd-stop').disabled=!busy;$('fd-png').disabled=!assets||busy;$('fd-fps').disabled=busy;};
  const pixels=canvas=>canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height);
  const present=()=>{$('fd-report').textContent=JSON.stringify(lastReport,null,2);$('fd-summary').textContent=JSON.stringify(lastReport?.summary||lastReport?.playback||{},null,2);controls();};
  const download=(blob,name)=>{if(!blob)throw new Error('导出画面失败。');const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const finishRecording=(abort=false)=>{if(!recording)return;recording.abort ||= abort;if(recording.recorder.state==='recording')recording.recorder.stop();};
  function stop(abortRecording=false){token++;cancelAnimationFrame(raf);raf=0;busy=false;finishRecording(abortRecording);controls();}
  function draw(canvas,headPose,state,articulation,featureCorrection=true,coefficients={},secondary={breath:0,sway:0,hair:0},renderFullFrame=false){
    const result=renderContinuousShortHairStudio(canvas,assets,'front',coefficients,{},
      {headPose,stateOverride:state,articulation,featureCorrection,faceOnly:true,transparent:true,secondary,renderFullFrame});
    if(result?.didDraw!==true)throw new Error('图形资源暂时不可用；本次未把未绘制画面作为有效样本。');
    return result;
  }
  function refreshDetails(headPose,state){
    const vertices=locateHeadTriangle(headPose).vertices;
    const sets=vertices.map(vertex=>featureChartsForState(assets.featureGeometry,vertex.poseId,state));
    const charts=blendFeatureSets(sets,vertices.map(vertex=>vertex.weight)).slice(0,3).filter(Boolean);
    const points=charts.flatMap(chart=>[0,1].flatMap(v=>Array.from({length:9},(_,i)=>chartPoint(chart,i/8,v))));
    if(!points.length)return;
    const x=Math.max(0,Math.floor(Math.min(...points.map(p=>p[0]))-cropX-18)),y=Math.max(0,Math.floor(Math.min(...points.map(p=>p[1]))-cropY-18));
    const w=Math.min(width-x,Math.ceil(Math.max(...points.map(p=>p[0]))-cropX+18-x)),h=Math.min(height-y,Math.ceil(Math.max(...points.map(p=>p[1]))-cropY+18-y));
    for(const [id,source] of [['fd-detail-before',before],['fd-detail-after',after]]){
      const canvas=$(id);if(canvas.width!==Math.round(w*2))canvas.width=Math.round(w*2);if(canvas.height!==Math.round(h*2))canvas.height=Math.round(h*2);const context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height);context.imageSmoothingEnabled=false;context.drawImage(source,x,y,w,h,0,0,canvas.width,canvas.height);
    }
  }
  function compose(label=lastPairLabel){
    if(composite.width!==width*2)composite.width=width*2;if(composite.height!==height+80)composite.height=height+80;
    const context=composite.getContext('2d');context.fillStyle='#e7ebef';context.fillRect(0,0,composite.width,composite.height);
    context.fillStyle='#142638';context.font='19px system-ui';context.fillText('五官校正关闭',18,28);context.fillText('五官校正开启',width+18,28);context.font='15px system-ui';context.fillText(label,18,57);
    context.drawImage(before,0,80);context.drawImage(after,width,80);return composite;
  }
  function example(count=()=>{}){
    const headPose={yaw:.4,pitch:.25},state=frameState(['eyeLeft','eyeRight'],'closed'),articulation=articulationFromState(state);
    count();draw(before,headPose,state,articulation,false);count();draw(after,headPose,state,articulation,true);
    lastPairLabel='yaw 0.4 · pitch 0.25 · 双眼 closed · 相同画稿与参数';refreshDetails(headPose,state);compose();
  }
  async function load(){
    if(assets)return assets;if(loading)return loading;
    status('正在校验并载入本机画稿、透明遮罩、运动场与五官几何…');
    loading=loadContinuousShortHairAssets();controls();
    try{assets=await loading;if(disposed)throw new Error('诊断页已关闭。');buildFeatureDiagnosticPlan(assets);example();status('画稿已载入一次。可运行诊断或播放动作；下方为闭眼中间角度对照。');return assets;}
    catch(error){assets?.flowRenderer?.dispose();assets?.fringeRenderer?.dispose();assets=null;status(`未载入：${error.message}`,'error');throw error;}
    finally{loading=null;controls();}
  }
  async function run(){
    if(busy||!assets)return;busy=true;controls();const active=++token,started=performance.now(),plan=buildFeatureDiagnosticPlan(assets);
    const cases=[];let drawCalls=0;
    const count=()=>{if(active!==token)throw new Error('用户已停止诊断。');if(drawCalls>=FEATURE_DIAGNOSTIC_DRAW_LIMIT)throw new Error('诊断绘制次数超出硬性预算。');drawCalls++;};
    const report={schemaVersion:1,kind:'short-hair-feature-diagnostics',generatedAt:new Date().toISOString(),complete:false,
      referenceMethod:{version:2,nativeCanvas:'Fresh default Canvas2D per pose, context created by the native painter at full dimensions',cropReadback:'Reference and continuous probe use identical willReadFrequently:true sinks from first context creation',reason:'Prior endpoint-isolation showed the same native painter differed by up to 65 RGB levels between reused/pre-created contexts and a fresh default canvas; those earlier reports remain independent evidence'},
      metricsVersion:2,pixelDefinitions:{raw:'Straight/unassociated RGBA, unchanged primary failure criterion',premultipliedRgb:'abs(RGB_A * alpha_A - RGB_B * alpha_B) / 255, scale 0-255',opaque:'Both compared pixels must have alpha >= 250; no eligible pixels yields null'},
      epsilon:FEATURE_DIAGNOSTIC_EPSILON,pixelLimit:FEATURE_DIAGNOSTIC_PIXEL_LIMIT,viewport:[...CONTINUOUS_FACE_VIEW],transparent:true,
      renderCallsPlanned:plan.renderCalls,renderCalls:0,featureSchemaVersion:assets.featureGeometry?.schemaVersion,
      sourceSha256:Object.fromEntries(Object.entries(assets.featureGeometry?.poses||{}).map(([id,pose])=>[id,pose.sourceSha256])),
      scope:'Native endpoints and continuity only. Intermediate line ghosting still requires visual review; no invented ghost-removal score.',cases};
    lastReport=report;$('fd-progress').max=plan.renderCalls;$('fd-progress').value=0;
    const yieldUi=async(label)=>{report.renderCalls=drawCalls;$('fd-progress').value=drawCalls;status(`${label}\n已绘制 ${drawCalls} / ${plan.renderCalls}；固定阈值不随结果调整。`);
      await new Promise(resolve=>requestAnimationFrame(resolve));if(active!==token)throw new Error('用户已停止诊断。');};
    const continuous=(head,state,articulation)=>{count();draw(probe,head,state,articulation);return pixels(probe);};
    const compare=(kind,id,a,b,details={})=>cases.push({kind,id,...details,metrics:compareFeaturePixels(a,b)});
    try{
      for(const pose of plan.poses){
        const head=poseHeadCoordinates(pose.poseId),nativeFrames=new Map();native=document.createElement('canvas');
        for(const state of pose.endpoints){
          count();renderShortHairStudio(native,assets,pose.poseId,{}, {},{faceOnly:false,stateOverride:state});applyShortHairAlpha(native,assets.alpha,pose.poseId);
          const context=reference.getContext('2d');context.clearRect(0,0,width,height);context.drawImage(native,cropX,cropY,width,height,0,0,width,height);
          const expected=pixels(reference);nativeFrames.set(stateKey(state),expected);
          compare('native-endpoint',`${pose.poseId}:${stateKey(state)}`,expected,continuous(head,state,articulationFromState(state)),{poseId:pose.poseId,state});
          if(drawCalls%8===0)await yieldUi(`核验原画端点：${pose.poseId}`);
        }
        for(const edge of pose.edges)for(const t of [FEATURE_DIAGNOSTIC_EPSILON,1-FEATURE_DIAGNOSTIC_EPSILON]){
          const articulation=articulationFromState();for(const group of edge.groups)articulation[group]={from:edge.from,to:edge.to,t};
          const state=articulationState(articulation),endpoint=frameState(edge.groups,t<.5?edge.from:edge.to);
          compare('articulation-limit',`${pose.poseId}:${edge.groups.join('+')}:${edge.from}>${edge.to}:${t}`,
            nativeFrames.get(stateKey(endpoint)),continuous(head,state,articulation),{poseId:pose.poseId,edge,t});
          if(drawCalls%8===0)await yieldUi(`核验连续表情极限：${pose.poseId}`);
        }
        nativeFrames.clear();await yieldUi(`完成该方向：${pose.poseId}`);
      }
      for(const state of plan.staticStates){
        const articulation=articulationFromState(state),key=stateKey(state);
        for(const seam of plan.seams){
          const center=continuous(seam.center,state,articulation),a=continuous(seam.before,state,articulation),b=continuous(seam.after,state,articulation);
          compare('triangle-seam',`${seam.id}:${key}:before`,center,a,{seam,state,side:'before'});
          compare('triangle-seam',`${seam.id}:${key}:after`,center,b,{seam,state,side:'after'});
          compare('triangle-seam',`${seam.id}:${key}:across`,a,b,{seam,state,side:'across'});
          await yieldUi('核验所有内部三角形接缝');
        }
        for(const vertex of plan.vertices){
          const center=continuous(vertex.center,state,articulation);
          for(const approach of vertex.approaches)compare('pose-vertex',`${vertex.poseId}:${key}:${JSON.stringify(approach)}`,center,continuous(approach,state,articulation),{poseId:vertex.poseId,state,approach});
          await yieldUi(`核验姿态顶点：${vertex.poseId}`);
        }
      }
      example(count);report.complete=true;report.renderCalls=drawCalls;report.elapsedMs=performance.now()-started;
      report.summary=summarizeCases(cases);const failures=Object.values(report.summary).reduce((sum,group)=>sum+group.failures,0);
      status(`诊断完成：${cases.length} 组比较，${drawCalls} 次绘制，${failures} 组未满足原始 RGBA 固定条件；预乘与不透明区域指标另列。\n这只衡量端点与连续性；仍需观看鼻线、眼睑和其他动作。`,failures?'warning':'');
    }catch(error){report.error=error.message;report.elapsedMs=performance.now()-started;report.renderCalls=drawCalls;report.summary=summarizeCases(cases);if(lastReport===report)status(`诊断未完成：${error.message}`,'error');}
    finally{if(active===token){busy=false;controls();}if(lastReport===report){$('fd-progress').value=drawCalls;present();}}
  }
  async function endpointIsolation(){
    if(busy||!assets)return;busy=true;controls();const active=++token,entries=[];
    const scratch=document.createElement('canvas');scratch.width=width;scratch.height=height;
    const read=scratch.getContext('2d',{willReadFrequently:true});
    const snapshot=source=>{read.clearRect(0,0,width,height);read.drawImage(source,cropX,cropY,width,height,0,0,width,height);return read.getImageData(0,0,width,height);};
    const nativePaint=(canvas,poseId,state)=>{renderShortHairStudio(canvas,assets,poseId,{}, {},{faceOnly:false,stateOverride:state});applyShortHairAlpha(canvas,assets.alpha,poseId);return snapshot(canvas);};
    try{
      for(const poseId of ['view-down','view-right-down'])for(const eye of ['open','half','closed']){
        if(active!==token)throw new Error('用户停止端点隔离检查。');
        const state=frameState(['eyeLeft','eyeRight'],eye),head=poseHeadCoordinates(poseId),frames={};
        frames.reusedNative=nativePaint(native,poseId,state);
        for(const [name,attribute] of [['freshDefault',null],['freshCpu',true],['freshGpuPreferred',false]]){
          const surface=document.createElement('canvas');if(attribute!==null)surface.getContext('2d',{willReadFrequently:attribute});
          frames[name]=nativePaint(surface,poseId,state);
        }
        const actual=document.createElement('canvas');actual.width=width;actual.height=height;actual.getContext('2d',{willReadFrequently:true});draw(actual,head,state,articulationFromState(state));frames.continuous=pixels(actual);
        const pairs=[['reusedNative','freshDefault'],['freshDefault','freshCpu'],['freshDefault','freshGpuPreferred'],['reusedNative','continuous'],['freshDefault','continuous'],['freshCpu','continuous'],['freshGpuPreferred','continuous']];
        entries.push({poseId,eye,comparisons:pairs.map(([from,to])=>({from,to,metrics:compareFeaturePixels(frames[from],frames[to])}))});
        status(`端点隔离检查：${poseId} / ${eye}\n比较同一原生 painter 的复用、新建和不同 Canvas2D readback 提示，不改变 runtime 或阈值。`);
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      lastReport={...(lastReport||{}),endpointIsolation:{complete:true,readbackMethod:'Matched CPU crop/readback sinks; native source contexts remain explicitly distinguished',renderCalls:30,entries}};present();status('端点隔离检查完成；JSON 包含各原生绘制后端提示之间的真实差值。');
    }catch(error){lastReport={...(lastReport||{}),endpointIsolation:{complete:false,error:error.message,entries}};present();status(error.message,'error');}
    finally{if(active===token){busy=false;controls();}}
  }
  async function jointEndpoints(){
    if(busy||!assets)return;busy=true;controls();const active=++token,entries=[];let drawCalls=0;
    const measure=(head,art)=>{drawCalls++;draw(probe,head,articulationState(art),art);return pixels(probe);};
    const result={complete:false,epsilon:FEATURE_DIAGNOSTIC_EPSILON,renderCalls:0,scope:'Four other parts remain at unequal interior progress while one part approaches each authored endpoint.',entries};
    try{
      for(const item of featureJointEndpointCases()){
        if(active!==token)throw new Error('用户停止联合表情端点检查。');
        const head=poseHeadCoordinates(item.poseId),expected=measure(head,item.expected),near=measure(head,item.near);
        entries.push({...item,metrics:compareFeaturePixels(expected,near)});
        status(`联合表情端点：${item.poseId} / ${item.group} / ${item.end}\n五个部位同时使用不同进度，保留其余四个部位。${drawCalls} / 60 次绘制。`);
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      result.complete=true;
    }catch(error){result.error=error.message;}
    finally{result.renderCalls=drawCalls;result.rawFailures=entries.filter(item=>!item.metrics.withinFixedTwoLevels).length;
      result.premultipliedRgbaFailures=entries.filter(item=>!item.metrics.withinFixedTwoPremultipliedRgbaLevels).length;
      result.opaqueRgbaFailures=entries.filter(item=>item.metrics.withinFixedTwoOpaqueLevels===false).length;
      lastReport={...(lastReport||{}),jointEndpoints:result};if(active===token)busy=false;present();
      status(result.complete?`联合表情端点完成：原始 RGBA ${result.rawFailures} 组超出固定≤2；完整数据保留。`:`联合检查未完成：${result.error}`,result.rawFailures||!result.complete?'warning':'');}
  }
  async function seamConvergence(){
    if(busy||!assets||!lastReport?.cases)return;
    const selected=selectFeatureSeamConvergenceCases(lastReport.cases);if(!selected.length)return;
    busy=true;controls();const active=++token,entries=[];let drawCalls=0;
    const result={complete:false,epsilons:[...FEATURE_CONVERGENCE_EPSILONS],pixelLimit:FEATURE_DIAGNOSTIC_PIXEL_LIMIT,renderCalls:0,
      selection:'Up to eight distinct seam+state cases ranked by max opaque/premultiplied difference. Original epsilon=1e-5 cases and failure fields remain unchanged.',entries};
    const measure=(head,state,art)=>{drawCalls++;draw(probe,head,state,art);return pixels(probe);};
    try{
      for(const item of selected){
        if(active!==token)throw new Error('用户停止接缝收敛检查。');
        const art=articulationFromState(item.state),center=measure(item.seam.center,item.state,art),samples=[];
        for(const epsilon of FEATURE_CONVERGENCE_EPSILONS){
          const points=featureSeamPointsAtEpsilon(item.seam,epsilon),a=measure(points.before,item.state,art),b=measure(points.after,item.state,art);
          samples.push({epsilon,headPoses:points,before:compareFeaturePixels(center,a),after:compareFeaturePixels(center,b),across:compareFeaturePixels(a,b)});
        }
        entries.push({seam:item.seam,state:item.state,score:item.score,originalCases:item.originalCases,samples});
        status(`接缝收敛补充：${item.seam.id}\n固定比较 1e-5、1e-6、1e-7；原检查与阈值不变。${drawCalls} / ${selected.length*7} 次绘制。`);
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      result.complete=true;
    }catch(error){result.error=error.message;}
    finally{result.renderCalls=drawCalls;lastReport={...(lastReport||{}),seamConvergence:result};if(active===token)busy=false;present();
      status(result.complete?'接缝收敛补充完成；请比较随 epsilon 缩小的原始、预乘和不透明差异，原始失败仍保留。':`收敛检查未完成：${result.error}`,result.complete?'':'warning');}
  }
  function startRecording(fps){
    if(typeof MediaRecorder!=='function'||typeof composite.captureStream!=='function')throw new Error('当前浏览器不支持 WebM；仍可导出 JSON 与 PNG。');
    const mimeType=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
    if(!mimeType)throw new Error('当前浏览器没有可用的 WebM 编码器。');
    const stream=composite.captureStream(fps),recorder=new MediaRecorder(stream,{mimeType}),session={recorder,stream,chunks:[],abort:false};recording=session;
    recorder.ondataavailable=event=>{if(event.data.size)session.chunks.push(event.data);};
    recorder.onerror=()=>{session.abort=true;status('录像编码失败；不会导出不完整视频。','error');stop(true);};
    recorder.onstop=()=>{stream.getTracks().forEach(track=>track.stop());if(recording===session)recording=null;
      if(!session.abort&&session.chunks.length)download(new Blob(session.chunks,{type:mimeType}),'short-hair-feature-actions.webm');};
    try{recorder.start(500);}catch(error){stream.getTracks().forEach(track=>track.stop());recording=null;throw error;}
  }
  function replay(record=false){
    if(busy||!assets)return;const fps=Number($('fd-fps').value),started=performance.now(),active=++token;
    let lastDraw=started-1000/fps,lastFrame=started,frames=0,artMotion=createArticulationMotion(),headMotion=createStudioPoseMotion();
    const measurements=[];busy=true;controls();$('fd-progress').max=8000;$('fd-progress').value=0;
    try{example();if(record)startRecording(fps);}catch(error){stop(true);status(error.message,'error');return;}
    status(`${record?'录制':'播放'}中：眨眼与眉形、张嘴与单眼动作并发，叠加呼吸／摆动／前发微动；来自真实 requestAnimationFrame 时间。`);
    const finish=(completed,error=null)=>{
      const elapsed=performance.now()-started;lastReport={...(lastReport||{}),playback:{complete:completed,requestedFps:fps,frames,elapsedMs:elapsed,
        measuredFps:frames>1?(frames-1)*1000/(measurements.at(-1).atMs-measurements[0].atMs):0,
        maxFrameGapMs:measurements.length?Math.max(...measurements.map(frame=>frame.dtMs)):null,
        averageDrawMs:measurements.length?measurements.reduce((sum,frame)=>sum+frame.drawMs,0)/frames:null,framesMeasured:measurements,error}};
      playbackFinish=null;stop(Boolean(error));present();status(error?`动作未完成：${error}`:`动作播放完成：${frames} 个实际绘制帧。请检查对照与录像；JSON 记录实际帧间隔。`,error?'error':'');
    };
    const frame=now=>{
      if(active!==token)return;if(document.hidden){finish(false,'页面隐藏，已停止');return;}
      const elapsed=now-started;if(elapsed>=8000){finish(true);return;}
      if(now-lastDraw<1000/fps-.5){raf=requestAnimationFrame(frame);return;}
      const dt=now-lastFrame,sample=featureActionSample(elapsed),begin=performance.now();
      const art=advanceArticulationMotion(targetArticulationMotion(artMotion,sample.state),dt);
      const pose=advanceStudioPoseMotion(targetStudioPoseMotion(headMotion,sample.headPose),dt,{mode:'turn'});
      try{
        draw(before,pose.headPose,art.state,art.articulation,false,sample.coefficients,sample.secondary);
        const displayed=draw(after,pose.headPose,art.state,art.articulation,true,sample.coefficients,sample.secondary);
        const actualArticulation=validateArticulation(displayed.articulation),actualSecondary=validateSecondaryFrame(displayed.secondary);
        artMotion=art.motion;headMotion=pose.motion;frames++;lastDraw=now;lastFrame=now;
        lastPairLabel=`${(elapsed/1000).toFixed(2)} s · yaw ${pose.headPose.yaw.toFixed(3)} · pitch ${pose.headPose.pitch.toFixed(3)} · 真实计时 ${fps} fps 请求`;
        refreshDetails(pose.headPose,art.state);compose();measurements.push({atMs:elapsed,dtMs:dt,drawMs:performance.now()-begin,headPose:pose.headPose,coefficients:{...sample.coefficients},articulation:actualArticulation,secondary:actualSecondary});
        $('fd-progress').value=elapsed;raf=requestAnimationFrame(frame);
      }catch(error){finish(false,error.message);}
    };
    playbackFinish=finish;raf=requestAnimationFrame(frame);
  }
  $('fd-load').addEventListener('click',()=>void load().catch(()=>{}));$('fd-run').addEventListener('click',()=>void run());
  $('fd-endpoint-check').addEventListener('click',()=>void endpointIsolation());
  $('fd-joint-check').addEventListener('click',()=>void jointEndpoints());$('fd-seam-check').addEventListener('click',()=>void seamConvergence());
  $('fd-crop-check').addEventListener('click',async()=>{
    if(busy||!assets)return;busy=true;controls();const entries=[],active=++token;
    try{
      for(const headPose of [{yaw:0,pitch:0},{yaw:-.45,pitch:-.4},{yaw:.4,pitch:.25},{yaw:.65,pitch:-.55}])for(const eye of ['open','half','closed']){
        if(active!==token||disposed)throw new Error('可见区域校验已停止。');
        const state=frameState(['eyeLeft','eyeRight'],eye),articulation=articulationFromState(state),secondary={breath:.2,sway:-.3,hair:.4};
        draw(probe,headPose,state,articulation,true,{},secondary,false);const cropped=pixels(probe);
        draw(reference,headPose,state,articulation,true,{},secondary,true);
        entries.push({headPose,eye,metrics:compareFeaturePixels(cropped,pixels(reference))});
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      lastReport={...(lastReport||{}),viewportRaster:{complete:true,renderCalls:24,entries,exact:entries.every(e=>e.metrics.exact)}};
      status(`可见区域校验完成：${entries.filter(e=>e.metrics.exact).length} / ${entries.length} 与全幅绘制像素完全一致。`);
    }catch(error){lastReport={...(lastReport||{}),viewportRaster:{complete:false,entries,error:error.message}};status(error.message,'error');}
    finally{busy=false;present();}
  });
  $('fd-compare').addEventListener('click',()=>{
    if(busy||!assets)return;
    try{
      const yaw=Number($('fd-yaw').value),pitch=Number($('fd-pitch').value),eye=$('fd-eye').value;
      if(![yaw,pitch].every(v=>Number.isFinite(v)&&v>=-1&&v<=1))throw new Error('yaw 和 pitch 需在 -1 至 1 之间。');
      const headPose={yaw,pitch},state=frameState(['eyeLeft','eyeRight'],eye),articulation=articulationFromState(state);
      draw(before,headPose,state,articulation,false);draw(after,headPose,state,articulation,true);
      lastPairLabel=`yaw ${yaw} · pitch ${pitch} · 双眼 ${eye} · 相同画稿与参数`;refreshDetails(headPose,state);compose();status(`已显示 ${lastPairLabel}。`);
    }catch(error){status(error.message,'error');}
  });
  $('fd-replay').addEventListener('click',()=>replay());$('fd-webm').addEventListener('click',()=>replay(true));
  $('fd-stop').addEventListener('click',()=>{if(playbackFinish)playbackFinish(false,'用户停止');else{stop(true);status('已停止；已完成的诊断记录可导出。');}});
  $('fd-json').addEventListener('click',()=>download(new Blob([JSON.stringify(lastReport,null,2)],{type:'application/json'}),'short-hair-feature-diagnostics.json'));
  $('fd-png').addEventListener('click',()=>compose().toBlob(blob=>download(blob,'short-hair-feature-comparison.png'),'image/png'));
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&busy){if(playbackFinish)playbackFinish(false,'页面隐藏');else{stop(true);status('页面已隐藏，诊断和录像已停止。');}}});
  window.addEventListener('pagehide',()=>{disposed=true;stop(true);assets?.flowRenderer?.dispose();assets?.fringeRenderer?.dispose();});controls();
}
if(typeof document!=='undefined')initializeFeatureDiagnostics();
