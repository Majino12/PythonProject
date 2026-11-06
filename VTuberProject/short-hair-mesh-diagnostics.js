import {createHairMeshBinding,deformHairMesh} from './short-hair-mesh-model.js';
import {ShortHairMeshRenderer} from './short-hair-mesh-renderer.js';
const makeCanvas=()=>{const c=document.createElement('canvas');c.width=1122;c.height=1402;return c;};
const pixels=source=>{const c=makeCanvas();c.getContext('2d').drawImage(source,0,0);return c.getContext('2d').getImageData(0,0,1122,1402).data;};
const at=(data,x,y)=>Array.from(data.slice((y*1122+x)*4,(y*1122+x)*4+4));
const equal=(a,b,tolerance=0)=>a.every((value,i)=>Math.abs(value-b[i])<=tolerance);
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
function syntheticSource(){const c=makeCanvas(),g=c.getContext('2d');
  for(const [color,rect]of [['#e53225',[260,280,40,40]],['#264deb',[260,1050,40,40]],['rgba(20,220,80,0.5)',[440,600,40,40]],['#24b879',[150,820,600,80]],['#ef51c0',[800,700,80,80]],['#e0ae20',[260,40,40,40]]]){g.fillStyle=color;g.fillRect(...rect);}return c;
}
function syntheticBinding(extra={}){return createHairMeshBinding({schemaVersion:1,kind:'short-hair-mesh-binding',poseId:'front',sourceSha256:'1'.repeat(64),bounds:[0,0,1122,1402],grid:{columns:33,rows:41},rootLine:[[0,100],[1122,100]],tipLine:[[0,250],[1122,250]],travel:{x:6,y:0},revealMarginPx:8,runtimeValidated:true,protectedRegions:[{rect:[800,700,80,80],padding:8}],...extra});}
function materialFixture(){
  const source=makeCanvas(),underpaint=makeCanvas(),weight=makeCanvas(),ownership=makeCanvas();
  const context=source.getContext('2d'),data=context.createImageData(1122,1402),hidden=context.createImageData(1122,1402),w=context.createImageData(1122,1402),h=context.createImageData(1122,1402);
  for(let y=0;y<1402;y++)for(let x=0;x<1122;x++){
    const k=(y*1122+x)*4;data.data.set([180,145,120,255],k);
    const owned=x>=450&&x<540&&y>=300&&y<430;
    const distance=Math.hypot(Math.max(450-x,0,x-539),Math.max(300-y,0,y-429));
    let amount=owned||distance<=3?1:distance>=12?0:1-((distance-3)/9)**2*(3-2*(distance-3)/9);amount=Math.round(amount*255);
    if(!amount)continue;
    hidden.data.set([205,172,149,255],k);w.data.set([255,255,255,amount],k);
    data.data.set(owned?[40,55,80,255]:[120,100,88,255],k);
    if(owned)h.data.set([255,255,255,255],k);
    // Exercise both extreme channel denominators and ordinary skin shades.
    if(!owned&&y%23===0){hidden.data.set([0,255,180,255],k);data.data.set([255,0,67,255],k);}
  }
  context.putImageData(data,0,0);underpaint.getContext('2d').putImageData(hidden,0,0);weight.getContext('2d').putImageData(w,0,0);ownership.getContext('2d').putImageData(h,0,0);
  return {source,material:{underpaint,weight,ownership,signature:'synthetic-material-v1'}};
}
function materialComposite(renderer,source,binding,material,signature){
  const weighted=makeCanvas(),wg=weighted.getContext('2d');wg.drawImage(material.underpaint,0,0);wg.globalCompositeOperation='destination-in';wg.drawImage(material.weight,0,0);
  const result=makeCanvas(),g=result.getContext('2d');g.drawImage(source,0,0);g.drawImage(weighted,0,0);
  // Small but nonzero: enter the real shader, without relying on identity bypass.
  const foreground=renderer.render(source,binding,{x:1e-6,y:0},{signature,material});if(!foreground)throw new Error('材质网格未绘制。');
  const foregroundPixels=pixels(foreground);g.drawImage(foreground,0,0);const actual=pixels(result),expected=pixels(source);let maxError=0,mismatchedPixels=0;
  for(let k=0;k<actual.length;k+=4){let mismatch=false;for(let c=0;c<4;c++){const e=Math.abs(actual[k+c]-expected[k+c]);maxError=Math.max(maxError,e);mismatch||=e>2;}if(mismatch)mismatchedPixels++;}
  return {realShaderPath:foreground!==source,maxError,mismatchedPixels,foregroundPixels,canvas:result};
}
const eventOnce=(target,name,timeout=5000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{target.removeEventListener(name,done);reject(new Error(`${name} 超时`));},timeout);const done=()=>{clearTimeout(timer);resolve();};target.addEventListener(name,done,{once:true});});

