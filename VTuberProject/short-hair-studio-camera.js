/** Loaded only after the user clicks the camera button. No requests on import. */
async function loadFaceTracker() {
  const {FaceLandmarker, FilesetResolver} = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
  const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
  const options = {
    baseOptions: {modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate: 'GPU'},
    numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO', minFaceDetectionConfidence: .35, minFacePresenceConfidence: .35, minTrackingConfidence: .35,
  };
  try { return await FaceLandmarker.createFromOptions(fileset, options); }
  catch { return FaceLandmarker.createFromOptions(fileset, {...options, baseOptions: {...options.baseOptions, delegate: 'CPU'}}); }
}

/** Own the stream lifecycle; stale start requests never reactivate a cancelled camera. */
export class ShortHairStudioCamera {
  constructor(video, {onState = () => {}, loadTracker = loadFaceTracker,
    getUserMedia = constraints => navigator.mediaDevices.getUserMedia(constraints)} = {}) {
    this.video = video; this.onState = onState; this.loadTracker = loadTracker; this.getUserMedia = getUserMedia;
    this.tracker = null; this.trackerPromise = null; this.stream = null; this.token = 0;
    this.starting = false; this.active = false; this.disposed = false;
    this.closedTrackers = new WeakSet();
    this.lastVideoTime = -1; this.lastProcessedAt = -Infinity;
  }

  async start() {
    if (this.disposed || this.starting || this.active) return false;
    const token = ++this.token; this.starting = true;
    let pending = null;
    this.onState({status: 'loading', message: '正在加载面部识别模型，首次使用需要联网…'});
    try {
      if (!this.tracker) {
        if (!this.trackerPromise) this.trackerPromise = Promise.resolve().then(() => this.loadTracker()).catch(error => {this.trackerPromise = null; throw error;});
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
      || now - this.lastProcessedAt < 32 || this.video.currentTime === this.lastVideoTime) return null;
    this.lastProcessedAt = now; this.lastVideoTime = this.video.currentTime;
    return this.tracker.detectForVideo(this.video, now);
  }

  dispose() {
    this.disposed = true; this.stop(); this.closeTracker(this.tracker); this.tracker = null;
  }

  closeTracker(tracker) {
    if (!tracker || this.closedTrackers.has(tracker)) return;
    this.closedTrackers.add(tracker); tracker.close?.();
  }
}
