/** Quality checks for fresh 2D camera samples only. Rendering, imported motion,
 * manual controls and the shared FaceSession deliberately do not use this gate. */
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validTime = value => finite(value) && value >= 0;
// motion.js returns roll already normalized to [-1,1], not radians/degrees.
// z was only the older test/adapter alias; prefer the actual detector property.
const roll = pose => pose && Object.hasOwn(pose,'roll') ? pose.roll : pose?.z ?? 0;
const copyPose = pose => ({x:pose.x,y:pose.y,roll:roll(pose)});
const validPose = pose => pose && ['x','y'].every(key => finite(pose[key]) && Math.abs(pose[key]) <= 1)
  && finite(roll(pose)) && Math.abs(roll(pose)) <= 1;
const distance = (a,b) => Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y));
const percentile = (values,fraction) => {
  const sorted = [...values].sort((a,b) => a-b);
  return sorted[Math.floor((sorted.length-1)*fraction)];
};

export const TRACKING_SIGNAL_LIMITS = Object.freeze({
  staleMs:240, lostMs:600, confirmationMs:160, jump:.30, confirmationRadius:.18,
});

/** A rendering frame cannot confirm an inference sample. Call push only for a
 * new usable detector result; use snapshot during skipped inference frames.
 * Small motion is not additionally filtered. Large jumps and reacquisition
 * need two nearby independent samples; the existing renderer damps accepted
 * targets, including the return from neutral after signal loss. */
export class StudioTrackingSignalGate {
  constructor() {this.reset();}
  reset(now = 0) {
    if (!validTime(now)) throw new RangeError('跟踪起始时间需要非负有限毫秒数。');
    this.startedAt=now;this.lastSampleAt=-Infinity;this.lastAcceptedAt=-Infinity;
    this.pose=null;this.candidate=null;this.reason='initial-confirmation';this.wasLost=false;
  }
  snapshot(now) {
    const valid=validTime(now) && now>=this.startedAt;
    const fresh=valid && this.pose!==null && now>=this.lastAcceptedAt && now-this.lastAcceptedAt<=TRACKING_SIGNAL_LIMITS.staleMs;
    const candidateFresh=valid && this.candidate && now>=this.candidate.at && now-this.candidate.at<=TRACKING_SIGNAL_LIMITS.confirmationMs;
    let status='acquiring';
    if (fresh) status='tracking';
    else if (candidateFresh && (this.pose || this.wasLost)) status='recovering';
    else if (valid && now-(this.pose ? this.lastAcceptedAt : this.startedAt)>TRACKING_SIGNAL_LIMITS.lostMs) {
      status='lost';this.wasLost=true;
    } else if (this.pose) status='recovering';
    return {accepted:false,pose:fresh?copyPose(this.pose):null,status,signalFresh:Boolean(fresh),
      lastAcceptedAt:Number.isFinite(this.lastAcceptedAt)?this.lastAcceptedAt:null,
      reason:valid ? fresh?this.reason:'stale' : 'invalid-time'};
  }
  push(pose,now) {
    const previous=this.snapshot(now);
    if (!validTime(now) || now<this.startedAt || now<=this.lastSampleAt) return {...previous,reason:'duplicate-or-old-time'};
    this.lastSampleAt=now;
    if (!validPose(pose)) {this.candidate=null;return {...previous,reason:'invalid-pose'};}
    const next=copyPose(pose), needsConfirmation=!previous.signalFresh || distance(next,this.pose)>TRACKING_SIGNAL_LIMITS.jump;
    if (needsConfirmation) {
      const confirmed=this.candidate && now>this.candidate.at && now-this.candidate.at<=TRACKING_SIGNAL_LIMITS.confirmationMs
        && distance(next,this.candidate.pose)<=TRACKING_SIGNAL_LIMITS.confirmationRadius;
      if (!confirmed) {
        this.candidate={pose:next,at:now};
        this.reason=previous.signalFresh?'jump-confirmation':this.pose||this.wasLost?'reacquiring':'initial-confirmation';
        return {...this.snapshot(now),reason:this.reason};
      }
    }
    this.pose=next;this.lastAcceptedAt=now;this.candidate=null;this.reason='accepted';this.wasLost=false;
    return {...this.snapshot(now),accepted:true};
  }
}

