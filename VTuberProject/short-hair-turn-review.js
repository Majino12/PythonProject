import {poseHeadCoordinates,validateHeadPose} from './short-hair-pose-motion.js';

const distance=(a,b)=>Math.hypot(a.yaw-b.yaw,a.pitch-b.pitch);
const same=(a,b)=>a.yaw===b.yaw&&a.pitch===b.pitch;

/** These samples are completed studio draws, not requested RAF callbacks.
 * Cadence is reported separately: small pose steps cannot prove a fast device. */
export function summarizeTurnSamples(samples,{goal,maxStep=.121,minIntermediate=8}={}){
  validateHeadPose(goal);
  if(!Array.isArray(samples)||samples.length<2)throw new Error('转头验收至少需要两次实际绘制。');
  for(let i=0;i<samples.length;i++){
    validateHeadPose(samples[i].headPose);
    if(!Number.isFinite(samples[i].at)||!Number.isFinite(samples[i].costMs)||samples[i].costMs<0
      ||i>0&&samples[i].at<samples[i-1].at)throw new Error('转头采样时间或绘制耗时无效。');
  }
  const steps=samples.slice(1).map((sample,i)=>distance(sample.headPose,samples[i].headPose));
  const intervals=samples.slice(1).map((sample,i)=>sample.at-samples[i].at).filter(value=>value>0);
  const intermediate=new Set(samples.filter(sample=>!same(sample.headPose,samples[0].headPose)&&!same(sample.headPose,goal))
    .map(sample=>`${sample.headPose.yaw.toFixed(7)},${sample.headPose.pitch.toFixed(7)}`));
  const span=samples.at(-1).at-samples[0].at;
  const largestStep=Math.max(...steps),endpointExact=same(samples.at(-1).headPose,goal);
  const costs=samples.map(sample=>sample.costMs).sort((a,b)=>a-b),sortedIntervals=[...intervals].sort((a,b)=>a-b);
  const percentile=(values,fraction)=>values.length?values[Math.min(values.length-1,Math.ceil(values.length*fraction)-1)]:null;
  const checks=[{name:'bounded-presented-step',passed:largestStep<=maxStep,actual:largestStep,limit:maxStep},
    {name:'distinct-intermediate-poses',passed:intermediate.size>=minIntermediate,actual:intermediate.size,minimum:minIntermediate},
    {name:'exact-final-pose',passed:endpointExact}];
  return {passed:checks.every(check=>check.passed),checks,completedDraws:samples.length,distinctIntermediatePoses:intermediate.size,
    largestStep,endpointExact,durationMs:span,measuredDrawFps:span>0?(samples.length-1)*1000/span:null,
    meanDrawCostMs:costs.reduce((sum,cost)=>sum+cost,0)/costs.length,p95DrawCostMs:percentile(costs,.95),
    p95FrameIntervalMs:percentile(sortedIntervals,.95),maximumFrameIntervalMs:intervals.length?Math.max(...intervals):null};
}

