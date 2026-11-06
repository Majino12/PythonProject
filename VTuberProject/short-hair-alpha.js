import {renderShortHairStudio,selectShortHairStudioState} from './short-hair-studio-renderer.js';

/** Model-derived alpha, independent of authored RGB and expression selection.
 * The browser only loads prepared masks; it never downloads/runs a segmenter.
 */
export const SHORT_HAIR_ALPHA_POSES=Object.freeze(['front','view-left','view-right','view-left-up','view-right-up','view-left-down','view-up','view-down','view-right-down']);
export const SHORT_HAIR_FEATURE_GROUPS=Object.freeze(['eyeLeft','eyeRight','browLeft','browRight','mouth']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sourcePath=value=>typeof value==='string'&&/^\.\/assets\/[a-zA-Z0-9_/-]+\.png$/.test(value)&&!value.includes('..');
const imageSize=image=>[image.naturalWidth??image.width,image.naturalHeight??image.height];

export function validateShortHairAlphaManifest(manifest){
 if(!object(manifest)||manifest.schemaVersion!==1||manifest.id!=='short-hair-alpha-v1'||manifest.width!==1122||manifest.height!==1402
  ||manifest.status!=='derived-candidate'||!object(manifest.poses)||Object.keys(manifest.poses).length!==9
  ||!object(manifest.model)||!hash(manifest.model.sha256))throw new Error('透明遮罩清单无效。');
 for(const id of SHORT_HAIR_ALPHA_POSES){
  const pose=manifest.poses[id];
  if(!object(pose)||!sourcePath(pose.source)||!hash(pose.sourceSha256)||!hash(pose.matteSha256)
   ||pose.matte!==`./assets/short-hair-alpha-v1/${id}-matte.png`
   ||!Number.isSafeInteger(pose.sourceBytes)||pose.sourceBytes<1||!Number.isSafeInteger(pose.matteBytes)||pose.matteBytes<1
   ||!Array.isArray(pose.neckline)||pose.neckline.length<2||pose.neckline.length>32
   ||pose.neckline.some((p,i)=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<0||p[0]>1122||p[1]<0||p[1]>1402
    ||i>0&&p[0]<=pose.neckline[i-1][0])||pose.neckline[0][0]!==0||pose.neckline.at(-1)[0]!==1122)
    throw new Error(`${id} 的透明遮罩、来源或颈线登记无效。`);
 }
 return manifest;
}

export async function loadShortHairAlphaAssets(){
 const response=await fetch('./assets/short-hair-alpha-v1/manifest.json',{cache:'no-store'});
 if(!response.ok)throw new Error('无法读取透明角色素材清单。');
 const manifest=validateShortHairAlphaManifest(await response.json());
 const mattes={};
 for(const id of SHORT_HAIR_ALPHA_POSES){
  const entry=manifest.poses[id],response=await fetch(entry.matte,{cache:'no-store'});
  if(!response.ok)throw new Error(`${id} 透明遮罩无法读取。`);
  const buffer=await response.arrayBuffer();
  if(buffer.byteLength!==entry.matteBytes)throw new Error(`${id} 透明遮罩长度不匹配。`);
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),value=>value.toString(16).padStart(2,'0')).join('');
  if(digest!==entry.matteSha256)throw new Error(`${id} 透明遮罩校验失败。`);
  const url=URL.createObjectURL(new Blob([buffer],{type:'image/png'}));
  try{
   mattes[id]=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error(`${id} 透明遮罩无法解码。`));image.src=url;});
  }finally{URL.revokeObjectURL(url);}
  if(imageSize(mattes[id]).some((n,i)=>n!==[1122,1402][i]))throw new Error(`${id} 透明遮罩尺寸不匹配。`);
 }
 return {manifest,mattes,matteByPose:mattes};
}

function context(alphaAssets,poseId,view){
 if(!SHORT_HAIR_ALPHA_POSES.includes(poseId))throw new Error('未知的透明角色姿态。');
 const pose=alphaAssets?.manifest?.poses?.[poseId],matte=(alphaAssets?.matteByPose??alphaAssets?.mattes)?.[poseId];
 if(!pose||!matte)throw new Error('当前姿态缺少已校验的透明遮罩。');
 if(!Array.isArray(view)||view.length!==4||!view.every(Number.isFinite)||view[0]<0||view[1]<0||view[2]<=0||view[3]<=0||view[0]+view[2]>1122||view[1]+view[3]>1402)throw new Error('透明裁切区域无效。');
 return {pose,matte};
}

