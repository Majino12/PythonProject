import {loadShortHairStudioAssets, renderShortHairStudio, selectShortHairStudioState} from './short-hair-studio-renderer.js';
import {loadExpressionAssets, drawExpression} from './expression-renderer.js';
import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';
import {gazeChannels} from './short-hair-studio-model.js';
import {StudioFrameClock, createStudioMotion, advanceStudioMotion} from './short-hair-studio-timing.js';

const $=selector=>document.querySelector(selector), pause=()=>new Promise(resolve=>setTimeout(resolve,0));
const eyes=['open','quarter','half','threeQuarter','closed'], jaws=['neutral','parted','openSmall','openMedium','openWide'];
const labels={open:'睁眼',quarter:'轻闭',half:'半闭',threeQuarter:'将闭',closed:'闭眼',neutral:'自然',parted:'微张',openSmall:'小张',openMedium:'中张',openWide:'大张'};
const extrema=[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
const families=[['front',()=>loadExpressionAssets({variant:'candidate'})],['side',()=>loadSideExpressionAssets('brows')],['pitch',()=>loadSideExpressionAssets('pitchBrows')],['complete',()=>loadSideExpressionAssets('completePitch')]];
const report={schemaVersion:1,version:'0.15.0',status:'loading',generatedAt:new Date().toISOString(),
  criteria:{pixels:'Exact native RGBA comparison; display CSS sizing is excluded.',stages:'Five real registered states per eye and jaw, distinct adjacent output pixels.',
    anchors:'Every jaw patch keeps the registered upper-lip destination and uses equal-size translation only; this does not evaluate lip anatomy.',
    gaze:'Center versus eight extreme inputs: no changed pixel outside the rasterized union of the current eye apertures; closed eyes remain identical.',
    legacy:'Independent frozen family loaders and renderers, using the same named old states. New coefficient thresholds intentionally select additional states.',
    timing:'Actual successful draw cadence; never RAF callback count, unique source count, camera inference, display presentation, or encoded video FPS.',
    visualApproval:'Not evaluated. No approval/feedback is written.'},
  poses:{},timing:{status:'not-run',runs:[]},summary:{passed:null,assertions:0,failedAssertions:0,pixelComparisons:0,failures:[]}};
let studio, selectedPose='front', timingToken=0, timingFrame=0, timingResolve=null;
const sheets=new Map();
function publish(){ $('#result').textContent=JSON.stringify(report,null,2); }
function check(pass,name,detail={}){report.summary.assertions++;if(!pass){report.summary.failedAssertions++;report.summary.failures.push({check:name,...detail});}}
function surface(){const canvas=document.createElement('canvas');return{canvas,context:canvas.getContext('2d',{willReadFrequently:true})};}
const actual=surface(), expected=surface(), maskSurface=surface();
function pixels(surface){return surface.context.getImageData(0,0,surface.canvas.width,surface.canvas.height).data;}
function difference(a,b,width,mask=null){
  if(a.length!==b.length)throw new Error('像素比较尺寸不同。');
  const aa=new Uint32Array(a.buffer,a.byteOffset,a.length/4),bb=new Uint32Array(b.buffer,b.byteOffset,b.length/4);
  let changed=0,outside=0,firstDifference=null;
  for(let index=0;index<aa.length;index++)if(aa[index]!==bb[index]){changed++;if(mask&&!mask[index*4+3])outside++;if(!firstDifference)firstDifference={x:index%width,y:Math.floor(index/width)};}
  report.summary.pixelComparisons++;return{changed,outside,firstDifference};
}
function contextFor(pose){const source=studio[pose.sourceFamily],record=pose.id==='front'?source.manifest:source.manifest.poses[pose.id];return{source,record,eyeMeta:pose.id==='front'?source.manifest.gaze.eyes:source.manifest.gaze.poses[pose.id].eyes};}
function neutral(pose){return selectShortHairStudioState(studio,pose.id,{},{}).targetState;}
function draw(pose,state,channels={},faceOnly=true,target=actual){return renderShortHairStudio(target.canvas,studio,pose.id,channels,{}, {faceOnly,stateOverride:state});}
function path(context,points){context.beginPath();points.forEach(([x,y],index)=>context[index?'lineTo':'moveTo'](x,y));context.closePath();}
function apertureMask(pose,state){
  const {source,eyeMeta}=contextFor(pose),{canvas,context}=maskSurface;
  canvas.width=source.manifest.width;canvas.height=source.manifest.height;
  for(const eye of ['eyeLeft','eyeRight']){const aperture=eyeMeta[eye].frames[state[eye]]?.aperture;if(aperture){path(context,aperture);context.fill();}}
  return pixels(maskSurface);
}
function makeCard(row,pose,state,label){
  const canvas=document.createElement('canvas');renderShortHairStudio(canvas,studio,pose.id,{}, {},{faceOnly:true,stateOverride:state});
  const figure=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=label;canvas.setAttribute('aria-label',`${pose.label} · ${label}`);figure.append(canvas,caption);row.append(figure);return canvas;
}
function buildSheets(){
  for(const pose of studio.poses){
    const option=document.createElement('option');option.value=pose.id;option.textContent=pose.label;$('#poseSelect').append(option);
    const section=document.createElement('section');section.className='pose-sheet';section.dataset.pose=pose.id;
    const heading=document.createElement('h2');heading.textContent=pose.label;section.append(heading);const rows=[];
    for(const [name,states] of [['眼睑',eyes],['张嘴',jaws]]){
      const title=document.createElement('h3');title.textContent=name;const row=document.createElement('div');row.className='row';section.append(title,row);
      rows.push(states.map(state=>makeCard(row,pose,{...neutral(pose),...(name==='眼睑'?{eyeLeft:state,eyeRight:state}:{mouth:state})},`${labels[state]} · ${state}`)));
    }
    sheets.set(pose.id,{section,rows});$('#sheets').append(section);
  }
  $('#poseSelect').value=selectedPose;$('#poseSelect').disabled=false;$('#downloadSheet').disabled=false;showPose();
}
function showPose(){
  selectedPose=$('#poseSelect').value;
  for(const [id,sheet]of sheets)sheet.section.hidden=!$('#showAll').checked&&id!==selectedPose;
  if(report.timing.status==='running')stopTiming('方向已切换；本次计时已取消。');
  const pose=studio.poses.find(item=>item.id===selectedPose);renderShortHairStudio($('#sequenceCanvas'),studio,pose.id,{},{});
}
function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function downloadSheet(){
  const {rows}=sheets.get(selectedPose),pose=studio.poses.find(item=>item.id===selectedPose),width=rows[0][0].width,height=rows[0][0].height;
  const sheet=document.createElement('canvas');sheet.width=width*5;sheet.height=(height+55)*2+65;const context=sheet.getContext('2d');
  context.fillStyle='#f2f4f7';context.fillRect(0,0,sheet.width,sheet.height);context.fillStyle='#253244';context.font='30px system-ui';context.fillText(`${pose.label} / ${pose.id} · five authored stages`,20,42);
  rows.forEach((row,ri)=>row.forEach((canvas,ci)=>{const y=65+ri*(height+55);context.drawImage(canvas,ci*width,y);context.fillText((ri?jaws:eyes)[ci],ci*width+16,y+height+36);}));
  sheet.toBlob(blob=>{if(blob)download(blob,`frame-art-${selectedPose}-five-stages.png`);},'image/png');
}
async function verifyPose(pose){
  const {record,eyeMeta}=contextFor(pose),base=neutral(pose),selection=selectShortHairStudioState(studio,pose.id,{},{});
  const result={stages:selection.availableSequences,distinct:[],anchors:[],gaze:[],legacy:[]};report.poses[pose.id]=result;
  for(const group of ['eyeLeft','eyeRight','mouth']){
    const sequence=group==='mouth'?jaws:eyes;check(JSON.stringify(selection.availableSequences[group])===JSON.stringify(sequence),'five-actual-stages',{pose:pose.id,group});
    let before=null;
    for(const state of sequence){
      const rendered=draw(pose,{...base,[group]:state});check(rendered.didDraw&&rendered.state[group]===state,'draws-requested-state',{pose:pose.id,group,state});
      const next=pixels(actual);if(before){const delta=difference(before,next,actual.canvas.width);result.distinct.push({group,state,...delta});check(delta.changed>0,'adjacent-paintings-distinct',{pose:pose.id,group,state,...delta});}before=next;
    }
  }
  for(const state of jaws.slice(1)){
    const patch=record.patches.mouth[state],anchor=patch?.anchor;
    const fixed=anchor?.kind==='upper-lip'&&JSON.stringify(anchor.destination)===JSON.stringify(record.mouthReference);
    const translated=patch?.transform==='translation-only'&&patch.rect.slice(2).every((value,index)=>value===patch.destination[index+2])
      &&anchor.source.every((value,index)=>value+patch.destination[index]-patch.rect[index]===anchor.destination[index]);
    result.anchors.push({state,reference:record.mouthReference,anchor,translationOnly:Boolean(translated)});
    check(fixed&&translated,'fixed-upper-lip-registration',{pose:pose.id,state});
  }
  for(const state of eyes){
    const displayed={...base,eyeLeft:state,eyeRight:state};draw(pose,displayed,{},false);const center=pixels(actual),mask=apertureMask(pose,displayed);
    if(state!=='closed')for(const eye of ['eyeLeft','eyeRight'])check(Boolean(eyeMeta[eye].frames[state]?.aperture),'registered-eye-aperture',{pose:pose.id,eye,state});
    for(const [x,y]of extrema){
      draw(pose,displayed,gazeChannels(x,y),false);const delta=difference(center,pixels(actual),actual.canvas.width,mask);result.gaze.push({state,x,y,...delta});
      check(delta.outside===0,'extreme-gaze-stays-in-aperture',{pose:pose.id,state,x,y,...delta});
      if(state==='closed')check(delta.changed===0,'closed-eye-gaze-is-inert',{pose:pose.id,x,y,...delta});
    }
    await pause();
  }
}
async function verifyLegacy(){
  for(const [family,load]of families){
    $('#summary').textContent=`正在与原有 ${family} 系列逐像素比较…`;const reference=await load();
    for(const pose of studio.poses.filter(item=>item.sourceFamily===family)){
      const base=neutral(pose),brows=pose.id==='front'?['up','down']:['innerUp','outerUp','down'];
      const cases=[...['open','half','closed'].flatMap(eye=>['neutral','openSmall','openWide'].map(mouth=>({id:`${eye}/${mouth}`,state:{...base,eyeLeft:eye,eyeRight:eye,mouth}}))),
        ...['pucker','press','shiftLeft','shiftRight'].map(mouth=>({id:mouth,state:{...base,mouth}})),
        ...brows.flatMap(brow=>['browLeft','browRight'].map(group=>({id:`${group}/${brow}`,state:{...base,[group]:brow}}))),
        ...extrema.map(([x,y])=>({id:`gaze/${x}/${y}`,state:{...base,eyeLeft:'half'},channels:gazeChannels(x,y)}))];
      for(const item of cases){
        const result=draw(pose,item.state,item.channels||{}),options={faceOnly:true,gaze:result.gaze};
        if(pose.id==='front')drawExpression(expected.canvas,reference,item.state,options);else drawSideExpression(expected.canvas,reference,pose.id,item.state,options);
        const dimensionsMatch=actual.canvas.width===expected.canvas.width&&actual.canvas.height===expected.canvas.height;
        const delta=dimensionsMatch?difference(pixels(actual),pixels(expected),actual.canvas.width):{changed:null};
        report.poses[pose.id].legacy.push({id:item.id,dimensionsMatch,...delta});check(dimensionsMatch&&delta.changed===0,'legacy-named-state-exact',{pose:pose.id,scenario:item.id,...delta});
      }
      // Full-image neutral comparison also protects the body, hair and background.
      const result=draw(pose,base,{},false);if(pose.id==='front')drawExpression(expected.canvas,reference,base,{faceOnly:false,gaze:result.gaze});else drawSideExpression(expected.canvas,reference,pose.id,base,{faceOnly:false,gaze:result.gaze});
      const delta=difference(pixels(actual),pixels(expected),actual.canvas.width);check(delta.changed===0,'legacy-full-neutral-exact',{pose:pose.id,...delta});
      await pause();publish();
    }
  }
}
function stopTiming(message='计时已停止。'){
  timingToken++;cancelAnimationFrame(timingFrame);timingFrame=0;timingResolve?.(null);timingResolve=null;
  if(report.timing.status==='running')report.timing.status='cancelled';$('#stopTiming').disabled=true;$('#runTiming').disabled=!studio;$('#timingReadout').textContent=message;publish();
}
function runRate(fps,token){
  return new Promise(resolve=>{
    timingResolve=resolve;const pose=studio.poses.find(item=>item.id===selectedPose),clock=new StudioFrameClock({targetFps:fps});
    const initial=selectShortHairStudioState(studio,pose.id,{},{}),trace=[{elapsedMs:0,state:initial.targetState}],canvas=$('#sequenceCanvas');
    let motion=createStudioMotion(initial.targetState),previousTarget=initial.targetState,start=null;
    renderShortHairStudio(canvas,studio,pose.id,{}, {},{stateOverride:initial.targetState});
    const tick=now=>{
      timingFrame=0;if(token!==timingToken||document.hidden){resolve(null);return;}if(start===null)start=now;
      const elapsed=now-start,frame=clock.advance(now);
      if(frame.render){
        const active=Math.floor(elapsed/600)%2===0,channels=active?{eyeBlinkLeft:1,eyeBlinkRight:1,jawOpen:1}:{};
        const selected=selectShortHairStudioState(studio,pose.id,channels,previousTarget),proposed=advanceStudioMotion(motion,selected.targetState,frame.dt*1000,selected.availableSequences),began=performance.now();
        try{
          const result=renderShortHairStudio(canvas,studio,pose.id,channels,previousTarget,{stateOverride:proposed.frameState});
          if(result.didDraw){motion=proposed.motion;previousTarget=selected.targetState;clock.recordFrame(now,performance.now()-began);
            if(JSON.stringify(trace.at(-1).state)!==JSON.stringify(result.state))trace.push({elapsedMs:Math.round(elapsed),state:result.state});}
        }catch(error){timingResolve=null;resolve({targetFps:fps,error:error.message,trace});return;}
        if(frame.updateUi){const stats=clock.snapshot(now);$('#timingReadout').textContent=`请求 ${fps} fps · ${stats.measuredFps===null?'正在测量…':`实测 ${stats.measuredFps.toFixed(1)} fps`} · ${(elapsed/1000).toFixed(1)} / 2.5 秒`;}
      }
      if(elapsed>=2500){timingResolve=null;resolve({...clock.snapshot(now),poseId:pose.id,trace});return;}
      timingFrame=requestAnimationFrame(tick);
    };timingFrame=requestAnimationFrame(tick);
  });
}
async function runTiming(){
  stopTiming();const token=++timingToken;report.timing={status:'running',runs:[]};$('#runTiming').disabled=true;$('#stopTiming').disabled=false;publish();
  for(const fps of [60,30]){
    const result=await runRate(fps,token);if(!result||token!==timingToken)return;
    const lanes={};for(const group of ['eyeLeft','eyeRight','mouth']){
      const sequence=group==='mouth'?jaws:eyes,visited=[...new Set(result.trace.map(item=>item.state[group]))];
      const steps=result.trace.map(item=>sequence.indexOf(item.state[group]));lanes[group]={visited,allStagesVisited:sequence.every(state=>visited.includes(state)),noSkippedStage:steps.every((step,index)=>index===0||Math.abs(step-steps[index-1])<=1)};
    }
    report.timing.runs.push({...result,lanes,passed:!result.error&&Object.values(lanes).every(lane=>lane.allStagesVisited&&lane.noSkippedStage)});publish();
  }
  report.timing.status='complete';report.timing.passed=report.timing.runs.every(run=>run.passed);$('#runTiming').disabled=false;$('#stopTiming').disabled=true;
  $('#timingReadout').textContent=report.timing.runs.map(run=>`${run.targetFps} 请求 → ${Number.isFinite(run.measuredFps)?run.measuredFps.toFixed(1):'未测得'} fps`).join('；');publish();
}
$('#poseSelect').addEventListener('change',showPose);$('#showAll').addEventListener('change',showPose);$('#downloadSheet').addEventListener('click',downloadSheet);
$('#downloadReport').addEventListener('click',()=>download(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'frame-motion-checks.json'));
$('#runTiming').addEventListener('click',runTiming);$('#stopTiming').addEventListener('click',()=>stopTiming());
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopTiming('页面已隐藏，计时已取消。');});window.addEventListener('pagehide',()=>stopTiming());
try{
  studio=await loadShortHairStudioAssets();report.status='running';
  for(const pose of studio.poses){$('#summary').textContent=`正在检查 ${pose.label} 的实际档位、上唇锚点与极端视线…`;await verifyPose(pose);publish();}
  await verifyLegacy();buildSheets();report.status='complete';report.summary.passed=report.summary.failedAssertions===0;
  $('#summary').dataset.state=report.summary.passed?'passed':'failed';$('#summary').textContent=`九个方向 · ${report.summary.pixelComparisons} 次原生像素比较 · ${report.summary.assertions} 项断言 · ${report.summary.failedAssertions} 项未通过。计时诊断需点击下方运行。`;
  $('#runTiming').disabled=false;$('#downloadReport').disabled=false;publish();
}catch(error){report.status='error';report.error={message:error.message,stack:error.stack};$('#summary').dataset.state='failed';$('#summary').textContent=`检查未完成：${error.message}`;$('#downloadReport').disabled=false;publish();}
