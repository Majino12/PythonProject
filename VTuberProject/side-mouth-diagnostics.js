import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const host = document.querySelector('#comparisons'), output = document.querySelector('#result');
const neutral = {eyeLeft:'open', eyeRight:'open', mouth:'neutral'};
const gaze = {eyeLeft:{x:.75,y:0},eyeRight:{x:.75,y:0}};
const states = [['neutral','已确认中性'], ['openSmall','已确认小张嘴'], ['openWide','已确认大张嘴'], ['pucker','噘嘴'], ['press','抿嘴'], ['shiftRight','角色右移 · 画面左'], ['shiftLeft','角色左移 · 画面右']];
const render = (assets, pose, state, options={}) => {
  const canvas=document.createElement('canvas');
  drawSideExpression(canvas,assets,pose,state,options); return canvas;
};
const pixels = canvas => canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
const inside = (r,x,y) => x>=r[0] && x<r[0]+r[2] && y>=r[1] && y<r[1]+r[3];
function difference(a,b,width,bounds,noseRect) {
  let changed=0,outside=0,nose=0,belowJaw=0;
  for(let i=0;i<a.length;i+=4) if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]) {
    changed++; const x=(i/4)%width,y=Math.floor(i/4/width);
    if(!bounds.some(r=>inside(r,x,y)))outside++;
    if(inside(noseRect,x,y))nose++;
    if(y>=740)belowJaw++;
  }
  return {changed,outside,nose,belowJaw};
}
function card(parent,canvas,label) {
  const figure=document.createElement('figure'),caption=document.createElement('figcaption');
  caption.textContent=label;figure.append(canvas,caption);parent.append(figure);
}
try {
  const [assets,approved]=await Promise.all([loadSideExpressionAssets('mouth'),loadSideExpressionAssets('gaze')]);
  const report={};
  for(const [pose,meta] of Object.entries(assets.manifest.poses)) {
    const h=document.createElement('h2');h.textContent=meta.label;host.append(h);
    const row=document.createElement('div');row.className='mouths';host.append(row);
    const items=[];report[pose]=items;
    const noseRect=pose==='view-left'?[386,566,45,49]:[695,555,35,51];
    for(const [mouth,label] of states) {
      const state={...neutral,mouth};
      card(row,render(assets,pose,state,{detail:'mouth'}),label);
      const full=render(assets,pose,state,{faceOnly:false});
      const expected=render(approved,pose,{...state,mouth: ['openSmall','openWide'].includes(mouth)?mouth:'neutral'},{faceOnly:false});
      const bounds=meta.patches.mouth[mouth]?[meta.patches.mouth[mouth].destination]:[];
      items.push({mouth,...difference(pixels(expected),pixels(full),full.width,bounds,noseRect)});
    }
    const faces=document.createElement('div');faces.className='faces';host.append(faces);
    for(const [label,state] of [['噘嘴＋看画面右',{...neutral,mouth:'pucker'}],['抿嘴＋半闭眼',{eyeLeft:'half',eyeRight:'half',mouth:'press'}]]) {
      card(faces,render(assets,pose,state,{gaze}),label);
      const full=render(assets,pose,state,{faceOnly:false,gaze});
      const expected=render(approved,pose,{...state,mouth:'neutral'},{faceOnly:false,gaze});
      items.push({combination:label,...difference(pixels(expected),pixels(full),full.width,[meta.patches.mouth[state.mouth].destination],noseRect)});
    }
  }
  output.textContent=JSON.stringify(report,null,2);
}catch(error) {output.textContent=error.stack;}