/** Apply once, AFTER expression/gaze composition. `view` is the source artwork
 * rectangle, even when the destination canvas is scaled to a different size. */
export function applyShortHairAlpha(canvas,alphaAssets,poseId,view=[0,0,1122,1402]){
 const {matte}=context(alphaAssets,poseId,view),c=canvas.getContext('2d');
 c.save();
 try{c.setTransform(1,0,0,1,0,0);c.globalAlpha=1;c.globalCompositeOperation='destination-in';c.drawImage(matte,...view,0,0,canvas.width,canvas.height);}
 finally{c.restore();}
 return canvas;
}

/** Per-pixel ownership gives complementary visible partitions. No feathered
 * overlaps, regenerated pixels or guessed hidden neck/cloth are introduced. */
export function headOwnsPixel(neckline,x,y){
 if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error('像素位置无效。');
 if(x<=neckline[0][0])return y<neckline[0][1];
 if(x>=neckline.at(-1)[0])return y<neckline.at(-1)[1];
 const right=neckline.findIndex(point=>point[0]>=x);
 const i=right<=0?1:right,from=neckline[i-1],to=neckline[i];
 const mix=Math.max(0,Math.min(1,(x-from[0])/(to[0]-from[0])));
 return y<from[1]+(to[1]-from[1])*mix;
}

function newCanvas(width,height){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;}

/** Returns native-coordinate visible cutouts for download. Set alphaApplied
 * only if the input already passed applyShortHairAlpha; applying twice would
 * darken semi-transparent edges. Each partition preserves the input RGB. */
export function createShortHairVisibleLayers(canvas,alphaAssets,poseId,{view=[0,0,1122,1402],alphaApplied=false}={}){
 const {pose}=context(alphaAssets,poseId,view),character=newCanvas(canvas.width,canvas.height);
 character.getContext('2d').drawImage(canvas,0,0);
 if(!alphaApplied)applyShortHairAlpha(character,alphaAssets,poseId,view);
 const head=newCanvas(canvas.width,canvas.height),torso=newCanvas(canvas.width,canvas.height);
 const pixels=character.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
 const headPixels=head.getContext('2d').createImageData(canvas.width,canvas.height),torsoPixels=torso.getContext('2d').createImageData(canvas.width,canvas.height);
 headPixels.data.set(pixels.data);torsoPixels.data.set(pixels.data);
 for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
  const owns=headOwnsPixel(pose.neckline,view[0]+(x+.5)*view[2]/canvas.width,view[1]+(y+.5)*view[3]/canvas.height);
  (owns?torsoPixels:headPixels).data[(y*canvas.width+x)*4+3]=0;
 }
 head.getContext('2d').putImageData(headPixels,0,0);torso.getContext('2d').putImageData(torsoPixels,0,0);
 return {character,head,torso};
}

const families=Object.freeze({front:'front','view-left':'side','view-right':'side','view-left-up':'pitch','view-right-up':'pitch','view-left-down':'pitch','view-up':'complete','view-down':'complete','view-right-down':'complete'});

/** Authored non-neutral cutouts retain fixed patch feathering and position.
 * Neutral cutouts are crops of the displayed native composition, including
 * current gaze. These are replacement paintings containing skin, NOT isolated
 * anatomical eyes/lips and NOT additional layers to stack over one another. */