/** Hook for the registered-layer diagnostic after assets are built. Does not
 * approve them: reports source bounds, identity, actual moved output and a
 * stable screenshot canvas for the caller's face/occlusion pixel checks. */
export function probeRegisteredHairMesh({source,binding,renderer,controls={x:1,y:.18},signature='registered-probe'}){
  const input=pixels(source),[x,y,w,h]=binding.bounds;let outsideBoundsPixels=0,sourcePixels=0;
  for(let py=0;py<1402;py++)for(let px=0;px<1122;px++)if(input[(py*1122+px)*4+3]){sourcePixels++;if(px<x||py<y||px+1>x+w||py+1>y+h)outsideBoundsPixels++;}
  const rest=renderer.render(source,binding,{x:0,y:0},{signature}),frame=deformHairMesh(binding,controls),result=renderer.render(source,binding,controls,{signature});
  if(!result)throw new Error('前发网格图形上下文尚未恢复。');const snapshot=makeCanvas();snapshot.getContext('2d').drawImage(result,0,0);
  return {poseId:binding.poseId,runtimeValidated:binding.runtimeValidated,sourcePixels,outsideBoundsPixels,exactIdentityPath:rest===source,moved:frame.moved,maxDisplacementPx:frame.maxDisplacementPx,minimumAreaRatio:frame.minimumAreaRatio,canvas:snapshot,pixels:pixels(snapshot)};
}

