import {loadSideExpressionAssets,drawSideExpression} from './side-expression-renderer.js';
const host=document.querySelector('#comparisons'), result=document.querySelector('#result');
const states=[{eyeLeft:'open',eyeRight:'open',mouth:'neutral'},{eyeLeft:'half',eyeRight:'half',mouth:'openSmall'},{eyeLeft:'closed',eyeRight:'closed',mouth:'openWide'},{eyeLeft:'closed',eyeRight:'open',mouth:'neutral'}];
try {
 const assets=await loadSideExpressionAssets(), metrics={};
 for(const [poseId,pose]of Object.entries(assets.manifest.poses)) {
  const h=document.createElement('h2');h.textContent=pose.label;host.append(h);
  const row=document.createElement('div');row.className='row';host.append(row);
  const ref=document.createElement('canvas');drawSideExpression(ref,assets,poseId,states[0],{faceOnly:false});
  const base=ref.getContext('2d').getImageData(0,0,ref.width,ref.height).data;
  metrics[poseId]=[];
  for(const [index,state]of states.entries()) {
   const fig=document.createElement('figure'),canvas=document.createElement('canvas'),cap=document.createElement('figcaption');
   cap.textContent=['已确认原画','半闭＋小张','闭眼＋大张','角色左眼闭合'][index];fig.append(canvas,cap);row.append(fig);
   drawSideExpression(canvas,assets,poseId,state);
   const full=document.createElement('canvas');drawSideExpression(full,assets,poseId,state,{faceOnly:false});
   const data=full.getContext('2d').getImageData(0,0,full.width,full.height).data;
   const active=Object.entries(state).filter(([g,s])=>pose.patches[g][s]).map(([g,s])=>pose.patches[g][s].destination);
   let changed=0,outside=0,belowJaw=0,nose=0;
   const noseRect=poseId==='view-left'?[386,566,45,49]:[695,555,35,51];
   const contains=(r,x,y)=>x>=r[0]&&x<r[0]+r[2]&&y>=r[1]&&y<r[1]+r[3];
   for(let i=0;i<data.length;i+=4)if(data[i]!==base[i]||data[i+1]!==base[i+1]||data[i+2]!==base[i+2]) {
    const pixel=i/4,x=pixel%full.width,y=Math.floor(pixel/full.width);changed++;
    if(!active.some(r=>contains(r,x,y)))outside++;if(y>=740)belowJaw++;if(contains(noseRect,x,y))nose++;
   }
   metrics[poseId].push({state,changedPixels:changed,outsideActivePatches:outside,belowJaw,nose});
  }
 }
 result.textContent=JSON.stringify(metrics,null,2);
}catch(error){result.textContent=error.stack;}