export function createShortHairFeatureLayers(studioAssets,poseId,state,nativeCanvas){
 if(nativeCanvas.width!==1122||nativeCanvas.height!==1402)throw new Error('五官导出需要完整原生尺寸的角色画面。');
 const source=studioAssets?.[families[poseId]],front=poseId==='front',record=front?source?.manifest:source?.manifest?.poses?.[poseId],compiled=front?source?.compiled:source?.compiled?.[poseId];
 if(!record||!compiled)throw new Error('缺少此姿态的五官画稿。');
 const layers={},descriptors={};
 for(const group of SHORT_HAIR_FEATURE_GROUPS){
  const canvas=newCanvas(1122,1402),c=canvas.getContext('2d'),paint=record.patches[group]?.[state?.[group]];
  if(paint&&compiled[group]?.[state[group]]){
   if(group.startsWith('eye')){
    // Keep the current eyeball/gaze visible through this authored lid mask.
    c.drawImage(nativeCanvas,...paint.destination,...paint.destination);
    c.globalCompositeOperation='destination-in';c.drawImage(compiled[group][state[group]],paint.destination[0],paint.destination[1]);
   }else c.drawImage(compiled[group][state[group]],paint.destination[0],paint.destination[1]);
   descriptors[group]={kind:'authored-replacement-patch',state:state[group],rect:[...paint.destination],source:source.manifest.sources[paint.source].src};
  }else{
   const neutral=group.startsWith('eye')?'open':'neutral';
   if(state?.[group]!==neutral)throw new Error(`${group} 的导出状态没有实际画稿。`);
   const rects=Object.values(record.patches[group]).map(p=>p.destination),x=Math.min(...rects.map(p=>p[0])),y=Math.min(...rects.map(p=>p[1]));
   const w=Math.max(...rects.map(p=>p[0]+p[2]))-x,h=Math.max(...rects.map(p=>p[1]+p[3]))-y;
   c.drawImage(nativeCanvas,x,y,w,h,x,y,w,h);
   descriptors[group]={kind:'displayed-neutral-crop',state:neutral,rect:[x,y,w,h],source:source.manifest.sources[record.reference].src};
  }
  layers[group]=canvas;
 }
 return {layers,descriptors};
}

