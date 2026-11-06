import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, get} from 'node:http';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createStudioOutputRelay} from './short-hair-studio-relay.mjs';
import {StudioOutputPublisher} from './short-hair-studio-publisher.js';
import {validateOutputFrame,validateOutputEnvelope,drawOutputFrame} from './short-hair-studio-output-model.js';
import {sanitizeChannels} from './expression-model.js';
import {poseHeadCoordinates} from './short-hair-pose-motion.js';

const senderId='output-test-sender';
const neutral={eyeLeft:'open',eyeRight:'open',mouth:'neutral',browLeft:'neutral',browRight:'neutral'};
const frame=(mouth='neutral')=>({poseId:'front',coefficients:sanitizeChannels({jawOpen:mouth==='openWide'?1:0}),
  state:{...neutral,mouth},faceOnly:true,original:false});
const packet=(sequence,mouth='neutral',sender=senderId)=>({senderId:sender,sequence,frame:frame(mouth)});
async function receive(client,predicate) {
  // Periodic SSE snapshots can precede the response under a busy test runner.
  // Wait for the actual transition rather than assuming every packet is new.
  for(let attempt=0;attempt<12;attempt++) {
    const value=await client.next();if(predicate(value))return value;
  }
  throw new Error('Expected SSE transition was not delivered');
}
const mouthIs=mouth=>value=>value.active&&value.frame?.state?.mouth===mouth;

