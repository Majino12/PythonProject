import{loadSideExpressionAssets,drawSideExpression}from'./side-expression-renderer.js';
const host=document.querySelector('#content');
try{
 const[a,b]=await Promise.all([loadSideExpressionAssets('gaze'),loadSideExpressionAssets('approved')]);host.replaceChildren();
 for(const pose of Object.keys(a.manifest.poses)){
  const h=document.createElement('h2');h.textContent=a.manifest.poses[pose].label;host.append(h);const grid=document.createElement('div');grid.className='grid';host.append(grid);
  for(const [label,asset,lid,x]of [['已确认',b,'open',0],['中心',a,'open',0],['画面左极值',a,'open',-1],['画面右极值',a,'open',1],['半闭中心',a,'half',0]]){
   const full=document.createElement('canvas');drawSideExpression(full,asset,pose,{eyeLeft:lid,eyeRight:lid,mouth:'neutral'},{faceOnly:false,gaze:{eyeLeft:{x,y:0},eyeRight:{x,y:0}}});
   for(const eye of ['eyeRight','eyeLeft']){
    const bounds=a.manifest.gaze.poses[pose].eyes[eye].bounds,figure=document.createElement('figure'),canvas=document.createElement('canvas'),caption=document.createElement('figcaption');canvas.width=bounds[2];canvas.height=bounds[3];canvas.getContext('2d').drawImage(full,...bounds,0,0,bounds[2],bounds[3]);caption.textContent=label+' · '+eye;figure.append(caption,canvas);grid.append(figure);
   }
  }
 }
}catch(e){host.textContent=e.stack;}
