import {validateOutputEnvelope} from './short-hair-studio-output-model.js';

const PREFIX = '/api/studio-output/';
const json = (response,status,value) => {
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(value));
};
export function createStudioOutputRelay({now = Date.now, maxClients = 8} = {}) {
  let latest = null, owner = null, lastSequence = -1, updatedAt = 0;
  const clients = new Set();
  const stoppedSequences = new Map();
  const payload = () => ({active:Boolean(owner),stale:Boolean(owner)&&now()-updatedAt>5000,updatedAt,frame:latest,clients:clients.size});
  const broadcast = () => {
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 65536) {client.destroy();clients.delete(client);}
      else client.write(message);
    }
  };
  async function handle(request,response) {
    const path = request.url?.split('?')[0];
    if (!path?.startsWith(PREFIX)) return false;
    const host = request.headers.host || '';
    const origin = request.headers.origin;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || (origin && origin !== `http://${host}`)
      || request.headers['sec-fetch-site'] === 'cross-site') {json(response,403,{error:'只允许本机工作台访问。'});return true;}
    if (path === `${PREFIX}events` && request.method === 'GET') {
      if (clients.size >= maxClients) {json(response,503,{error:'输出窗口过多。'});return true;}
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      clients.add(response);response.write(`retry: 1000\ndata: ${JSON.stringify(payload())}\n\n`);
      const heartbeat = setInterval(()=>{
        if(response.writableLength>65536){response.destroy();return;}
        response.write(`data: ${JSON.stringify(payload())}\n\n`);
      },1000);heartbeat.unref?.();
      response.on('close',()=>{clearInterval(heartbeat);clients.delete(response);});
      return true;
    }
    if (path === `${PREFIX}status` && request.method === 'GET') {json(response,200,{...payload(),frame:undefined});return true;}
    if (!['state','stop'].some(action=>path===`${PREFIX}${action}`)) {json(response,404,{error:'未知输出接口。'});return true;}
    if (request.method !== 'POST') {json(response,405,{error:'需要 POST。'});return true;}
    if (origin !== `http://${host}` || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
      json(response,403,{error:'输出请求必须来自本机工作台。'});return true;
    }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) {size += chunk.length;if(size>8192)throw new Error('直播状态过大。');chunks.push(chunk);}
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (path.endsWith('/stop')) {
        if (typeof value?.senderId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value.senderId)
          || !Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error('停止输出标识无效。');
        stoppedSequences.set(value.senderId,Math.max(value.sequence,stoppedSequences.get(value.senderId) ?? -1));
        if (stoppedSequences.size>128) stoppedSequences.delete(stoppedSequences.keys().next().value);
        // A delayed stop from an older generation cannot clear a restarted sender.
        if (value.senderId === owner && value.sequence <= lastSequence) {json(response,200,{stopped:false});return true;}
        if (value.senderId === owner) {owner=null;latest=null;lastSequence=-1;updatedAt=now();broadcast();}
        json(response,200,{stopped:true});return true;
      }
      const packet = validateOutputEnvelope(value), time = now();
      if (packet.sequence <= (stoppedSequences.get(packet.senderId) ?? -1)) {json(response,409,{error:'已停止的输出帧已忽略。'});return true;}
      if (owner && owner !== packet.senderId && time-updatedAt < 5000) {json(response,409,{error:'另一工作台正在输出，请先停止它的直播画面。'});return true;}
      if (owner === packet.senderId && packet.sequence <= lastSequence) {json(response,409,{error:'过期的输出帧已忽略。'});return true;}
      owner=packet.senderId;lastSequence=packet.sequence;latest=packet.frame;updatedAt=time;broadcast();
      json(response,200,{accepted:true,clients:clients.size});
    } catch(error) {json(response,400,{error:error.message || '输出状态无效。'});}
    return true;
  }
  return {handle,close(){for(const client of clients)client.end();clients.clear();}};
}
