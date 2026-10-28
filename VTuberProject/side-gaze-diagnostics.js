import {loadSideExpressionAssets,drawSideExpression} from './side-expression-renderer.js';
const host=document.querySelector('#comparisons'),output=document.querySelector('#result');
const neutral={eyeLeft:'open',eyeRight:'open',mouth:'neutral'};
const gaze=(x,y)=>({eyeLeft:{x,y},eyeRight:{x,y}});
const directions=[['中心',0,0],['画面左',-1,0],['画面右',1,0],['上',0,-1],['下',0,1],['左上',-1,-1],['右上',1,-1],['左下',-1,1],['右下',1,1]];
const render=(assets,pose,state,g,options={})=>{const c=document.createElement('canvas');drawSideExpression(c,assets,pose,state,{gaze:g,...options});return c;};
const pixels=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
function difference(a,b,width,bounds){let changed=0,outside=0,max=0,large=0;for(let i=0;i<a.length;i+=4){let delta=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));if(delta){changed++;max=Math.max(max,delta);if(delta>20)large++;const x=(i/4)%width,y=Math.floor(i/4/width);if(!bounds.some(r=>x>=r[0]&&x<r[0]+r[2]&&y>=r[1]&&y<r[1]+r[3]))outside++;}}return{changed,outside,max,large};}
try {
 const [assets,approved]=await Promise.all([loadSideExpressionAssets('gaze'),loadSideExpressionAssets('approved')]),report={};
 for(const pose of Object.keys(assets.manifest.poses)) {
  const bounds=Object.values(assets.manifest.gaze.poses[pose].eyes).map(e=>e.bounds),items=[];report[pose]=items;
  for(const eyelid of ['open','half']) {
   const state={...neutral,eyeLeft:eyelid,eyeRight:eyelid};
   const h=document.createElement('h2');h.textContent=assets.manifest.poses[pose].label+' · '+eyelid;host.append(h);
   const row=document.createElement('div');row.className='row';host.append(row);
   const original=render(approved,pose,state,gaze(0,0),{faceOnly:false}),base=pixels(original);
   const originalFig=document.createElement('figure'),oc=render(approved,pose,state,gaze(0,0),{detail:'eyes'}),caption=document.createElement('figcaption');caption.textContent='已确认表情';originalFig.append(oc,caption);row.append(originalFig);
   for(const[name,x,y]of directions) {
    const fig=document.createElement('figure'),c=render(assets,pose,state,gaze(x,y),{detail:'eyes'}),cap=document.createElement('figcaption');cap.textContent=name;fig.append(c,cap);row.append(fig);
    const full=render(assets,pose,state,gaze(x,y),{faceOnly:false});items.push({eyelid,direction:name,...difference(base,pixels(full),full.width,bounds)});
   }
  }
  const center=render(assets,pose,neutral,gaze(0,0),{faceOnly:false});
  for(const tiny of [.001,.01])items.push({check:'tiny '+tiny,...difference(pixels(center),pixels(render(assets,pose,neutral,gaze(tiny,0),{faceOnly:false})),center.width,bounds)});
  const closed={...neutral,eyeLeft:'closed',eyeRight:'closed'};
  items.push({check:'closed opposite gaze',...difference(pixels(render(assets,pose,closed,gaze(-1,-1),{faceOnly:false})),pixels(render(assets,pose,closed,gaze(1,1),{faceOnly:false})),center.width,bounds)});
 }
 output.textContent=JSON.stringify(report,null,2);
}catch(error){output.textContent=error.stack;}
