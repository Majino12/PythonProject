import {loadContinuousShortHairAssets,renderContinuousShortHairStudio} from './short-hair-continuous-renderer.js';
import {poseHeadCoordinates} from './short-hair-pose-motion.js';
import {validateOutputFrame,drawOutputFrame} from './short-hair-studio-output-model.js';

const canvas=document.querySelector('#outputCanvas'),notice=document.querySelector('#outputNotice');
const native=document.createElement('canvas');
let assets=null,pending=null,animation=0,connection=null,signalStale=false,disposed=false,lastDrawn=null;
function cancelDraw(){cancelAnimationFrame(animation);animation=0;}
function clear(message) {
  const context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height);lastDrawn=null;
  notice.className='';notice.textContent=message;notice.hidden=false;document.title=`MoeMotion · ${message}`;
}
function warn(message) {notice.className='connection-warning';notice.textContent=message;notice.hidden=false;document.title=`MoeMotion · ${message}`;}
function warnConnection(){warn('工作台信号中断 · 保留最后画面');}
function connected(){notice.hidden=true;document.title='MoeMotion · 直播画面已连接';if(signalStale)warnConnection();}
function draw() {
  animation=0;if(disposed||document.hidden||!assets||!pending)return;
  const frame=pending;
  try {
    const result=renderContinuousShortHairStudio(native,assets,frame.poseId,frame.coefficients,{},
      {faceOnly:frame.faceOnly,original:frame.original,stateOverride:frame.state,headPose:frame.headPose||poseHeadCoordinates(frame.poseId),
        transparent:frame.transparent===true,secondary:frame.secondary});
    if(result?.didDraw===false) {warn('图形资源正在恢复 · 保留最后画面');schedule();return;}
    drawOutputFrame(canvas,native,{transparent:frame.transparent===true,composition:frame.composition});
    lastDrawn=JSON.stringify(frame);pending=null;connected();
  }catch(error){pending=null;warn(`画面无法绘制：${error.message} · 保留最后画面`);}
}
function schedule() {if(!disposed&&!document.hidden&&assets&&pending&&!animation)animation=requestAnimationFrame(draw);}
async function start() {
  try {
    const loaded=await loadContinuousShortHairAssets();
    if(disposed){loaded.flowRenderer?.dispose();return;}
    assets=loaded;clear('请在工作台启用直播画面');
    connection=new EventSource('/api/studio-output/events');
    connection.onmessage=event=>{
      if(disposed)return;
      try {
        const packet=JSON.parse(event.data);
        if(!packet.active){
          pending=null;cancelDraw();
          if(packet.stopped===false&&lastDrawn){signalStale=true;warnConnection();}
          else clear(packet.stopped===false?'请在工作台启用直播画面':'直播画面已停止');
          return;
        }
        signalStale=packet.stale===true;
        const frame=validateOutputFrame(packet.frame);
        // Relay heartbeats carry the last snapshot; their lease status still updates the notice.
        if(!pending&&JSON.stringify(frame)===lastDrawn){connected();return;}
        pending=frame;if(signalStale)warnConnection();schedule();
      }catch{pending=null;cancelDraw();warn('收到的角色状态无效 · 保留最后画面，请重新启用输出。');}
    };
    connection.onerror=()=>{if(!disposed){signalStale=true;warnConnection();}};
  }catch(error){if(!disposed)clear(`角色载入失败：${error.message}`);}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelDraw();else schedule();});
window.addEventListener('pagehide',()=>{disposed=true;pending=null;connection?.close();assets?.flowRenderer?.dispose();cancelDraw();});
start();
