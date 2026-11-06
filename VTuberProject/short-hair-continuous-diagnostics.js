import {loadContinuousShortHairAssets,renderContinuousShortHairStudio} from './short-hair-continuous-renderer.js';
import {renderShortHairStudio} from './short-hair-studio-renderer.js';
import {STUDIO_HEAD_POSES,poseHeadCoordinates,nearestStudioPoseId} from './short-hair-pose-motion.js';
import {continuousViewport} from './short-hair-continuous-model.js';
import {drawOutputFrame} from './short-hair-studio-output-model.js';
import {createShortHairLayerInspection} from './short-hair-layer-inspector.js';
import {sanitizeChannels} from './expression-model.js';

/** Premultiplied RGB makes transparent-edge comparisons meaningful: invisible
 * RGB is not counted as a seam. Alpha is measured separately and in RGBA mean. */
export function compareDiagnosticPixels(a,b,{premultiplied=false}={}) {
  if(!a||!b||a.length!==b.length||a.length===0||a.length%4)throw new Error('像素比较需要相同长度的 RGBA。');
  let difference=0,alphaDifference=0,maxDifference=0,differentPixels=0;
  for(let i=0;i<a.length;i+=4){
    let changed=false;
    for(let c=0;c<4;c++){
      const x=c<3&&premultiplied?a[i+c]*a[i+3]/255:a[i+c];
      const y=c<3&&premultiplied?b[i+c]*b[i+3]/255:b[i+c];
      const delta=Math.abs(x-y);difference+=delta;maxDifference=Math.max(maxDifference,delta);changed ||= delta!==0;
      if(c===3)alphaDifference+=delta;
    }
    if(changed)differentPixels++;
  }
  return {pixels:a.length/4,differentPixels,meanAbsoluteDifference:difference/a.length,
    meanAlphaDifference:alphaDifference/(a.length/4),maxDifference};
}

export const CONTINUOUS_SEAM_CASES=Object.freeze([
  {name:'vertical-upper',yaw:0,pitch:.37,axis:'yaw'},
  {name:'vertical-lower',yaw:0,pitch:-.37,axis:'yaw'},
  {name:'horizontal-left',yaw:-.37,pitch:0,axis:'pitch'},
  {name:'horizontal-right',yaw:.37,pitch:0,axis:'pitch'},
  ...[1,0].flatMap(top=>[-1,0].map(left=>({name:`diagonal-${left}-${top}`,yaw:left+.43,pitch:top-.43,axis:'pitch'}))),
].map(Object.freeze));

const makeCanvas=(width=1122,height=1402)=>Object.assign(document.createElement('canvas'),{width,height});
const pixels=canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
const nextPaint=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));

