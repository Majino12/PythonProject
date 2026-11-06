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
const response=(ok=true,result={clients:1})=>({ok,json:async()=>result});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function controlledPublisher() {
  const calls=[],states=[];
  const publisher=new StudioOutputPublisher({senderId,onState:state=>states.push(state),fetcher:(url,options)=>{
    const pending=deferred();calls.push({url,options,body:JSON.parse(options.body),...pending});return pending.promise;
  }});
  return {publisher,calls,states};
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

test('current-generation publisher failure discards pending frames and sends a newer stop envelope',async()=>{
  for(const mode of ['http','network']) {
    const {publisher,calls,states}=controlledPublisher();publisher.start();
    publisher.publish(frame('parted'));publisher.publish(frame('openWide'));
    if(mode==='http')calls[0].resolve(response(false,{error:'current sender rejected'}));
    else calls[0].reject(new Error('current connection failed'));
    await turn();
    assert.equal(publisher.enabled,false);assert.equal(publisher.pending,null);assert.equal(publisher.sending,false);
    assert.equal(calls.length,2);assert.equal(calls[1].url,'/api/studio-output/stop');
    assert.ok(calls[1].body.sequence>calls[0].body.sequence);assert.equal(calls[1].options.keepalive,true);
    assert.equal(states.at(-1).status,'error');
    calls[1].reject(new Error('network also unavailable for cleanup'));await turn();
    assert.equal(calls.length,2);assert.equal(publisher.enabled,false);
  }
});

test('retry after current-generation failure survives its still-pending cleanup response',async()=>{
  const {publisher,calls,states}=controlledPublisher();publisher.start();publisher.publish(frame('parted'));
  calls[0].resolve(response(false,{error:'first connection failed'}));await turn();
  assert.equal(calls[1].url,'/api/studio-output/stop');
  publisher.start();publisher.publish(frame('press'));
  assert.equal(calls[2].url,'/api/studio-output/state');assert.ok(calls[2].body.sequence>calls[1].body.sequence);
  calls[2].resolve(response());await turn();assert.equal(states.at(-1).status,'active');
  calls[1].reject(new Error('old cleanup failed later'));await turn();
  assert.equal(publisher.enabled,true);assert.equal(states.at(-1).status,'active');assert.equal(publisher.sending,false);
});

async function receiverHarness() {
  const source=readFileSync(new URL('./short-hair-output.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'');
  const scheduled=new Map(),draws=[],outputDraws=[],events={},connections=[],notice={};let nextId=0,clears=0,fills=0;
  const canvas={width:1280,height:720,getContext:()=>({clearRect(){clears++;},fillRect(){fills++;}})};
  const document={hidden:false,title:'',querySelector:selector=>selector==='#outputCanvas'?canvas:notice,
    createElement:()=>({width:630,height:460}),addEventListener(type,callback){events[type]=callback;}};
  const windowEvents={};
  const context=vm.createContext({document,window:{addEventListener(type,callback){windowEvents[type]=callback;}},
    loadContinuousShortHairAssets:async()=>({}),poseHeadCoordinates,validateOutputFrame,
    drawOutputFrame(target,native,options){outputDraws.push({target,native,options});},
    renderContinuousShortHairStudio(native,assets,poseId,coefficients,previous,options){draws.push({poseId,state:options.stateOverride,coefficients,options});},
    EventSource:class {constructor(url){this.url=url;this.closed=false;connections.push(this);}close(){this.closed=true;}},
    requestAnimationFrame(callback){scheduled.set(++nextId,callback);return nextId;},cancelAnimationFrame(id){scheduled.delete(id);}});
  vm.runInContext(source,context);await turn();
  return {notice,document,draws,outputDraws,scheduled,windowEvents,connections,get clears(){return clears;},get fills(){return fills;},
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
