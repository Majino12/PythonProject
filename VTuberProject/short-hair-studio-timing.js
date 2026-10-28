/** Timing owns no DOM, canvas, camera, RAF callback, or image data. A target
 * frame rate is a scheduling request, never evidence of measured output. */
export const STUDIO_RENDER_FPS = 60;
export const STUDIO_RECORDING_FPS = 60;
export const STUDIO_FRAME_RATES = Object.freeze([30,60]);
const validTime = value => Number.isFinite(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class StudioFrameClock {
  constructor({targetFps=STUDIO_RENDER_FPS,uiIntervalMs=100,windowMs=2000}={}) {
    if(!STUDIO_FRAME_RATES.includes(targetFps)) throw new RangeError('目标帧率只能选择 30 或 60。');
    if(!Number.isFinite(uiIntervalMs)||uiIntervalMs<50) throw new RangeError('界面更新间隔至少为 50 ms。');
    if(!Number.isFinite(windowMs)||windowMs<500||windowMs>10000) throw new RangeError('测量窗口需要在 500–10000 ms 之间。');
    this.targetFps=targetFps;this.uiIntervalMs=uiIntervalMs;this.windowMs=windowMs;this.reset();
  }

  reset() {
    this.lastCallback=null;this.lastScheduledRender=null;this.nextRender=null;this.nextUi=null;this.samples=[];
  }

  setTargetFps(targetFps) {
    if(!STUDIO_FRAME_RATES.includes(targetFps)) throw new RangeError('目标帧率只能选择 30 或 60。');
    if(targetFps===this.targetFps) return false;
    this.targetFps=targetFps;this.reset();return true;
  }

  /** At most one render per callback. Missed deadlines are discarded instead
   * of running catch-up draws. A small deadline tolerance absorbs RAF jitter
   * without turning a 60 Hz callback stream into an accidental 30 Hz stream. */
  advance(now) {
    if(!validTime(now)) return {render:false,dt:0,updateUi:false};
    if(this.lastCallback!==null&&now<this.lastCallback) this.reset();
    if(now===this.lastCallback) return {render:false,dt:0,updateUi:false};
    this.lastCallback=now;
    const interval=1000/this.targetFps,tolerance=.75;
    if(this.nextRender!==null&&now+tolerance<this.nextRender) return {render:false,dt:0,updateUi:false};
    const dt=this.lastScheduledRender===null?1/this.targetFps:Math.min(.1,Math.max(0,(now-this.lastScheduledRender)/1000));
    this.lastScheduledRender=now;
    if(this.nextRender===null) this.nextRender=now+interval;
    else this.nextRender+=Math.max(1,Math.floor((now+tolerance-this.nextRender)/interval)+1)*interval;
    const updateUi=this.nextUi===null||now+tolerance>=this.nextUi;
    if(updateUi) {
      if(this.nextUi===null) this.nextUi=now+this.uiIntervalMs;
      else this.nextUi+=Math.max(1,Math.floor((now+tolerance-this.nextUi)/this.uiIntervalMs)+1)*this.uiIntervalMs;
    }
    return {render:true,dt,updateUi};
  }

  /** Call only after a canvas draw succeeds. Merely receiving a RAF callback,
   * accepting camera input, or requesting captureStream(60) does not count. */
  recordFrame(now,costMs) {
    if(!validTime(now)||!Number.isFinite(costMs)||costMs<0) return false;
    const last=this.samples.at(-1);
    if(last&&now<=last.at) return false;
    this.samples.push({at:now,cost:costMs});this.prune(now);return true;
  }

  prune(now) {
    const cutoff=now-this.windowMs;
    let first=0;while(first<this.samples.length&&this.samples[first].at<cutoff) first++;
    if(first) this.samples.splice(0,first);
  }

  /** Canvas draw cadence, not display presentation rate, camera inference
   * rate, or encoded-video FPS. Insufficient/stale samples stay explicitly
   * unmeasured; the selected target is never substituted for missing data. */
  snapshot(now) {
    if(validTime(now)) this.prune(now);
    const first=this.samples[0],last=this.samples.at(-1),span=first&&last?last.at-first.at:0;
    const usable=validTime(now)&&first&&last&&now>=last.at&&now-last.at<=400&&this.samples.length>=12&&span>=250;
    const costs=usable?this.samples.map(sample=>sample.cost).sort((a,b)=>a-b):[];
    return {
      targetFps:this.targetFps,measuredFps:usable?(this.samples.length-1)*1000/span:null,
      averageRenderMs:usable?costs.reduce((sum,cost)=>sum+cost,0)/costs.length:null,
      p95RenderMs:usable?costs[Math.max(0,Math.ceil(costs.length*.95)-1)]:null,
      sampleCount:this.samples.length,windowDurationMs:span,
    };
  }
}

export const STUDIO_PAINT_STEP_MS=Object.freeze({eyeLeft:24,eyeRight:24,mouth:38});
function copyState(state) {
  if(!object(state)||Object.values(state).some(value=>typeof value!=='string'||!value)) throw new TypeError('画稿状态需要非空字符串对象。');
  return {...state};
}
function freezeMotion(frameState,elapsedMs) {
  return Object.freeze({frameState:frameState===null?null:Object.freeze(copyState(frameState)),elapsedMs:Object.freeze({...elapsedMs})});
}

/** initialState must be the frame already shown, not the previous target.
 * Reset with null on a pose/source/original/import/export boundary to snap to
 * that boundary's exact selected state rather than replaying an old queue. */
export function createStudioMotion(initialState=null) {
  return freezeMotion(initialState,STUDIO_PAINT_STEP_MS);
}

/** Pure proposal: save returned `motion` only after rendering frameState
 * succeeds. Reusing the prior motion cannot skip an unseen intermediate.
 * Changing targets replans from that committed displayed frame. There is no
 * queued old destination, catch-up loop, crossfade, warp, or synthetic art.
 * `dtMs` is elapsed display time, while sequences list actual prepared art. */
export function advanceStudioMotion(motion,target,dtMs,sequences) {
  if(!object(motion)||!object(motion.elapsedMs)||Object.keys(STUDIO_PAINT_STEP_MS).some(group=>!validTime(motion.elapsedMs[group]))) throw new TypeError('画稿时序状态无效。');
  if(!validTime(dtMs)) throw new TypeError('画稿时序间隔需要非负有限毫秒数。');
  if(!object(sequences)) throw new TypeError('需要此姿态实际可用的顺序画稿。');
  const goal=copyState(target);
  for(const [group,states] of Object.entries(sequences)) {
    if(!['eyeLeft','eyeRight','mouth'].includes(group)||!Array.isArray(states)||states.length<2
      ||new Set(states).size!==states.length||states.some(state=>typeof state!=='string'||!state)) throw new TypeError('顺序画稿登记无效。');
  }
  if(motion.frameState===null) return {frameState:goal,moving:false,motion:freezeMotion(goal,{eyeLeft:0,eyeRight:0,mouth:0})};
  const current=copyState(motion.frameState),frameState={...goal};
  const elapsedMs={};let moving=false;
  for(const group of ['eyeLeft','eyeRight','mouth']) {
    const step=STUDIO_PAINT_STEP_MS[group],elapsed=Math.min(step*2,motion.elapsedMs[group]+dtMs);
    elapsedMs[group]=Math.min(step,elapsed);
    const sequence=sequences[group],canStep=elapsed+.75>=step;
    if(!sequence) continue;
    const from=sequence.indexOf(current[group]),to=sequence.indexOf(goal[group]);
    // Special authored mouths (pucker/press/lateral) are independent states,
    // not points on the neutral-to-open jaw sequence, and switch directly.
    if(from<0||to<0||from===to) continue;
    frameState[group]=canStep?sequence[from+Math.sign(to-from)]:current[group];
    // Preserve only a sub-step remainder, making 30/60 Hz motion duration
    // similar. A long stall never creates a debt to replay at zero elapsed.
    if(canStep) elapsedMs[group]=elapsed>=step*2?0:Math.max(0,elapsed-step);
    moving ||= frameState[group]!==goal[group];
  }
  return {frameState,moving,motion:freezeMotion(frameState,elapsedMs)};
}