export async function runContinuousDiagnostics(assets,{onProgress=()=>{},preview=null}={}) {
  const report={schemaVersion:1,kind:'short-hair-continuous-browser-validation',version:'0.18.0',
    startedAt:new Date().toISOString(),status:'running',checks:[],limitations:[
      'Pixel continuity is not an artistic-quality or real-camera/OBS acceptance test.',
      'Model pair fields are extended geometrically to triangle interiors; this is not three-image neural inference.',
      'Alpha tests check known exterior/interior pixels, not every fine hair boundary.',
    ]};
  const add=(name,passed,detail={})=>{
    report.checks.push({name,passed,...detail});onProgress(report);
  };
  const actual=makeCanvas(),native=makeCanvas(),expected=makeCanvas(),other=makeCanvas();
  const neutral=sanitizeChannels({});
  const render=(canvas,headPose,coefficients=neutral,options={})=>renderContinuousShortHairStudio(canvas,assets,
    nearestStudioPoseId(headPose),coefficients,{}, {headPose,faceOnly:true,transparent:false,...options});

  for(const pose of STUDIO_HEAD_POSES){
    const headPose=poseHeadCoordinates(pose.id);
    for(const [expression,coefficients] of [['neutral',neutral],['closed-eyes-open-jaw',sanitizeChannels({eyeBlinkLeft:1,eyeBlinkRight:1,jawOpen:1})]]){
      renderShortHairStudio(native,assets,pose.id,coefficients,{}, {faceOnly:false});
      for(const faceOnly of [true,false]){
        const view=continuousViewport(headPose,{faceOnly});expected.width=view[2];expected.height=view[3];
        expected.getContext('2d').clearRect(0,0,expected.width,expected.height);
        expected.getContext('2d').drawImage(native,...view,0,0,view[2],view[3]);
        render(actual,headPose,coefficients,{faceOnly});
        const metric=compareDiagnosticPixels(pixels(actual),pixels(expected));
        add(`endpoint:${pose.id}:${expression}:${faceOnly?'face':'full'}`,metric.differentPixels===0,{metric});
      }
    }
    render(actual,headPose,neutral,{faceOnly:false,transparent:true});
    const data=pixels(actual),entry=assets[pose.id==='front'?'front':assets.poses.find(item=>item.id===pose.id).sourceFamily];
    const record=pose.id==='front'?entry.manifest:entry.manifest.poses[pose.id];
    const [x,y]=record.mouthReference,inside=data[(Math.round(y)*1122+Math.round(x))*4+3];
    const corners=[data[3],data[(1122-1)*4+3]];
    add(`alpha:${pose.id}`,corners.every(value=>value===0)&&inside>=250,{topCorners:corners,mouthInterior:inside});
    await nextPaint();
  }

  const epsilon=.0001,seamMeanLimit=1;
  for(const seam of CONTINUOUS_SEAM_CASES)for(const transparent of [false,true]){
    const before={yaw:seam.yaw,pitch:seam.pitch},after={...before};before[seam.axis]-=epsilon;after[seam.axis]+=epsilon;
    render(actual,before,neutral,{transparent});render(other,after,neutral,{transparent});
    const metric=compareDiagnosticPixels(pixels(actual),pixels(other),{premultiplied:transparent});
    add(`seam:${seam.name}:${transparent?'alpha':'opaque'}`,metric.meanAbsoluteDifference<=seamMeanLimit,
      {epsilon,meanLimit:seamMeanLimit,metric});
    await nextPaint();
  }

  const middle={yaw:.37,pitch:.22};render(actual,middle,neutral,{transparent:true});const resting=pixels(actual);
  for(const [name,channels] of [['eyes',{eyeBlinkLeft:1,eyeBlinkRight:1}],['mouth',{jawOpen:1}]]){
    render(other,middle,sanitizeChannels(channels),{transparent:true});
    const metric=compareDiagnosticPixels(resting,pixels(other),{premultiplied:true});
    add(`intermediate-expression:${name}`,metric.differentPixels>100&&metric.meanAbsoluteDifference>.005,{metric});
  }
  const output=makeCanvas(1280,720),context=output.getContext('2d');
  context.fillStyle='#ff0000';context.fillRect(0,0,1280,720);
  drawOutputFrame(output,actual,{transparent:true});const outputPixels=pixels(output);
  const corners=[0,1279,719*1280,720*1280-1].map(index=>outputPixels[index*4+3]);
  add('output:transparent-corners',corners.every(value=>value===0),{size:[1280,720],cornerAlpha:corners});

  for(const pose of STUDIO_HEAD_POSES){
    const inspection=createShortHairLayerInspection(assets,pose.id,sanitizeChannels({eyeBlinkLeft:.5,jawOpen:.5}));
    const layers=inspection.layers;
    add(`layers:full-size:${pose.id}`,Object.keys(layers).length===8&&Object.values(layers).every(layer=>layer.width===1122&&layer.height===1402));
    native.width=1122;native.height=1402;const nc=native.getContext('2d');nc.clearRect(0,0,1122,1402);nc.drawImage(layers.head,0,0);nc.drawImage(layers.torso,0,0);
    const metric=compareDiagnosticPixels(pixels(layers.character),pixels(native),{premultiplied:true});
    add(`layers:head-torso-reconstruction:${pose.id}`,metric.meanAbsoluteDifference<.01&&metric.meanAlphaDifference===0,{metric});
    await nextPaint();
  }
  const secondary={breath:.55,sway:-.25,hair:.6};
  for(const headPose of [{yaw:0,pitch:0},middle,{yaw:-.7,pitch:.6}]){
    render(actual,headPose,neutral,{transparent:true});const zeroPixels=pixels(actual);
    render(other,headPose,neutral,{transparent:true,secondary:{breath:0,sway:0,hair:0}});
    let metric=compareDiagnosticPixels(zeroPixels,pixels(other));
    add(`secondary:zero:${headPose.yaw},${headPose.pitch}`,metric.differentPixels===0,{metric});
    render(other,headPose,neutral,{transparent:true,secondary});const moved=pixels(other);
    metric=compareDiagnosticPixels(zeroPixels,moved,{premultiplied:true});
    add(`secondary:bounded:${headPose.yaw},${headPose.pitch}`,metric.differentPixels>100&&metric.meanAbsoluteDifference<5,{metric});
    render(actual,headPose,neutral,{transparent:true,secondary});
    metric=compareDiagnosticPixels(pixels(actual),moved);
    add(`secondary:deterministic:${headPose.yaw},${headPose.pitch}`,metric.differentPixels===0,{metric});
    await nextPaint();
  }
  render(actual,middle,neutral,{transparent:true,secondary});
  drawOutputFrame(output,actual,{transparent:true,composition:{scale:.75,x:.2,y:-.1,mirror:true}});
  expected.width=1280;expected.height=720;
  const ec=expected.getContext('2d'),fit=Math.min(1280/actual.width,720/actual.height)*.75;
  ec.save();ec.translate(1280*.6,720*.45);ec.scale(-1,1);ec.drawImage(actual,-actual.width*fit/2,-actual.height*fit/2,actual.width*fit,actual.height*fit);ec.restore();
  const compositionMetric=compareDiagnosticPixels(pixels(output),pixels(expected));
  add('output:composition-mirror',compositionMetric.differentPixels===0,{metric:compositionMetric});

  // Exercise the actual browser GPU lifecycle, not just a stubbed flag.
  const renderer=assets.flowRenderer,extension=renderer.gl.getExtension('WEBGL_lose_context');
  if(extension){
    const gpuEvent=name=>new Promise((resolve,reject)=>{
      const handler=()=>{clearTimeout(timeout);resolve();};
      const timeout=setTimeout(()=>{renderer.canvas.removeEventListener(name,handler);reject(new Error('GPU event timeout: '+name));},10000);
      renderer.canvas.addEventListener(name,handler,{once:true});
    });
    const beforeLoss=pixels(actual),lost=gpuEvent('webglcontextlost');extension.loseContext();await lost;
    const attempt=render(actual,middle,neutral,{transparent:true,secondary});
    const lostMetric=compareDiagnosticPixels(beforeLoss,pixels(actual));
    add('graphics:loss-retains-frame',attempt.didDraw===false&&lostMetric.differentPixels===0,{metric:lostMetric});
    await new Promise(resolve=>setTimeout(resolve,100));
    const restored=gpuEvent('webglcontextrestored');extension.restoreContext();await restored;
    const restoredResult=render(actual,middle,neutral,{transparent:true,secondary});
    const restoredMetric=compareDiagnosticPixels(beforeLoss,pixels(actual));
    add('graphics:restore-rebuilds-resources',restoredResult.didDraw===true&&restoredMetric.differentPixels===0,{metric:restoredMetric});
  }else add('graphics:restore-rebuilds-resources',false,{reason:'WEBGL_lose_context unavailable; restoration not exercised'});

  if(preview){render(preview,middle,sanitizeChannels({jawOpen:.65,eyeBlinkLeft:.5}),{transparent:true});}
  report.status=report.checks.every(check=>check.passed)?'passed':'failed';
  report.summary={checks:report.checks.length,passed:report.checks.filter(check=>check.passed).length,
    failed:report.checks.filter(check=>!check.passed).length,endpointComparisons:36,seamComparisons:16};
  report.finishedAt=new Date().toISOString();onProgress(report);return report;
}

if(typeof document!=='undefined'){
  const run=document.querySelector('#run'),download=document.querySelector('#download'),reportNode=document.querySelector('#report');
  let assets=null,result=null,lastReport=null;
  const show=report=>{lastReport=report;reportNode.textContent=JSON.stringify(report,null,2);};
  run.addEventListener('click',async()=>{
    run.disabled=true;download.disabled=true;result=null;document.querySelector('#status').textContent='正在核验本地素材并运行像素比较…';
    show({status:'loading'});
    try{
      assets ||= await loadContinuousShortHairAssets();
      result=await runContinuousDiagnostics(assets,{onProgress:show,preview:document.querySelector('#preview')});
      document.querySelector('#status').textContent=`${result.status==='passed'?'通过':'存在失败'} · ${result.summary.passed}/${result.summary.checks} 项`;
    }catch(error){result={...lastReport,status:'error',message:error.message,stack:error.stack};show(result);document.querySelector('#status').textContent=`验收未完成：${error.message}`;}
    finally{run.disabled=false;download.disabled=false;}
  });
  download.addEventListener('click',()=>{
    if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='v0.18-continuous-browser-validation.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  window.addEventListener('pagehide',()=>assets?.flowRenderer?.dispose());
}
