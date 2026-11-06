/** One explicitly started worker, bounded requests and transferable frame ownership. */
export class StudioFaceWorkerClient {
  constructor({workerFactory=()=>new Worker(new URL('./short-hair-face-worker.js',import.meta.url)),
    initTimeoutMs=20000,inferenceTimeoutMs=5000}={}) {
    this.inferenceMode='worker';this.pending=new Map();this.nextId=0;this.closed=false;
    this.initTimeoutMs=initTimeoutMs;this.inferenceTimeoutMs=inferenceTimeoutMs;this.worker=workerFactory();
    this.worker.onmessage=event=>{
      const data=event.data,request=this.pending.get(data?.id);if(!request)return;
      this.pending.delete(data.id);clearTimeout(request.timer);
      if(data.type==='error')request.reject(new Error(data.message||'后台识别失败。'));
      else if(data.type===request.expected)request.resolve(data);
      else request.reject(new Error('后台识别返回了无效消息。'));
    };
    this.worker.onerror=event=>this.close(new Error(event.message||'后台识别线程中断。'));
    this.worker.onmessageerror=()=>this.close(new Error('后台识别消息无法读取。'));
  }
  request(type,payload,timeoutMs,transfer=[]) {
    if(this.closed){payload.bitmap?.close();return Promise.reject(new Error('后台识别线程已关闭。'));}
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.close(new Error(type==='init'?'后台识别模型加载超时。':'后台识别处理超时。')),timeoutMs);
      this.pending.set(id,{resolve,reject,timer,expected:type==='init'?'ready':'result'});
      try{this.worker.postMessage({type,id,...payload},transfer);}
      catch(error){payload.bitmap?.close();this.pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }
  async initialize({delegate='CPU'}={}){await this.request('init',{delegate},this.initTimeoutMs);return this;}
  async detectForVideo(bitmap,timestampMs) {
    const response=await this.request('detect',{bitmap,timestampMs},this.inferenceTimeoutMs,[bitmap]);
    if(!response.result||!Array.isArray(response.result.faceLandmarks)||!Number.isFinite(response.durationMs)||response.durationMs<0)
      throw new Error('后台识别结果无效。');
    return {result:response.result,durationMs:response.durationMs};
  }
  close(error=new Error('后台识别线程已关闭。')) {
    if(this.closed)return;this.closed=true;try{this.worker.terminate();}catch{}
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();
  }
}
export async function createWorkerFaceTracker(options={}) {
  const client=new StudioFaceWorkerClient(options);
  const abort=()=>client.close(new Error('后台识别初始化已取消。'));
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  try{return await client.initialize(options);}catch(error){client.close();throw error;}
  finally{options.signal?.removeEventListener('abort',abort);}
}
export const supportsTrackingWorker=()=>typeof Worker==='function'&&typeof createImageBitmap==='function'&&typeof OffscreenCanvas==='function';
