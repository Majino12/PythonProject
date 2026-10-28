import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';
import {COMPLETE_POSE_IDS} from './complete-pose-gaze.js';
import {addInspectionDownload} from './diagnostic-sheet-export.js';

const host = document.querySelector('#comparisons'), output = document.querySelector('#result'), summary = document.querySelector('#summary');
const EYES = [
  {id:'open', eyeLeft:'open', eyeRight:'open'}, {id:'half', eyeLeft:'half', eyeRight:'half'},
  {id:'closed', eyeLeft:'closed', eyeRight:'closed'}, {id:'winkLeft', eyeLeft:'closed', eyeRight:'open'}, {id:'winkRight', eyeLeft:'open', eyeRight:'closed'},
];
const MOUTHS = ['neutral','openSmall','openWide','pucker','press','shiftLeft','shiftRight'];
const BROWS = ['neutral','innerUp','outerUp','down'];
const PAIRS = BROWS.flatMap(browLeft => BROWS.map(browRight => ({browLeft,browRight})));
const DIRECTIONS = [
  {id:'center',x:0,y:0}, {id:'up-left',x:-1,y:-1}, {id:'down-right',x:1,y:1},
  {id:'left',x:-1,y:0}, {id:'right',x:1,y:0}, {id:'up',x:0,y:-1}, {id:'down',x:0,y:1}, {id:'up-right',x:1,y:-1}, {id:'down-left',x:-1,y:1},
];
const neutral = {eyeLeft:'open',eyeRight:'open',mouth:'neutral',browLeft:'neutral',browRight:'neutral'};
const nativeCanvas = document.createElement('canvas'), nativeContext = nativeCanvas.getContext('2d',{willReadFrequently:true});
const inside = ([x,y,w,h],px,py) => px >= x && px < x+w && py >= y && py < y+h;
const gaze = ({x,y}) => ({eyeLeft:{x,y},eyeRight:{x,y}});

