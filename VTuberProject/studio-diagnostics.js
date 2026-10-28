import {loadShortHairStudioAssets, renderShortHairStudio} from './short-hair-studio-renderer.js';
import {loadExpressionAssets, drawExpression} from './expression-renderer.js';
import {selectExpression, selectGaze} from './expression-model.js';
import {loadSideExpressionAssets, drawSideExpression} from './side-expression-renderer.js';
import {selectSideBrowExpression} from './side-brow-model.js';
import {selectSideGaze} from './side-gaze.js';
import {addInspectionDownload} from './diagnostic-sheet-export.js';

const summary = document.querySelector('#summary'), output = document.querySelector('#result'), host = document.querySelector('#comparisons');
const families = [
  {id:'front', load:() => loadExpressionAssets({variant:'candidate'})},
  {id:'side', load:() => loadSideExpressionAssets('brows')},
  {id:'pitch', load:() => loadSideExpressionAssets('pitchBrows')},
  {id:'complete', load:() => loadSideExpressionAssets('completePitch')},
];
const directionChannels = (x,y) => ({
  eyeLookOutLeft:Math.max(0,x), eyeLookInLeft:Math.max(0,-x),
  eyeLookInRight:Math.max(0,x), eyeLookOutRight:Math.max(0,-x),
  eyeLookUpLeft:Math.max(0,-y), eyeLookUpRight:Math.max(0,-y),
  eyeLookDownLeft:Math.max(0,y), eyeLookDownRight:Math.max(0,y),
});
const scenarios = [
  ['neutral', {}],
  ['quarter-eyes', {eyeBlinkLeft:.2, eyeBlinkRight:.2}],
  ['half-eyes', {eyeBlinkLeft:.5, eyeBlinkRight:.5}],
  ['three-quarter-eyes', {eyeBlinkLeft:.8, eyeBlinkRight:.8}],
  ['closed-eyes', {eyeBlinkLeft:1, eyeBlinkRight:1}],
  ['wink-left', {eyeBlinkLeft:1}], ['wink-right', {eyeBlinkRight:1}],
  ['parted-mouth', {jawOpen:.2}], ['small-mouth', {jawOpen:.4}],
  ['medium-mouth', {jawOpen:.65}], ['wide-mouth', {jawOpen:1}],
  ['pucker', {mouthPucker:1}], ['press', {mouthPressLeft:1, mouthPressRight:1}],
  ['shift-left', {mouthLeft:1}], ['shift-right', {mouthRight:1}],
  ['close-priority', {jawOpen:1, mouthClose:1, mouthPucker:1}],
  ['inner-brows', {browInnerUp:1}], ['outer-left-brow', {browOuterUpLeft:1}],
  ['outer-right-brow', {browOuterUpRight:1}], ['down-left-brow', {browDownLeft:1}],
  ['down-right-brow', {browDownRight:1}],
  ['mixed-brows', {browOuterUpLeft:1, browDownRight:1}],
  ...[-1,0,1].flatMap(y => [-1,0,1].filter(x => x || y).map(x => [`gaze-${x}-${y}`, directionChannels(x,y)])),
  ['independent-gaze', {eyeLookOutLeft:1, eyeLookUpLeft:.7, eyeLookOutRight:.6, eyeLookDownRight:1}],
  ['combined-a', {eyeBlinkLeft:.5, eyeBlinkRight:1, jawOpen:.65, browInnerUp:.8, ...directionChannels(-.8,-.7)}],
  ['combined-b', {eyeBlinkLeft:1, eyeBlinkRight:.5, mouthRight:1, browOuterUpLeft:1, browDownRight:1, ...directionChannels(.8,.6)}],
].map(([id,channels]) => ({id,channels}));
const modes = [{id:'face',faceOnly:true}, {id:'full',faceOnly:false}];
const originals = scenarios.filter(({id}) => ['neutral','independent-gaze','combined-b'].includes(id));

