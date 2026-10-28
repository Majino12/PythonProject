import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';

const host=document.querySelector('#comparisons'), output=document.querySelector('#result');
const neutral={eyeLeft:'open',eyeRight:'open',mouth:'neutral',browLeft:'neutral',browRight:'neutral'};
const gaze={eyeLeft:{x:-.75,y:0},eyeRight:{x:-.75,y:0}};
const states=[['neutral','已确认中性'],['innerUp','眉头抬起'],['outerUp','眉尾抬起'],['down','压眉']];
const render=(assets,pose,state,options={})=>{const c=document.createElement('canvas');drawSideExpression(c,assets,pose,state,options);return c;};
const pixels=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
const inside=(r,x,y)=>x>=r[0]&&x<r[0]+r[2]&&y>=r[1]&&y<r[1]+r[3];
const inPolygon=(p,x,y)=>{let value=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const [xi,yi]=p[i],[xj,yj]=p[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)value=!value;}return value;};
function difference(a,b,width,bounds,protectedEyes,protectedHair){
  let changed=0,outside=0,eyes=0,hair=0,lowerFace=0;
  for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]){
    changed++;const x=(i/4)%width,y=Math.floor(i/4/width);
    if(!bounds.some(r=>inside(r,x,y)))outside++;
    if(protectedEyes.some(p=>inPolygon(p,x,y)))eyes++;
    if(protectedHair.some(p=>inPolygon(p,x,y)))hair++;
    if(y>=555)lowerFace++;
  }
  return {changed,outside,eyes,hair,lowerFace};
}
function card(parent,canvas,label){const fig=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=label;fig.append(canvas,caption);parent.append(fig);}
try{
  const [assets,approved,geometry]=await Promise.all([loadSideExpressionAssets('brows'),loadSideExpressionAssets('mouth'),fetch('./assets/short-hair-side-brows-v1/validation/registration.json').then(r=>r.json())]);
  const report={};
  for(const [pose,meta]of Object.entries(assets.manifest.poses)){
    const h=document.createElement('h2');h.textContent=meta.label;host.append(h);
    const row=document.createElement('div');row.className='brows';host.append(row);
    for(const [brow,label]of states)card(row,render(assets,pose,{...neutral,browLeft:brow,browRight:brow},{detail:'brows'}),label);
    const faces=document.createElement('div');faces.className='faces';host.append(faces);
    card(faces,render(assets,pose,{...neutral,browLeft:'outerUp',browRight:'down',mouth:'press'}),'左眉尾抬＋右眉压低＋抿嘴');
    card(faces,render(assets,pose,{...neutral,browLeft:'innerUp',browRight:'innerUp',eyeLeft:'half',eyeRight:'half',mouth:'pucker'},{gaze}),'眉头抬＋半闭眼＋噘嘴＋看画面左');
    const items=[];report[pose]=items;
    const protection=geometry.poses[pose].protection;
    for(const eye of ['open','half','closed']){
      const common={...neutral,eyeLeft:eye,eyeRight:eye,mouth:eye==='half'?'pucker':eye==='closed'?'press':'neutral'};
      const expected=pixels(render(approved,pose,common,{faceOnly:false,gaze}));
      for(const [browLeft]of states)for(const [browRight]of states){
        const full=render(assets,pose,{...common,browLeft,browRight},{faceOnly:false,gaze});
        const bounds=[meta.patches.browLeft[browLeft]?.destination,meta.patches.browRight[browRight]?.destination].filter(Boolean);
        items.push({eye,browLeft,browRight,...difference(expected,pixels(full),full.width,bounds,protection.eyes,protection.hair)});
      }
    }
    const expected=render(approved,pose,neutral,{faceOnly:false,original:true});
    const actual=render(assets,pose,{...neutral,browLeft:'down',browRight:'innerUp',mouth:'pucker'},{faceOnly:false,original:true,gaze});
    items.push({original:true,...difference(pixels(expected),pixels(actual),actual.width,[],protection.eyes,protection.hair)});
  }
  output.textContent=JSON.stringify(report,null,2);
  const rows=Object.values(report).flat();const failures=rows.filter(r=>r.outside||r.eyes||r.hair||r.lowerFace);
  document.querySelector('#summary').textContent=`${rows.length} 项像素检查，${failures.length} 项超出眉区或进入保护区域。`;
}catch(error){output.textContent=error.stack;document.querySelector('#summary').textContent='检查失败';}
