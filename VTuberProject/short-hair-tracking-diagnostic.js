import {createWorkerFaceTracker,supportsTrackingWorker} from './short-hair-tracking-worker-client.js';

/** Explicit diagnostic only: a local painting, never getUserMedia or audio.
 * A successful empty-face result proves execution, not human tracking quality. */
export async function runTrackingWorkerDiagnostic({delegate='CPU',imageUrl=new URL('./assets/short-hair-frame-art-v1/view-left-quarter-parted-v2.png',import.meta.url)}={}) {
  if(!supportsTrackingWorker())throw new Error('此浏览器缺少 Worker、ImageBitmap 或 OffscreenCanvas。');
  const startedAt=performance.now();let tracker=null,bitmap=null,tickTimer=null,mainThreadTicks=0;
  try {
    tracker=await createWorkerFaceTracker({delegate});const loadedAt=performance.now();
    const response=await fetch(imageUrl);if(!response.ok)throw new Error('诊断画稿无法读取。');
    const blob=await response.blob(),samples=[];let faces=0,maxPending=0;
    tickTimer=setInterval(()=>{mainThreadTicks++;},16);
    // One cold call followed by three sequential measured calls. Never queue
    // frames concurrently or choose a different delegate for favorable numbers.
    for(let index=0;index<4;index++){
      bitmap=await createImageBitmap(blob);
      const inference=tracker.detectForVideo(bitmap,performance.now());bitmap=null;
      maxPending=Math.max(maxPending,tracker.pending.size);
      const result=await inference;samples.push(result.durationMs);faces=result.result.faceLandmarks.length;
    }
    const rounded=value=>Math.round(value*10)/10,warm=samples.slice(1);
    return {ok:true,mode:'worker',delegate,modelLoadMs:Math.round(loadedAt-startedAt),
      coldInferenceMs:rounded(samples[0]),warmInferenceMs:warm.map(rounded),
      meanWarmInferenceMs:rounded(warm.reduce((sum,value)=>sum+value,0)/warm.length),faces,maxPending,mainThreadTicks,
      totalMs:Math.round(performance.now()-startedAt),note:'仅验证后台模型可加载并处理已有画稿；未测真人精度，未访问摄像头或麦克风。'};
  }finally{if(tickTimer!==null)clearInterval(tickTimer);bitmap?.close();tracker?.close();}
}

if(typeof document!=='undefined'){
  const button=document.querySelector('#runWorkerDiagnostic'),status=document.querySelector('#workerDiagnosticStatus');
  button?.addEventListener('click',async()=>{
    button.disabled=true;status.textContent='正在加载后台模型，处理项目内画稿并测量连续三帧…';
    try{status.textContent=JSON.stringify(await runTrackingWorkerDiagnostic(),null,2);}
    catch(error){status.textContent=`诊断未通过：${error.message}`;}
    finally{button.disabled=false;}
  });
}
