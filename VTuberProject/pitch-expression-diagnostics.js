import {loadSideExpressionAssets,drawSideExpression} from './side-expression-renderer.js';
const host=document.querySelector('#comparisons'),output=document.querySelector('#result');
const neutral={eyeLeft:'open',eyeRight:'open',mouth:'neutral'};
const eyes=['open','half','closed'],mouths=['neutral','openSmall','openWide'];
const render=(assets,pose,state,options={})=>{const c=document.createElement('canvas');drawSideExpression(c,assets,pose,state,options);return c;};
const pixels=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
const inside=(r,x,y)=>x>=r[0]&&x<r[0]+r[2]&&y>=r[1]&&y<r[1]+r[3];
const inPolygon=(p,x,y)=>{let v=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const [xi,yi]=p[i],[xj,yj]=p[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)v=!v;}return v;};
function difference(a,b,width,bounds,protection,inactive){let changed=0,outside=0;const protectedCounts=Object.fromEntries(Object.keys(protection).map(k=>[k,0]));const inactiveCounts=Object.fromEntries(Object.keys(inactive).map(k=>[k,0]));for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3]){changed++;const x=(i/4)%width,y=Math.floor(i/4/width);if(!bounds.some(r=>inside(r,x,y)))outside++;for(const[k,polys]of Object.entries(protection))if(polys.some(p=>inPolygon(p,x+.5,y+.5)))protectedCounts[k]++;for(const[k,r]of Object.entries(inactive))if(inside(r,x,y))inactiveCounts[k]++;}return{changed,outside,protected:protectedCounts,inactive:inactiveCounts};}
function card(parent,canvas,label){const fig=document.createElement('figure'),cap=document.createElement('figcaption');cap.textContent=label;fig.append(canvas,cap);parent.append(fig);}
try{
 const[assets,geometry]=await Promise.all([loadSideExpressionAssets('pitch'),fetch('./assets/short-hair-pitch-expressions-v1/validation/registration.json').then(r=>r.json())]);const report={};
 for(const[pose,meta]of Object.entries(assets.manifest.poses)){
  const h=document.createElement('h2');h.textContent=meta.label;host.append(h);const details=document.createElement('div');details.className='details';host.append(details);
  for(const[detail,states,label]of [['eyes',eyes,'眼睛：睁开 / 半闭 / 闭合'],['mouth',mouths,'嘴部：闭合 / 小幅 / 大幅']]){const section=document.createElement('section'),title=document.createElement('h3');title.textContent=label;section.append(title);const row=document.createElement('div');row.className='row';section.append(row);details.append(section);for(const value of states)card(row,render(assets,pose,detail==='eyes'?{...neutral,eyeLeft:value,eyeRight:value}:{...neutral,mouth:value},{detail}),value);}
  const faces=document.createElement('div');faces.className='faces';host.append(faces);card(faces,render(assets,pose,{eyeLeft:'closed',eyeRight:'open',mouth:'openSmall'}),'角色左眼闭合＋小幅张嘴');card(faces,render(assets,pose,{eyeLeft:'closed',eyeRight:'closed',mouth:'openWide'}),'双眼闭合＋大幅张嘴');
  const original=render(assets,pose,neutral,{faceOnly:false,original:true}),expected=pixels(original),protection=geometry.protection?.[pose]||geometry.poses[pose].protection;
  const rows=[];report[pose]=rows;
  for(const eyeLeft of eyes)for(const eyeRight of eyes)for(const mouth of mouths){const state={eyeLeft,eyeRight,mouth};const actual=render(assets,pose,state,{faceOnly:false});const bounds=Object.entries(state).map(([k,s])=>meta.patches[k][s]?.destination).filter(Boolean);const inactive={};for(const[k,s]of Object.entries(state))if(s==='open'||s==='neutral'){const r=meta.patches[k][k==='mouth'?'openSmall':'half'].destination;inactive[k]=r;}rows.push({...state,...difference(expected,pixels(actual),actual.width,bounds,protection,inactive)});}
  rows.push({original:true,...difference(expected,pixels(render(assets,pose,{eyeLeft:'closed',eyeRight:'closed',mouth:'openWide'},{faceOnly:false,original:true})),original.width,[],protection,{})});
 }
 output.textContent=JSON.stringify(report,null,2);const rows=Object.values(report).flat(),fail=rows.filter(r=>r.outside||Object.values(r.protected).some(Boolean)||Object.values(r.inactive).some(Boolean));document.querySelector('#summary').textContent=`${rows.length} 组检查；${fail.length} 组进入保护区或影响未动作五官。`;
}catch(error){output.textContent=error.stack;document.querySelector('#summary').textContent='检查失败';}
