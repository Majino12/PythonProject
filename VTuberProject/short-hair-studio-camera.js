import {extractFaceMotion} from './motion.js';
import {TrackingInferenceMetrics} from './short-hair-studio-tracking.js';

import {loadFaceTracker} from './short-hair-face-tracker.js';
import {createWorkerFaceTracker,supportsTrackingWorker} from './short-hair-tracking-worker-client.js';

/** Leave rendering time between synchronous inferences. Four sustained costly
 * calls reduce the budget; recovering needs 24 cheap calls and a two-second
 * dwell, with separate thresholds to avoid oscillation around a boundary. */
export class StudioInferenceBudget {
  constructor() {this.reset();}
  reset() {this.level=0;this.meanMs=null;this.slow=0;this.fast=0;this.changedAt=-Infinity;}
  get fps() {return [30,20,15][this.level];}
  get intervalMs() {return [32,50,1000/15][this.level];}
  record(durationMs,now) {
    if(!Number.isFinite(durationMs)||durationMs<0||!Number.isFinite(now))return;
    this.meanMs=this.meanMs===null?durationMs:this.meanMs*.8+durationMs*.2;
    const slow=this.level<2&&this.meanMs>[18,30][this.level];
    const fast=this.level>0&&this.meanMs<[0,12,22][this.level];
    this.slow=slow?this.slow+1:0;this.fast=fast?this.fast+1:0;
    if(this.slow>=4){this.level++;this.changedAt=now;this.slow=0;this.fast=0;}
    else if(this.fast>=24&&now-this.changedAt>=2000){this.level--;this.changedAt=now;this.slow=0;this.fast=0;}
  }
}

/** Own the stream lifecycle; stale start requests never reactivate a cancelled camera. */
export class ShortHairStudioCamera {
  constructor(video, {onState = () => {}, loadTracker = loadFaceTracker,
    loadWorkerTracker = createWorkerFaceTracker,workerSupported = supportsTrackingWorker,
    createBitmap = source => createImageBitmap(source),
    getUserMedia = constraints => navigator.mediaDevices.getUserMedia(constraints),
    clock = () => performance.now()} = {}) {
    this.video = video; this.onState = onState; this.loadTracker = loadTracker; this.getUserMedia = getUserMedia;
    this.loadWorkerTracker=loadWorkerTracker;this.workerSupported=workerSupported;this.createBitmap=createBitmap;
    this.tracker = null; this.trackerPromise = null; this.trackerAbort=null;this.stream = null; this.token = 0;
    this.starting = false; this.active = false; this.disposed = false;
    this.closedTrackers = new WeakSet();
    this.lastVideoTime = -1; this.lastProcessedAt = -Infinity;
    this.clock = clock; this.metrics = new TrackingInferenceMetrics();this.budget=new StudioInferenceBudget();
    this.preferredDelegate='GPU';
    this.inferenceMode='main-thread';this.fallbackReason=null;this.workerFailed=false;this.workerFailureReason=null;
    this.pendingJob=null;this.latestResult=null;this.pendingError=null;this.resultLatencyMs=null;
    this.staleWorkerStreak=0;this.staleResultCount=0;
  }

  async prepareTracker(signal) {
    if(signal?.aborted)throw new Error('识别初始化已取消。');
    if(!this.workerFailed&&this.workerSupported()){
      try {const tracker=await this.loadWorkerTracker({delegate:'CPU',signal});this.fallbackReason=null;return tracker;}
      catch(error) {if(signal?.aborted)throw error;this.fallbackReason='worker-initialization-failed';}
    }else this.fallbackReason=this.workerFailed?(this.workerFailureReason||'worker-runtime-failed'):'worker-unavailable';
    return this.loadTracker({delegate:this.preferredDelegate});
  }

