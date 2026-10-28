import {loadSideExpressionAssets,drawSideExpression} from './side-expression-renderer.js';
const a=await loadSideExpressionAssets('brows'), host=document.querySelector('#content');
for(const [label,rect]of [['近眉前细刘海',[489,397,65,74]],['远眉前细刘海',[741,388,63,74]]]){
  const h=document.createElement('h2');h.textContent=label;host.append(h);
  const row=document.createElement('section');host.append(row);
  for(const [brow,caption]of [['neutral','中性'],['innerUp','眉头抬'],['outerUp','眉尾抬'],['down','压眉']]){
    const source=document.createElement('canvas');drawSideExpression(source,a,'view-right',{eyeLeft:'open',eyeRight:'open',mouth:'neutral',browLeft:brow,browRight:brow},{faceOnly:false});
    const c=document.createElement('canvas');c.width=rect[2];c.height=rect[3];c.getContext('2d').drawImage(source,...rect,0,0,c.width,c.height);
    const fig=document.createElement('figure'),cap=document.createElement('figcaption');cap.textContent=caption;fig.append(c,cap);row.append(fig);
  }
}