function render(assets,pose,state,direction,options={},canvas=document.createElement('canvas')) {
  drawSideExpression(canvas,assets,pose,state,{gaze:gaze(direction),...options}); return canvas;
}
function pixels(assets,pose,state,direction,options={}) {
  render(assets,pose,state,direction,{...options,faceOnly:false},nativeCanvas);
  return nativeContext.getImageData(0,0,nativeCanvas.width,nativeCanvas.height).data;
}
function card(parent,canvas,label) {
  const figure=document.createElement('figure'),caption=document.createElement('figcaption');
  canvas.setAttribute('aria-label',label); caption.textContent=label; figure.append(canvas,caption); parent.append(figure);
}
function path(context,polygon) {
  context.beginPath(); polygon.forEach(([x,y],i)=>context[i?'lineTo':'moveTo'](x,y)); context.closePath();
}
function mask(width,height,polygons,boundary=0) {
  const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  for(const polygon of polygons) {path(context,polygon);context.fill();if(boundary){context.lineWidth=boundary*2;context.lineJoin='round';context.stroke();}}
  const pixels=context.getImageData(0,0,width,height).data,result=new Uint8Array(width*height);
  for(let i=0;i<result.length;i++)result[i]=pixels[i*4+3]?1:0;return result;
}
function protection(width,height,regions,required) {
  for(const name of required)if(!Array.isArray(regions?.[name])||!regions[name].length)throw new Error(`缺少${name}独立保护区。`);
  const names=Object.keys(regions);if(names.length>8)throw new Error('保护区类别过多。');
  const result=new Uint8Array(width*height);
  names.forEach((name,index)=>{const local=mask(width,height,regions[name]);for(let i=0;i<result.length;i++)if(local[i])result[i]|=1<<index;});
  return {names,mask:result};
}
function diff(a,b,width,rects,allowed,protectedMask) {
  if(a.length!==b.length)throw new Error('待比较原生尺寸不一致。');
  let changed=0,outsideRect=0,outsideClip=0,maxDelta=0;
  const protectedChanged=Object.fromEntries(protectedMask.names.map(name=>[name,0]));
  for(let i=0;i<a.length;i+=4){
    const delta=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]),Math.abs(a[i+3]-b[i+3]));if(!delta)continue;
    changed++;maxDelta=Math.max(maxDelta,delta);const pixel=i/4,x=pixel%width,y=Math.floor(pixel/width);
    if(rects&&!rects.some(rect=>inside(rect,x,y)))outsideRect++;if(allowed&&!allowed[pixel])outsideClip++;
    const flags=protectedMask.mask[pixel];if(flags)protectedMask.names.forEach((name,index)=>{if(flags&(1<<index))protectedChanged[name]++;});
  }
  return {changed,outsideRect,outsideClip,maxDelta,protectedChanged};
}
const rectangle = ([x,y,w,h]) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const patchMask = (width,height,patches) => mask(width,height,patches.map(p=>p.clip||rectangle(p.destination)),1);
function contactSheet(assets,pose,meta) {
  const title=document.createElement('h2');title.textContent=meta.label;host.append(title);
  const exportGroups=[{label:'脸部合成 / Face composites',items:[]}];
  addInspectionDownload(host,{id:`download-${pose}`,label:`下载${meta.label}原生检查图`,title:`${meta.label} / ${pose}`,
    filename:`${pose}-native-inspection.png`,groups:exportGroups});
  const faces=document.createElement('div');faces.className='row';host.append(faces);
  for(const [state,direction,label]of [
    [neutral,DIRECTIONS[0],'新姿态中性'],[{...neutral,eyeLeft:'half',eyeRight:'half',mouth:'openSmall'},DIRECTIONS[1],'半闭眼 · 小张嘴 · 左上视线'],
    [{...neutral,eyeLeft:'closed',eyeRight:'closed',mouth:'openWide',browLeft:'down',browRight:'down'},DIRECTIONS[2],'闭眼 · 大张嘴 · 压眉'],
  ]){
    const canvas=render(assets,pose,state,direction);card(faces,canvas,label);exportGroups[0].items.push({canvas,label});
  }
  const details=document.createElement('details'),heading=document.createElement('summary');heading.textContent='查看眼部、七种嘴型与双眉画稿';details.append(heading);host.append(details);
  for(const [group,title,entries]of [
    ['eyes','眼睑与原画 / Eyelids and source',[
      {state:neutral,direction:DIRECTIONS[0],label:'原画眼部 / owned source',original:true},
      ...EYES.map(eyes=>({state:{...neutral,...eyes},direction:DIRECTIONS[0],label:eyes.id})),
    ]],
    ['eyes','九向视线 / Gaze',DIRECTIONS.map(direction=>({state:neutral,direction,label:`视线 ${direction.id}`}))],
    ['mouth','七种嘴型 / Mouths',MOUTHS.map(mouth=>({state:{...neutral,mouth},direction:DIRECTIONS[0],label:mouth}))],
    ['brows','眉毛与发丝接缝 / Brows and hair junctions',BROWS.map(brow=>({state:{...neutral,browLeft:brow,browRight:brow},direction:DIRECTIONS[0],label:brow}))],
  ]){
    const row=document.createElement('div');row.className='row';details.append(row);
    const exportGroup={label:title,items:[]};exportGroups.push(exportGroup);
    for(const {state,direction,label,original=false}of entries){
      const canvas=render(assets,pose,state,direction,{detail:group,original});card(row,canvas,label);exportGroup.items.push({canvas,label});
    }
  }
}