  async start() {
    if (this.disposed || this.starting || this.active) return false;
    const token = ++this.token; this.starting = true;
    let pending = null;
    this.onState({status: 'loading', message: '正在加载面部识别模型，首次使用需要联网…'});
    try {
      // A worker can fail while the camera is stopped. Recover before asking
      // for media, instead of reopening with an already terminated client.
      if(this.tracker?.inferenceMode==='worker'&&this.tracker.closed===true){
        this.workerFailed=true;this.workerFailureReason='worker-runtime-failed';this.invalidateTracker();
      }
      if (!this.tracker) {
        if (!this.trackerPromise) {
          const abort=new AbortController();this.trackerAbort=abort;
          const loading=Promise.resolve().then(()=>this.prepareTracker(abort.signal)).catch(error=>{
            if(this.trackerPromise===loading){this.trackerPromise=null;this.trackerAbort=null;}throw error;
          });this.trackerPromise=loading;
        }
        const loading=this.trackerPromise,abort=this.trackerAbort,tracker=await loading;
        if (this.disposed||abort?.signal.aborted) {this.closeTracker(tracker); return false;}
        if(this.trackerPromise===loading)this.trackerAbort=null;
        this.tracker = tracker;
      }
      this.inferenceMode=this.tracker.inferenceMode==='worker'?'worker':'main-thread';
      if (token !== this.token) return false;
      this.onState({status: 'requesting', message: '请在浏览器中允许摄像头；麦克风保持关闭。'});
      pending = await this.getUserMedia({video: {width: {ideal: 640}, height: {ideal: 480}, facingMode: 'user'}, audio: false});
      if (token !== this.token) {pending.getTracks().forEach(track => track.stop()); return false;}
      this.video.srcObject = pending;
      await this.video.play();
      if (token !== this.token) {
        pending.getTracks().forEach(track => track.stop());
        if (this.video.srcObject === pending) this.video.srcObject = null;
        return false;
      }
      this.stream = pending; this.active = true; this.lastVideoTime = -1; this.lastProcessedAt = -Infinity;
      this.metrics.reset();this.budget.reset();this.latestResult=null;this.pendingError=null;this.resultLatencyMs=null;
      this.staleWorkerStreak=0;this.staleResultCount=0;
      pending.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (this.stream === pending) this.stop('摄像头连接已结束，已回到手动模式。');
      }, {once: true}));
      this.onState({status: 'active', message: this.inferenceMode==='worker'
        ?'面部跟踪已开启，后台线程在本机处理。':'面部跟踪已开启；后台线程不可用，正在使用主线程兼容模式。'});
      return true;
    } catch (error) {
      pending?.getTracks().forEach(track => track.stop());
      if (this.video.srcObject === pending) this.video.srcObject = null;
      if (token === this.token) {
        this.active = false; this.stream = null;
        this.onState({status: 'error', message: error?.name === 'NotAllowedError'
          ? '没有获得摄像头权限，仍可使用手动控制和演示。'
          : '摄像头或识别模型暂不可用，仍可使用手动控制和演示。'});
      }
      return false;
    } finally {if (token === this.token) this.starting = false;}
  }

  stop(message = '摄像头已关闭。') {
    ++this.token; this.starting = false; this.active = false;
    if(this.trackerAbort){this.trackerAbort.abort();this.trackerAbort=null;this.trackerPromise=null;}
    this.latestResult=null;this.pendingError=null;
    // An in-flight worker owns a transferred bitmap. Termination bounds its
    // lifetime; a healthy idle task can still be reused by an ordinary restart.
    if(this.pendingJob){this.pendingJob=null;const cancelled=this.tracker;this.tracker=null;this.trackerPromise=null;this.closeTracker(cancelled);}
    const stream = this.stream || this.video.srcObject;
    this.stream = null; this.video.srcObject = null;
    stream?.getTracks().forEach(track => track.stop());
    this.onState({status: 'stopped', message});
  }

  poll(now) {
    if(!this.active||!Number.isFinite(now)||now<0)return null;
    if(this.pendingError){const error=this.pendingError;this.pendingError=null;throw error;}
    const completed=this.latestResult;this.latestResult=null;
    let result=null;
    if(completed&&completed.token===this.token&&now>=completed.at){
      if(now-completed.at<=240){result={...completed.result,trackingSampleTimeMs:completed.at};this.staleWorkerStreak=0;}
      else this.expireWorkerResult();
    }
    if(!this.active)return null;
    if (!this.tracker || this.video.readyState < 2 || this.pendingJob
      || now - this.lastProcessedAt < this.budget.intervalMs || this.video.currentTime === this.lastVideoTime) return result;
    this.lastProcessedAt = now; this.lastVideoTime = this.video.currentTime;
    if(this.inferenceMode==='worker'){this.scheduleWorker(now);return result;}
    const startedAt = this.clock();
    try {
      const result = this.tracker.detectForVideo(this.video, now);
      const durationMs = Math.max(0, this.clock() - startedAt);
      this.metrics.record(now, durationMs, Boolean(extractFaceMotion(result)));
      this.budget.record(durationMs,now);
      this.resultLatencyMs=durationMs;
      return {...result,trackingSampleTimeMs:now};
    } catch (error) {
      this.metrics.record(now, Math.max(0, this.clock() - startedAt), false, true);
      // A failed GPU task must not be reused by a later start. A fresh CPU task
      // also gives the next explicit user retry a chance after context loss.
      this.invalidateTracker();
      throw error;
    }
  }

  scheduleWorker(now) {
    const job={token:this.token,tracker:this.tracker,at:now};this.pendingJob=job;
    const current=()=>this.active&&!this.disposed&&this.token===job.token&&this.pendingJob===job;
    Promise.resolve().then(()=>current()?this.createBitmap(this.video):null).then(async bitmap=>{
      if(!bitmap)return;
      if(!current()){bitmap.close();return;}
      // The client now owns the bitmap (transferred on success, closed on a
      // failed post). The worker closes its transferred copy in all code paths.
      const response=await job.tracker.detectForVideo(bitmap,now);
      if(!current())return;
      this.resultLatencyMs=Math.max(0,this.clock()-now);
      this.metrics.record(now,response.durationMs,Boolean(extractFaceMotion(response.result)));
      this.budget.record(response.durationMs,now);
      if(this.resultLatencyMs<=240)this.latestResult={token:job.token,at:now,result:response.result};
      else this.expireWorkerResult();
    }).catch(error=>{
      if(!current())return;
      this.metrics.record(now,Math.max(0,this.clock()-now),false,true);
      this.workerFailed=true;this.workerFailureReason=this.fallbackReason='worker-runtime-failed';this.pendingError=error;this.invalidateTracker();
    }).finally(()=>{if(this.pendingJob===job)this.pendingJob=null;});
  }

  expireWorkerResult() {
    this.staleResultCount++;this.staleWorkerStreak++;
    if(this.staleWorkerStreak<3)return;
    this.workerFailed=true;this.workerFailureReason=this.fallbackReason='worker-too-slow';
    // Keep the 240 ms validity boundary. Let the next explicit start try the
    // main-thread GPU path; never begin potentially blocking work automatically.
    this.invalidateTracker('GPU');
    this.stop('后台推理持续过慢，已暂停摄像头；请重新开启，将使用主线程兼容模式。');
  }

  invalidateTracker(delegate='CPU') {
    const failed=this.tracker;this.tracker=null;this.trackerPromise=null;this.preferredDelegate=delegate;this.closeTracker(failed);
  }

  getMetrics(now = this.clock()) {
    const measured = this.metrics.snapshot(now);
    return {...measured, inferenceFps:this.active ? measured.inferenceFps : null, signalStale:!this.active || measured.signalStale,
      inferenceBudgetFps:this.budget.fps,inferenceMode:this.inferenceMode,pending:Boolean(this.pendingJob),
      resultLatencyMs:this.resultLatencyMs,fallbackReason:this.fallbackReason,staleResultCount:this.staleResultCount};
  }

  dispose() {
    this.disposed = true; this.stop(); this.closeTracker(this.tracker); this.tracker = null;this.trackerPromise=null;
  }

  closeTracker(tracker) {
    if (!tracker || this.closedTrackers.has(tracker)) return;
    this.closedTrackers.add(tracker);
    // Cleanup may itself fail after a lost graphics context. Invalidation and
    // the original inference error must still reach the lifecycle handler.
    try {tracker.close?.();} catch {}
  }
}