let lastReport;
export async function runSyntheticHairMeshDiagnostics(){
  const report={schemaVersion:1,kind:'short-hair-mesh-browser-validation',version:'0.20.0',startedAt:new Date().toISOString(),status:'running',checks:[],limitations:['Synthetic texture checks do not validate hair segmentation or hidden paintings.','No webcam, microphone, or OBS session.']};
  const check=(name,passed,detail={})=>report.checks.push({name,passed,...detail});let renderer;
  try{
    renderer=new ShortHairMeshRenderer();const source=syntheticSource(),original=pixels(source),binding=syntheticBinding(),controls={x:1,y:0};
    check('zero-returns-exact-source',renderer.render(source,binding,{x:0,y:0})===source);
    check('original-returns-exact-source',renderer.render(source,binding,controls,{original:true})===source);
    check('candidate-does-not-move',renderer.render(source,syntheticBinding({runtimeValidated:false,revealMarginPx:0}),controls)===source);
    const moved=renderer.render(source,binding,controls,{signature:'synthetic'});if(!moved)throw new Error('网格未绘制。');const data=pixels(moved);
    check('source-top-stays-top',equal(at(data,280+6,300),at(original,280,300),1),{actual:at(data,286,300)});
    check('source-bottom-stays-bottom',equal(at(data,280+6,1070),at(original,280,1070),1),{actual:at(data,286,1070)});
    check('integer-move-vacates-old-edge',at(data,261,300)[3]===0&&at(data,267,300)[3]===255);
    check('root-pixels-stay-fixed',equal(at(data,280,60),at(original,280,60),1));
    let guardMismatch=0;for(let y=702;y<778;y++)for(let x=802;x<878;x++)if(!equal(at(data,x,y),at(original,x,y),1))guardMismatch++;
    check('protected-region-remains-fixed',guardMismatch===0,{mismatchedPixels:guardMismatch});
    let seamHoles=0;for(let y=835;y<885;y+=3)for(let x=180;x<730;x+=3)if(at(data,x,y)[3]!==255)seamHoles++;
    check('shared-triangle-edges-have-no-holes',seamHoles===0,{holes:seamHoles});
    check('semi-transparent-interior-preserved',equal(at(data,466,620),at(original,460,620),1),{source:at(original,460,620),actual:at(data,466,620)});
    const fraction=pixels(renderer.render(source,binding,{x:.55,y:0},{signature:'synthetic'})),edge=at(fraction,443,620),inside=at(original,450,620);
    check('fractional-edge-preserves-premultiplied-color',edge[3]>0&&edge[3]<inside[3]&&equal(edge.slice(0,3),inside.slice(0,3),3),{source:inside,edge});
    const negative=pixels(renderer.render(source,binding,{x:-1,y:0},{signature:'synthetic'}));check('negative-control-moves-opposite',equal(at(negative,274,300),at(original,280,300),1)&&at(negative,299,300)[3]===0);
    const proof=probeRegisteredHairMesh({source,binding,renderer,controls,signature:'synthetic'});
    check('synthetic-source-support-inside-binding',proof.outsideBoundsPixels===0,{sourcePixels:proof.sourcePixels});
    check('bounded-positive-jacobian',proof.maxDisplacementPx<=6&&proof.minimumAreaRatio>=.5-1e-7,{maximumDisplacementPx:proof.maxDisplacementPx,minimumAreaRatio:proof.minimumAreaRatio});
    const fixture=materialFixture(),matFirst=materialComposite(renderer,fixture.source,binding,fixture.material,'material-D-a');
    check('material-epsilon-reconstructs-current-rgba',matFirst.realShaderPath&&matFirst.maxError<=2,{maximumChannelError:matFirst.maxError,pixelsOverTolerance:matFirst.mismatchedPixels});
    fixture.source.getContext('2d').fillStyle='#e52b65';fixture.source.getContext('2d').fillRect(541,330,7,60);
    const matChanged=materialComposite(renderer,fixture.source,binding,fixture.material,'material-D-b');
    check('material-current-expression-replaces-cached-neutral',matChanged.realShaderPath&&matChanged.maxError<=2,{maximumChannelError:matChanged.maxError,pixelsOverTolerance:matChanged.mismatchedPixels});
    const changedSource=pixels(fixture.source);
    check('material-ownership-uses-D-and-outside-is-transparent',equal(at(matChanged.foregroundPixels,480,350),at(changedSource,480,350),1)&&at(matChanged.foregroundPixels,100,100)[3]===0);
    const materialBefore=await digest(matChanged.foregroundPixels);
    const before=await digest(proof.pixels),ext=renderer.gl.getExtension('WEBGL_lose_context');if(!ext)throw new Error('浏览器未提供真实图形丢失/恢复测试扩展。');
    let pending=eventOnce(renderer.canvas,'webglcontextlost');ext.loseContext();await pending;
    check('real-gpu-loss-does-not-claim-a-frame',renderer.render(source,binding,controls,{signature:'synthetic'})===null&&renderer.lost);
    // Browsers may reject restoreContext until loss-event dispatch has fully returned.
    await new Promise(resolve=>setTimeout(resolve,100));pending=eventOnce(renderer.canvas,'webglcontextrestored');ext.restoreContext();await pending;
    const restored=renderer.render(source,binding,controls,{signature:'synthetic'});if(!restored)throw new Error('图形恢复后仍未生成网格画面。');
    const after=await digest(pixels(restored));const materialAfter=await digest(materialComposite(renderer,fixture.source,binding,fixture.material,'material-D-b').foregroundPixels);check('real-gpu-restoration-is-pixel-identical',before===after&&materialBefore===materialAfter,{before,after,materialBefore,materialAfter});
    const preview=renderer.render(source,binding,controls,{signature:'synthetic'});document.querySelector('#preview')?.getContext('2d').drawImage(preview,0,0);
  }catch(error){check('completed-without-runtime-error',false,{error:error.message});}
  finally{renderer?.dispose();}
  const passed=report.checks.filter(c=>c.passed).length;report.summary={checks:report.checks.length,passed,failed:report.checks.length-passed};report.status=report.summary.failed?'failed':'passed';report.finishedAt=new Date().toISOString();return report;
}
const run=document.body?.dataset.meshDiagnostic==='synthetic'?document.querySelector('#run'):null;
if(run)run.addEventListener('click',async()=>{run.disabled=true;document.querySelector('#status').textContent='正在运行真实 WebGL 网格像素检查…';document.querySelector('#report').textContent=JSON.stringify({status:'running'});
  lastReport=await runSyntheticHairMeshDiagnostics();document.querySelector('#report').textContent=JSON.stringify(lastReport,null,2);document.querySelector('#status').textContent=`${lastReport.status==='passed'?'通过':'未通过'}：${lastReport.summary.passed}/${lastReport.summary.checks}`;document.querySelector('#download').disabled=false;run.disabled=false;});
if(run)document.querySelector('#download')?.addEventListener('click',()=>{if(!lastReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(lastReport,null,2)+'\n'],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='v0.20-mesh-browser-validation.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
