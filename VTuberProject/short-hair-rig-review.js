import {loadShortHairStudioAssets,renderShortHairStudio,getStudioPaintStates} from './short-hair-studio-renderer.js';
import {loadShortHairAlphaAssets,applyShortHairAlpha} from './short-hair-alpha.js';
import {loadShortHairFringeAssets} from './short-hair-fringe-assets.js';
import {ShortHairFringeRenderer} from './short-hair-fringe-renderer.js';
import {deformHairMesh} from './short-hair-mesh-model.js';
import {loadShortHairMotionFields} from './short-hair-motion-fields.js';
import {ShortHairFlowRenderer} from './short-hair-flow-renderer.js';
import {renderContinuousShortHairStudio,validateContinuousShortHairSources} from './short-hair-continuous-renderer.js';
import {locateHeadTriangle} from './short-hair-continuous-model.js';
import {nearestStudioPoseId} from './short-hair-pose-motion.js';
import {drawOutputFrame} from './short-hair-studio-output-model.js';

const WIDTH=1122,HEIGHT=1402;
const EXPRESSIONS=Object.freeze({neutral:{},blink:{eyeBlinkLeft:1,eyeBlinkRight:1,browInnerUp:1,jawOpen:1},asymmetric:{eyeBlinkLeft:1,browDownLeft:1,browDownRight:1,jawOpen:.4,eyeLookOutRight:.8,eyeLookInLeft:.8}});
const makeCanvas=(width=WIDTH,height=HEIGHT)=>{const c=document.createElement('canvas');c.width=width;c.height=height;return c;};
const rgba=source=>{const c=makeCanvas(source.width,source.height),g=c.getContext('2d',{willReadFrequently:true});g.drawImage(source,0,0);return g.getImageData(0,0,c.width,c.height).data;};
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const yieldFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const materialOf=p=>({ownership:p.ownership,weight:p.weight,underpaint:p.underpaint,signature:p.signature});

/** Compare exact stored RGBA; alpha is checked independently of tolerance. */
export function compareRigPixels(actual,expected,{mask=null,tolerance=0}={}){
 if(!actual?.length||actual.length!==expected?.length||actual.length%4||mask&&mask.length!==actual.length)throw new Error('像素尺寸不一致。');
 if(!Number.isFinite(tolerance)||tolerance<0)throw new Error('像素容差无效。');
 let maxError=0,overTolerance=0,alphaMismatch=0,comparedPixels=0;
 for(let k=0;k<actual.length;k+=4){if(mask&&!mask[k+3])continue;comparedPixels++;let bad=false;
  for(let ch=0;ch<4;ch++){const error=Math.abs(actual[k+ch]-expected[k+ch]);maxError=Math.max(maxError,error);bad||=error>tolerance;}
  if(bad)overTolerance++;if(actual[k+3]!==expected[k+3])alphaMismatch++;
 }
 return {maxError,overTolerance,alphaMismatch,comparedPixels};
}
function protectedMask(binding){
 const c=makeCanvas(),g=c.getContext('2d');g.fillStyle='#fff';
 for(const region of binding.protectedRegions){
  if(region.rect){g.fillRect(...region.rect);continue;}
  g.beginPath();region.polygon.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.closePath();g.fill();
 }
 return rgba(c);
}
function baseOf(source,pose){const c=makeCanvas(),g=c.getContext('2d');g.drawImage(source,0,0);g.drawImage(pose.weightedUnderpaint,0,0);return c;}
function paint(assets,alpha,poseId,expression,{source=makeCanvas(),stateOverride}={}){
 const options={faceOnly:false};if(stateOverride)options.stateOverride=stateOverride;
 const state=renderShortHairStudio(source,assets,poseId,EXPRESSIONS[expression],{},options);
 applyShortHairAlpha(source,alpha,poseId);return {source,state};
}
async function actualFile(record){
 const response=await fetch(record.path,{cache:'no-store'});if(!response.ok)throw new Error(`无法读取 ${record.path}`);
 const bytes=await response.arrayBuffer(),actualSha256=await hash(bytes);
 return {path:record.path,bytes:bytes.byteLength,expectedSha256:record.sha256,actualSha256,matched:actualSha256===record.sha256};
}
function sourceIdentity(studio,alpha,fringe,poseId){
 const descriptor=studio.poses.find(p=>p.id===poseId),family=studio[descriptor.sourceFamily];
 const record=poseId==='front'?family.manifest:family.manifest.poses[poseId],path=family.manifest.sources[record.reference].src;
 const registered=fringe.manifest.poses[poseId],matte=alpha.manifest.poses[poseId];
 if(path!==registered.source.path||path!==matte.source||registered.source.sha256!==matte.sourceSha256||registered.alphaSha256!==matte.matteSha256)throw new Error(`${poseId} 当前画稿与分层/透明遮罩不对应。`);
 return {registered,matte};
}