const crcTable=Uint32Array.from({length:256},(_,value)=>{let c=value;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const value of bytes)crc=crcTable[(crc^value)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function header(length){const bytes=new Uint8Array(length),view=new DataView(bytes.buffer);return {bytes,u16:(at,value)=>view.setUint16(at,value,true),u32:(at,value)=>view.setUint32(at,value,true)};}
function concat(parts){const result=new Uint8Array(parts.reduce((sum,p)=>sum+p.byteLength,0));let offset=0;for(const part of parts){result.set(part,offset);offset+=part.byteLength;}return result;}

/** Minimal ZIP STORE encoder: no executable entries, paths, ZIP64 or external
 * dependency. Files are already PNG-compressed. UTF-8 names and CRC32 included. */
export function createShortHairLayerZip(entries){
 if(!Array.isArray(entries)||entries.length<1||entries.length>32)throw new Error('图层归档项目数量无效。');
 const names=new Set(),locals=[],centrals=[];let offset=0;
 for(const entry of entries){
  if(!object(entry)||typeof entry.name!=='string'||!/^[a-zA-Z0-9_-]+\.(png|json|txt)$/.test(entry.name)||names.has(entry.name)
   ||!(entry.data instanceof Uint8Array)||entry.data.byteLength>32*1024*1024)throw new Error('图层归档文件无效。');
  names.add(entry.name);const name=new TextEncoder().encode(entry.name),size=entry.data.byteLength,crc=crc32(entry.data);
  const local=header(30);local.u32(0,0x04034b50);local.u16(4,20);local.u16(6,0x0800);local.u16(12,0x21);local.u32(14,crc);local.u32(18,size);local.u32(22,size);local.u16(26,name.length);
  locals.push(local.bytes,name,entry.data);
  const central=header(46);central.u32(0,0x02014b50);central.u16(4,20);central.u16(6,20);central.u16(8,0x0800);central.u16(14,0x21);central.u32(16,crc);central.u32(20,size);central.u32(24,size);central.u16(28,name.length);central.u32(42,offset);
  centrals.push(central.bytes,name);offset+=30+name.length+size;
 }
 const central=concat(centrals),end=header(22);end.u32(0,0x06054b50);end.u16(8,entries.length);end.u16(10,entries.length);end.u32(12,central.length);end.u32(16,offset);
 return concat([...locals,central,end.bytes]);
}

function pngBytes(canvas){return new Promise((resolve,reject)=>canvas.toBlob(blob=>{if(!blob){reject(new Error('PNG 图层导出失败。'));return;}blob.arrayBuffer().then(bytes=>resolve(new Uint8Array(bytes)),reject);},'image/png'));}

/** One synchronous native-pose composition serves inspection and ZIP export.
 * Endpoint compatibility is resolved before any five-feature layer is cut. */
export function createShortHairLayerFrame(assets,poseId,coefficients,{state}={}){
 if(!assets?.alpha)throw new Error('透明图层尚未加载完成。');
 if(!SHORT_HAIR_ALPHA_POSES.includes(poseId))throw new Error('未知的透明角色姿态。');
 const source=assets[families[poseId]],record=poseId==='front'?source?.manifest:source?.manifest?.poses?.[poseId],compiled=poseId==='front'?source?.compiled:source?.compiled?.[poseId];
 const selected=selectShortHairStudioState(assets,poseId,coefficients,{}).targetState;
 const native=newCanvas(1122,1402),options={faceOnly:false,stateOverride:compatibleShortHairExportState(selected,state,record,compiled)};
 const rendered=renderShortHairStudio(native,assets,poseId,coefficients,{},options);
 const visible=createShortHairVisibleLayers(native,assets.alpha,poseId);
 const features=createShortHairFeatureLayers(assets,poseId,rendered.state,native);
 const original=assets.alpha.manifest.poses[poseId].source,rect=[0,0,1122,1402];
 return {poseId,state:{...rendered.state},layers:{...visible,...features.layers},descriptors:{
  character:{kind:'transparent-character',source:original,rect:[...rect]},
  head:{kind:'visible-head-partition',source:original,rect:[...rect],includes:['hair','face'],hiddenPixelsReconstructed:false},
  torso:{kind:'visible-torso-partition',source:original,rect:[...rect],hiddenPixelsReconstructed:false},
  ...features.descriptors}};
}

/** UI entry point. Exports the authored pose endpoint with current expressions,
 * irrespective of preview crop/scale. Motion-model in-between images are not
 * mislabelled as authored feature layers. Source files remain untouched. */
export async function exportShortHairLayers(assets,poseId,coefficients,{state}={}){
 const inspection=createShortHairLayerFrame(assets,poseId,coefficients,{state});
 const entries=[];
 for(const [name,canvas]of Object.entries(inspection.layers))entries.push({name:`${name}.png`,data:await pngBytes(canvas)});
 const descriptor={schemaVersion:1,kind:'short-hair-visible-layer-export',poseId,width:1122,height:1402,
  source:assets.alpha.manifest.poses[poseId],state:inspection.state,features:Object.fromEntries(SHORT_HAIR_FEATURE_GROUPS.map(group=>[group,inspection.descriptors[group]])),
  compositing:'head.png and torso.png are mutually exclusive visible partitions; their sum recreates character.png. Feature PNGs are authored replacement patches, not additive anatomy.',
  limitations:['No occluded neck, scalp, face or clothes have been reconstructed.','Hair and face are together in head.png.','Neutral feature crops and eyelid patches include current gaze.','The export uses the authored endpoint pose; motion interpolation is not flattened into feature layers.']};
 entries.push({name:'layers.json',data:new TextEncoder().encode(JSON.stringify(descriptor,null,2)+'\n')});
 entries.push({name:'README.txt',data:new TextEncoder().encode('透明分层导出\ncharacter.png：当前姿态角色透明图。\nhead.png + torso.png：沿登记颈线分开的可见像素，位置与原图一致，两层合成可还原 character.png。\n眼、口、眉 PNG：对应实际画稿的局部替换片，含皮肤及原有遮挡；不是可任意叠加的纯五官。眼部含当前视线。\n没有补画被遮挡的脸、头皮、颈部或衣服；头发与脸仍在同一头部层。\n导出的是当前选定的实际姿态端点，不把转头模型中间图冒充为画师分层。\n')});
 return {blob:new Blob([createShortHairLayerZip(entries)],{type:'application/zip'}),filename:`short-hair-${poseId}-layers.zip`};
}

/** A preview can be between two poses. Reuse only states actually painted for
 * the export endpoint; e.g. a front "up" brow cannot enter a side "innerUp" set. */
export function compatibleShortHairExportState(selected,displayed,record,compiled){
 if(!object(selected)||!record?.patches||!compiled)throw new Error('导出姿态缺少表情定义。');
 if(displayed!==undefined&&!object(displayed))throw new Error('导出显示状态无效。');
 const result={...selected};
 for(const group of SHORT_HAIR_FEATURE_GROUPS){
  const value=displayed?.[group],neutral=group.startsWith('eye')?'open':'neutral';
  if(value===neutral||typeof value==='string'&&Object.hasOwn(record.patches[group]??{},value)&&Object.hasOwn(compiled[group]??{},value))result[group]=value;
 }
 return result;
}
