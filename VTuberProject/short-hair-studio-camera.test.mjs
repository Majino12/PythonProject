import test from 'node:test';
import assert from 'node:assert/strict';
import {ShortHairStudioCamera} from './short-hair-studio-camera.js';
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