async function runRigFlowDiagnostics({studio,alpha,fringe,fringeRenderer,check,report,onProgress}){
 const motionFields=await loadShortHairMotionFields();validateContinuousShortHairSources(studio,alpha,motionFields,fringe);
 let flowRenderer,lastCall;const onLeave=()=>flowRenderer?.dispose();globalThis.addEventListener?.('pagehide',onLeave,{once:true});
 try{
  flowRenderer=new ShortHairFlowRenderer(motionFields);const directFlow=flowRenderer.render.bind(flowRenderer);
  flowRenderer.render=(vertices,sources,signatures,secondary)=>{lastCall={vertices,sources:[...sources],signatures:[...signatures],secondary:{...secondary}};return directFlow(vertices,sources,signatures,secondary);};
  const assets={...studio,alpha,fringe,motionFields,flowRenderer,fringeRenderer,continuousBuffers:new Map()},canvas=makeCanvas();
  const headPoses=[{yaw:.37,pitch:.22},{yaw:-.36,pitch:.48},{yaw:.43,pitch:-.29}],secondary={breath:.4,sway:-.2,hair:.8};
  report.integration={status:'running',headPoses,flowModel:motionFields.manifest.model,outputs:[1280,720],cases:[]};
  const render=(headPose,expression,extra={})=>renderContinuousShortHairStudio(canvas,assets,nearestStudioPoseId(headPose),EXPRESSIONS[expression],{},{headPose,faceOnly:false,transparent:true,secondary,...extra});
  for(let index=0;index<headPoses.length;index++){
   const headPose=headPoses[index],label=`blend:${headPose.yaw},${headPose.pitch}`;onProgress(`检查连续转头 ${index+1}/3：三源合成与透明输出…`);await yieldFrame();
   render(headPose,'neutral',{secondary:{...secondary,hair:0}});const resting=rgba(canvas);
   const start=performance.now(),result=render(headPose,'neutral'),elapsedMs=performance.now()-start,actual=rgba(canvas),call=lastCall;
   const active=locateHeadTriangle(headPose).vertices.filter(v=>v.weight>0),sourceCanvases=active.map(v=>fringeRenderer.buffers.get(v.poseId)?.front);
   check(null,`${label}:independent-pose-buffers`,result.didDraw===true&&call.sources.length===3&&new Set(call.sources).size===3&&sourceCanvases.every((source,i)=>source===call.sources[i]),{poses:call.vertices.map(v=>v.poseId),weights:call.vertices.map(v=>v.weight)});
   check(null,`${label}:hair-deformed-once`,call.secondary.hair===0&&call.secondary.breath===secondary.breath&&call.secondary.sway===secondary.sway,{flowSecondary:call.secondary});
   const effect=compareRigPixels(actual,resting,{tolerance:2});
   check(null,`${label}:visible-fringe-motion`,effect.overTolerance>0,{pixelsOverTwoBytes:effect.overTolerance,maxError:effect.maxError});
   const repeat=render(headPose,'neutral'),deterministic=compareRigPixels(rgba(canvas),actual);
   check(null,`${label}:deterministic`,repeat.didDraw===true&&deterministic.maxError===0,deterministic);

   // Independent assembly of the same triangle: fresh authored expression
   // buffers -> per-pose fringe -> RIFE. This catches ordering/aliasing errors
   // in the continuous orchestration, rather than reusing its cached inputs.
   const vertices=locateHeadTriangle(headPose).vertices,manualSources=[],manualSignatures=[];
   for(const vertex of vertices){
    const {source}=paint(studio,alpha,vertex.poseId,'neutral'),signature=`manual:${index}:${vertex.poseId}`;
    const assembled=fringeRenderer.render(source,vertex.poseId,{x:secondary.hair,y:.18*secondary.hair},{signature});if(!assembled)throw new Error('独立三源前发组装失败。');
    manualSources.push(assembled);manualSignatures.push(signature);
   }
   const expected=directFlow(vertices,manualSources,manualSignatures,{...secondary,hair:0});if(!expected)throw new Error('独立 RIFE 组装失败。');
   const oracle=compareRigPixels(rgba(expected),actual);
   check(null,`${label}:independent-fringe-before-rife`,oracle.maxError===0,oracle);

   render(headPose,'blink');const dynamic=rgba(canvas),changed=compareRigPixels(dynamic,actual,{tolerance:2});
   check(null,`${label}:current-painted-expression-survives`,changed.overTolerance>100,{pixelsOverTwoBytes:changed.overTolerance,maxError:changed.maxError});
   render(headPose,'neutral');const recovered=compareRigPixels(rgba(canvas),actual);
   check(null,`${label}:neutral-restored-after-expression`,recovered.maxError===0,recovered);

   const output=makeCanvas(1280,720),expectedOutput=makeCanvas(1280,720),composition={scale:.75,x:.2,y:-.1,mirror:true};
   const oc=output.getContext('2d');oc.fillStyle='red';oc.fillRect(0,0,1280,720);drawOutputFrame(output,canvas,{transparent:true,composition});
   const out=rgba(output),corners=[0,1279,719*1280,720*1280-1].map(i=>out[i*4+3]);
   check(null,`${label}:transparent-output-clears-previous-frame`,corners.every(a=>a===0),{size:[1280,720],cornerAlpha:corners});
   const ec=expectedOutput.getContext('2d'),fit=Math.min(1280/WIDTH,720/HEIGHT)*.75;
   ec.save();ec.translate(1280*.6,720*.45);ec.scale(-1,1);ec.drawImage(canvas,-WIDTH*fit/2,-HEIGHT*fit/2,WIDTH*fit,HEIGHT*fit);ec.restore();
   const outputDiff=compareRigPixels(out,rgba(expectedOutput));check(null,`${label}:output-scale-position-mirror`,outputDiff.maxError===0,outputDiff);
   report.integration.cases.push({headPose,renderMs:Number(elapsedMs.toFixed(3)),rgbaSha256:await hash(actual),outputRgbaSha256:await hash(out)});
  }
  report.integration.status=report.checks.filter(c=>c.name.startsWith('blend:')).every(c=>c.passed)?'passed':'failed';
 }finally{globalThis.removeEventListener?.('pagehide',onLeave);flowRenderer?.dispose();}
}