export const CALIBRATION_QUALITY_LIMITS = Object.freeze({
  minSamples:12,minSpanMs:1200,maxAgeMs:240,maxGapMs:500,maxSamples:120,
  maxYawSpread:.16,maxPitchSpread:.18,maxRollSpread:.22,maxBlinkMedian:.35,maxJawMedian:.20,
});
const calibrationMessages = Object.freeze({
  'not-started':'请先开始校准。',
  'invalid-time':'校准计时中断，请重新校准。',
  'too-few-samples':'有效人脸样本不足；请保持在镜头内后重新校准。',
  'too-short':'有效跟踪时间不足；请保持正脸约 3 秒后重新校准。',
  'stale':'校准结束时没有稳定看到人脸；请回到镜头内后重新校准。',
  'interrupted':'校准期间人脸跟踪多次中断；请保持在镜头内后重新校准。',
  'moving':'校准期间头部移动较多；请保持正脸静止后重新校准。',
  'eyes-closed':'校准时眼睛闭合较多；请自然睁眼后重新校准。',
  'mouth-open':'校准时嘴巴未放松；请闭合嘴巴后重新校准。',
  'ready':'校准完成。现在可以眨眼、张嘴或抬眉。',
});

/** Collect raw fresh samples before signal gating. Transient natural blinks and
 * a few noisy landmarks do not spoil the robust median/spread checks. This
 * class never mutates a calibration: apply FaceSession.finishCalibration and
 * neutralPose only when finish().ok; otherwise retain the previous calibration. */
export class StudioCalibrationQuality {
  constructor() {this.samples=[];this.startedAt=null;this.active=false;}
  begin(now) {
    if (!validTime(now)) throw new RangeError('校准起始时间需要非负有限毫秒数。');
    this.samples=[];this.startedAt=now;this.active=true;
  }
  add({pose,channels} = {},now) {
    if (!this.active || !validTime(now) || now<this.startedAt || now<=(this.samples.at(-1)?.at ?? -Infinity)
      || !validPose(pose) || !channels || !['eyeBlinkLeft','eyeBlinkRight','jawOpen'].every(key =>
        finite(channels[key]) && channels[key]>=0 && channels[key]<=1)) return false;
    this.samples.push({pose:copyPose(pose),channels:{eyeBlinkLeft:channels.eyeBlinkLeft,
      eyeBlinkRight:channels.eyeBlinkRight,jawOpen:channels.jawOpen},at:now});
    if(this.samples.length>CALIBRATION_QUALITY_LIMITS.maxSamples)this.samples.shift();
    return true;
  }
  finish(now) {
    const samples=this.samples,limits=CALIBRATION_QUALITY_LIMITS;
    const spanMs=samples.length>1?samples.at(-1).at-samples[0].at:0;
    const report=reason=>({ok:reason==='ready',reason,message:calibrationMessages[reason],sampleCount:samples.length,spanMs,
      neutralPose:reason==='ready'?{x:percentile(samples.map(sample=>sample.pose.x),.5),y:percentile(samples.map(sample=>sample.pose.y),.5)}:null});
    if(!this.active)return report('not-started');
    this.active=false;
    if(!validTime(now)||now<this.startedAt||now<(samples.at(-1)?.at??0))return report('invalid-time');
    if(samples.length<limits.minSamples)return report('too-few-samples');
    if(now-samples.at(-1).at>limits.maxAgeMs)return report('stale');
    if(spanMs<limits.minSpanMs)return report('too-short');
    if(samples.some((sample,index)=>index>0&&sample.at-samples[index-1].at>limits.maxGapMs))return report('interrupted');
    if([['x',limits.maxYawSpread],['y',limits.maxPitchSpread],['roll',limits.maxRollSpread]].some(([axis,max])=>{
      const values=samples.map(sample=>sample.pose[axis]);return percentile(values,.9)-percentile(values,.1)>max;
    }))return report('moving');
    if(['eyeBlinkLeft','eyeBlinkRight'].some(key=>percentile(samples.map(sample=>sample.channels[key]),.5)>limits.maxBlinkMedian))return report('eyes-closed');
    if(percentile(samples.map(sample=>sample.channels.jawOpen),.5)>limits.maxJawMedian)return report('mouth-open');
    return report('ready');
  }
}