async function withRelay(run,options={}) {
  const relay=createStudioOutputRelay(options),connections=new Set(),errors=[];
  const server=createServer((request,response)=>{
    relay.handle(request,response).then(handled=>{if(!handled){response.writeHead(404);response.end();}})
      .catch(error=>{errors.push(error);response.destroy(error);});
  });
  server.on('connection',socket=>{connections.add(socket);socket.once('close',()=>connections.delete(socket));});
  const clients=[];
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin=`http://127.0.0.1:${server.address().port}`;
    const request=async(path,{method='GET',body,headers={}}={})=>{
      const response=await fetch(`${origin}/api/studio-output/${path}`,{method,
        headers:{...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...headers},
        ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
      const text=await response.text();
      return {status:response.status,headers:response.headers,body:text?JSON.parse(text):null};
    };
    const connect=()=>new Promise((resolve,reject)=>{
      const messages=[],waiters=[];let buffer='',response;
      const req=get(`${origin}/api/studio-output/events`,res=>{
        response=res;
        if(res.statusCode!==200){res.resume();reject(new Error(`SSE ${res.statusCode}`));return;}
        res.setEncoding('utf8');
        res.on('data',chunk=>{
          buffer+=chunk;
          let boundary;
          while((boundary=buffer.indexOf('\n\n'))>=0){
            const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            const line=event.split('\n').find(value=>value.startsWith('data: '));
            if(!line)continue;
            const value=JSON.parse(line.slice(6));
            if(waiters.length)waiters.shift()(value);else messages.push(value);
          }
        });
        const client={
          next(){
            if(messages.length)return Promise.resolve(messages.shift());
            return new Promise((resolveNext,rejectNext)=>{
              const deliver=value=>{clearTimeout(timer);resolveNext(value);};
              const timer=setTimeout(()=>{const i=waiters.indexOf(deliver);if(i>=0)waiters.splice(i,1);rejectNext(new Error('SSE event timeout'));},1500);
              waiters.push(deliver);
            });
          },
          close(){req.destroy();response?.destroy();},
        };
        clients.push(client);resolve(client);
      });
      req.on('error',reject);
    });
    await run({origin,request,connect});
    assert.deepEqual(errors,[],'relay must handle request errors without leaking an exception to the server');
  } finally {
    for(const client of clients)client.close();
    relay.close();for(const socket of connections)socket.destroy();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
}

test('output validates bounded complete painted state and copies supported fields',()=>{
  const source=frame('pucker'),validated=validateOutputFrame(source);
  assert.deepEqual(validated,source);assert.notEqual(validated.state,source.state);assert.notEqual(validated.coefficients,source.coefficients);
  for(const value of [null,{}, {...source,poseId:'legacy-3d'}, {...source,original:1},
    {...source,state:{...neutral,mouth:'invented'}}, {...source,state:{...neutral,extra:'open'}},
    {...source,coefficients:{...source.coefficients,jawOpen:NaN}}, {...source,coefficients:{...source.coefficients,jawOpen:1.1}},
    {...source,coefficients:{...source.coefficients,unknown:0}}])assert.throws(()=>validateOutputFrame(value));
  assert.throws(()=>validateOutputEnvelope({...packet(1),sequence:-1}));
  assert.throws(()=>validateOutputEnvelope({...packet(1),senderId:'bad/id'}));
  assert.throws(()=>validateOutputEnvelope({...packet(1),sequence:Number.MAX_SAFE_INTEGER+1}));
});

test('output fits native aspect ratio inside the fixed canvas and clears previous alpha before opaque drawing',()=>{
  const operations=[],context={clearRect:(...args)=>operations.push(['clear',...args]),fillRect:(...args)=>operations.push(['fill',...args]),drawImage:(...args)=>operations.push(['draw',...args])};
  const canvas={width:1280,height:720,getContext:()=>context},source={width:630,height:460};
  drawOutputFrame(canvas,source);
  assert.equal(context.fillStyle,'#bfc6d3');assert.deepEqual(operations[0],['clear',0,0,1280,720]);
  assert.deepEqual(operations[1],['fill',0,0,1280,720]);
  const [kind,image,x,y,width,height]=operations[2];
  assert.equal(kind,'draw');assert.equal(image,source);assert.equal(y,0);assert.equal(height,720);
  assert.ok(Math.abs(width/height-630/460)<1e-12);assert.ok(Math.abs(x-(1280-width)/2)<1e-12);
});

test('output protocol retains continuous head coordinates and transparency with strict typed bounds',()=>{
  const value={...frame(),headPose:{yaw:.375,pitch:-.625},transparent:true};
  const result=validateOutputFrame(value);
  assert.deepEqual(result,value);assert.notEqual(result.headPose,value.headPose);
  value.headPose.yaw=1;assert.equal(result.headPose.yaw,.375);
  for(const headPose of [null,[],{}, {yaw:0}, {yaw:0,pitch:0,roll:0},
    {yaw:NaN,pitch:0},{yaw:0,pitch:Infinity},{yaw:'0',pitch:0},{yaw:1.001,pitch:0},{yaw:0,pitch:-1.001}])
    assert.throws(()=>validateOutputFrame({...frame(),headPose}));
  for(const transparent of [null,0,1,'true',{},[]])assert.throws(()=>validateOutputFrame({...frame(),transparent}));
  for(const transparent of [true,false])for(const yaw of [-1,0,1])for(const pitch of [-1,0,1])
    assert.deepEqual(validateOutputFrame({...frame(),headPose:{yaw,pitch},transparent}).headPose,{yaw,pitch});
  const legacy=validateOutputFrame(frame());assert.equal(Object.hasOwn(legacy,'headPose'),false);assert.equal(Object.hasOwn(legacy,'transparent'),false);
});

test('transparent output clears old opaque pixels and never paints gray behind the character',()=>{
  const operations=[],context={clearRect:(...args)=>operations.push(['clear',...args]),
    fillRect:(...args)=>operations.push(['fill',...args]),drawImage:(...args)=>operations.push(['draw',...args])};
  const canvas={width:1280,height:720,getContext:()=>context},source={width:1122,height:1402};
  drawOutputFrame(canvas,source,{transparent:false});operations.length=0;
  drawOutputFrame(canvas,source,{transparent:true});
  assert.deepEqual(operations.map(op=>op[0]),['clear','draw']);
  assert.deepEqual(operations[0],['clear',0,0,1280,720]);
  assert.equal(operations[1][1],source);assert.equal(operations[1][5],720);
  assert.ok(Math.abs(operations[1][4]/operations[1][5]-1122/1402)<1e-12);
});

test('HTTP relay preserves fractional head pose and alpha choice for a separate browser and late OBS receiver',async()=>{
  await withRelay(async({request,connect})=>{
    const receiver=await connect();await receiver.next();
    const sent={...packet(1,'parted'),frame:{...frame('parted'),headPose:{yaw:.375,pitch:-.625},transparent:true}};
    assert.equal((await request('state',{method:'POST',body:sent})).status,200);
    const received=await receive(receiver,mouthIs('parted'));
    assert.deepEqual(received.frame.headPose,sent.frame.headPose);assert.equal(received.frame.transparent,true);
    const late=await connect(),latest=await late.next();assert.deepEqual(latest.frame.headPose,sent.frame.headPose);assert.equal(latest.frame.transparent,true);
    for(const bad of [{headPose:{yaw:2,pitch:0}},{headPose:{yaw:0,pitch:0,roll:0}},{transparent:'true'}])
      assert.equal((await request('state',{method:'POST',body:{...packet(2),frame:{...frame(),...bad}}})).status,400);
    const unchanged=await connect(),last=await unchanged.next();assert.deepEqual(last.frame.headPose,sent.frame.headPose);
    assert.equal(last.frame.transparent,true);
  });
});

test('HTTP relay broadcasts to separate SSE clients and replays only the last frame to a late client',async()=>{
  await withRelay(async({request,connect})=>{
    const first=await connect(),second=await connect();
    assert.equal((await first.next()).active,false);assert.equal((await second.next()).active,false);
    const sent=await request('state',{method:'POST',body:packet(1,'parted')});
    assert.equal(sent.status,200);assert.equal(sent.body.clients,2);
    await receive(first,mouthIs('parted'));await receive(second,mouthIs('parted'));
    assert.equal((await request('state',{method:'POST',body:packet(2,'openWide')})).status,200);
    await receive(first,mouthIs('openWide'));await receive(second,mouthIs('openWide'));
    const late=await connect(),latest=await late.next();
    assert.equal(latest.active,true);assert.equal(latest.frame.state.mouth,'openWide');
    const status=await request('status');assert.equal(status.body.clients,3);assert.equal(Object.hasOwn(status.body,'frame'),false);
  });
});

test('HTTP stop clears every receiver and blocks delayed state while a newer generation can restart',async()=>{
  await withRelay(async({request,connect})=>{
    const receiver=await connect();await receiver.next();
    await request('state',{method:'POST',body:packet(1,'openWide')});await receive(receiver,mouthIs('openWide'));
    assert.equal((await request('stop',{method:'POST',body:{senderId,sequence:3}})).status,200);
    const stopped=await receive(receiver,value=>!value.active);assert.equal(stopped.frame,null);
    assert.equal((await request('state',{method:'POST',body:packet(2,'pucker')})).status,409);
    assert.equal((await request('state',{method:'POST',body:packet(3,'pucker')})).status,409);
    assert.equal((await request('status')).body.active,false);
    assert.equal((await request('state',{method:'POST',body:packet(4,'press')})).status,200);
    await receive(receiver,mouthIs('press'));
    const delayedStop=await request('stop',{method:'POST',body:{senderId,sequence:3}});
    assert.equal(delayedStop.body.stopped,false);assert.equal((await request('status')).body.active,true);
    assert.equal((await request('state',{method:'POST',body:packet(4,'neutral')})).status,409);
  });
});

test('HTTP stop arriving before its older in-flight state prevents accidental reactivation',async()=>{
  await withRelay(async({request,connect})=>{
    assert.equal((await request('stop',{method:'POST',body:{senderId,sequence:2}})).status,200);
    assert.equal((await request('state',{method:'POST',body:packet(1,'openWide')})).status,409);
    const late=await connect();assert.equal((await late.next()).active,false);
    assert.equal((await request('state',{method:'POST',body:packet(3,'parted')})).status,200);
    await receive(late,mouthIs('parted'));
  });
});

test('HTTP relay rejects foreign origins, cross-site fetches, unsupported methods and invalid payloads',async()=>{
  await withRelay(async({request})=>{
    assert.equal((await request('state',{method:'POST',body:packet(1),headers:{Origin:'https://unrelated.example'}})).status,403);
    assert.equal((await request('state',{method:'POST',body:packet(1),headers:{Origin:''}})).status,403);
    assert.equal((await request('state',{method:'POST',body:packet(1),headers:{'Content-Type':'text/plain'}})).status,403);
    assert.equal((await request('status',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await request('status',{headers:{Origin:'http://localhost:1'}})).status,403);
    assert.equal((await request('state')).status,405);
    assert.equal((await request('missing')).status,404);
    assert.equal((await request('state',{method:'POST',body:'not json'})).status,400);
    assert.equal((await request('state',{method:'POST',body:{}})).status,400);
    assert.equal((await request('stop',{method:'POST',body:{senderId,sequence:-1}})).status,400);
    assert.equal((await request('status')).body.active,false);
  });
});

test('HTTP relay rejects an oversized payload and remains available for valid requests',async()=>{
  await withRelay(async({request})=>{
    const rejected=await request('state',{method:'POST',body:JSON.stringify({...packet(1),padding:'x'.repeat(9000)})});
    assert.ok([400,413].includes(rejected.status));
    assert.equal((await request('status')).body.active,false);
    assert.equal((await request('state',{method:'POST',body:packet(1)})).status,200);
  });
});

test('HTTP relay enforces receiver limit and prevents a second live sender from replacing an active one',async()=>{
  await withRelay(async({request,connect})=>{
    const receiver=await connect();await receiver.next();
    assert.equal((await request('events')).status,503);
    assert.equal((await request('state',{method:'POST',body:packet(1)})).status,200);await receive(receiver,mouthIs('neutral'));
    assert.equal((await request('state',{method:'POST',body:packet(1,'openWide','second-sender')})).status,409);
    await request('stop',{method:'POST',body:{senderId,sequence:2}});await receive(receiver,value=>!value.active);
    assert.equal((await request('state',{method:'POST',body:packet(1,'openWide','second-sender')})).status,200);
    await receive(receiver,mouthIs('openWide'));
  },{maxClients:1});
});

test('HTTP status and periodic SSE flag an expired signal while retaining its final frame, then recover on renewal',async()=>{
  let time=100;
  await withRelay(async({request,connect})=>{
    const receiver=await connect(),empty=await receiver.next();
    assert.equal(empty.active,false);assert.equal(empty.stale,false);
    await request('state',{method:'POST',body:packet(1,'pucker')});
    const current=await receive(receiver,mouthIs('pucker'));assert.equal(current.stale,false);assert.equal(current.updatedAt,100);
    time=5100;assert.equal((await request('status')).body.stale,false);
    time=5101;
    const status=(await request('status')).body;assert.equal(status.active,true);assert.equal(status.stale,true);
    // No new state is posted: the relay's real SSE timer must report staleness.
    const expired=await receive(receiver,value=>value.stale);assert.equal(expired.active,true);
    assert.equal(expired.frame.state.mouth,'pucker');assert.equal(expired.updatedAt,100);
    time=5200;await request('state',{method:'POST',body:packet(2,'press')});
    const recovered=await receive(receiver,mouthIs('press'));assert.equal(recovered.stale,false);assert.equal(recovered.updatedAt,5200);
    assert.equal(recovered.frame.state.mouth,'press');assert.equal((await request('status')).body.stale,false);
    time=10201;await request('stop',{method:'POST',body:{senderId,sequence:3}});
    const stopped=await receive(receiver,value=>!value.active);assert.equal(stopped.stale,false);assert.equal(stopped.frame,null);
  },{now:()=>time});
});

test('repeated identical state renews a static sender lease without allowing another publisher to take it',async()=>{
  let time=0;
  await withRelay(async({request})=>{
    await request('state',{method:'POST',body:packet(1)});
    time=4000;await request('state',{method:'POST',body:packet(2)});
    time=8000;assert.equal((await request('status')).body.stale,false);
    assert.equal((await request('state',{method:'POST',body:packet(1,'openWide','another-sender')})).status,409);
    time=9001;assert.equal((await request('status')).body.stale,true);
    assert.equal((await request('state',{method:'POST',body:packet(1,'openWide','another-sender')})).status,200);
    assert.equal((await request('status')).body.stale,false);
  },{now:()=>time});
});

function deferred() {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const response=(ok=true,result={clients:1},status=ok?200:400)=>({ok,status,json:async()=>result});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fakeClock() {
  let time=0,nextId=0;const timers=new Map();
  return {now:()=>time,setTimer(callback,delay){const id=++nextId;timers.set(id,{at:time+delay,callback});return id;},clearTimer:id=>timers.delete(id),
    get size(){return timers.size;},async advance(delta){const end=time+delta;
      while(true){const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].callback();await turn();}
      time=end;}};
}
function controlledPublisher() {
  const calls=[],states=[],clock=fakeClock();
  const publisher=new StudioOutputPublisher({senderId,now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,onState:state=>states.push(state),fetcher:(url,options)=>{
    const pending=deferred();calls.push({url,options,body:JSON.parse(options.body),...pending});return pending.promise;
  }});
  return {publisher,calls,states,clock};
}

test('publisher has one in-flight state and coalesces all queued updates to the latest frame',async()=>{
  const {publisher,calls,states}=controlledPublisher();publisher.start();
  publisher.publish(frame('parted'));publisher.publish(frame('openSmall'));publisher.publish(frame('openWide'));
  assert.equal(calls.length,1);assert.equal(calls[0].body.frame.state.mouth,'parted');
  calls[0].resolve(response());await turn();
  assert.equal(calls.length,2);assert.equal(calls[1].body.frame.state.mouth,'openWide');
  assert.equal(calls[1].body.sequence,2);assert.equal(calls[0].options.method,'POST');
  calls[1].resolve(response());await turn();
  assert.equal(publisher.sending,false);assert.equal(publisher.pending,null);assert.equal(states.at(-1).status,'active');
});

test('publisher stop invalidates old replies and restart sends the new generation with increasing sequence',async()=>{
  const {publisher,calls,states}=controlledPublisher();publisher.start();publisher.publish(frame('parted'));
  const stop=publisher.stop();assert.equal(calls[1].url,'/api/studio-output/stop');assert.equal(calls[1].options.keepalive,true);
  publisher.start();publisher.publish(frame('pucker'));publisher.publish(frame('press'));
  calls[0].resolve(response(false,{error:'old generation error'}));await turn();
  assert.equal(publisher.enabled,true);assert.equal(states.some(state=>state.status==='error'),false);
  assert.equal(calls.length,3);assert.equal(calls[2].body.frame.state.mouth,'press');
  assert.ok(calls[2].body.sequence>calls[1].body.sequence);assert.ok(calls[1].body.sequence>calls[0].body.sequence);
  calls[1].resolve(response());await stop;
  calls[2].resolve(response());await turn();assert.equal(states.at(-1).status,'active');
});

test('publisher stop clears pending updates and a late successful reply cannot reactivate its UI',async()=>{
  const {publisher,calls,states}=controlledPublisher();publisher.start();publisher.publish(frame('parted'));publisher.publish(frame('openWide'));
  const stop=publisher.stop();calls[1].resolve(response());await stop;
  calls[0].resolve(response());await turn();
  assert.equal(calls.length,2);assert.equal(publisher.enabled,false);assert.equal(publisher.pending,null);
  assert.equal(states.some(state=>state.status==='active'),false);
});

test('publisher stale network rejection cannot disable a restarted sender',async()=>{
  const {publisher,calls,states}=controlledPublisher();publisher.start();publisher.publish(frame());
  const stop=publisher.stop();publisher.start();publisher.publish(frame('openWide'));
  calls[0].reject(new Error('old request timed out'));await turn();
  assert.equal(publisher.enabled,true);assert.equal(states.some(state=>state.status==='error'),false);
  assert.equal(calls[2].body.frame.state.mouth,'openWide');
  calls[1].resolve(response());await stop;calls[2].resolve(response());await turn();
});

test('stopping a publisher which has never started makes no network request',async()=>{
  const {publisher,calls}=controlledPublisher();await publisher.stop();
  assert.equal(calls.length,0);assert.equal(publisher.enabled,false);
});

test('publisher deduplicates only successful snapshots and independently renews a static lease every second',async()=>{
  const {publisher,calls,clock}=controlledPublisher();publisher.start();const current=frame('parted');publisher.publish(current);
  current.state.mouth='pucker';assert.equal(calls[0].body.frame.state.mouth,'parted','publish snapshots mutable caller state');
  calls[0].resolve(response());await turn();
  for(let i=0;i<120;i++){publisher.publish(frame('parted'));await turn();}
  assert.equal(calls.length,1);
  await clock.advance(999);assert.equal(calls.length,1);
  await clock.advance(1);assert.equal(calls.length,2);assert.equal(calls[1].body.frame.state.mouth,'parted');
  calls[1].resolve(response());await turn();await clock.advance(1000);assert.equal(calls.length,3);
  calls[2].resolve(response());await turn();
  const stopped=publisher.stop();calls[3].resolve(response());await stopped;
  assert.equal(clock.size,0);await clock.advance(10000);assert.equal(calls.length,4);
});

test('publisher retries transient failures with only the latest frame and does not mark a failed frame as delivered',async()=>{
  for(const failure of ['network',408,429,500,503]) {
    const {publisher,calls,states,clock}=controlledPublisher();publisher.start();publisher.publish(frame('parted'));
    if(failure==='network')calls[0].reject(new Error('temporary network failure'));
    else calls[0].resolve(response(false,{error:'temporary relay failure'},failure));
    await turn();assert.equal(publisher.enabled,true);assert.equal(states.at(-1).status,'reconnecting');
    publisher.publish(frame('openSmall'));publisher.publish(frame('press'));
    await clock.advance(249);assert.equal(calls.length,1);
    await clock.advance(1);assert.equal(calls.length,2);assert.equal(calls[1].body.frame.state.mouth,'press');
    calls[1].resolve(response());await turn();assert.equal(states.at(-1).status,'active');assert.equal(publisher.failures,0);
    const stopped=publisher.stop();calls[2].resolve(response());await stopped;
  }
});

test('publisher retries an unchanged frame that has never succeeded',async()=>{
  const {publisher,calls,clock}=controlledPublisher();publisher.start();publisher.publish(frame());
  calls[0].reject(new Error('offline'));await turn();publisher.publish(frame());await clock.advance(250);
  assert.equal(calls.length,2);assert.deepEqual(calls[1].body.frame,frame());
  calls[1].resolve(response());await turn();const stopped=publisher.stop();calls[2].resolve(response());await stopped;
});

test('publisher resends the previous successful state after an uncertain failed change',async()=>{
  const {publisher,calls,clock}=controlledPublisher();publisher.start();publisher.publish(frame());calls[0].resolve(response());await turn();
  publisher.publish(frame('press'));calls[1].reject(new Error('response was lost'));await turn();publisher.publish(frame());
  await clock.advance(250);assert.equal(calls.length,3);assert.deepEqual(calls[2].body.frame,frame());
  calls[2].resolve(response());await turn();const stopped=publisher.stop();calls[3].resolve(response());await stopped;
});

test('publisher bounds retries and preserves the last successful relay frame on exhaustion',async()=>{
  const {publisher,calls,states,clock}=controlledPublisher();publisher.start();publisher.publish(frame('parted'));
  const delays=[250,500,1000,2000,4000,4000];
  for(let attempt=0;attempt<=delays.length;attempt++) {
    calls[attempt].reject(new Error('server offline'));await turn();
    if(attempt<delays.length){assert.equal(publisher.enabled,true);await clock.advance(delays[attempt]);}
  }
  assert.equal(calls.length,7);assert.equal(publisher.enabled,false);assert.equal(clock.size,0);
  assert.equal(calls.every(call=>call.url.endsWith('/state')),true);assert.match(states.at(-1).message,/已保留最后画面/);
  await clock.advance(30000);assert.equal(calls.length,7);
  publisher.start();publisher.publish(frame('press'));calls[7].resolve(response());await turn();assert.equal(states.at(-1).status,'active');
  const stopped=publisher.stop();calls[8].resolve(response());await stopped;
});

test('publisher conflicts and invalid requests stop immediately with explicit error and no automatic clear',async()=>{
  for(const status of [400,403,409,413]) {
    const {publisher,calls,states,clock}=controlledPublisher();publisher.start();publisher.publish(frame());
    calls[0].resolve(response(false,{error:'invalid publisher state'},status));await turn();
    assert.equal(publisher.enabled,false);assert.equal(publisher.pending,null);assert.equal(states.at(-1).status,'error');
    if(status===409)assert.match(states.at(-1).message,/占用.*冲突/);
    await clock.advance(30000);assert.equal(calls.length,1);assert.equal(clock.size,0);
  }
});

test('publisher explicit stop cancels delayed recovery and aborts in-flight delivery',async()=>{
  const {publisher,calls,clock}=controlledPublisher();publisher.start();publisher.publish(frame());
  const stop=publisher.stop();assert.equal(calls[0].options.signal.aborted,true);calls[1].resolve(response());await stop;
  calls[0].reject(new Error('aborted'));await turn();await clock.advance(30000);assert.equal(calls.length,2);
  publisher.start();publisher.publish(frame());calls[2].reject(new Error('offline'));await turn();assert.equal(clock.size,1);
  const again=publisher.stop();calls[3].resolve(response());await again;assert.equal(clock.size,0);
  await clock.advance(30000);assert.equal(calls.length,4);
});

async function receiverHarness({render,loader}={}) {
  const source=readFileSync(new URL('./short-hair-output.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'');
  const scheduled=new Map(),draws=[],outputDraws=[],events={},connections=[],notice={};let nextId=0,clears=0,fills=0;
  const canvas={width:1280,height:720,getContext:()=>({clearRect(){clears++;},fillRect(){fills++;}})};
  const document={hidden:false,title:'',querySelector:selector=>selector==='#outputCanvas'?canvas:notice,
    createElement:()=>({width:630,height:460}),addEventListener(type,callback){events[type]=callback;}};
  const windowEvents={};
  const context=vm.createContext({document,window:{addEventListener(type,callback){windowEvents[type]=callback;}},
    loadContinuousShortHairAssets:loader|| (async()=>({})),poseHeadCoordinates,validateOutputFrame,
    drawOutputFrame(target,native,options){outputDraws.push({target,native,options});},
    renderContinuousShortHairStudio(native,assets,poseId,coefficients,previous,options){draws.push({poseId,state:options.stateOverride,coefficients,options});return render?.();},
    EventSource:class {constructor(url){this.url=url;this.closed=false;connections.push(this);}close(){this.closed=true;}},
    requestAnimationFrame(callback){scheduled.set(++nextId,callback);return nextId;},cancelAnimationFrame(id){scheduled.delete(id);}});
  vm.runInContext(source,context);await turn();
  return {notice,document,draws,outputDraws,scheduled,events,windowEvents,connections,get clears(){return clears;},get fills(){return fills;},
    send(value){connections[0].onmessage({data:JSON.stringify(value)});},
    step(){const entry=scheduled.entries().next().value;if(entry){scheduled.delete(entry[0]);entry[1]();}}};
}

test('receiver passes continuous coordinates and transparency through both character rendering and output compositing',async()=>{
  const h=await receiverHarness();
  assert.equal(h.fills,0,'receiver startup remains transparent');
  const value={...frame('openSmall'),headPose:{yaw:-.3125,pitch:.6875},transparent:true};
  h.send({active:true,frame:value});h.step();
  assert.equal(h.draws.length,1);assert.deepEqual(h.draws[0].options.headPose,value.headPose);
  assert.equal(h.draws[0].options.transparent,true);assert.equal(h.outputDraws[0].options.transparent,true);
  assert.deepEqual(h.draws[0].coefficients,value.coefficients);
  h.send({active:true,frame:{...value,headPose:{yaw:.125,pitch:-.25},transparent:false}});h.step();
  assert.deepEqual(h.draws[1].options.headPose,{yaw:.125,pitch:-.25});assert.equal(h.draws[1].options.transparent,false);
  assert.equal(h.outputDraws[1].options.transparent,false);
  h.send({active:false,frame:null});assert.equal(h.fills,0,'explicit stop clears rather than filling opaque gray');
  h.windowEvents.pagehide();
});

test('receiver accepts legacy discrete packets by assigning their exact grid coordinates',async()=>{
  const h=await receiverHarness();
  h.send({active:true,frame:{...frame(),poseId:'view-left-up'}});h.step();
  assert.deepEqual(h.draws[0].options.headPose,{yaw:-1,pitch:1});
  assert.equal(h.draws[0].options.transparent,false);assert.equal(h.outputDraws[0].options.transparent,false);
  h.windowEvents.pagehide();
});

test('receiver rejects invalid head or alpha packets before any renderer receives them',async()=>{
  const h=await receiverHarness();
  for(const bad of [{headPose:{yaw:2,pitch:0}},{headPose:{yaw:0}},{transparent:1}]){
    h.send({active:true,frame:{...frame(),...bad}});h.step();
    assert.equal(h.draws.length,0);assert.equal(h.outputDraws.length,0);assert.equal(h.notice.hidden,false);
  }
  h.windowEvents.pagehide();
});

test('receiver renders only the latest pending packet at its next animation frame',async()=>{
  const h=await receiverHarness();assert.equal(h.connections[0].url,'/api/studio-output/events');
  h.send({active:true,frame:frame('parted')});h.send({active:true,frame:frame('openWide')});
  assert.equal(h.scheduled.size,1);h.step();assert.equal(h.draws.length,1);assert.equal(h.draws[0].state.mouth,'openWide');
  assert.equal(h.notice.hidden,true);h.windowEvents.pagehide();assert.equal(h.connections[0].closed,true);
});

test('receiver stop clears the canvas before pending draw and a subsequent active packet recovers',async()=>{
  const h=await receiverHarness();h.send({active:true,frame:frame('pucker')});
  const before=h.clears;h.send({active:false,frame:null});assert.equal(h.clears,before+1);
  h.step();assert.equal(h.draws.length,0);assert.match(h.notice.textContent,/已停止/);
  h.send({active:true,frame:frame('press')});h.step();assert.equal(h.draws[0].state.mouth,'press');assert.equal(h.notice.hidden,true);
  h.windowEvents.pagehide();assert.equal(h.connections[0].closed,true);assert.equal(h.scheduled.size,0);
});

test('receiver invalid packet cannot leave an earlier queued image to overwrite its error',async()=>{
  const h=await receiverHarness();h.send({active:true,frame:frame('openWide')});
  h.send({active:true,frame:{}});h.step();
  assert.equal(h.draws.length,0);assert.match(h.notice.textContent,/无效/);assert.equal(h.notice.hidden,false);
  h.windowEvents.pagehide();
});

test('receiver stale packets retain the last character frame with a warning and fresh data removes it',async()=>{
  const h=await receiverHarness();h.send({active:true,stale:false,frame:frame('pucker')});h.step();
  const before=h.clears;
  h.send({active:true,stale:true,frame:frame('pucker')});h.step();
  assert.equal(h.clears,before);assert.equal(h.draws.at(-1).state.mouth,'pucker');
  assert.equal(h.notice.hidden,false);assert.equal(h.notice.className,'connection-warning');
  assert.match(h.notice.textContent,/信号中断.*保留最后画面/);assert.match(h.document.title,/信号中断/);
  h.send({active:true,stale:false,frame:frame('press')});h.step();
  assert.equal(h.draws.at(-1).state.mouth,'press');assert.equal(h.notice.hidden,true);assert.match(h.document.title,/已连接/);
  h.windowEvents.pagehide();
});

test('receiver transport failure warns immediately and a queued draw cannot hide that warning',async()=>{
  const h=await receiverHarness();h.send({active:true,stale:false,frame:frame('openWide')});
  const before=h.clears;h.connections[0].onerror();
  assert.equal(h.clears,before);assert.equal(h.notice.hidden,false);assert.match(h.notice.textContent,/保留最后画面/);
  h.step();assert.equal(h.notice.hidden,false);assert.equal(h.notice.className,'connection-warning');
  h.send({active:true,stale:false,frame:frame('neutral')});h.step();assert.equal(h.notice.hidden,true);
  h.windowEvents.pagehide();
});

test('receiver preserves the last successful output while recovering resources and renders the latest pending frame',async()=>{
  let ready=true;const h=await receiverHarness({render:()=>({didDraw:ready})});
  h.send({active:true,frame:frame('parted')});h.step();const before=h.clears;
  ready=false;h.send({active:true,frame:frame('press')});h.step();
  assert.equal(h.outputDraws.length,1);assert.equal(h.clears,before);assert.equal(h.scheduled.size,1);assert.match(h.notice.textContent,/恢复.*保留最后画面/);
  h.send({active:true,frame:frame('openWide')});h.step();assert.equal(h.outputDraws.length,1);assert.equal(h.scheduled.size,1);
  ready=true;h.step();assert.equal(h.outputDraws.length,2);assert.equal(h.draws.at(-1).state.mouth,'openWide');assert.equal(h.notice.hidden,true);
  h.windowEvents.pagehide();
});

test('receiver suspends recovery RAF in the background and resumes with the newest state on visibility',async()=>{
  let ready=false;const h=await receiverHarness({render:()=>({didDraw:ready})});
  h.send({active:true,frame:frame()});h.step();assert.equal(h.scheduled.size,1);
  h.document.hidden=true;h.events.visibilitychange();assert.equal(h.scheduled.size,0);
  h.send({active:true,frame:frame('pucker')});h.step();assert.equal(h.draws.length,1);assert.equal(h.scheduled.size,0);
  ready=true;h.document.hidden=false;h.events.visibilitychange();assert.equal(h.scheduled.size,1);h.step();
  assert.equal(h.draws.at(-1).state.mouth,'pucker');assert.equal(h.notice.hidden,true);h.windowEvents.pagehide();
});

test('receiver keeps its successful image on invalid packets or a rendering exception and recovers from later valid state',async()=>{
  let fail=false;const h=await receiverHarness({render:()=>{if(fail)throw new Error('unavailable image');return {didDraw:true};}});
  h.send({active:true,frame:frame()});h.step();const before=h.clears;
  h.send({active:true,frame:{}});assert.equal(h.clears,before);assert.match(h.notice.textContent,/无效.*保留最后画面/);
  fail=true;h.send({active:true,frame:frame('press')});h.step();assert.equal(h.clears,before);assert.equal(h.outputDraws.length,1);
  assert.match(h.notice.textContent,/unavailable image.*保留最后画面/);assert.equal(h.scheduled.size,0);
  fail=false;h.send({active:true,frame:frame('press')});h.step();assert.equal(h.outputDraws.length,2);assert.equal(h.notice.hidden,true);h.windowEvents.pagehide();
});

test('receiver does not redraw duplicate relay heartbeats but updates stale and fresh notices',async()=>{
  const h=await receiverHarness();h.send({active:true,frame:frame()});h.step();
  h.send({active:true,stale:true,frame:frame()});h.step();assert.equal(h.draws.length,1);assert.equal(h.notice.hidden,false);
  h.send({active:true,stale:false,frame:frame()});h.step();assert.equal(h.draws.length,1);assert.equal(h.notice.hidden,true);
  h.windowEvents.pagehide();
});

test('receiver forwards user framing independently from native character motion',async()=>{
  const h=await receiverHarness(),composition={scale:1.6,x:.25,y:-.5,mirror:true};
  h.send({active:true,frame:{...frame(),composition}});h.step();assert.deepEqual(h.outputDraws[0].options.composition,composition);
  assert.equal(h.draws[0].options.composition,undefined);h.windowEvents.pagehide();
});

test('receiver disposes assets loaded after its page has already closed without opening an SSE connection',async()=>{
  const pending=deferred();let disposed=0;const h=await receiverHarness({loader:()=>pending.promise});
  h.windowEvents.pagehide();pending.resolve({flowRenderer:{dispose(){disposed++;}}});await turn();
  assert.equal(disposed,1);assert.equal(h.connections.length,0);assert.equal(h.scheduled.size,0);
});

test('HTTP relay preserves user framing for late receivers and rejects out of range composition without replacing the last frame',async()=>{
  await withRelay(async({request,connect})=>{
    const composition={scale:2.5,x:-1,y:1,mirror:true};
    assert.equal((await request('state',{method:'POST',body:{...packet(1),frame:{...frame(),composition}}})).status,200);
    const receiver=await connect();assert.deepEqual((await receiver.next()).frame.composition,composition);
    for(const bad of [{scale:3,x:0,y:0,mirror:false},{scale:1,x:0,y:0},{scale:1,x:0,y:0,mirror:false,extra:1}])
      assert.equal((await request('state',{method:'POST',body:{...packet(2),frame:{...frame(),composition:bad}}})).status,400);
    const late=await connect();assert.deepEqual((await late.next()).frame.composition,composition);
  });
});

test('output protocol preserves bounded secondary motion while legacy frames keep it optional',()=>{
  assert.equal(Object.hasOwn(validateOutputFrame(frame()),'secondary'),false);
  const secondary={breath:.25,sway:-.5,hair:1};const result=validateOutputFrame({...frame(),secondary});
  assert.deepEqual(result.secondary,secondary);assert.notEqual(result.secondary,secondary);
  for(const value of [null,{}, {breath:0,sway:0},{breath:0,sway:0,hair:2},{breath:0,sway:NaN,hair:0},
    {breath:'0',sway:0,hair:0},{breath:0,sway:0,hair:0,extra:0}])assert.throws(()=>validateOutputFrame({...frame(),secondary:value}));
});

test('receiver forwards exact secondary motion without advancing a separate clock',async()=>{
  const h=await receiverHarness(),secondary={breath:.25,sway:-.5,hair:1};
  h.send({active:true,frame:{...frame(),secondary}});h.step();assert.deepEqual(h.draws[0].options.secondary,secondary);
  h.send({active:true,frame:{...frame(),secondary}});h.step();assert.equal(h.draws.length,1);
  h.windowEvents.pagehide();
});

test('receiver keeps its last image across a restarted empty relay but explicit stop still clears it',async()=>{
  const h=await receiverHarness();h.send({active:true,frame:frame('press')});h.step();const before=h.clears;
  h.connections[0].onerror();h.send({active:false,stopped:false,frame:null});
  assert.equal(h.clears,before);assert.match(h.notice.textContent,/信号中断.*保留最后画面/);
  h.send({active:true,stopped:false,frame:frame('press')});h.step();assert.equal(h.notice.hidden,true);assert.equal(h.draws.length,1);
  h.send({active:false,stopped:true,frame:null});assert.equal(h.clears,before+1);assert.match(h.notice.textContent,/已停止/);
  h.windowEvents.pagehide();
});

test('HTTP relay distinguishes initial empty state from explicit stop and relays secondary motion unchanged',async()=>{
  await withRelay(async({request,connect})=>{
    const receiver=await connect();assert.equal((await receiver.next()).stopped,false);
    const secondary={breath:.1,sway:-.5,hair:1};
    await request('state',{method:'POST',body:{...packet(1,'press'),frame:{...frame('press'),secondary}}});
    const current=await receive(receiver,mouthIs('press'));assert.equal(current.stopped,false);assert.deepEqual(current.frame.secondary,secondary);
    const late=await connect();assert.deepEqual((await late.next()).frame.secondary,secondary);
    await request('stop',{method:'POST',body:{senderId,sequence:2}});assert.equal((await receive(receiver,value=>!value.active)).stopped,true);
    await request('state',{method:'POST',body:packet(3)});assert.equal((await receive(receiver,mouthIs('neutral'))).stopped,false);
  });
});

test('HTTP explicit stop also clears retained receivers after the relay has restarted without an owner',async()=>{
  await withRelay(async({request,connect})=>{
    const receiver=await connect();assert.equal((await receiver.next()).stopped,false);
    await request('stop',{method:'POST',body:{senderId,sequence:8}});
    const current=await receive(receiver,value=>value.stopped);assert.equal(current.active,false);assert.equal(current.frame,null);
    assert.equal((await request('state',{method:'POST',body:packet(7)})).status,409);
  });
});

test('publisher default browser host functions retain their global receiver during delivery, renewal, recovery and stop',async()=>{
  const source=readFileSync(new URL('./short-hair-studio-publisher.js',import.meta.url),'utf8').replace(/^export /gm,'');
  const timers=new Map(),calls=[],states=[];let time=0,failNext=false;
  const context=vm.createContext({AbortController,testFrame:frame('parted'),hostTimers:timers,
    clockNow:()=>time,onPublisherState:state=>states.push(state),
    request(url,options){calls.push({url,options});if(failNext){failNext=false;return Promise.reject(new Error('temporary interruption'));}return Promise.resolve(response());}});
  // Browser timer/fetch APIs reject a receiver other than Window. Sloppy host
  // stubs model a plain global call binding Window, but reject publisher.method().
  vm.runInContext(`
    let nextTimer=0;
    globalThis.setTimeout=function(callback,delay){if(this!==globalThis)throw new TypeError('Illegal invocation: setTimeout');const id=++nextTimer;hostTimers.set(id,{callback,delay});return id;};
    globalThis.clearTimeout=function(id){if(this!==globalThis)throw new TypeError('Illegal invocation: clearTimeout');hostTimers.delete(id);};
    globalThis.fetch=function(...args){if(this!==globalThis)throw new TypeError('Illegal invocation: fetch');return request(...args);};
    globalThis.crypto={randomUUID(){if(this!==globalThis.crypto)throw new TypeError('Illegal invocation: randomUUID');return 'browser-host-sender';}};
    Date.now=clockNow;
    ${source}
    globalThis.publisher=new StudioOutputPublisher({onState:onPublisherState});
    publisher.start();publisher.publish(testFrame);
  `,context);
  await turn();assert.equal(calls.length,1);assert.equal(states.at(-1).status,'active');assert.equal(timers.size,1);
  assert.equal(JSON.parse(calls[0].options.body).senderId,'browser-host-sender');
  const fire=async delay=>{
    const entry=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(entry,`expected ${delay} ms browser timer`);
    timers.delete(entry[0]);time+=delay;entry[1].callback();await turn();
  };
  await fire(1000);assert.equal(calls.length,2);assert.equal(states.at(-1).status,'active');
  failNext=true;await fire(1000);assert.equal(calls.length,3);assert.equal(states.at(-1).status,'reconnecting');
  await fire(250);assert.equal(calls.length,4);assert.equal(states.at(-1).status,'active');
  await vm.runInContext('publisher.stop()',context);
  assert.equal(calls.at(-1).url,'/api/studio-output/stop');assert.equal(timers.size,0);assert.equal(context.publisher.enabled,false);
});