try {
  const [assets,response]=await Promise.all([loadSideExpressionAssets('completePitch'),fetch('./assets/short-hair-complete-poses-v1/validation/registration.json',{cache:'no-store'})]);
  if(!response.ok)throw new Error('无法读取补全姿态保护区。');const geometry=await response.json(),{width,height}=assets.manifest;
  const report={schemaVersion:1,status:'running',generatedAt:new Date().toISOString(),nativeSize:[width,height],asset:{id:assets.manifest.id,status:assets.manifest.status},
    measuringContext:nativeContext.getContextAttributes?.()||null,
    criteria:{mouth:'7 mouths × 5 eyelids × 3 gaze directions; only selected mouth pixels may change',brows:'16 brow pairs × 7 mouth/eyelid/gaze contexts; independent brow removal remains on its own side',
      gaze:'5 eyelid states × 9 directions; changes stay in actual visible apertures, closed eyes never show iris',original:'Native original equals the owned source image regardless of target channels',
      limits:'Exact RGBA comparisons; one source pixel of aperture/clip antialias allowance, strict destination rectangles. These checks cannot establish expression beauty or pose anatomy.'},
    poses:{},summary:{passed:null,mouthCombinations:0,browCombinations:0,gazeCombinations:0,comparisons:0,assertions:0,failedAssertions:0,failures:[]}};
  const check=(pass,pose,name,data={})=>{report.summary.assertions++;if(!pass){report.summary.failedAssertions++;report.summary.failures.push({pose,check:name,...data});}};
  const compare=(...args)=>{report.summary.comparisons++;return diff(...args);};
  for(const [poseIndex,pose]of COMPLETE_POSE_IDS.entries()){
    const meta=assets.manifest.poses[pose],regions=geometry.poses?.[pose]?.protection;
    const noProtection={names:[],mask:new Uint8Array(width*height)};
    const browProtection=protection(width,height,Object.fromEntries(Object.entries(regions||{}).filter(([name])=>name!=='brows')),['eyes','mouth','nose','hair','chin']);
    const mouthRegions=Object.fromEntries(Object.entries(regions||{}).filter(([name])=>name!=='mouth'));
    mouthRegions.browDrawings=['browLeft','browRight'].flatMap(group=>Object.values(meta.patches[group]).map(p=>rectangle(p.destination)));
    const mouthProtection=protection(width,height,mouthRegions,['eyes','nose','hair','chin']);
    const browMasks=new Map(PAIRS.map(pair=>{const patches=['browLeft','browRight'].map(group=>meta.patches[group][pair[group]]).filter(Boolean);return [JSON.stringify(pair),{rects:patches.map(p=>p.destination),mask:patchMask(width,height,patches)}];}));
    const mouths=Object.fromEntries(MOUTHS.map(mouth=>{const patch=meta.patches.mouth[mouth];return [mouth,{rects:patch?[patch.destination]:[],mask:patchMask(width,height,patch?[patch]:[])}];}));
    const result={label:meta.label,mouths:[],brows:[],gaze:[],original:[],repeatability:[]};report.poses[pose]=result;
    summary.textContent=`正在检查 ${poseIndex+1}/3：${meta.label}…`;contactSheet(assets,pose,meta);
    const probe={...neutral,eyeRight:'half',mouth:'press',browLeft:'outerUp',browRight:'down'};
    const before=pixels(assets,pose,probe,DIRECTIONS[2]);
    for(const eyes of EYES)for(const direction of DIRECTIONS.slice(0,3)){
      const state={...neutral,...eyes},base=pixels(assets,pose,state,direction);
      for(const mouth of MOUTHS){
        const bounds=mouths[mouth],delta=compare(base,pixels(assets,pose,{...state,mouth},direction),width,bounds.rects,bounds.mask,mouthProtection),key={eyes:eyes.id,gaze:direction.id,mouth};
        result.mouths.push({...key,...delta});report.summary.mouthCombinations++;
        check(delta.outsideRect===0&&delta.outsideClip===0,pose,'mouth-boundary',{...key,outsideRect:delta.outsideRect,outsideClip:delta.outsideClip});
        check(Object.values(delta.protectedChanged).every(v=>v===0),pose,'mouth-protected-anatomy',{...key,changed:delta.protectedChanged});
        check(mouth==='neutral'?delta.changed===0:delta.changed>0,pose,'mouth-visible',{...key,changed:delta.changed});
      }
    }
    for(const [index,mouth]of MOUTHS.entries()){
      const eyes=EYES[index%EYES.length],direction=DIRECTIONS[index%3],state={...neutral,...eyes,mouth},base=pixels(assets,pose,state,direction);
      for(const pair of PAIRS){
        const bounds=browMasks.get(JSON.stringify(pair)),actualState={...state,...pair},actual=pixels(assets,pose,actualState,direction);
        const delta=compare(base,actual,width,bounds.rects,bounds.mask,browProtection),key={eyes:eyes.id,gaze:direction.id,mouth,...pair};
        const item={...key,...delta};result.brows.push(item);report.summary.browCombinations++;
        check(delta.outsideRect===0&&delta.outsideClip===0,pose,'brow-boundary',{...key,outsideRect:delta.outsideRect,outsideClip:delta.outsideClip});
        check(Object.values(delta.protectedChanged).every(v=>v===0),pose,'brow-protected-anatomy',{...key,changed:delta.protectedChanged});
        check(bounds.rects.length?delta.changed>0:delta.changed===0,pose,'brow-visible',{...key,changed:delta.changed});
        for(const group of ['browLeft','browRight'])if(pair[group]!=='neutral'){
          const single={browLeft:group==='browLeft'?pair[group]:'neutral',browRight:group==='browRight'?pair[group]:'neutral'},local=browMasks.get(JSON.stringify(single));
          const one=compare(pixels(assets,pose,{...actualState,[group]:'neutral'},direction),actual,width,local.rects,local.mask,browProtection);
          (item.independentBrows||={})[group]=one;check(one.changed>0&&one.outsideRect===0&&one.outsideClip===0,pose,'independent-brow',{...key,group,changed:one.changed,outsideRect:one.outsideRect,outsideClip:one.outsideClip});
        }
      }
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    for(const eyes of EYES){
      const state={...neutral,...eyes},base=pixels(assets,pose,state,DIRECTIONS[0]);
      const polygons=['eyeLeft','eyeRight'].flatMap(eye=>assets.manifest.gaze.poses[pose].eyes[eye].frames[state[eye]]?.aperture?[assets.manifest.gaze.poses[pose].eyes[eye].frames[state[eye]].aperture]:[]);
      const allowed=mask(width,height,polygons,1);
      for(const direction of DIRECTIONS){
        const delta=compare(base,pixels(assets,pose,state,direction),width,null,allowed,noProtection),key={eyes:eyes.id,gaze:direction.id};
        result.gaze.push({...key,...delta});report.summary.gazeCombinations++;
        check(delta.outsideClip===0,pose,'gaze-aperture',{...key,changed:delta.outsideClip});
        check(direction.id==='center'||eyes.id==='closed'?delta.changed===0:delta.changed>0,pose,'gaze-visible-only-open-eyes',{...key,changed:delta.changed});
      }
    }
    // Draw the owned source directly, independent of the renderer's original
    // branch, so a misrouted reference would be detected by this comparison.
    const originalCanvas=document.createElement('canvas');originalCanvas.width=width;originalCanvas.height=height;
    const context=originalCanvas.getContext('2d',{willReadFrequently:true});context.drawImage(assets.images[meta.reference],0,0);
    const source=context.getImageData(0,0,width,height).data;
    for(const [index,pair]of PAIRS.entries()){
      const state={...neutral,...pair,...EYES[index%EYES.length],mouth:MOUTHS[index%MOUTHS.length]};
      const delta=compare(source,pixels(assets,pose,state,DIRECTIONS[index%DIRECTIONS.length],{original:true}),width,null,null,noProtection);
      result.original.push({...pair,...delta});check(delta.changed===0,pose,'original-owned-source',{...pair,changed:delta.changed});
    }
    const after=pixels(assets,pose,probe,DIRECTIONS[2]);
    for(const [stage,reference]of [['before-after',before],['repeat-after',pixels(assets,pose,probe,DIRECTIONS[2])]]){
      const delta=compare(reference,after,width,null,null,noProtection);result.repeatability.push({stage,...delta});check(delta.changed===0,pose,'repeatability',{stage,changed:delta.changed});
    }
    output.textContent=JSON.stringify(report,null,2);await new Promise(resolve=>setTimeout(resolve,0));
  }
  report.status='complete';report.summary.passed=report.summary.failedAssertions===0;output.textContent=JSON.stringify(report,null,2);
  summary.dataset.state=report.summary.passed?'passed':'failed';summary.textContent=`${width} × ${height} 原生像素；${report.summary.mouthCombinations} 组嘴型、${report.summary.browCombinations} 组眉毛、${report.summary.gazeCombinations} 组视线；${report.summary.assertions} 项断言，${report.summary.failedAssertions} 项未通过。`;
}catch(error){
  output.textContent=JSON.stringify({schemaVersion:1,status:'error',error:error.message,stack:error.stack},null,2);
  summary.dataset.state='failed';summary.textContent=`检查未完成：${error.message}`;
}
