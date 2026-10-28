import {loadExpressionAssets,drawExpression} from './expression-renderer.js';
const assets = await loadExpressionAssets();
const neutral = {eyeLeft:'open',eyeRight:'open',browLeft:'neutral',browRight:'neutral',mouth:'neutral'};
const cases = [
  ['原画', 'open', 0, 0, true],['0.001 输入','open',.001,0],['0.01 输入','open',.01,0],['中心','open',0,0],
  ['向画面左','open',-1,0],['向画面右','open',1,0],['上看','open',0,-1],['下看','open',0,1],
  ['轻闭左看','quarter',-1,0],['轻闭右看','quarter',1,0],['半闭上看','half',0,-1],['半闭下看','half',0,1],
  ['半闭左看','half',-1,0],['半闭右看','half',1,0],['近闭上看','threeQuarter',0,-1],['近闭下看','threeQuarter',0,1],
  ['近闭左看','threeQuarter',-1,0],['近闭右看','threeQuarter',1,0],['完全闭眼左看','closed',-1,0],['完全闭眼右看','closed',1,0]
];
function render(state,gaze,original=false,full=false){const c=document.createElement('canvas');drawExpression(c,assets,state,{gaze,original,...(full?{faceOnly:false}:{detail:'eyes'})});return c;}
const snapshots=[];
for(const [label,eye,x,y,original] of cases){const gaze={eyeLeft:{x,y},eyeRight:{x,y}},state={...neutral,eyeLeft:eye,eyeRight:eye};const c=render(state,gaze,original);const f=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=label;f.append(c,caption);document.querySelector('#cases').append(f);snapshots.push({label,canvas:render(state,gaze,original,true),state,gaze});}
function diff(a,b){const p=a.getContext('2d').getImageData(0,0,a.width,a.height).data,q=b.getContext('2d').getImageData(0,0,b.width,b.height).data;let changed=0,over20=0,max=0,outsideEyes=0,sum=0;for(let i=0;i<p.length;i+=4){let d=0;for(let k=0;k<4;k++)d=Math.max(d,Math.abs(p[i+k]-q[i+k]));if(d){changed++;const x=(i/4)%a.width,y=Math.floor(i/4/a.width);if(!(y>=448&&y<564&&((x>=347&&x<514)||(x>=606&&x<761))))outsideEyes++;}if(d>20)over20++;max=Math.max(max,d);sum+=d;}return{changed,over20,max,outsideEyes,sum};}
const report={zeroVsOriginal:diff(snapshots[0].canvas,snapshots[3].canvas),tiny001VsCenter:diff(snapshots[3].canvas,snapshots[1].canvas),tiny01VsCenter:diff(snapshots[3].canvas,snapshots[2].canvas),closedLeftVsRight:diff(snapshots[18].canvas,snapshots[19].canvas),cases:snapshots.slice(4).map(s=>({label:s.label,...diff(s.canvas,render(s.state,{eyeLeft:{x:0,y:0},eyeRight:{x:0,y:0}},false,true))}))};
document.querySelector('#results').textContent=JSON.stringify(report,null,2);
const b=document.querySelector('#export');b.disabled=false;b.onclick=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='gaze-pixel-check.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
