import test from 'node:test';
import assert from 'node:assert/strict';
import {StudioFaceWorkerClient,createWorkerFaceTracker} from './short-hair-tracking-worker-client.js';
import {createFaceWorkerHandler} from './short-hair-face-worker-runtime.js';
class WorkerMock {
  messages=[];terminated=0;
  postMessage(data,transfer){this.messages.push({data,transfer});}
  emit(data){this.onmessage({data});}
  terminate(){this.terminated++;}
}
const bitmap=()=>({closed:0,close(){this.closed++;}});
test('worker client explicitly initializes CPU and transfers a bitmap exactly once',async()=>{
  const worker=new WorkerMock(),client=new StudioFaceWorkerClient({workerFactory:()=>worker});
  assert.equal(worker.messages.length,0);const init=client.initialize();
  assert.equal(worker.messages[0].data.delegate,'CPU');worker.emit({type:'ready',id:1});await init;
  const input=bitmap(),task=client.detectForVideo(input,120);
  assert.deepEqual(worker.messages[1].transfer,[input]);assert.equal(worker.messages[1].data.timestampMs,120);
  worker.emit({type:'result',id:2,result:{faceLandmarks:[]},durationMs:12});
  assert.deepEqual(await task,{result:{faceLandmarks:[]},durationMs:12});assert.equal(input.closed,0,'worker owns the transferred bitmap');
  client.close();client.close();assert.equal(worker.terminated,1);assert.equal(client.pending.size,0);
});
test('worker initialization timeout is bounded and terminates the incomplete task',async()=>{
  const worker=new WorkerMock();await assert.rejects(createWorkerFaceTracker({workerFactory:()=>worker,initTimeoutMs:5}),/超时/);
  assert.equal(worker.terminated,1);
});
test('aborting model initialization immediately terminates its worker without waiting for timeout',async()=>{
  const worker=new WorkerMock(),abort=new AbortController();
  const loading=createWorkerFaceTracker({workerFactory:()=>worker,signal:abort.signal});
  const rejected=assert.rejects(loading,/取消/);abort.abort();await rejected;assert.equal(worker.terminated,1);
  worker.emit({type:'ready',id:1});assert.equal(worker.terminated,1);
});
test('worker inference timeout releases the worker and rejects its pending request',async()=>{
  const worker=new WorkerMock(),client=new StudioFaceWorkerClient({workerFactory:()=>worker,inferenceTimeoutMs:5});
  const init=client.initialize();worker.emit({type:'ready',id:1});await init;
  await assert.rejects(client.detectForVideo(bitmap(),0),/超时/);assert.equal(worker.terminated,1);assert.equal(client.pending.size,0);
});
test('failed transfer closes the still-owned main-thread bitmap',async()=>{
  const worker=new WorkerMock(),client=new StudioFaceWorkerClient({workerFactory:()=>worker});
  worker.postMessage=()=>{throw new Error('cannot transfer');};const input=bitmap();
  await assert.rejects(client.detectForVideo(input,0),/cannot transfer/);assert.equal(input.closed,1);assert.equal(client.pending.size,0);client.close();
});
test('worker crashes and disposal reject waiting callers; late results cannot revive them',async()=>{
  const worker=new WorkerMock(),client=new StudioFaceWorkerClient({workerFactory:()=>worker});
  const init=client.initialize(),rejected=assert.rejects(init,/crashed/);worker.onerror({message:'crashed'});await rejected;
  worker.emit({type:'ready',id:1});assert.equal(client.closed,true);assert.equal(worker.terminated,1);
  const input=bitmap();await assert.rejects(client.detectForVideo(input,1),/关闭/);assert.equal(input.closed,1);
});
test('malformed worker results cannot enter the camera result queue',async()=>{
  const worker=new WorkerMock(),client=new StudioFaceWorkerClient({workerFactory:()=>worker});
  const task=client.detectForVideo(bitmap(),0);worker.emit({type:'result',id:1,result:{},durationMs:1});
  await assert.rejects(task,/结果无效/);client.close();
});
test('runtime processes a transferred image and always closes its bitmap',async()=>{
  const messages=[],seen=[];let clock=0;
  const handler=createFaceWorkerHandler({loadTracker:async options=>{seen.push(options);return{detectForVideo(image,t){seen.push(t);return{faceLandmarks:[]};}};},
    postMessage:message=>messages.push(message),clock:()=>clock+=7});
  await handler({type:'init',id:1});const input=bitmap();await handler({type:'detect',id:2,bitmap:input,timestampMs:100});
  assert.equal(input.closed,1);assert.deepEqual(seen,[{delegate:'CPU'},100]);
  assert.deepEqual(messages[1],{type:'result',id:2,result:{faceLandmarks:[]},durationMs:7});
});
test('runtime releases bitmaps after detector errors, malformed requests and requests before initialization',async()=>{
  const messages=[],handler=createFaceWorkerHandler({loadTracker:async()=>({detectForVideo(){throw new Error('bad detector');}}),postMessage:m=>messages.push(m)});
  const early=bitmap();await handler({type:'detect',id:1,bitmap:early,timestampMs:0});assert.equal(early.closed,1);
  await handler({type:'init',id:2});
  for(const [type,timestampMs] of [['detect',1],['detect',NaN],['unknown',2]]){
    const input=bitmap();await handler({type,id:3,bitmap:input,timestampMs});assert.equal(input.closed,1);assert.equal(messages.at(-1).type,'error');
  }
});