/** Actual artwork, actual current-expression painter, and real WebGL material.
 * Each nonzero result is read before the renderer can reuse its output buffer. */
export async function runRegisteredRigDiagnostics({studio,alpha,fringe,onProgress=()=>{}}){
 const report={schemaVersion:1,kind:'short-hair-rig-browser-validation',version:'0.20.0',status:'running',startedAt:new Date().toISOString(),assetStatus:fringe.manifest.status,poses:[],checks:[],limitations:['Technical checks do not approve segmentation or hidden artwork.','Only registered poses are tested; unregistered directions are not claimed.','Performance is a local diagnostic sample, not an OBS or end-to-end tracking benchmark.']};
 const check=(poseId,name,passed,details={})=>report.checks.push({poseId,name,passed,...details});let renderer;
 const onLeave=()=>renderer?.dispose();globalThis.addEventListener?.('pagehide',onLeave,{once:true});
 try{
  renderer=new ShortHairFringeRenderer(fringe);
  for(const poseId of Object.keys(fringe.poses)){
   onProgress(`检查 ${poseId}：校验原画与分层文件…`);await yieldFrame();
   const pose=fringe.poses[poseId],{registered,matte}=sourceIdentity(studio,alpha,fringe,poseId);
   const files=await Promise.all([actualFile(registered.source),actualFile({path:matte.matte,sha256:matte.matteSha256}),...['ownership','weight','underpaint','hairOwnership'].map(key=>actualFile(registered[key]))]);
   const poseReport={poseId,files,bindingSha256:await hash(new TextEncoder().encode(JSON.stringify(registered.binding))),runtimeValidated:pose.binding.runtimeValidated,vertices:pose.binding.positions.length/2,triangles:pose.binding.triangles.length/3,expressions:[],performance:[]};report.poses.push(poseReport);
   check(poseId,'actual-files-match-registered-sha256',files.every(f=>f.matched),{files:files.length});
   const guard=protectedMask(pose.binding),dynamicSource=makeCanvas();
   for(const expression of Object.keys(EXPRESSIONS)){
    onProgress(`检查 ${poseId}：${expression} 表情、零位和前发极限…`);await yieldFrame();
    const {source,state}=paint(studio,alpha,poseId,expression,{source:dynamicSource}),original=rgba(source),signature=`rig:${poseId}:${expression}`;
    poseReport.expressions.push({id:expression,state:state.state,gaze:state.gaze,sourceRgbaSha256:await hash(original)});
    const rest=renderer.render(source,poseId,{x:0,y:0},{signature}),restDiff=compareRigPixels(rgba(rest),original);
    check(poseId,`${expression}:zero-exact-source`,rest===source&&restDiff.maxError===0,restDiff);
    const epsilon=renderer.render(source,poseId,{x:1e-6,y:0},{signature});if(!epsilon)throw new Error('前发图形上下文未完成绘制。');
    const epsilonDiff=compareRigPixels(rgba(epsilon),original,{tolerance:2});
    check(poseId,`${expression}:epsilon-current-expression-reconstruction`,epsilon!==source&&epsilonDiff.overTolerance===0,{...epsilonDiff,realShaderPath:epsilon!==source});
    for(const [name,control]of [['negative',{x:-1,y:-.18}],['positive',{x:1,y:.18}]]){
     const started=performance.now(),composite=renderer.render(source,poseId,control,{signature});if(!composite)throw new Error('极限位置未生成画面。');
     const renderMs=performance.now()-started,pixels=rgba(composite);poseReport.performance.push({expression,control:name,renderMs:Number(renderMs.toFixed(3)),renderAndReadbackMs:Number((performance.now()-started).toFixed(3))});
     const protectedDiff=compareRigPixels(pixels,original,{mask:guard,tolerance:2}),allDiff=compareRigPixels(pixels,original),frame=deformHairMesh(pose.binding,control);
     check(poseId,`${expression}:${name}:protected-eyes-brows`,protectedDiff.overTolerance===0,protectedDiff);
     check(poseId,`${expression}:${name}:outer-alpha-unchanged`,allDiff.alphaMismatch===0,{alphaMismatch:allDiff.alphaMismatch});
     check(poseId,`${expression}:${name}:bounded-no-folds`,frame.maxDisplacementPx<=Math.hypot(pose.binding.travel.x,pose.binding.travel.y)+1e-6&&frame.minimumAreaRatio>=.25,{maxDisplacementPx:frame.maxDisplacementPx,minimumAreaRatio:frame.minimumAreaRatio});
     const changed=compareRigPixels(pixels,original,{tolerance:2});check(poseId,`${expression}:${name}:visible-fringe-motion`,changed.overTolerance>0,{pixelsOverTwoBytes:changed.overTolerance,maxError:changed.maxError});
    }
   }
   // Every authored aperture/jaw step passes through the SAME mutable source
   // canvas; signatures, rather than canvas identity, must refresh D textures.
   const neutral=paint(studio,alpha,poseId,'neutral',{source:dynamicSource}).state.state,sequences=getStudioPaintStates(studio,poseId);
   poseReport.paintCoverage={eyes:sequences.eyes,mouth:sequences.mouth,mutableSourceReused:true};
   const cases=[...sequences.eyes.map(state=>({id:`eyes:${state}`,state:{...neutral,eyeLeft:state,eyeRight:state}})),...sequences.mouth.map(state=>({id:`mouth:${state}`,state:{...neutral,mouth:state}}))];
   check(poseId,'five-authored-eye-and-jaw-steps-available',sequences.eyes.length===5&&sequences.mouth.length===5,{eyes:sequences.eyes,mouth:sequences.mouth});
   for(const sample of cases){
    onProgress(`检查 ${poseId}：逐档画稿 ${sample.id}…`);await yieldFrame();
    const {source,state}=paint(studio,alpha,poseId,'neutral',{source:dynamicSource,stateOverride:sample.state}),original=rgba(source),signature=`rig:${poseId}:${sample.id}`;
    const epsilon=renderer.render(source,poseId,{x:1e-6,y:0},{signature});if(!epsilon)throw new Error('逐档画稿网格未绘制。');
    const epsilonDiff=compareRigPixels(rgba(epsilon),original,{tolerance:2});let maximumGuardError=0,guardFailures=0,alphaMismatch=0;
    for(const control of [{x:-1,y:-.18},{x:1,y:.18}]){
     const moved=renderer.render(source,poseId,control,{signature});if(!moved)throw new Error('逐档画稿极限位置未绘制。');
     const data=rgba(moved),guardDiff=compareRigPixels(data,original,{mask:guard,tolerance:2});
     maximumGuardError=Math.max(maximumGuardError,guardDiff.maxError);guardFailures+=guardDiff.overTolerance;alphaMismatch+=compareRigPixels(data,original).alphaMismatch;
    }
    check(poseId,`authored-step:${sample.id}`,epsilon!==source&&epsilonDiff.overTolerance===0&&guardFailures===0&&alphaMismatch===0,{state:state.state,epsilonMaxError:epsilonDiff.maxError,maximumGuardError,guardFailures,alphaMismatch});
   }
   const {source}=paint(studio,alpha,poseId,'neutral',{source:dynamicSource}),original=rgba(source);
   for(const x of [-1,1])for(const y of [-1,1]){
    const controls={x,y},result=renderer.render(source,poseId,controls,{signature:`rig:${poseId}:corners`});if(!result)throw new Error('控制角未绘制。');
    const pixels=rgba(result),guardDiff=compareRigPixels(pixels,original,{mask:guard,tolerance:2}),allDiff=compareRigPixels(pixels,original),frame=deformHairMesh(pose.binding,controls);
    check(poseId,`corner:${x},${y}:protected-eyes-brows`,guardDiff.overTolerance===0,guardDiff);
    check(poseId,`corner:${x},${y}:outer-alpha-unchanged`,allDiff.alphaMismatch===0,{alphaMismatch:allDiff.alphaMismatch});
    check(poseId,`corner:${x},${y}:bounded-no-folds`,frame.maxDisplacementPx<=Math.hypot(pose.binding.travel.x,pose.binding.travel.y)+1e-6&&frame.minimumAreaRatio>=.25,{maxDisplacementPx:frame.maxDisplacementPx,minimumAreaRatio:frame.minimumAreaRatio});
   }
   const samples=[];
   for(let i=0;i<10;i++){const start=performance.now();renderer.render(source,poseId,{x:(i%2?-1:1)*(.1+i*.08),y:0},{signature:`rig:${poseId}:timing`});if(i>1)samples.push(performance.now()-start);}
   samples.sort((a,b)=>a-b);poseReport.warmRenderTiming={samples:samples.length,meanMs:Number((samples.reduce((a,b)=>a+b,0)/samples.length).toFixed(3)),p50Ms:Number(samples[Math.floor(samples.length/2)].toFixed(3)),p95Ms:Number(samples.at(-1).toFixed(3)),scope:'CPU submission and native canvas assembly; texture cache warm; no readback, no tracking/OBS'};
  }
  if(Object.keys(fringe.poses).length===9){onProgress('检查前发、RIFE 三源连续画面和直播画面输出…');await yieldFrame();await runRigFlowDiagnostics({studio,alpha,fringe,fringeRenderer:renderer,check,report,onProgress});}
  else report.integration={status:'not-run',reason:'Requires all nine registered directions; this front/subset report makes no RIFE/output acceptance claim.'};
 }catch(error){check(null,'completed-without-runtime-error',false,{error:error.message});}
 finally{globalThis.removeEventListener?.('pagehide',onLeave);renderer?.dispose();}
 const passed=report.checks.filter(c=>c.passed).length;report.summary={poses:report.poses.length,checks:report.checks.length,passed,failed:report.checks.length-passed};report.status=report.summary.failed?'failed':'passed';report.finishedAt=new Date().toISOString();return report;
}