// Both measuring surfaces are explicitly native readback canvases from their
// first context request. The reference does not call the studio adapter.
function surface() {
  const canvas = document.createElement('canvas');
  return {canvas, context:canvas.getContext('2d',{willReadFrequently:true})};
}
const actual = surface(), expected = surface();
function referenceDraw(canvas, assets, poseId, channels, options) {
  const front = poseId === 'front';
  const available = front ? assets.available : {
    mouthArt:assets.manifest.mouthArt !== undefined,
    browArt:assets.manifest.browArt !== undefined, gaze:Boolean(assets.gazeLayers),
  };
  const select = front ? selectExpression : selectSideBrowExpression;
  const look = front ? selectGaze : selectSideGaze;
  const targetState = select(channels, {}, available), targetGaze = look(channels, available);
  const state = options.original ? select({}, {}, available) : targetState;
  const gaze = options.original ? look({}, available) : targetGaze;
  if (front) drawExpression(canvas,assets,state,{...options,gaze});
  else drawSideExpression(canvas,assets,poseId,state,{...options,gaze});
  return {state,gaze,targetState,targetGaze};
}
function comparePixels() {
  const dimensionsMatch = actual.canvas.width === expected.canvas.width && actual.canvas.height === expected.canvas.height;
  const result = {dimensionsMatch, dimensions:[actual.canvas.width,actual.canvas.height], changed:0, maxDelta:0, firstDifference:null};
  if (!dimensionsMatch) return result;
  const a = actual.context.getImageData(0,0,actual.canvas.width,actual.canvas.height).data;
  const b = expected.context.getImageData(0,0,expected.canvas.width,expected.canvas.height).data;
  for (let index=0; index<a.length; index+=4) {
    const delta = Math.max(Math.abs(a[index]-b[index]), Math.abs(a[index+1]-b[index+1]), Math.abs(a[index+2]-b[index+2]), Math.abs(a[index+3]-b[index+3]));
    if (!delta) continue;
    result.changed++; result.maxDelta = Math.max(result.maxDelta,delta);
    if (!result.firstDifference) result.firstDifference = {
      x:(index/4)%actual.canvas.width, y:Math.floor(index/4/actual.canvas.width),
      studio:Array.from(a.slice(index,index+4)), reference:Array.from(b.slice(index,index+4)),
    };
  }
  return result;
}
function copyCard(canvas, label, row) {
  const figure = document.createElement('figure'), caption = document.createElement('figcaption'), copy = document.createElement('canvas');
  copy.width=canvas.width; copy.height=canvas.height; copy.getContext('2d').drawImage(canvas,0,0);
  copy.setAttribute('aria-label',label); caption.textContent=label; figure.append(copy,caption); row.append(figure);
}

