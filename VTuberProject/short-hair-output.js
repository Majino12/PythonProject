import {loadContinuousShortHairAssets,renderContinuousShortHairStudio} from './short-hair-continuous-renderer.js';
import {poseHeadCoordinates} from './short-hair-pose-motion.js';
import {validateOutputFrame,drawOutputFrame} from './short-hair-studio-output-model.js';

const canvas=document.querySelector('#outputCanvas'),notice=document.querySelector('#outputNotice');
const native=document.createElement('canvas');
let assets=null,pending=null,animation=0,connection=null,signalStale=false;
function clear(message) {
  const context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height);
  notice.className='';notice.textContent=message;notice.hidden=false;document.title=`MoeMotion · ${message}`;
}
function warnConnection(){notice.className='connection-warning';notice.textContent='工作台信号中断 · 保留最后画面';notice.hidden=false;document.title='MoeMotion · 工作台信号中断';}
function draw() {
  animation=0;if(!assets||!pending)return;
  const frame=pending;pending=null;
  try {
    renderContinuousShortHairStudio(native,assets,frame.poseId,frame.coefficients,{},
      {faceOnly:frame.faceOnly,original:frame.original,stateOverride:frame.state,headPose:frame.headPose||poseHeadCoordinates(frame.poseId),transparent:frame.transparent===true});
    drawOutputFrame(canvas,native,{transparent:frame.transparent===true});notice.hidden=true;document.title='MoeMotion · 直播画面已连接';if(signalStale)warnConnection();
  }catch(error){clear(`画面无法绘制：${error.message}`);}
}
function schedule() {if(assets&&pending&&!animation)animation=requestAnimationFrame(draw);}
async function start() {
  try {
    assets=await loadContinuousShortHairAssets();clear('请在工作台启用直播画面');
    connection=new EventSource('/api/studio-output/events');
    connection.onmessage=event=>{
      try {
        const packet=JSON.parse(event.data);
        if(!packet.active){pending=null;clear('直播画面已停止');return;}
        signalStale=packet.stale===true;pending=validateOutputFrame(packet.frame);schedule();
      }catch{pending=null;clear('收到的角色状态无效，请重新启用输出。');}
    };
    connection.onerror=()=>{signalStale=true;warnConnection();};
  }catch(error){clear(`角色载入失败：${error.message}`);}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
window.addEventListener('pagehide',()=>{connection?.close();assets?.flowRenderer?.dispose();cancelAnimationFrame(animation);});
start();
