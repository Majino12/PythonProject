import {extractFaceMotion} from './motion.js';
import {TrackingInferenceMetrics} from './short-hair-studio-tracking.js';

/** Loaded only after the user clicks the camera button. No requests on import. */
async function loadFaceTracker({delegate = 'GPU'} = {}) {
  const {FaceLandmarker, FilesetResolver} = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
  const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
  const options = {
    baseOptions: {modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate},
    numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO', minFaceDetectionConfidence: .35, minFacePresenceConfidence: .35, minTrackingConfidence: .35,
  };
  try { return await FaceLandmarker.createFromOptions(fileset, options); }
  catch (error) {
    if(delegate==='CPU')throw error;
    return FaceLandmarker.createFromOptions(fileset, {...options, baseOptions: {...options.baseOptions, delegate: 'CPU'}});
  }
}

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
    getUserMedia = constraints => navigator.mediaDevices.getUserMedia(constraints),
    clock = () => performance.now()} = {}) {
    this.video = video; this.onState = onState; this.loadTracker = loadTracker; this.getUserMedia = getUserMedia;
    this.tracker = null; this.trackerPromise = null; this.stream = null; this.token = 0;
    this.starting = false; this.active = false; this.disposed = false;
    this.closedTrackers = new WeakSet();
    this.lastVideoTime = -1; this.lastProcessedAt = -Infinity;
    this.clock = clock; this.metrics = new TrackingInferenceMetrics();this.budget=new StudioInferenceBudget();
    this.preferredDelegate='GPU';
  }

  async start() {
    if (this.disposed || this.starting || this.active) return false;
    const token = ++this.token; this.starting = true;
    let pending = null;
    this.onState({status: 'loading', message: '正在加载面部识别模型，首次使用需要联网…'});
    try {
      if (!this.tracker) {
        if (!this.trackerPromise) this.trackerPromise = Promise.resolve().then(() => this.loadTracker({delegate:this.preferredDelegate})).catch(error => {this.trackerPromise = null; throw error;});
        const tracker = await this.trackerPromise;
        if (this.disposed) {this.closeTracker(tracker); return false;}
        this.tracker = tracker;
      }
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
      this.metrics.reset();this.budget.reset();
      pending.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (this.stream === pending) this.stop('摄像头连接已结束，已回到手动模式。');
      }, {once: true}));
      this.onState({status: 'active', message: '面部跟踪已开启，画面在本机处理。'});
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
    const stream = this.stream || this.video.srcObject;
    this.stream = null; this.video.srcObject = null;
    stream?.getTracks().forEach(track => track.stop());
    this.onState({status: 'stopped', message});
  }

  poll(now) {
    if (!this.active || !this.tracker || this.video.readyState < 2 || !Number.isFinite(now)
      || now - this.lastProcessedAt < this.budget.intervalMs || this.video.currentTime === this.lastVideoTime) return null;
    this.lastProcessedAt = now; this.lastVideoTime = this.video.currentTime;
    const startedAt = this.clock();
    try {
      const result = this.tracker.detectForVideo(this.video, now);
      const durationMs = Math.max(0, this.clock() - startedAt);
      this.metrics.record(now, durationMs, Boolean(extractFaceMotion(result)));
      this.budget.record(durationMs,now);
      return result;
    } catch (error) {
      this.metrics.record(now, Math.max(0, this.clock() - startedAt), false, true);
      // A failed GPU task must not be reused by a later start. A fresh CPU task
      // also gives the next explicit user retry a chance after context loss.
      const failed=this.tracker;this.tracker=null;this.trackerPromise=null;this.preferredDelegate='CPU';
      this.closeTracker(failed);
      throw error;
    }
  }

  getMetrics(now = this.clock()) {
    const measured = this.metrics.snapshot(now);
    return {...measured, inferenceFps:this.active ? measured.inferenceFps : null, signalStale:!this.active || measured.signalStale,
      inferenceBudgetFps:this.budget.fps};
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