let session,lastReport,painted,paintKey,closed=false;
function drawMesh(g,binding,control){
 const frame=deformHairMesh(binding,control),p=frame.positions;g.lineWidth=.75;g.strokeStyle='rgba(0,168,190,.6)';g.beginPath();
 for(let i=0;i<binding.triangles.length;i+=3){const [a,b,c]=binding.triangles.slice(i,i+3);g.moveTo(p[a*2],p[a*2+1]);g.lineTo(p[b*2],p[b*2+1]);g.lineTo(p[c*2],p[c*2+1]);g.closePath();}g.stroke();
 g.fillStyle='rgba(246,146,26,.2)';g.strokeStyle='#c66b16';g.lineWidth=2;
 for(const region of binding.protectedRegions){g.beginPath();if(region.rect)g.rect(...region.rect);else{region.polygon.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.closePath();}g.fill();g.stroke();}
 g.strokeStyle='#9b22be';g.lineWidth=3;g.beginPath();binding.rootLine.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.stroke();
}
function updatePreview(){
 if(!session)return;const $=id=>document.getElementById(id),poseId=$('pose').value,expression=$('expression').value,view=$('view').value;
 const controls={x:Number($('x').value),y:Number($('y').value)};for(const axis of ['x','y'])$(`${axis}-value`).textContent=controls[axis].toFixed(2);
 const key=`${poseId}:${expression}`;if(paintKey!==key){painted=paint(session.studio,session.alpha,poseId,expression);paintKey=key;}
 const source=painted.source,pose=session.fringe.poses[poseId],g=$('preview').getContext('2d');let shown=source;
 if(view==='base')shown=baseOf(source,pose);
 else if(view==='foreground')shown=session.renderer.meshRenderer.render(source,pose.binding,controls.x||controls.y?controls:{x:1e-6,y:0},{signature:key,material:materialOf(pose)});
 else if(view!=='source')shown=session.renderer.render(source,poseId,controls,{signature:key});
 if(!shown)throw new Error('图形上下文正在恢复，预览保留上一帧。');g.clearRect(0,0,WIDTH,HEIGHT);g.drawImage(shown,0,0);if(view==='mesh')drawMesh(g,pose.binding,controls);
 $('view-note').textContent=view==='foreground'?'单独查看前发与接触阴影。归零时以极小非零位移显示分解层；完整合成归零仍直接使用原画。':view==='mesh'?'青色：三角网格；紫色：固定发根；橙色：五官保护区。位移受已补画范围限制。':view==='base'?'底图包含生成的隐区补画，仅供分层检查；完整画面会盖回当前表情和前发。':'完整合成归零使用当前表情原画的原始像素路径。';
}
const ui=typeof document!=='undefined'&&document.body?.dataset.rigReview==='registered';
if(ui){
 const $=id=>document.getElementById(id),controls=['pose','expression','view','x','y','reset','run'];
 const error=e=>{$('status').textContent=`检查未完成：${e.message}`;$('report').textContent=JSON.stringify({status:'failed',error:e.message},null,2);};
 for(const id of ['pose','expression','view','x','y'])$(id).addEventListener('input',()=>{try{updatePreview();}catch(e){error(e);}});
 $('reset').addEventListener('click',()=>{$('x').value=$('y').value='0';updatePreview();});
 $('run').addEventListener('click',async()=>{
  controls.forEach(id=>$(id).disabled=true);$('report').textContent=JSON.stringify({status:'running'});
  try{lastReport=await runRegisteredRigDiagnostics({...session,onProgress:text=>$('status').textContent=text});$('report').textContent=JSON.stringify(lastReport,null,2);$('status').textContent=`${lastReport.status==='passed'?'通过':'未通过'}：${lastReport.summary.passed}/${lastReport.summary.checks} 项，${lastReport.summary.poses} 个方向。`;$('download').disabled=false;}
  catch(e){error(e);}finally{controls.forEach(id=>$(id).disabled=false);updatePreview();}
 });
 $('download').addEventListener('click',()=>{if(!lastReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(lastReport,null,2)+'\n'],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='v0.20-rig-browser-validation.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
 $('native-pixels').addEventListener('change',()=>{$('preview').style.width=$('native-pixels').checked?`${WIDTH}px`:'100%';$('preview').parentElement.style.overflow=$('native-pixels').checked?'auto':'hidden';});
 $('save-view').addEventListener('click',()=>{$('preview').toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`rig-${$('pose').value}-${$('expression').value}-${$('view').value}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/png');});
 window.addEventListener('pagehide',()=>{closed=true;session?.renderer.dispose();session=null;},{once:true});
 Promise.all([loadShortHairStudioAssets(),loadShortHairAlphaAssets(),loadShortHairFringeAssets()]).then(([studio,alpha,fringe])=>{
  if(closed)return;
  for(const id of Object.keys(fringe.poses))sourceIdentity(studio,alpha,fringe,id);
  session={studio,alpha,fringe,renderer:new ShortHairFringeRenderer(fringe)};
  for(const id of Object.keys(fringe.poses)){const option=document.createElement('option');option.value=id;option.textContent=studio.poses.find(p=>p.id===id)?.label||id;$('pose').append(option);}
  controls.forEach(id=>$(id).disabled=false);$('save-view').disabled=false;$('status').textContent=`已载入 ${Object.keys(fringe.poses).length} 个已登记方向。`;$('report').textContent=JSON.stringify({status:'ready',poses:Object.keys(fringe.poses)},null,2);updatePreview();
 }).catch(error);
}