function download(blob,name){
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function installTurnReview(){
  if(document.querySelector('#turnReviewPanel'))return;
  const panel=document.createElement('details');panel.id='turnReviewPanel';panel.className='details-panel';panel.open=true;
  panel.innerHTML='<summary>实际转头逐帧验收</summary><p>通过工作台的方向按钮运行正面、左右、对角和中途反向；只记录成功绘制。请保持本页可见，测试时不要操作其他控件。不会开启摄像头。</p><button id="turnReviewRun" type="button">运行转头验收</button> <button id="turnReviewRecord" type="button">录制并运行转头验收</button> <button id="turnReviewDownload" type="button" disabled>下载转头 JSON</button> <button id="turnReviewVideo" type="button" disabled>下载转头录像</button> <button id="turnReviewImage" type="button" disabled>下载中间帧对照</button><p id="turnReviewStatus" role="status">点击运行前会检查角色是否已载入。</p><canvas style="max-width:100%;height:auto;display:block" id="turnReviewSheet" width="1170" height="690" aria-label="左转到右转的九个实际中间画面"></canvas><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto" id="turnReviewReport">{"status":"idle"}</pre>';
  document.querySelector('main').append(panel);
  const get=id=>document.querySelector('#'+id),canvas=get('studioCanvas'),sheet=get('turnReviewSheet'),sheetContext=sheet.getContext('2d');
  let running=false,latest=null,collector=null,report=null,recording=null,videoBlob=null,captured=0;
  const controls=[get('turnReviewRun'),get('turnReviewRecord')];
  const status=message=>{get('turnReviewStatus').textContent=message;};
  const available=()=>!get('studioControls').disabled&&!canvas.hidden;
  function captureFrame(sample){
    if(captured>=9||sample.headPose.yaw<-1+captured*.25-1e-6)return;
    const x=(captured%3)*390,y=Math.floor(captured/3)*230;
    sheetContext.fillStyle='#e3e7ec';sheetContext.fillRect(x,y,390,230);
    const scale=Math.min(390/canvas.width,200/canvas.height),width=canvas.width*scale,height=canvas.height*scale;
    sheetContext.drawImage(canvas,x+(390-width)/2,y+(200-height)/2,width,height);
    sheetContext.fillStyle='#24364b';sheetContext.font='14px sans-serif';
    sheetContext.fillText(`实际 yaw ${sample.headPose.yaw.toFixed(3)} · 采样 ${captured+1}`,x+12,y+219);captured++;
  }
  function sampleEvent(event){
    const detail=event.detail;
    if(!detail?.headPose||!detail?.target)return;
    latest={headPose:{...detail.headPose},target:{...detail.target},at:detail.at,costMs:detail.costMs,moving:detail.moving};
    if(!running&&available())status('角色已就绪。验收会运行约 15 秒，保持本页可见。');
    collector?.(latest);
  }
  document.addEventListener('studio-frame-painted',sampleEvent);
  function pressPose(id){
    const button=document.querySelector(`[data-pose="${id}"]`);
    if(!button||button.disabled||!available())throw new Error('角色尚未就绪或方向按钮不可用。');
    button.click();
  }
  function runTurn(name,targetId,{capture=false,reversal=false,minimum=8}={}){
    status(`正在验收：${name}`);
    const goal=poseHeadCoordinates(targetId),start=latest?{...latest,headPose:{...latest.headPose},target:{...latest.target}}:null;
    return new Promise((resolve,reject)=>{
      let timeout,reversed=false,settled=false;
      const samples=start?[start]:[];
      const finish=(error)=>{
        if(settled)return;settled=true;clearTimeout(timeout);collector=null;
        if(error){reject(error);return;}
        try{
          // Preparation can begin before the optional listener observed the
          // first draw; it is not one of the measured acceptance turns.
          if(minimum===0&&samples.length<2){resolve({name,goal,prepared:true,samples});return;}
          resolve({name,goal,...summarizeTurnSamples(samples,{goal,minIntermediate:minimum}),samples});
        }catch(error){reject(error);}
      };
      collector=sample=>{
        if(document.hidden){finish(new Error('页面隐藏，验收已中止；没有将暂停时间计为有效播放。'));return;}
        samples.push({...sample,headPose:{...sample.headPose},target:{...sample.target}});
        if(capture)captureFrame(sample);
        if(reversal&&!reversed&&sample.headPose.yaw>=.35){
          reversed=true;setTimeout(()=>{if(!settled)try{pressPose(targetId);}catch(error){finish(error);}},0);return;
        }
        if(!sample.moving&&same(sample.headPose,goal)&&same(sample.target,goal)&&(!reversal||reversed))
          setTimeout(()=>finish(),0);
      };
      timeout=setTimeout(()=>finish(new Error(`转头未在 20 秒内到达目标：${name}`)),20000);
      try{pressPose(reversal?'view-right':targetId);}catch(error){finish(error);}
    });
  }
  function beginRecording(){
    const type=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(value=>MediaRecorder.isTypeSupported(value));
    if(!type)throw new Error('此浏览器没有可用的 WebM 录像编码器。');
    const stream=canvas.captureStream(60),chunks=[],recorder=new MediaRecorder(stream,{mimeType:type});
    const stopped=new Promise((resolve,reject)=>{
      recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      recorder.onerror=event=>reject(new Error(event.error?.message||'录像失败。'));
      recorder.onstop=()=>{stream.getTracks().forEach(track=>track.stop());videoBlob=new Blob(chunks,{type});get('turnReviewVideo').disabled=!videoBlob.size;resolve();};
    });
    recorder.start();return {recorder,stopped,stream};
  }
  async function run(record=false){
    if(running)return;
    if(!available()){status('画稿仍在载入，请载入完成后再运行。');return;}
    if(document.hidden){status('请在可见的工作台运行验收。');return;}
    running=true;controls.forEach(button=>button.disabled=true);get('turnReviewDownload').disabled=true;
    get('turnReviewImage').disabled=true;captured=0;sheetContext.clearRect(0,0,sheet.width,sheet.height);
    report={schemaVersion:1,kind:'short-hair-real-time-studio-turn-validation',version:'0.20.1',startedAt:new Date().toISOString(),
      studioVersion:document.querySelector('footer')?.textContent?.trim()||null,
      testedPage:location.pathname+location.search,requestedFps:Number(get('renderRate').value),status:'running',turns:[],limitations:[
        'Successful draws and their cadence are measured; this is not proof of compositor presentation or encoded video FPS.',
        'Step-bound checks do not establish artistic quality or remove existing intermediate-angle facial ghosting.',
        'No camera, microphone or OBS hardware session is started. Optional video captures only the local character canvas.'
      ]};
    try{
      // UI semantics remain authoritative: stop sources, clear overlays and use
      // actual buttons, rather than assigning private state or a fake clock.
      get('manualButton').click();get('clearPerformance').click();get('resetExpression').click();
      if(get('originalToggle').checked)get('originalToggle').click();
      await runTurn('准备正面','front',{minimum:0});
      if(record){if(typeof MediaRecorder==='undefined'||!canvas.captureStream)throw new Error('当前浏览器不支持画布录像。');recording=beginRecording();}
      for(const [name,target,capture] of [['正面→左转','view-left',false],['左转→右转','view-right',true],['右转→正面','front',false],
        ['正面→右上','view-right-up',false],['右上→左下','view-left-down',false],['左下→正面','front',false]]){
        report.turns.push(await runTurn(name,target,{capture}));get('turnReviewReport').textContent=JSON.stringify(report,null,2);
      }
      report.turns.push(await runTurn('向右途中反向左转','view-left',{reversal:true}));
      report.turns.push(await runTurn('反向后回正','front'));
      report.status=report.turns.every(turn=>turn.passed)?'passed':'failed';
      report.summary={turns:report.turns.length,passed:report.turns.filter(turn=>turn.passed).length,
        maximumStep:Math.max(...report.turns.map(turn=>turn.largestStep)),capturedIntermediateImages:captured};
      status(`${report.status==='passed'?'通过':'发现问题'}：${report.summary.passed}/${report.summary.turns} 组转头；最大单帧坐标变化 ${report.summary.maximumStep.toFixed(4)}。实际帧率与帧间隔见报告。`);
    }catch(error){report.status='failed';report.error=error.message;status(`验收中止：${error.message}`);}
    finally{
      collector=null;
      if(recording){try{if(recording.recorder.state!=='inactive')recording.recorder.stop();await recording.stopped;}catch(error){report.recordingError=error.message;recording.stream.getTracks().forEach(track=>track.stop());}recording=null;}
      report.finishedAt=new Date().toISOString();get('turnReviewReport').textContent=JSON.stringify(report,null,2);
      running=false;controls.forEach(button=>button.disabled=false);get('turnReviewDownload').disabled=false;get('turnReviewImage').disabled=captured===0;
    }
  }
  get('turnReviewRun').addEventListener('click',()=>void run());
  get('turnReviewRecord').addEventListener('click',()=>void run(true));
  get('turnReviewDownload').addEventListener('click',()=>report&&download(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'v0.20.1-real-time-turn-browser.json'));
  get('turnReviewVideo').addEventListener('click',()=>videoBlob&&download(videoBlob,'v0.20.1-real-time-turn-demo.webm'));
  get('turnReviewImage').addEventListener('click',()=>sheet.toBlob(blob=>blob&&download(blob,'v0.20.1-turn-intermediate-frames.png'),'image/png'));
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)status('页面已隐藏，当前验收将中止。');});
  if(available())status('角色已就绪。验收会运行约 15 秒，保持本页可见。');
}

if(typeof document!=='undefined'&&new URLSearchParams(location.search).get('turn-review')==='1')installTurnReview();
