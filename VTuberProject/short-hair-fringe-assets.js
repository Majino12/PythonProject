import {createHairMeshBinding,HAIR_MESH_POSES} from './short-hair-mesh-model.js';
const SIZE=[1122,1402],DIR='./assets/short-hair-fringe-v1/';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const own=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const imageSize=image=>[image.naturalWidth??image.width,image.naturalHeight??image.height];
const canvas=()=>{const c=document.createElement('canvas');[c.width,c.height]=SIZE;return c;};
export function validateShortHairFringeManifest(value){
 if(!object(value)||value.schemaVersion!==1||value.id!=='short-hair-fringe-v1'||value.status!=='derived-candidate'
  ||value.width!==SIZE[0]||value.height!==SIZE[1]||!object(value.model)||value.model.name!=='SAM 2.1 Hiera Large'
  ||value.model.weightsSha256!=='2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318'||value.model.commit!=='2b90b9f5ceec907a1c18123530e92e794ad901a4'||!object(value.poses)||Object.keys(value.poses).length<1||Object.keys(value.poses).length>9)
  throw new TypeError('前发分层清单无效。');
 for(const [id,p]of Object.entries(value.poses)){
  if(!HAIR_MESH_POSES.includes(id)||!object(p)||!own(p.source,['path','sha256'])||!hash(p.source.sha256)
   ||!/^\.\/assets\/[a-zA-Z0-9_/-]+\.png$/.test(p.source.path)||p.source.path.includes('..')||!hash(p.alphaSha256)
   ||p.binding?.poseId!==id||p.binding?.sourceSha256!==p.source.sha256||p.binding?.runtimeValidated!==true
   ||p.supportRadius!==24||p.solidRadius!==12)throw new TypeError(`${id} 的分层来源或绑定无效。`);
  createHairMeshBinding(p.binding);
  for(const key of ['ownership','weight','underpaint','hairOwnership']){
   const f=p[key];if(!own(f,['path','bytes','sha256'])||f.path!==`${DIR}${id}-${key}.png`||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>16*1024*1024||!hash(f.sha256))throw new TypeError(`${id} 的 ${key} 登记无效。`);
  }
 }
 return value;
}
async function verifiedImage(record,label){
 const response=await fetch(record.path,{cache:'no-store'});if(!response.ok)throw new Error(`无法读取${label}。`);
 const data=await response.arrayBuffer();if(data.byteLength!==record.bytes)throw new Error(`${label}长度不匹配。`);
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');
 if(digest!==record.sha256)throw new Error(`${label}校验失败。`);
 const url=URL.createObjectURL(new Blob([data],{type:'image/png'}));let image;
 try{image=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(new Error(`${label}无法解码。`));im.src=url;});}finally{URL.revokeObjectURL(url);}
 if(imageSize(image).some((n,i)=>n!==SIZE[i]))throw new Error(`${label}不是原生画稿尺寸。`);
 return image;
}
function pixels(image){const c=canvas(),ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);return ctx.getImageData(0,0,...SIZE).data;}
function alphaMask(data,{binary=false}={}){
 const result=canvas(),ctx=result.getContext('2d'),out=ctx.createImageData(...SIZE);
 for(let i=0;i<SIZE[0]*SIZE[1];i++){
  const k=i*4,value=data[k];if(data[k+1]!==value||data[k+2]!==value||data[k+3]!==255||binary&&value!==0&&value!==255)throw new Error('前发遮罩编码无效。');
  out.data[k]=out.data[k+1]=out.data[k+2]=255;out.data[k+3]=value;
 }
 ctx.putImageData(out,0,0);return result;
}
/** Decoded once. W/H grayscale bytes become ALPHA canvases; the shader and
 * source-over base share exactly the same UNORM8 weights. No inference runs. */
export async function loadShortHairFringeAssets(){
 const response=await fetch(`${DIR}manifest.json`,{cache:'no-store'});if(!response.ok)throw new Error('无法读取前发分层清单。');
 const manifest=validateShortHairFringeManifest(await response.json()),poses={};
 for(const [id,p]of Object.entries(manifest.poses)){
  const images=await Promise.all(['ownership','weight','underpaint','hairOwnership'].map(key=>verifiedImage(p[key],`${id} ${key}`)));
  const [h,w,u,whole]=images.map(pixels),ownership=alphaMask(h,{binary:true}),weight=alphaMask(w),hairOwnership=alphaMask(whole,{binary:true});
  const [x,y,bw,bh]=p.binding.bounds;let nonzero=0,owned=0;
  for(let i=0;i<SIZE[0]*SIZE[1];i++){
   const k=i*4,px=i%SIZE[0],py=Math.floor(i/SIZE[0]);
   if(h[k]===255)owned++;
   if(h[k]===255&&(w[k]!==255||whole[k]!==255))throw new Error(`${id} 的前发与补画归属不一致。`);
   if(w[k]>0){nonzero++;if(u[k+3]!==255||px<x||py<y||px+1>x+bw||py+1>y+bh)throw new Error(`${id} 的补画或网格覆盖不足。`);}
   else if(u[k+3]!==0)throw new Error(`${id} 的补画越出登记范围。`);
  }
  if(nonzero<32||owned<32)throw new Error(`${id} 缺少实际前发区域。`);
  const weightedUnderpaint=canvas(),c=weightedUnderpaint.getContext('2d');c.drawImage(images[2],0,0);c.globalCompositeOperation='destination-in';c.drawImage(weight,0,0);c.globalCompositeOperation='source-over';
  poses[id]={ownership,weight,underpaint:images[2],weightedUnderpaint,hairOwnership,binding:createHairMeshBinding(p.binding),signature:[p.source.sha256,p.ownership.sha256,p.weight.sha256,p.underpaint.sha256].join(':')+JSON.stringify(p.binding),maskPixels:{ownership:h,weight:w,hairOwnership:whole}};
 }
 return {manifest,poses};
}
