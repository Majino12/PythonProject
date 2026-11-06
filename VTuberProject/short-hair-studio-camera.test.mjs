import test from 'node:test';
import assert from 'node:assert/strict';
import {ShortHairStudioCamera,StudioInferenceBudget} from './short-hair-studio-camera.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function harness(overrides={}){
  const states=[],events={},calls={load:0,media:0,stops:0,closed:0,detect:0};
  const track={stop(){calls.stops++;},addEventListener(type,fn){events[type]=fn;}};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
  const tracker={close(){calls.closed++;},detectForVideo(){calls.detect++;return{faceLandmarks:[]};}};
  const video={srcObject:null,readyState:2,currentTime:0,play:async()=>{}};
  const camera=new ShortHairStudioCamera(video,{onState:s=>states.push(s),loadTracker:async()=>{calls.load++;return tracker;},
    getUserMedia:async c=>{calls.media++;assert.equal(c.audio,false);return stream;},...overrides});
  return{camera,video,stream,tracker,events,calls,states};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function workerHarness(overrides={}){
  const workerCalls={loads:0,detect:0,closed:0,bitmaps:[],delegates:[]};
  const task={inferenceMode:'worker',close(){workerCalls.closed++;},async detectForVideo(bitmap){workerCalls.detect++;bitmap.close();return{result:{faceLandmarks:[]},durationMs:7};}};
  const h=harness({workerSupported:()=>true,loadWorkerTracker:async options=>{workerCalls.loads++;workerCalls.delegates.push(options.delegate);return task;},
    createBitmap:async()=>{const value={closed:0,close(){this.closed++;}};workerCalls.bitmaps.push(value);return value;},...overrides});
  return{...h,workerCalls,task};
}
test('worker initialization is lazy, uses CPU by default and idle healthy tasks survive normal stop',async()=>{
  const h=workerHarness();assert.equal(h.workerCalls.loads,0);assert.equal(h.calls.media,0);
  await h.camera.start();assert.equal(h.camera.getMetrics(0).inferenceMode,'worker');assert.equal(h.calls.load,0);
  assert.deepEqual(h.workerCalls.delegates,['CPU']);h.camera.stop();await h.camera.start();
  assert.equal(h.workerCalls.loads,1);assert.equal(h.workerCalls.closed,0);h.camera.dispose();assert.equal(h.workerCalls.closed,1);
});
test('worker initialization failure transparently chooses an explicitly reported main-thread fallback',async()=>{
  const h=workerHarness({loadWorkerTracker:async()=>{throw new Error('worker unsupported');}});
  assert.equal(await h.camera.start(),true);assert.equal(h.calls.load,1);assert.equal(h.camera.getMetrics(0).inferenceMode,'main-thread');
  assert.equal(h.camera.getMetrics(0).fallbackReason,'worker-initialization-failed');assert.match(h.states.at(-1).message,/主线程兼容/);h.camera.dispose();
});
test('worker polling has at most one request in flight and consumes each completed sample once',async()=>{
  const response=deferred();let now=20;const h=workerHarness({clock:()=>now});
  h.task.detectForVideo=async bitmap=>{h.workerCalls.detect++;try{return await response.promise;}finally{bitmap.close();}};
  await h.camera.start();assert.equal(h.camera.poll(0),null);await settle();
  h.video.currentTime=.1;for(const time of [40,80,120])assert.equal(h.camera.poll(time),null);
  assert.equal(h.workerCalls.detect,1);assert.equal(h.camera.getMetrics(120).pending,true);
  response.resolve({result:{faceLandmarks:[]},durationMs:12});await settle();
  h.video.currentTime=0;const result=h.camera.poll(20);assert.equal(result.trackingSampleTimeMs,0);
  assert.equal(h.camera.poll(25),null);assert.equal(h.camera.getMetrics(25).resultLatencyMs,20);
  assert.equal(h.camera.getMetrics(25).sampleCount,1);assert.equal(h.workerCalls.bitmaps[0].closed,1);h.camera.dispose();
});
test('worker results retain capture time and expire during inference or while waiting for the next poll',async()=>{
  for(const completionTime of [20,300]){
    let timer=completionTime;const h=workerHarness({clock:()=>timer});await h.camera.start();h.camera.poll(0);await settle();
    assert.equal(h.camera.poll(301),null);assert.equal(h.camera.getMetrics(301).resultLatencyMs,completionTime);h.camera.dispose();
  }
});
test('stopping while a bitmap is being created closes its late result without sending it to a worker',async()=>{
  const pending=deferred();let closes=0;const h=workerHarness({createBitmap:()=>pending.promise});await h.camera.start();
  h.camera.poll(0);await settle();h.camera.stop();pending.resolve({close(){closes++;}});await settle();
  assert.equal(closes,1);assert.equal(h.workerCalls.detect,0);assert.equal(h.workerCalls.closed,1);assert.equal(h.camera.getMetrics(100).pending,false);
});
test('late inference after stop cannot publish or revive a cancelled camera session',async()=>{
  const pending=deferred();const h=workerHarness();h.task.detectForVideo=async bitmap=>{try{return await pending.promise;}finally{bitmap.close();}};
  await h.camera.start();h.camera.poll(0);await settle();h.camera.stop();pending.resolve({result:{faceLandmarks:[]},durationMs:10});await settle();
  assert.equal(h.camera.poll(50),null);assert.equal(h.camera.getMetrics(50).sampleCount,0);assert.equal(h.camera.active,false);
  assert.equal(h.workerCalls.closed,1);assert.equal(h.workerCalls.bitmaps[0].closed,1);
});
test('worker inference failure reaches lifecycle handling once and explicit retry uses a fresh main CPU task',async()=>{
  const h=workerHarness();h.task.detectForVideo=async bitmap=>{bitmap.close();throw new Error('worker task failed');};
  await h.camera.start();h.camera.poll(0);await settle();
  assert.equal(h.workerCalls.closed,1);assert.throws(()=>h.camera.poll(40),/worker task failed/);assert.equal(h.camera.poll(41),null);
  h.camera.stop();assert.equal(await h.camera.start(),true);assert.equal(h.calls.load,1);assert.equal(h.workerCalls.loads,1);
  assert.equal(h.camera.preferredDelegate,'CPU');assert.equal(h.camera.getMetrics(50).fallbackReason,'worker-runtime-failed');h.camera.dispose();
});
test('disposal during worker initialization closes the late worker and never requests camera permission',async()=>{
  const pending=deferred();const h=workerHarness({loadWorkerTracker:()=>pending.promise});
  const starting=h.camera.start();await settle();h.camera.dispose();pending.resolve(h.task);
  assert.equal(await starting,false);assert.equal(h.workerCalls.closed,1);assert.equal(h.calls.media,0);
});
test('an immediately cancelled start creates neither a worker nor a main-thread model',async()=>{
  const h=workerHarness();const starting=h.camera.start();h.camera.stop();
  assert.equal(await starting,false);assert.equal(h.workerCalls.loads,0);assert.equal(h.calls.load,0);assert.equal(h.calls.media,0);
});
test('late results from a cancelled initialization cannot replace a newer healthy worker',async()=>{
  const loads=[],tasks=[{inferenceMode:'worker',closed:0,close(){this.closed++;}},{inferenceMode:'worker',closed:0,close(){this.closed++;}}];
  const h=workerHarness({loadWorkerTracker:()=>{const wait=deferred();loads.push(wait);return wait.promise;}});
  const first=h.camera.start();await settle();h.camera.stop();const second=h.camera.start();await settle();
  loads[1].resolve(tasks[1]);assert.equal(await second,true);loads[0].resolve(tasks[0]);assert.equal(await first,false);
  assert.equal(h.camera.tracker,tasks[1]);assert.equal(tasks[0].closed,1);assert.equal(tasks[1].closed,0);
  assert.equal(h.calls.media,1);assert.equal(h.camera.active,true);h.camera.dispose();
});
test('an aborted loading rejection cannot clear a newer initialization promise',async()=>{
  const loads=[];const h=workerHarness({loadWorkerTracker:()=>{const wait=deferred();loads.push(wait);return wait.promise;}});
  const first=h.camera.start();await settle();h.camera.stop();const second=h.camera.start();await settle();
  const current=h.camera.trackerPromise;loads[0].reject(new Error('cancelled load'));assert.equal(await first,false);
  assert.equal(h.camera.trackerPromise,current);loads[1].resolve(h.task);assert.equal(await second,true);h.camera.dispose();
});
test('three consecutive expired worker results pause media and require an explicit compatibility restart',async()=>{
  let now=0;const h=workerHarness({clock:()=>now});await h.camera.start();
  h.task.detectForVideo=async bitmap=>{bitmap.close();return{result:{faceLandmarks:[]},durationMs:250};};
  for(let index=0;index<3;index++){
    now=index*300;h.video.currentTime=index;assert.equal(h.camera.poll(now),null);
    now+=260;await settle();assert.equal(h.camera.poll(now),null);
    assert.equal(h.camera.active,index<2);
  }
  assert.equal(h.calls.stops,1);assert.equal(h.workerCalls.closed,1);assert.equal(h.calls.load,0,'fallback does not block the main thread automatically');
  assert.equal(h.camera.getMetrics(now).staleResultCount,3);assert.equal(h.camera.getMetrics(now).fallbackReason,'worker-too-slow');
  assert.match(h.states.at(-1).message,/后台推理持续过慢/);assert.match(h.states.at(-1).message,/重新开启.*兼容模式/);
  assert.equal(await h.camera.start(),true);assert.equal(h.calls.load,1);assert.equal(h.workerCalls.loads,1);
  assert.equal(h.camera.inferenceMode,'main-thread');assert.equal(h.camera.preferredDelegate,'GPU');
  assert.equal(h.camera.getMetrics(now).fallbackReason,'worker-too-slow');h.camera.dispose();
});
test('a fresh consumed worker result resets the consecutive-expiry guard',async()=>{
  let now=0;const h=workerHarness({clock:()=>now});await h.camera.start();
  for(const [index,latency] of [260,260,20,260,260].entries()){
    now=index*300;h.video.currentTime=index;h.camera.poll(now);now+=latency;await settle();
    const result=h.camera.poll(now);assert.equal(Boolean(result),latency===20);assert.equal(h.camera.active,true);
  }
  assert.equal(h.camera.getMetrics(now).staleResultCount,4);assert.equal(h.camera.staleWorkerStreak,2);
  assert.equal(h.camera.getMetrics(now).fallbackReason,null);h.camera.dispose();
});
test('worker results expiring in the delivery queue also pause after three consecutive misses',async()=>{
  let now=0;const h=workerHarness({clock:()=>now});await h.camera.start();
  for(let index=0;index<3;index++){
    now=index*300;h.video.currentTime=index;h.camera.poll(now);now+=20;await settle();
    now+=230;assert.equal(h.camera.poll(now),null);
  }
  assert.equal(h.camera.active,false);assert.equal(h.camera.getMetrics(now).staleResultCount,3);
  assert.equal(h.workerCalls.closed,1);assert.equal(h.camera.getMetrics(now).fallbackReason,'worker-too-slow');
});
test('a worker that died while idle is replaced before a single restart requests media',async()=>{
  const events=[],h=workerHarness({loadTracker:async options=>{events.push(`load-${options.delegate}`);return h.tracker;},
    getUserMedia:async()=>{events.push('media');return h.stream;}});
  await h.camera.start();h.camera.stop();h.task.closed=true;events.length=0;
  assert.equal(await h.camera.start(),true);assert.deepEqual(events,['load-CPU','media']);
  assert.equal(h.workerCalls.loads,1);assert.equal(h.workerCalls.closed,1);assert.equal(h.camera.inferenceMode,'main-thread');
  assert.doesNotThrow(()=>h.camera.poll(100));assert.equal(h.camera.active,true);h.camera.dispose();
});
test('camera construction performs no model or permission work and successful stop releases all tracks',async()=>{
  const h=harness();assert.equal(h.calls.load,0);assert.equal(h.calls.media,0);
  assert.equal(await h.camera.start(),true);assert.equal(h.camera.active,true);assert.equal(h.video.srcObject,h.stream);
  h.camera.stop();assert.equal(h.calls.stops,1);assert.equal(h.video.srcObject,null);assert.equal(h.camera.active,false);
});
test('cancelling a model load cannot request camera permission afterward',async()=>{
  const wait=deferred(),h=harness({loadTracker:()=>wait.promise});
  const started=h.camera.start();h.camera.stop();wait.resolve(h.tracker);
  assert.equal(await started,false);assert.equal(h.calls.media,0);assert.equal(h.camera.active,false);
});
test('a stream arriving after permission cancellation is immediately stopped',async()=>{
  const wait=deferred(),requested=deferred(),h=harness({getUserMedia:()=>{requested.resolve();return wait.promise;}});
  const started=h.camera.start();await requested.promise;h.camera.stop();wait.resolve(h.stream);
  assert.equal(await started,false);assert.equal(h.calls.stops,1);assert.equal(h.video.srcObject,null);
});
test('cancelling pending video playback prevents a late camera reactivation',async()=>{
  const wait=deferred(),playing=deferred(),h=harness();h.video.play=()=>{playing.resolve();return wait.promise;};
  const started=h.camera.start();await playing.promise;h.camera.stop();wait.resolve();
  assert.equal(await started,false);assert.equal(h.camera.active,false);assert.equal(h.video.srcObject,null);assert.ok(h.calls.stops>=1);
});
test('camera permission rejection is recoverable and does not leave a starting state',async()=>{
  const error=new Error('denied');error.name='NotAllowedError';const h=harness({getUserMedia:async()=>{throw error;}});
  assert.equal(await h.camera.start(),false);assert.equal(h.camera.starting,false);assert.equal(h.camera.active,false);
  assert.equal(h.states.at(-1).status,'error');assert.match(h.states.at(-1).message,/权限/);
});
test('camera polling skips duplicate video frames, throttles work and closes after hardware disconnect',async()=>{
  const h=harness();await h.camera.start();h.camera.poll(0);h.camera.poll(40);assert.equal(h.calls.detect,1);
  h.video.currentTime=.1;h.camera.poll(20);assert.equal(h.calls.detect,1);h.camera.poll(40);assert.equal(h.calls.detect,2);
  h.events.ended();assert.equal(h.camera.active,false);assert.equal(h.video.srcObject,null);assert.equal(h.calls.stops,1);
});
test('disposing during a model load closes its late resource without requesting a stream',async()=>{
  const wait=deferred(),h=harness({loadTracker:()=>wait.promise});const started=h.camera.start();await settle();h.camera.dispose();wait.resolve(h.tracker);
  assert.equal(await started,false);assert.equal(h.calls.closed,1);assert.equal(h.calls.media,0);assert.equal(await h.camera.start(),false);
});
test('model loading failures can be retried without requesting camera permission on the failed attempt',async()=>{
  let attempts=0;const h=harness({loadTracker:async()=>{if(++attempts===1)throw new Error('offline');return h.tracker;}});
  assert.equal(await h.camera.start(),false);assert.equal(h.calls.media,0);assert.equal(h.camera.starting,false);
  assert.equal(await h.camera.start(),true);assert.equal(attempts,2);assert.equal(h.calls.media,1);h.camera.dispose();
});
test('permission rejection can recover using the already loaded model',async()=>{
  let attempts=0;const denied=new Error('denied');denied.name='NotAllowedError';
  const h=harness({getUserMedia:async()=>{if(++attempts===1)throw denied;return h.stream;}});
  assert.equal(await h.camera.start(),false);assert.equal(await h.camera.start(),true);assert.equal(h.calls.load,1);
  h.camera.dispose();assert.equal(h.calls.stops,1);assert.equal(h.calls.closed,1);
});
test('overlapping cancelled starts close a late tracker only once when the page is disposed',async()=>{
  const wait=deferred(),h=harness({loadTracker:()=>wait.promise});
  const first=h.camera.start();await settle();h.camera.stop();const second=h.camera.start();await settle();h.camera.dispose();wait.resolve(h.tracker);
  assert.deepEqual(await Promise.all([first,second]),[false,false]);assert.equal(h.calls.closed,1);assert.equal(h.calls.media,0);
});
test('inference metrics count only completed detector calls and measure detector time with a separate clock',async()=>{
  let timer=0;const h=harness({clock:()=>{timer+=7;return timer;}});await h.camera.start();
  h.camera.poll(0);h.camera.poll(50);
  assert.equal(h.camera.getMetrics(50).sampleCount,1);
  assert.equal(h.camera.getMetrics(50).inferenceFps,null);
  for(let now=40;now<=240;now+=40){h.video.currentTime=now/1000;h.camera.poll(now);}
  const metrics=h.camera.getMetrics(240);
  assert.equal(metrics.sampleCount,7);assert.equal(metrics.inferenceFps,25);assert.equal(metrics.meanInferenceMs,7);
  assert.equal(metrics.signalStale,true);assert.equal(metrics.signalAgeMs,null);
  h.camera.stop();assert.equal(h.camera.poll(400),null);assert.equal(h.camera.getMetrics(400).sampleCount,7);
  assert.equal(h.camera.getMetrics(240).inferenceFps,null);
  await h.camera.start();assert.equal(h.camera.getMetrics(500).sampleCount,0);h.camera.dispose();
});
test('detector errors propagate to lifecycle handling without becoming successful inference samples',async()=>{
  let timer=0;const h=harness({clock:()=>++timer});await h.camera.start();
  h.tracker.detectForVideo=()=>{throw new Error('detector failed');};
  assert.throws(()=>h.camera.poll(0),/detector failed/);
  assert.equal(h.camera.getMetrics(1).failedCount,1);assert.equal(h.camera.getMetrics(1).sampleCount,0);
  h.camera.dispose();
});
test('a failed detector is closed and an explicit restart builds a fresh CPU task',async()=>{
  const delegates=[],instances=[];
  const h=harness({loadTracker:async options=>{
    delegates.push(options.delegate);
    const instance={closed:0,close(){this.closed++;},detectForVideo(){if(instances.length===1)throw new Error('GPU context lost');return{faceLandmarks:[]};}};
    instances.push(instance);return instance;
  }});
  await h.camera.start();assert.throws(()=>h.camera.poll(0),/GPU context lost/);
  assert.equal(instances[0].closed,1);assert.equal(h.camera.tracker,null);assert.equal(h.camera.trackerPromise,null);
  h.camera.stop();assert.equal(await h.camera.start(),true);h.video.currentTime=.1;
  assert.doesNotThrow(()=>h.camera.poll(100));assert.deepEqual(delegates,['GPU','CPU']);
  assert.notEqual(instances[0],h.camera.tracker);h.camera.dispose();
  assert.deepEqual(instances.map(instance=>instance.closed),[1,1]);
});
test('normal stop and restart reuse the healthy task and do not force CPU fallback',async()=>{
  const h=harness();await h.camera.start();h.camera.poll(0);h.camera.stop();await h.camera.start();
  assert.equal(h.calls.load,1);assert.equal(h.calls.closed,0);assert.equal(h.camera.preferredDelegate,'GPU');h.camera.dispose();
});
test('a cleanup exception cannot hide the original detector error or block a fresh retry',async()=>{
  let loads=0;const broken={close(){throw new Error('cleanup context lost');},detectForVideo(){throw new Error('original inference failure');}};
  const h=harness({loadTracker:async()=>++loads===1?broken:h.tracker});await h.camera.start();
  assert.throws(()=>h.camera.poll(0),/original inference failure/);assert.equal(h.camera.tracker,null);
  h.camera.stop();assert.equal(await h.camera.start(),true);assert.equal(loads,2);h.camera.dispose();
});
test('a cancelled replacement load never reopens the camera and disposal closes its late task',async()=>{
  const waiting=deferred();let loads=0,closed=0;
  const broken={detectForVideo(){throw new Error('failed');},close(){closed++;}};
  const replacement={close(){closed++;}};
  const h=harness({loadTracker:()=>++loads===1?Promise.resolve(broken):waiting.promise});
  await h.camera.start();assert.throws(()=>h.camera.poll(0),/failed/);h.camera.stop();
  const restarted=h.camera.start();await settle();h.camera.stop();h.camera.dispose();waiting.resolve(replacement);
  assert.equal(await restarted,false);assert.equal(h.calls.media,1);assert.equal(closed,2);
});
test('inference budget backs off only after sustained measured cost and reports its effective target',()=>{
  const budget=new StudioInferenceBudget();assert.equal(budget.fps,30);
  for(let i=0;i<3;i++)budget.record(40,i*40);assert.equal(budget.fps,30);
  budget.record(40,120);assert.equal(budget.fps,20);assert.equal(budget.intervalMs,50);
  for(let i=0;i<4;i++)budget.record(40,160+i*50);assert.equal(budget.fps,15);
  assert.equal(budget.intervalMs,1000/15);
});
test('budget hysteresis and dwell prevent rapid upgrades or oscillation around a threshold',()=>{
  const budget=new StudioInferenceBudget();for(let i=0;i<8;i++)budget.record(40,i*70);
  for(let i=0;i<30;i++)budget.record(5,600+i*20);assert.equal(budget.fps,15);
  budget.record(5,2500);assert.equal(budget.fps,20);
  for(let i=0;i<40;i++)budget.record(i%2?19:17,2550+i*50);assert.equal(budget.fps,20);
  for(let i=0;i<40;i++)budget.record(5,4600+i*50);assert.equal(budget.fps,30);
  budget.record(NaN,9000);budget.record(-1,9000);assert.equal(budget.fps,30);
});
test('camera obeys a slower inference budget without reprocessing frames and resets it on restart',async()=>{
  let timer=0;const h=harness({clock:()=>{timer+=40;return timer;}});await h.camera.start();
  for(let i=0;i<8;i++){h.video.currentTime=i/10;h.camera.poll(i*100);}
  assert.equal(h.camera.getMetrics(700).inferenceBudgetFps,15);assert.equal(h.calls.detect,8);
  h.video.currentTime=.9;assert.equal(h.camera.poll(740),null);assert.equal(h.calls.detect,8);
  h.camera.poll(770);assert.equal(h.calls.detect,9);h.camera.poll(850);assert.equal(h.calls.detect,9);
  h.camera.stop();await h.camera.start();assert.equal(h.camera.getMetrics(900).inferenceBudgetFps,30);h.camera.dispose();
});
test('face signal expires through skipped or empty detections and recovers only with usable landmarks',async()=>{
  const h=harness();await h.camera.start();
  const landmarks=Array.from({length:468},()=>({x:.5,y:.5,z:0}));
  landmarks[33]={x:.4,y:.4};landmarks[263]={x:.6,y:.4};landmarks[234]={x:.3,y:.5};landmarks[454]={x:.7,y:.5};
  h.tracker.detectForVideo=()=>({faceLandmarks:[landmarks]});h.camera.poll(0);
  assert.equal(h.camera.getMetrics(0).signalStale,false);assert.equal(h.camera.getMetrics(0).signalAgeMs,0);
  h.camera.poll(250);assert.equal(h.camera.getMetrics(250).signalStale,true);
  h.video.currentTime=.3;h.tracker.detectForVideo=()=>({faceLandmarks:[]});h.camera.poll(280);
  assert.equal(h.camera.getMetrics(280).signalAgeMs,280);
  h.video.currentTime=.4;h.tracker.detectForVideo=()=>({faceLandmarks:[landmarks]});h.camera.poll(320);
  assert.equal(h.camera.getMetrics(320).signalStale,false);h.camera.dispose();
});
