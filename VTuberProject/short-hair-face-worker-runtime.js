/** Framework-free worker protocol, separately testable without cameras. */
export function createFaceWorkerHandler({loadTracker,postMessage,clock=()=>performance.now()}) {
  let tracker=null,busy=false;
  return async function handle(data) {
    const bitmap=data?.bitmap;
    try {
      if(data?.type==='init') {
        if(tracker)tracker.close();tracker=await loadTracker({delegate:data.delegate==='GPU'?'GPU':'CPU'});
        postMessage({type:'ready',id:data.id});return;
      }
      if(data?.type!=='detect')throw new Error('未知的后台识别请求。');
      if(!tracker||busy||!bitmap||!Number.isFinite(data.timestampMs)||data.timestampMs<0)throw new Error('后台识别尚未就绪或请求无效。');
      busy=true;const start=clock();
      try {
        const result=tracker.detectForVideo(bitmap,data.timestampMs);
        postMessage({type:'result',id:data.id,result,durationMs:Math.max(0,clock()-start)});
      }finally{busy=false;}
    }catch(error){postMessage({type:'error',id:data?.id,message:error?.message||'后台识别失败。'});}
    finally{bitmap?.close();}
  };
}