try {
  const studio = await loadShortHairStudioAssets();
  const exportGroups=[{label:'九向工作台 / Studio combined expression',items:[]},
    {label:'独立参考渲染器 / Independent reference',items:[]},{label:'九向中性原画 / Owned neutral sources',items:[]}];
  const download=addInspectionDownload(host,{id:'download-studio-contact-sheet',label:'下载九向原生对照图',
    title:'九向工作台 / Native studio equivalence',filename:'studio-nine-poses-native-inspection.png',groups:()=>exportGroups.map(group=>({
      ...group,items:[...group.items].sort((a,b)=>studio.poses.findIndex(pose=>pose.id===a.pose)-studio.poses.findIndex(pose=>pose.id===b.pose)),
    }))});
  download.disabled=true;
  const report = {
    schemaVersion:1, status:'running', generatedAt:new Date().toISOString(),
    criteria:{
      reference:'Original family loaders, selectors, and renderers; full source image dictionaries remain available to the independent reference.',
      actual:'Production loadShortHairStudioAssets and renderShortHairStudio, with only nine full neutral source images retained after compilation.',
      comparison:'Exact RGBA equality at native face and full image sizes. No tolerance, transforms, camera access, or runtime monkey-patching.',
      coverage:'33 coefficient scenarios in face/full mode; original mode repeats neutral, independent gaze, and combined expressions in both framings.',
      limit:'Equivalence verifies adapter dispatch and retained layers. It does not establish artistic quality or validate live camera hardware.',
    },
    retainedSources:{}, poses:{},
    summary:{passed:null,poses:0,scenarios:scenarios.length,comparisons:0,assertions:0,failedAssertions:0,failures:[]},
  };
  const check = (pass,name,data={}) => {
    report.summary.assertions++;
    if (!pass) {report.summary.failedAssertions++; report.summary.failures.push({check:name,...data});}
  };
  let retainedTotal = 0;
  for (const family of families) {
    const assets=studio[family.id], ids=Object.keys(assets.images);
    const references=family.id==='front'?[assets.manifest.reference]:Object.values(assets.manifest.poses).map(pose=>pose.reference);
    report.retainedSources[family.id]={retained:ids,manifestSourceCount:Object.keys(assets.manifest.sources).length};
    retainedTotal+=ids.length;
    check(ids.length===references.length && references.every(id=>Object.hasOwn(assets.images,id)),'neutral-source-pruning',{family:family.id});
  }
  check(retainedTotal===9,'nine-retained-portraits',{retainedTotal});
  for (const family of families) {
    summary.textContent=`正在独立载入 ${family.id} 参考画稿…`;
    // Keep only one unpruned reference family live at a time; studio sources
    // are already compiled and retain just their own neutral portraits.
    const reference = await family.load();
    report.retainedSources[family.id].referenceSourceCount=Object.keys(reference.images).length;
    check(Object.keys(reference.images).length===Object.keys(reference.manifest.sources).length,'complete-reference-sources',{family:family.id});
    check(reference.manifest.id===studio[family.id].manifest.id,'same-source-manifest',{family:family.id});
    for (const pose of studio.poses.filter(pose=>pose.sourceFamily===family.id)) {
      const result={family:family.id, label:pose.label, cases:[]}; report.poses[pose.id]=result;
      const heading=document.createElement('h2'); heading.textContent=pose.label; host.append(heading);
      const row=document.createElement('div'); row.className='row'; row.id=`pose-${pose.id}`; host.append(row);
      const cases=[...scenarios.flatMap(scenario=>modes.map(framing=>({scenario,framing,original:false}))),
        ...originals.flatMap(scenario=>modes.map(framing=>({scenario,framing,original:true})))];
      for (const [index,{scenario,framing,original}] of cases.entries()) {
        const options={faceOnly:framing.faceOnly,original};
        summary.textContent=`正在检查 ${pose.label}：${index+1}/${cases.length}…`;
        const actualState=renderShortHairStudio(actual.canvas,studio,pose.id,scenario.channels,{},options);
        const expectedState=referenceDraw(expected.canvas,reference,pose.id,scenario.channels,options);
        const pixels=comparePixels(), metadataMatch=JSON.stringify(actualState)===JSON.stringify(expectedState);
        const item={scenario:scenario.id,framing:framing.id,original,...pixels,metadataMatch};
        result.cases.push(item); report.summary.comparisons++;
        const key={pose:pose.id,scenario:scenario.id,framing:framing.id,original};
        check(pixels.dimensionsMatch,'native-dimensions',key);
        check(pixels.dimensionsMatch && pixels.changed===0,'exact-pixels',{...key,changed:pixels.changed,maxDelta:pixels.maxDelta,firstDifference:pixels.firstDifference});
        check(metadataMatch,'rendered-and-target-metadata',key);
        if (!original && framing.faceOnly && scenario.id==='combined-b') {
          copyCard(actual.canvas,'实际工作台 · 合成表情',row);
          copyCard(expected.canvas,'独立参考渲染器 · 相同输入',row);
          const neutralCanvas=document.createElement('canvas');
          renderShortHairStudio(neutralCanvas,studio,pose.id,{}, {},{faceOnly:true,original:true});
          copyCard(neutralCanvas,'此角度中性原画',row);
          for(const [index,sourceCanvas] of [actual.canvas,expected.canvas,neutralCanvas].entries()){
            const copy=document.createElement('canvas');copy.width=sourceCanvas.width;copy.height=sourceCanvas.height;
            copy.getContext('2d').drawImage(sourceCanvas,0,0);exportGroups[index].items.push({canvas:copy,label:`${pose.label} / ${pose.id}`,pose:pose.id});
          }
        }
        if (index%8===7) await new Promise(resolve=>setTimeout(resolve,0));
      }
      report.summary.poses++; output.textContent=JSON.stringify(report,null,2);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  report.status='complete'; report.summary.passed=report.summary.failedAssertions===0;
  download.disabled=false;
  output.textContent=JSON.stringify(report,null,2); summary.dataset.state=report.summary.passed?'passed':'failed';
  summary.textContent=`${report.summary.poses} 个方向，${report.summary.comparisons} 次原生逐像素对照，${report.summary.assertions} 项断言，${report.summary.failedAssertions} 项未通过。工作台保留 ${retainedTotal} 张完整中性原画。`;
} catch(error) {
  output.textContent=JSON.stringify({schemaVersion:1,status:'error',error:error.message,stack:error.stack},null,2);
  summary.dataset.state='failed'; summary.textContent=`检查未完成：${error.message}`;
}
