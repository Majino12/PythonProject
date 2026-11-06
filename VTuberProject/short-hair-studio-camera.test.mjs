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
  const wait=deferred(),h=harness({loadTracker:()=>wait.promise});const started=h.camera.start();h.camera.dispose();wait.resolve(h.tracker);
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
  const first=h.camera.start();h.camera.stop();const second=h.camera.start();h.camera.dispose();wait.resolve(h.tracker);
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
  const restarted=h.camera.start();h.camera.stop();h.camera.dispose();waiting.resolve(replacement);
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
