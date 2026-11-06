/** Latest-only delivery: a slow output never queues old expressions. */
export class StudioOutputPublisher {
  constructor({fetcher = (...args)=>fetch(...args), onState = ()=>{}, senderId = globalThis.crypto.randomUUID()} = {}) {
    this.fetcher=fetcher;this.onState=onState;this.senderId=senderId;this.enabled=false;
    this.sequence=0;this.pending=null;this.sending=false;this.generation=0;
  }
  start() {this.enabled=true;++this.generation;this.onState({status:'connecting',message:'正在连接独立画面…'});}
  publish(frame) {if(!this.enabled)return;this.pending=frame;void this.flush();}
  async flush() {
    if(this.sending || !this.pending || !this.enabled)return;
    this.sending=true;const generation=this.generation;
    const frame=this.pending;this.pending=null;
    try {
      const response=await this.fetcher('/api/studio-output/state',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({senderId:this.senderId,sequence:++this.sequence,frame}),signal:AbortSignal.timeout(2000)});
      const result=await response.json();
      if(generation!==this.generation)return;
      if(!response.ok)throw new Error(result.error || '输出连接失败。');
      this.onState({status:'active',message:`直播画面已启用 · ${result.clients} 个接收窗口`});
    } catch(error) {
      if(generation===this.generation) {
        this.enabled=false;this.pending=null;
        void this.stop();
        this.onState({status:'error',message:error.message || '输出连接中断，请重新启用。'});
      }
    } finally {this.sending=false;if(this.enabled&&this.pending)void this.flush();}
  }
  stop() {
    if(!this.enabled && this.sequence===0)return Promise.resolve();
    this.enabled=false;this.pending=null;++this.generation;
    // Same-origin JSON + keepalive also clears a source when its controller closes.
    return this.fetcher('/api/studio-output/stop',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({senderId:this.senderId,sequence:++this.sequence}),keepalive:true}).catch(()=>{});
  }
}
