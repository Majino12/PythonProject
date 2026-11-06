const RETRY_DELAYS=Object.freeze([250,500,1000,2000,4000,4000]);
const RENEW_MS=1000;

/** Latest-only delivery with bounded recovery and a lease for unchanged frames. */
export class StudioOutputPublisher {
  constructor({fetcher=(...args)=>fetch(...args),onState=()=>{},senderId=globalThis.crypto.randomUUID(),
    now=()=>Date.now(),setTimer=(...args)=>setTimeout(...args),clearTimer=(...args)=>clearTimeout(...args)}={}) {
    this.fetcher=fetcher;this.onState=onState;this.senderId=senderId;this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;
    this.enabled=false;this.sequence=0;this.pending=null;this.sending=false;this.generation=0;
    this.latest=null;this.lastSuccess=null;this.lastSuccessAt=0;this.failures=0;
    this.retryTimer=null;this.renewTimer=null;this.controller=null;
  }
  timer(callback,delay) {const id=this.setTimer(callback,delay);id?.unref?.();return id;}
  cancelTimers() {
    if(this.retryTimer!==null)this.clearTimer(this.retryTimer);
    if(this.renewTimer!==null)this.clearTimer(this.renewTimer);
    this.retryTimer=null;this.renewTimer=null;
  }
  start() {
    if(this.enabled)return;
    this.cancelTimers();this.enabled=true;++this.generation;this.failures=0;this.lastSuccess=null;this.latest=null;
    this.onState({status:'connecting',message:'正在连接独立画面…'});
  }
  publish(frame) {
    if(!this.enabled)return;
    // Capture the caller's mutable state now, including the exact deduplication key.
    const signature=JSON.stringify(frame);
    this.latest={frame:JSON.parse(signature),signature};this.pending=this.latest;void this.flush();
  }
  scheduleRenewal(generation) {
    if(this.renewTimer!==null)this.clearTimer(this.renewTimer);
    this.renewTimer=this.timer(()=>{
      this.renewTimer=null;
      if(this.enabled&&generation===this.generation&&this.latest){this.pending=this.latest;void this.flush();}
    },RENEW_MS);
  }
  async flush() {
    if(this.sending||this.retryTimer!==null||!this.pending||!this.enabled)return;
    const current=this.pending;this.pending=null;
    if(this.failures===0&&current.signature===this.lastSuccess&&this.now()-this.lastSuccessAt<RENEW_MS)return;
    if(this.renewTimer!==null){this.clearTimer(this.renewTimer);this.renewTimer=null;}
    this.sending=true;const generation=this.generation,controller=new AbortController();this.controller=controller;
    const timeout=this.timer(()=>controller.abort(),2000);
    try {
      const response=await this.fetcher('/api/studio-output/state',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({senderId:this.senderId,sequence:++this.sequence,frame:current.frame}),signal:controller.signal});
      let result;
      try {result=await response.json();} catch(error) {if(response.ok)throw error;result={};}
      if(generation!==this.generation)return;
      if(!response.ok) {
        const error=new Error(response.status===409?'直播画面已被另一工作台占用或发送顺序冲突，请检查后重新启用。':result.error||'输出连接失败。');
        error.retryable=response.status===408||response.status===429||response.status>=500;
        throw error;
      }
      this.lastSuccess=current.signature;this.lastSuccessAt=this.now();this.failures=0;
      this.onState({status:'active',message:`直播画面已启用 · ${result.clients} 个接收窗口`});this.scheduleRenewal(generation);
    } catch(error) {
      if(generation!==this.generation)return;
      if(error.retryable!==false&&this.failures<RETRY_DELAYS.length) {
        this.pending=this.latest||current;
        const delay=RETRY_DELAYS[this.failures++];
        this.onState({status:'reconnecting',message:`输出连接中断 · 保留最后画面 · 正在重连 ${this.failures}/${RETRY_DELAYS.length}`});
        this.retryTimer=this.timer(()=>{this.retryTimer=null;if(this.enabled&&generation===this.generation)void this.flush();},delay);
      } else {
        // Only explicit stop clears receivers; failed delivery leaves the last good frame visible.
        this.enabled=false;this.pending=null;this.cancelTimers();++this.generation;
        this.onState({status:'error',message:error.retryable===false?error.message:'输出重连失败 · 已保留最后画面，请重新启用。'});
      }
    } finally {
      this.clearTimer(timeout);if(this.controller===controller)this.controller=null;
      this.sending=false;if(this.enabled&&this.pending&&this.retryTimer===null)void this.flush();
    }
  }
  stop() {
    if(!this.enabled&&this.sequence===0)return Promise.resolve();
    this.enabled=false;this.pending=null;this.latest=null;++this.generation;this.cancelTimers();this.controller?.abort();
    // Same-origin JSON + keepalive also clears a source when its controller closes.
    return this.fetcher('/api/studio-output/stop',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({senderId:this.senderId,sequence:++this.sequence}),keepalive:true}).catch(()=>{});
  }
}
