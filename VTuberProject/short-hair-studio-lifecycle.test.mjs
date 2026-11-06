import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as model from './short-hair-studio-model.js';
import {sanitizeChannels,selectGaze,selectExpression} from './expression-model.js';
import {FaceSession} from './face-session.js';
import * as timing from './short-hair-studio-timing.js';
import * as tracking from './short-hair-studio-tracking.js';
import * as poseMotion from './short-hair-pose-motion.js';
import * as trackingQuality from './short-hair-tracking-quality.js';
import * as secondaryMotion from './short-hair-secondary-motion.js';
import * as composition from './short-hair-composition.js';
import {mapBlendshapeValue} from './arkit-blendshapes.js';

const source = readFileSync(new URL('./short-hair-studio.js', import.meta.url),'utf8').replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm,'');
function harness() {
  const elements = new Map(), documentEvents = {}, windowEvents = {}, frames = new Map(), intervals = new Map(), calls = {load:0,assetResolvers:[],saved:[],recordStop:0,downloads:[],filenames:[],streams:[],draws:[],compositions:[],now:0,attributeWrites:0,published:[],outputStops:0};
  let frameId=0;
  const element = key => {
    if (!elements.has(key)) elements.set(key,{value:'',checked:false,hidden:false,disabled:false,dataset:{},textContent:'',
      classList:{toggle(){},add(){},remove(){}},events:{},attributes:{},setAttribute(key,value){this.attributes[key]=value;calls.attributeWrites++;},getAttribute(key){return this.attributes[key];},addEventListener(type,callback){this.events[type]=callback;}});
    return elements.get(key);
  };
  class Camera {
    constructor(video,{onState}) {this.video=video;this.onState=onState;this.active=false;this.starting=false;this.starts=0;this.stops=0;this.disposals=0;}
    async start(){this.starts++;return false;}
    stop(){this.stops++;this.active=false;this.starting=false;this.onState({status:'stopped',message:'stopped'});}
    dispose(){this.disposals++;this.stop();}
    getMetrics(){return{inferenceFps:null,meanInferenceMs:null,signalStale:true};}
  }
  class Publisher {
    constructor({onState}){this.onState=onState;this.enabled=false;}
    start(){this.enabled=true;}
    publish(value){calls.published.push(value);}
    stop(){this.enabled=false;calls.outputStops++;return Promise.resolve();}
  }
  const document={hidden:false,querySelector:element,querySelectorAll:()=>[],body:{append(){}},
    createElement(tag){
      if(tag==='a')return{click(){calls.filenames.push(this.download);},remove(){}};
      if(tag==='canvas')return{width:0,height:0,getContext:()=>({fillRect(){},clearRect(){},drawImage(){}}),captureStream(fps){const stream={fps,stops:0,getTracks:()=>[{stop(){stream.stops++;}}]};calls.streams.push(stream);return stream;}};
      throw new Error(`Unexpected element ${tag}`);
    },addEventListener(type,callback){documentEvents[type]=callback;}};
  Object.assign(element('#studioCanvas'),{width:630,height:460,captureStream(){}});
  const capabilities={extendedEyes:true,extendedJaw:true,shiftLeft:true,shiftRight:true,gaze:true};
  const selector=(assets,poseId,channels,previous={})=>({targetState:selectExpression(channels,previous,capabilities),targetGaze:selectGaze(channels,capabilities),
    availableSequences:{eyeLeft:['open','quarter','half','threeQuarter','closed'],eyeRight:['open','quarter','half','threeQuarter','closed'],mouth:['neutral','parted','openSmall','openMedium','openWide']}});
  const context=vm.createContext({...model,...timing,...tracking,...poseMotion,...trackingQuality,...secondaryMotion,...composition,sanitizeChannels,selectGaze,FaceSession,ShortHairStudioCamera:Camera,StudioOutputPublisher:Publisher,document,
    window:{location:{origin:'http://127.0.0.1:4175'},addEventListener(type,callback){windowEvents[type]=callback;}},localStorage:{getItem:()=>null,setItem(key,value){calls.saved.push({key,value});}},
    performance:{now:()=>calls.now},requestAnimationFrame(callback){frames.set(++frameId,callback);return frameId;},cancelAnimationFrame(id){frames.delete(id);},
    loadContinuousShortHairAssets(){calls.load++;return new Promise(resolve=>calls.assetResolvers.push(resolve));},selectShortHairStudioState:selector,
    exportShortHairLayers(){return Promise.resolve([]);},
    createShortHairLayerInspection(){return{layers:{}};},
    drawOutputFrame(output,source,options){calls.compositions.push({transparent:options.transparent,composition:{...options.composition}});},
    loadShortHairCharacterPack(){return Promise.resolve({pack:{}});},summarizeShortHairCharacterPack(){return{poseCount:9,artworkFileCount:0,poses:[]};},
    renderContinuousShortHairStudio(canvas,assets,poseId,channels,previous,options){
      const target=selector(assets,poseId,channels,previous),neutral=selector(assets,poseId,{});
      const result={...target,state:options.original?neutral.targetState:options.stateOverride || target.targetState,gaze:options.original?neutral.targetGaze:target.targetGaze,didDraw:true,
        headPose:options.original?poseMotion.poseHeadCoordinates(poseMotion.nearestStudioPoseId(options.headPose)):{...options.headPose},transparent:options.transparent,
        secondary:options.original?{breath:0,sway:0,hair:0}:{...options.secondary}};
      calls.draws.push({at:calls.now,poseId,...result});return result;
    },extractFaceMotion:result=>result?.faceMotion || null,
    calls,console,Blob,URL:{createObjectURL(blob){calls.downloads.push(blob);return 'blob:test';},revokeObjectURL(){}},setTimeout(callback){callback();return 0;},
    setInterval(callback){const id=intervals.size+1;intervals.set(id,callback);return id;},clearInterval(id){intervals.delete(id);}});
  vm.runInContext(source,context);
  return{context,calls,elements,frames,intervals,document,documentEvents,windowEvents,run:code=>vm.runInContext(code,context),
    step(now){const next=frames.entries().next().value;if(!next)return false;const[id,callback]=next;frames.delete(id);calls.now=now;callback(now);return true;},
    prepare(){vm.runInContext('assets={poses:STUDIO_POSES.map(pose=>({...pose,label:pose.id}))};ready=true;paint({snap:true});',context);}};
}

test('loading the studio prepares only local art and remains still with no camera start',()=>{
  const h=harness();assert.equal(h.calls.load,1);assert.equal(h.run('camera.starts'),0);assert.equal(h.run('source'),'manual');assert.equal(h.frames.size,0);
  assert.equal(h.elements.get('#studioControls').disabled,true);
});
test('hiding an active camera recording closes the camera and recorder without scheduling a hidden frame',()=>{
  const h=harness();h.run("ready=true;source='camera';camera.active=true;recorder={state:'recording',stop(){this.state='inactive';calls.recordStop++;}};ensureAnimation();");
  assert.equal(h.frames.size,1);h.document.hidden=true;h.documentEvents.visibilitychange();
  assert.equal(h.run('source'),'manual');assert.equal(h.run('camera.active'),false);assert.equal(h.calls.recordStop,1);assert.equal(h.frames.size,0);
});
test('hiding a demo pauses it, while returning visible never restarts animation or camera',()=>{
  const h=harness();h.run("ready=true;source='demo';ensureAnimation();");h.document.hidden=true;h.documentEvents.visibilitychange();
  assert.equal(h.run('source'),'manual');assert.equal(h.frames.size,0);h.document.hidden=false;h.documentEvents.visibilitychange();
  assert.equal(h.frames.size,0);assert.equal(h.run('camera.starts'),0);
});
test('leaving the page cancels camera startup and disposes its resource owner',()=>{
  const h=harness();h.run("source='camera-pending';camera.starting=true;");h.windowEvents.pagehide();
  assert.equal(h.run('camera.starting'),false);assert.equal(h.run('camera.disposals'),1);assert.equal(h.run('source'),'manual');
});
test('invalid imported frames leave active input and coefficients unchanged',()=>{
  const h=harness();h.run("source='demo';coefficients=sanitizeChannels({jawOpen:.7});applyFrame('{\"jawOpen\":null}');");
  assert.equal(h.run('source'),'demo');assert.equal(h.run('coefficients.jawOpen'),.7);assert.match(h.elements.get('#importStatus').textContent,/未应用/);
});
test('the first calibrated frame uses the new head baseline without a one-frame pose jump',()=>{
  const h=harness();h.run(`source='camera';camera.active=true;poseId='front';beginCalibration();
    camera.poll=()=>({faceMotion:{pose:{x:.7,y:.6}},faceBlendshapes:[{categories:[]}]});`);
  h.elements.get('#followHead').checked=true;
  for(let now=0;now<=3000;now+=100){h.calls.now=now;h.run(`cameraFrame(${now},.1)`);}
  assert.equal(h.run('calibrationUntil'),0);assert.match(h.elements.get('#motionStatus').textContent,/校准完成/);
  assert.equal(h.run('poseId'),'front');assert.equal(h.run('trackedPose.yaw'),0);assert.equal(Math.abs(h.run('trackedPose.pitch')),0);
});
test('tracking runtime errors close the camera and leave a retryable manual state',()=>{
  const h=harness();h.run("source='camera';camera.active=true;camera.poll=()=>{throw new Error('GPU context lost');};cameraFrame(1000,1/60);");
  assert.equal(h.run('source'),'manual');assert.equal(h.run('camera.active'),false);assert.match(h.elements.get('#motionStatus').textContent,/识别已中断/);
});
test('an invalid project import does not stop the active source or partially overwrite current settings',async()=>{
  const h=harness();h.context.input={files:[{size:20,text:async()=>'{"kind":"unknown"}'}],value:'file'};
  h.run("source='demo';coefficients=sanitizeChannels({jawOpen:.7});poseId='view-right';");
  await h.run('readInputFile(input,"project")');
  assert.equal(h.run('source'),'demo');assert.equal(h.run('poseId'),'view-right');assert.equal(h.run('coefficients.jawOpen'),.7);
  assert.match(h.elements.get('#motionStatus').textContent,/未打开项目/);
});
test('a project file finishing after a newer manual action cannot overwrite that action',async()=>{
  let finish;const text=new Promise(resolve=>{finish=resolve;}),h=harness();
  h.context.input={files:[{size:100,text:()=>text}],value:'file'};
  h.run('assets={poses:[{id:"front",label:"正面"}]};ready=true;');
  const reading=h.run('readInputFile(input,"project")');h.run('setManual({mouthPucker:1});');
  finish(JSON.stringify(model.createStudioProject({poseId:'view-down',coefficients:{jawOpen:.8}})));await reading;
  assert.equal(h.run('poseId'),'front');assert.equal(h.run('coefficients.mouthPucker'),1);assert.equal(h.run('coefficients.jawOpen'),0);
});
function recorderHarness({failFirstStart=false}={}){
  const h=harness(),instances=[];
  h.context.MediaRecorder=class {
    static isTypeSupported(type){return type==='video/mp4';}
    constructor(stream,options){this.stream=stream;this.mimeType=options?.mimeType || 'video/webm';this.state='inactive';instances.push(this);}
    start(){if(failFirstStart&&instances.length===1)throw new Error('encoder unavailable');this.state='recording';}
    stop(){this.state='inactive';}
  };
  h.run('ready=true;');return{...h,instances};
}
test('recording finalization uses the actual MIME extension and stops its stream after deferred onstop',()=>{
  const h=recorderHarness();h.run('startRecording();');const recorder=h.instances[0];
  recorder.ondataavailable({data:new Blob(['video'],{type:'video/mp4'})});h.run('stopRecording();');
  assert.equal(h.frames.size,0);recorder.onstop();assert.equal(h.calls.downloads.length,1);assert.equal(h.calls.downloads[0].type,'video/mp4');
  assert.match(h.calls.filenames[0],/\.mp4$/);assert.equal(h.calls.streams[0].stops,1);assert.equal(h.run('recorder'),null);
});
test('a recorder error never labels possibly damaged chunks as a successful download',()=>{
  const h=recorderHarness();h.run('startRecording();');const recorder=h.instances[0];
  recorder.ondataavailable({data:new Blob(['partial'],{type:'video/mp4'})});recorder.onerror();recorder.onstop();
  assert.equal(h.calls.downloads.length,0);assert.match(h.elements.get('#recordStatus').textContent,/未保存可能损坏/);assert.equal(h.calls.streams[0].stops,1);
});
test('a late callback from a failed encoder cannot clear or stop a newer recording',()=>{
  const h=recorderHarness({failFirstStart:true});h.run('startRecording();startRecording();');
  assert.equal(h.instances.length,2);h.instances[0].onstop();
  assert.equal(h.run('recorder.state'),'recording');assert.equal(h.calls.streams[1].stops,0);assert.equal(h.run('recordingStream'),h.calls.streams[1]);
  h.run('stopRecording();');h.instances[1].onstop();
});
test('camera ARKit gaze remains unit coefficients and normalized head pitch is converted to up-positive studio coordinates',()=>{
  const h=harness();h.run(`source='camera';camera.active=true;camera.poll=()=>({faceMotion:{pose:{x:.7,y:-.6}},faceBlendshapes:[{categories:[
    {categoryName:'eyeLookOutLeft',score:.8},{categoryName:'eyeLookInRight',score:.8},
    {categoryName:'eyeLookUpLeft',score:.6},{categoryName:'eyeLookUpRight',score:.6}]}]});`);
  h.elements.get('#followHead').checked=true;h.run('cameraFrame(1000,1/60)');
  assert.equal(h.run('poseMotion.current.yaw'),0);assert.equal(h.run('poseMotion.target.yaw'),0);h.run('cameraFrame(1080,1/60)');
  assert.equal(h.run('poseMotion.target.yaw'),1);
  assert.equal(h.run('poseId'),'view-right-up');assert.equal(h.run('trackedPose.pitch'),.6);
  const configs=tracking.createFaceSessionSettings().channels;
  assert.equal(h.run('selectGaze(coefficients,{gaze:true}).eyeLeft.x'),mapBlendshapeValue(.8,configs.eyeLookOutLeft));
  assert.equal(h.run('selectGaze(coefficients,{gaze:true}).eyeLeft.y'),-mapBlendshapeValue(.6,configs.eyeLookUpLeft));
});
test('a delayed PNG callback retains the captured pose name rather than a later selection',()=>{
  const h=harness();let complete;h.elements.get('#studioCanvas').toBlob=callback=>{complete=callback;};
  h.run('assets={poses:[{id:"front",label:"正面"}]};ready=true;savePng();poseId="view-right";');
  complete(new Blob(['png'],{type:'image/png'}));assert.match(h.calls.filenames[0],/^short-hair-front-/);
});
test('camera calibration handles every studio channel and new frames replace stale gaze and expression coefficients',()=>{
  const h=harness(), keys=model.STUDIO_CHANNELS.map(channel=>channel.key);
  const baseline=Object.fromEntries(keys.map((key,index)=>[key,.04+index*.01]));
  h.context.frameInput={faceMotion:{pose:{x:.12,y:.18}},faceBlendshapes:[{categories:keys.map(key=>({categoryName:key,score:baseline[key]}))}]};
  h.run("source='camera';camera.active=true;camera.poll=()=>frameInput;beginCalibration();");
  for(let time=0;time<=3000;time+=100) h.run(`cameraFrame(${time},1/60)`);
  assert.equal(h.run('calibrationUntil'),0);
  for(const key of keys){
    assert.ok(Math.abs(h.run(`session.neutral[${JSON.stringify(key)}]`)-baseline[key])<1e-12,key);
    assert.ok(h.run(`coefficients[${JSON.stringify(key)}]`)<1e-12,`${key}: neutral after calibration`);
  }
  for(const [index,active] of keys.entries()){
    h.context.frameInput.faceBlendshapes[0].categories=keys.map(key=>({categoryName:key,score:baseline[key]+(key===active ? (1-baseline[key])*.8 : 0)}));
    h.run(`cameraFrame(${3100+index*100},1)`);
    const config=tracking.createFaceSessionSettings().channels;
    for(const key of keys)assert.ok(Math.abs(h.run(`coefficients[${JSON.stringify(key)}]`)-(key===active?mapBlendshapeValue(.8,config[key]):0))<1e-6,`${active} active; ${key} output`);
  }
  h.context.frameInput=null;h.run('cameraFrame(6000,1)');
  for(const key of keys)assert.ok(h.run(`coefficients[${JSON.stringify(key)}]`)<1e-6,`${key}: stale face clears`);
  const gaze=h.run('selectGaze(coefficients,{gaze:true})');
  for(const eye of [gaze.eyeLeft,gaze.eyeRight])assert.ok(Math.abs(eye.x)<1e-6&&Math.abs(eye.y)<1e-6);
});

const distinct=values=>values.filter((value,index)=>index===0||value!==values[index-1]);
test('manual eye and jaw actions visit every real intermediate painting, then stop at the exact endpoints',()=>{
  const h=harness();h.prepare();h.run('setManual({eyeBlinkLeft:1,eyeBlinkRight:1,jawOpen:1});');
  for(let time=0;time<500&&h.frames.size;time+=1000/60)h.step(time);
  assert.deepEqual(distinct(h.calls.draws.map(draw=>draw.state.eyeLeft)),['open','quarter','half','threeQuarter','closed']);
  assert.deepEqual(distinct(h.calls.draws.map(draw=>draw.state.mouth)),['neutral','parted','openSmall','openMedium','openWide']);
  assert.equal(h.run('transitionPending'),false);assert.equal(h.frames.size,0);assert.equal(h.run('previousState.mouth'),'openWide');
  assert.match(h.elements.get('#frameStats').textContent,/静止/);
});
test('a reversed manual action replans from the displayed frame without completing an old target',()=>{
  const h=harness();h.prepare();h.run('setManual({eyeBlinkLeft:1});');h.step(0);h.step(17);h.step(34);
  const shown=h.run('rendered.state.eyeLeft'),start=h.calls.draws.length;
  h.run('setManual({});');for(let time=50;time<300&&h.frames.size;time+=17)h.step(time);
  const order=['open','quarter','half','threeQuarter','closed'],states=[shown,...h.calls.draws.slice(start).map(draw=>draw.state.eyeLeft)];
  for(let index=1;index<states.length;index++)assert.ok(order.indexOf(states[index])<=order.indexOf(states[index-1]));
  assert.equal(states.at(-1),'open');assert.equal(h.frames.size,0);
});
test('pausing or hiding a manual transition freezes its actual frame and never restarts from a stale RAF',()=>{
  for(const hidden of [false,true]){
    const h=harness();h.prepare();h.run('setManual({jawOpen:1});');h.step(0);const shown=h.run('rendered.state.mouth');
    const callback=[...h.frames.values()][0];
    if(hidden){h.document.hidden=true;h.documentEvents.visibilitychange();h.document.hidden=false;h.documentEvents.visibilitychange();}
    else h.elements.get('#manualButton').events.click();
    callback(500);assert.equal(h.run('rendered.state.mouth'),shown);assert.equal(h.frames.size,0);assert.equal(h.run('transitionPending'),false);
  }
});
test('pose selection moves continuously, original preview uses neutral art and exports freeze actual display states',async()=>{
  const h=harness();h.prepare();h.run('setManual({jawOpen:1});choosePose("view-right");');
  assert.notEqual(h.run('rendered.state.mouth'),'openWide');assert.equal(h.run('poseMotion.current.yaw'),0);assert.equal(h.frames.size,1);
  h.elements.get('#originalToggle').checked=true;h.elements.get('#originalToggle').events.change();
  assert.equal(h.run('rendered.state.mouth'),'neutral');assert.equal(h.run('rendered.targetState.mouth'),'openWide');
  h.run('exportFrame();');const original=JSON.parse(await h.calls.downloads[0].text());
  assert.equal(original.renderedState.mouth,'neutral');assert.equal(original.targetState.mouth,'openWide');
  h.elements.get('#originalToggle').checked=false;h.run('setManual({eyeBlinkLeft:1,jawOpen:1});exportFrame();');
  const exported=JSON.parse(await h.calls.downloads[1].text());
  assert.equal(exported.renderedState.eyeLeft,h.run('rendered.state.eyeLeft'));assert.equal(exported.renderedState.mouth,h.run('rendered.state.mouth'));
  assert.equal(exported.targetState.eyeLeft,'closed');assert.equal(exported.targetState.mouth,'openWide');
  assert.equal(h.frames.size,0);
});
test('render scheduling counts successful 30/60 fps draws rather than 120 Hz RAF callbacks',()=>{
  for(const fps of [30,60]){
    const h=harness();h.prepare();h.elements.get('#renderRate').value=String(fps);h.elements.get('#renderRate').events.change();
    h.run('toggleDemo();');const start=h.calls.draws.length;
    for(let frame=0;frame<=120;frame++)h.step(frame*1000/120);
    const draws=h.calls.draws.length-start;assert.ok(Math.abs(draws-(fps+1))<=1,`${fps}: ${draws}`);
    const stats=h.run('frameClock.snapshot(1000)');assert.ok(Math.abs(stats.measuredFps-fps)<.1);assert.equal(stats.sampleCount,draws);
    assert.match(h.elements.get('#frameStats').textContent,new RegExp(`实测 ${fps}\\.0 fps`));
  }
});
test('a skipped or failed render cannot commit unseen motion or contribute to measured drawing rate',()=>{
  const h=harness();h.prepare();h.run('setManual({jawOpen:1});choosePose("view-right");');
  const before=h.run('frameMotion'),beforePose=h.run('poseMotion'),draw=h.context.renderContinuousShortHairStudio;
  h.context.renderContinuousShortHairStudio=()=>({didDraw:false});h.step(0);
  assert.equal(h.run('frameMotion'),before);assert.equal(h.run('poseMotion'),beforePose);
  assert.equal(h.run('frameClock.snapshot(0).sampleCount'),0);assert.equal(h.frames.size,1);
  h.context.renderContinuousShortHairStudio=draw;h.step(17);assert.notEqual(h.run('frameMotion'),before);assert.ok(h.run('poseMotion.current.yaw')>0);
  h.context.renderContinuousShortHairStudio=()=>{throw new Error('context lost');};const shown=h.run('rendered.state');h.step(34);
  assert.equal(h.run('ready'),false);assert.equal(h.run('rendered.state'),shown);assert.equal(h.frames.size,0);assert.equal(h.run('frameClock.snapshot(34).sampleCount'),0);
});
test('recording requests the selected fps, locks it until finalization and preserves a paused visible frame',()=>{
  const h=recorderHarness();h.prepare();h.elements.get('#renderRate').value='30';h.elements.get('#renderRate').events.change();
  h.run('setManual({jawOpen:1});startRecording();');const instance=h.instances[0];
  assert.equal(h.calls.streams[0].fps,30);assert.equal(h.elements.get('#renderRate').disabled,true);
  h.elements.get('#renderRate').value='60';h.elements.get('#renderRate').events.change();assert.equal(h.run('frameClock.targetFps'),30);
  h.run('stopActive();');const shown=h.run('rendered.state.mouth');
  for(let frame=0;frame<60;frame++)h.step(frame*1000/60);
  assert.equal(h.run('rendered.state.mouth'),shown);assert.equal(h.run('transitionPending'),false);
  h.run('stopRecording();');assert.equal(h.elements.get('#renderRate').disabled,true);instance.onstop();
  assert.equal(h.elements.get('#renderRate').disabled,false);assert.equal(h.frames.size,0);
  h.run('frameClock.setTargetFps(60);startRecording();');assert.equal(h.calls.streams[1].fps,60);
});
test('camera disconnection freezes a pending motion and cancels the next scheduled frame',()=>{
  const h=harness();h.prepare();h.run('setManual({jawOpen:1});source="camera";camera.active=true;');
  const shown=h.run('rendered.state.mouth');h.run('camera.active=false;camera.onState({status:"error",message:"device disconnected"});');
  assert.equal(h.run('source'),'manual');assert.equal(h.run('transitionPending'),false);assert.equal(h.frames.size,0);assert.equal(h.run('rendered.state.mouth'),shown);
});
test('a camera polling failure during RAF cannot repaint or advance the last visible expression',()=>{
  const h=harness();h.prepare();h.run('setManual({jawOpen:1});source="camera";camera.active=true;camera.poll=()=>{throw new Error("lost");};');
  const count=h.calls.draws.length,shown=h.run('rendered.state.mouth');h.step(0);
  assert.equal(h.calls.draws.length,count);assert.equal(h.run('rendered.state.mouth'),shown);assert.equal(h.frames.size,0);
});

const trackingClip = (jawOpen=.8) => ({schemaVersion:1,kind:'moemotion-short-hair-tracking-clip',characterId:'short-hair-v1',durationMs:160,
  samples:[{t:0,poseId:'front',coefficients:sanitizeChannels({})},{t:80,poseId:'front',coefficients:sanitizeChannels({jawOpen})}]});

test('numeric clip recording retains manual changes, stops on pause and never starts a camera or download',()=>{
  const h=harness();h.prepare();h.run('toggleClipRecording();');
  assert.equal(h.run('clipRecorder.recording'),true);assert.equal(h.frames.size,1);
  h.step(0);h.calls.now=40;h.run('setManual({jawOpen:.8});');h.step(60);
  assert.equal(h.run('clipRecorder.recording'),true);
  h.calls.now=80;h.run('stopActive();');
  assert.equal(h.run('clipRecorder.recording'),false);assert.equal(h.run('savedClip.durationMs'),80);
  assert.equal(h.run('savedClip.samples.some(sample=>sample.coefficients.jawOpen===.8)'),true);
  assert.equal(h.run('camera.starts'),0);assert.equal(h.calls.downloads.length,0);assert.equal(h.frames.size,0);
  assert.equal(h.elements.get('#saveClip').disabled,false);
});

test('manual input deliberately closes camera while preserving an ongoing mixed-source numeric recording',()=>{
  const h=harness();h.prepare();h.run('source="camera";camera.active=true;toggleClipRecording();');
  h.calls.now=40;h.run('setManual({jawOpen:.8});');
  assert.equal(h.run('camera.active'),false);assert.equal(h.run('source'),'manual');
  assert.equal(h.run('clipRecorder.recording'),true);
  h.calls.now=80;h.run('choosePose("view-right");');
  assert.equal(h.run('clipRecorder.recording'),true);
  h.calls.now=100;h.run('stopActive();');
  assert.equal(h.run('savedClip.samples.some(sample=>sample.coefficients.jawOpen===.8&&sample.poseId==="view-right")'),true);
});

test('replay closes an active camera, completes painted endpoints and a manual change cancels pending replay',()=>{
  const h=harness();h.prepare();h.context.testClip=trackingClip();
  h.run('savedClip=testClip;source="camera";camera.active=true;playClip();');
  assert.equal(h.run('camera.active'),false);assert.equal(h.run('camera.stops'),1);assert.equal(h.run('source'),'clip');
  for(let time=0;time<600&&h.frames.size;time+=17)h.step(time);
  assert.equal(h.run('source'),'manual');assert.equal(h.run('coefficients.jawOpen'),.8);
  assert.equal(h.run('rendered.state.mouth'),'openMedium');assert.equal(h.frames.size,0);
  h.calls.now=700;h.run('playClip();');const oldCallback=[...h.frames.values()][0];
  h.run('setManual({mouthPucker:1});');oldCallback(720);
  assert.equal(h.run('source'),'manual');assert.equal(h.run('clipPlayer.playing'),false);
  assert.equal(h.run('coefficients.mouthPucker'),1);assert.equal(h.run('coefficients.jawOpen'),0);
});

test('hiding a numeric recording finalizes it and returning visible cannot resume either capture or replay',()=>{
  const h=harness();h.prepare();h.run('toggleClipRecording();');h.step(0);h.step(40);
  h.calls.now=60;h.document.hidden=true;h.documentEvents.visibilitychange();
  assert.equal(h.run('clipRecorder.recording'),false);assert.equal(h.run('savedClip.durationMs'),60);assert.equal(h.frames.size,0);
  h.document.hidden=false;h.documentEvents.visibilitychange();assert.equal(h.frames.size,0);
  h.run('playClip();');h.document.hidden=true;h.documentEvents.visibilitychange();
  assert.equal(h.run('clipPlayer.playing'),false);assert.equal(h.run('source'),'manual');assert.equal(h.frames.size,0);
});

test('hardware camera disconnect finalizes an active numeric clip instead of leaving a stuck recording',()=>{
  const h=harness();h.prepare();h.run('source="camera";camera.active=true;toggleClipRecording();');
  h.calls.now=80;h.run('camera.active=false;camera.onState({status:"stopped",message:"device ended"});');
  assert.equal(h.run('clipRecorder.recording'),false);assert.equal(h.run('savedClip.durationMs'),80);
  assert.equal(h.run('source'),'manual');assert.equal(h.frames.size,0);
});

test('a delayed numeric clip cannot replace newer manual work or a more recently opened clip',async()=>{
  const h=harness();h.prepare();let finish;
  const wait=new Promise(resolve=>{finish=resolve;});h.elements.get('#clipFile').files=[{size:100,text:()=>wait}];
  const first=h.run('openClipFile();');h.run('setManual({mouthPucker:1});');finish(JSON.stringify(trackingClip()));await first;
  assert.equal(h.run('savedClip'),null);assert.equal(h.run('coefficients.mouthPucker'),1);
  let finishOlder;const older=new Promise(resolve=>{finishOlder=resolve;});
  h.elements.get('#clipFile').files=[{size:100,text:()=>older}];const readingOlder=h.run('openClipFile();');
  h.elements.get('#clipFile').files=[{size:100,text:async()=>JSON.stringify(trackingClip(.4))}];await h.run('openClipFile();');
  finishOlder(JSON.stringify(trackingClip(.9)));await readingOlder;
  assert.equal(h.run('savedClip.samples[1].coefficients.jawOpen'),.4);assert.equal(h.run('source'),'manual');
});

test('starting a fresh numeric recording invalidates a pending clip import',async()=>{
  const h=harness();h.prepare();let finish;const wait=new Promise(resolve=>{finish=resolve;});
  h.elements.get('#clipFile').files=[{size:100,text:()=>wait}];const reading=h.run('openClipFile();');
  h.run('toggleClipRecording();');finish(JSON.stringify(trackingClip()));await reading;
  assert.equal(h.run('clipRecorder.recording'),true);assert.equal(h.run('savedClip'),null);
});

test('a rejected stale clip import cannot overwrite the status of a newer manual action',async()=>{
  const h=harness();h.prepare();let reject;const wait=new Promise((resolve,no)=>{reject=no;});
  h.elements.get('#clipFile').files=[{size:100,text:()=>wait}];const reading=h.run('openClipFile();');
  h.run('setManual({jawOpen:.4});syncClipControls("new state");');reject(new Error('obsolete failure'));await reading;
  assert.equal(h.elements.get('#clipStatus').textContent,'new state');
});

test('continuous manual input at one pose keeps the already accumulated mouth hold time',()=>{
  const h=harness();h.prepare();h.run('coefficients=sanitizeChannels({mouthPucker:1});paint({snap:true});setManual({mouthPressLeft:1});');
  h.step(0);
  const before=h.run('frameMotion.elapsedMs.mouth'),shown=h.run('rendered.state.mouth');
  assert.ok(before>0 && before<38,`elapsed=${before}, shown=${shown}`);
  h.calls.now=8;h.run('setManual({mouthPressLeft:.95},{reset:false});');
  assert.equal(h.run('frameMotion.elapsedMs.mouth'),before);assert.equal(h.run('rendered.state.mouth'),shown);
  for(let time=17;time<200&&h.frames.size;time+=17)h.step(time);
  assert.equal(h.run('rendered.state.mouth'),'press');
  assert.ok(h.calls.draws.some(draw=>draw.state.mouth==='neutral'));
});

test('tracking reset restores short-hair defaults and recalibrates only an already active camera',()=>{
  const h=harness();h.prepare();h.run('trackingSettings=normalizeTrackingSettings({preset:"stable",eyeSensitivity:1.4,mouthSensitivity:.7});applyTrackingSettings(false);session.neutral.jawOpen=.3;');
  h.elements.get('#resetTracking').events.click();
  assert.equal(h.run('trackingSettings.preset'),'balanced');assert.equal(h.run('trackingSettings.eyeSensitivity'),1);
  assert.equal(h.run('session.settings.channels.eyeBlinkLeft.smoothing'),24);assert.equal(h.run('camera.starts'),0);
  h.run('source="camera";camera.active=true;session.neutral.jawOpen=.3;poseStabilizer.update({yaw:1},0);');
  h.calls.now=500;h.elements.get('#resetTracking').events.click();
  assert.equal(h.run('calibrationUntil'),3500);assert.equal(h.run('session.neutral.jawOpen'),0);
  assert.equal(h.run('poseStabilizer.candidate'),null);assert.equal(h.run('source'),'camera');
});

test('camera targets preserve fractional angles and stale input returns toward neutral without a hard displayed jump',()=>{
  const h=harness();h.prepare();h.elements.get('#followHead').checked=true;
  h.run('source="camera";camera.active=true;signalGate.reset(960);camera.poll=()=>({faceMotion:{pose:{x:.16,y:0}},faceBlendshapes:[{categories:[]}]});cameraFrame(960,1/60);cameraFrame(1000,1/60);camera.poll=()=>null;');
  assert.ok(Math.abs(h.run('poseMotion.target.yaw')-.35)<1e-12);
  for(const now of [1040,1080,1160])h.run(`cameraFrame(${now},1/60)`);
  assert.ok(Math.abs(h.run('poseMotion.target.yaw')-.35)<1e-12);
  assert.equal(h.run('poseMotion.current.yaw'),0);
  h.run('paint({dt:.1});');const shown=h.run('poseMotion.current.yaw');assert.ok(shown>0&&shown<.35);
  h.run('camera.poll=()=>null;cameraFrame(1241,1/60);');assert.equal(h.run('poseMotion.target.yaw'),0);
  assert.equal(h.run('poseMotion.current.yaw'),shown);
});

test('output publishing is explicit and page exit clears its heartbeat and publisher',()=>{
  const h=harness();h.prepare();assert.equal(h.calls.published.length,0);assert.equal(h.intervals.size,0);
  h.elements.get('#outputToggle').checked=true;h.elements.get('#outputToggle').events.change();
  assert.equal(h.calls.published.length,1);assert.equal(h.intervals.size,1);
  assert.equal(h.calls.published[0].poseId,'front');
  h.windowEvents.pagehide();assert.equal(h.intervals.size,0);assert.equal(h.calls.outputStops,1);assert.equal(h.run('publisher.enabled'),false);
});

test('manual turns and slider reversals start from the displayed fractional angle and pause freezes it',()=>{
  const h=harness();h.prepare();h.run('choosePose("view-right");');
  assert.equal(h.run('rendered.headPose.yaw'),0);assert.equal(h.run('poseMotion.target.yaw'),1);
  for(const now of [0,17,34,51])h.step(now);
  const first=h.run('rendered.headPose.yaw');assert.ok(first>0&&first<1);
  h.elements.get('#headYaw').value='-.72';h.elements.get('#headYaw').events.input();
  assert.equal(h.run('rendered.headPose.yaw'),first);assert.equal(h.run('poseMotion.target.yaw'),-.72);
  for(let now=68;now<800&&h.frames.size;now+=17)h.step(now);
  assert.ok(h.run('rendered.headPose.yaw')<0);assert.ok(h.run('rendered.headPose.yaw')>=-.72);
  const shown=h.run('rendered.headPose.yaw'),callback=[...h.frames.values()][0];
  h.elements.get('#manualButton').events.click();if(callback)callback(900);
  assert.equal(h.run('rendered.headPose.yaw'),shown);assert.equal(h.run('poseMotion.target.yaw'),shown);
  assert.equal(h.frames.size,0);
});

test('v2 clip playback uses recorded displayed coordinates without live tracking damping a second time',()=>{
  const h=harness();h.prepare();h.context.testClip={schemaVersion:2,kind:'moemotion-short-hair-tracking-clip',characterId:'short-hair-v1',durationMs:100,
    samples:[{t:0,poseId:'front',headPose:{yaw:.1,pitch:-.2},coefficients:sanitizeChannels({})},
      {t:100,poseId:'view-right',headPose:{yaw:.9,pitch:.4},coefficients:sanitizeChannels({})}]};
  h.run('savedClip=testClip;trackingSettings=normalizeTrackingSettings({preset:"stable"});playClip();');
  h.step(0);assert.equal(h.run('rendered.headPose.yaw'),.1);
  h.step(50);assert.equal(h.run('rendered.headPose.yaw'),.5);
  assert.ok(Math.abs(h.run('rendered.headPose.pitch')-.1)<1e-12);
  h.step(100);assert.equal(h.run('rendered.headPose.yaw'),.9);assert.equal(h.run('source'),'manual');
  assert.equal(h.run('camera.starts'),0);
});

test('PNG, project and frame exports freeze the currently displayed angle instead of finishing its turn',async()=>{
  const h=harness();h.prepare();h.run('choosePose("view-right");');
  for(const now of [0,17,34])h.step(now);
  const yaw=h.run('rendered.headPose.yaw');assert.ok(yaw>0&&yaw<1);
  let pngPose;h.elements.get('#studioCanvas').toBlob=callback=>{
    pngPose=h.run('poseMotion.current.yaw');callback(new Blob(['png'],{type:'image/png'}));
  };
  h.run('savePng();');assert.equal(pngPose,yaw);assert.equal(h.frames.size,0);
  h.run('saveProject();exportFrame();');
  const project=JSON.parse(await h.calls.downloads[1].text()),frame=JSON.parse(await h.calls.downloads[2].text());
  assert.equal(project.headPose.yaw,yaw);assert.equal(frame.headPose.yaw,yaw);assert.equal(frame.schemaVersion,3);
  assert.equal(project.transparent,true);assert.equal(frame.preview.transparent,true);
  assert.equal(h.run('poseMotion.target.yaw'),yaw);assert.equal(h.frames.size,0);
});

test('continuous recording saves displayed intermediate coordinates and output transmits the same alpha setting',()=>{
  const h=harness();h.prepare();h.elements.get('#outputToggle').checked=true;h.elements.get('#outputToggle').events.change();
  h.run('toggleClipRecording();choosePose("view-right");');
  for(const now of [0,17,34,51,68,85])h.step(now);
  const displayed=h.run('rendered.headPose.yaw'),published=h.calls.published.at(-1);
  assert.equal(published.headPose.yaw,displayed);assert.equal(published.transparent,true);
  assert.ok(h.run('clipRecorder.samples.some(sample=>sample.headPose.yaw>0&&sample.headPose.yaw<1)'));
  h.elements.get('#transparentToggle').checked=false;h.elements.get('#transparentToggle').events.change();
  assert.equal(h.calls.published.at(-1).transparent,false);
  h.run('stopActive();');assert.equal(h.run('savedClip.schemaVersion'),3);
  assert.ok(h.run('savedClip.samples.some(sample=>sample.headPose.yaw>0&&sample.headPose.yaw<1)'));
});

test('an invalid continuous frame cannot interrupt a live source or partially change its alpha setting',()=>{
  const h=harness();h.prepare();h.run('source="demo";transparent=false;');
  const invalid={schemaVersion:2,headPose:{yaw:1.1,pitch:0},coefficients:{jawOpen:.8},preview:{transparent:true}};
  h.context.badFrame=JSON.stringify(invalid);h.run('applyFrame(badFrame);');
  assert.equal(h.run('source'),'demo');assert.equal(h.run('transparent'),false);assert.equal(h.run('coefficients.jawOpen'),0);
});

test('a valid v2 frame restores its displayed angle and explicit alpha option before painting',()=>{
  const h=harness();h.prepare();h.context.importedFrame=JSON.stringify({schemaVersion:2,headPose:{yaw:.234,pitch:-.678},
    coefficients:{jawOpen:.8},preview:{transparent:false}});
  h.run('source="demo";applyFrame(importedFrame);');
  assert.equal(h.run('source'),'manual');assert.equal(h.run('rendered.headPose.yaw'),.234);
  assert.equal(h.run('rendered.headPose.pitch'),-.678);assert.equal(h.run('transparent'),false);
  assert.equal(h.elements.get('#transparentToggle').checked,false);assert.equal(h.calls.draws.at(-1).transparent,false);
});

test('original view publishes and exports the exact nearest painting while retaining the continuous return position',async()=>{
  const h=harness();h.prepare();h.run('poseMotion=createStudioPoseMotion({yaw:.31,pitch:-.22});poseId="view-right";paint({snap:true});');
  h.elements.get('#outputToggle').checked=true;h.elements.get('#outputToggle').events.change();
  h.elements.get('#originalToggle').checked=true;h.elements.get('#originalToggle').events.change();
  assert.equal(h.run('poseMotion.current.yaw'),.31);assert.equal(h.run('rendered.headPose.yaw'),0);
  assert.equal(h.calls.published.at(-1).poseId,'front');assert.equal(h.calls.published.at(-1).headPose.yaw,0);
  h.run('exportFrame();');const frame=JSON.parse(await h.calls.downloads[0].text());
  assert.equal(frame.poseId,'front');assert.deepEqual(frame.headPose,{yaw:0,pitch:0});assert.equal(frame.preview.original,true);
  h.elements.get('#originalToggle').checked=false;h.elements.get('#originalToggle').events.change();
  assert.equal(h.run('rendered.headPose.yaw'),.31);assert.equal(h.run('rendered.headPose.pitch'),-.22);
});

test('a skipped clip frame cannot commit new coordinates or mix a heartbeat with unrendered inputs',()=>{
  const h=harness();h.prepare();h.context.testClip={schemaVersion:2,kind:'moemotion-short-hair-tracking-clip',characterId:'short-hair-v1',durationMs:100,
    samples:[{t:0,poseId:'front',headPose:{yaw:0,pitch:0},coefficients:sanitizeChannels({})},
      {t:100,poseId:'view-right',headPose:{yaw:1,pitch:.4},coefficients:sanitizeChannels({jawOpen:1})}]};
  h.elements.get('#outputToggle').checked=true;h.elements.get('#outputToggle').events.change();
  h.run('savedClip=testClip;playClip();');h.step(0);
  const before=h.run('poseMotion'),committed=structuredClone(h.calls.published.at(-1)),draw=h.context.renderContinuousShortHairStudio;
  h.context.renderContinuousShortHairStudio=()=>({didDraw:false});h.step(50);
  assert.equal(h.run('poseMotion'),before);assert.equal(h.run('rendered.headPose.yaw'),0);
  h.run('publishOutput();');assert.deepEqual(JSON.parse(JSON.stringify(h.calls.published.at(-1))),committed);
  h.context.renderContinuousShortHairStudio=draw;h.step(67);assert.equal(h.run('rendered.headPose.yaw'),.67);
});

test('a skipped final clip frame is retried before playback is declared complete',()=>{
  const h=harness();h.prepare();h.context.testClip={schemaVersion:2,kind:'moemotion-short-hair-tracking-clip',characterId:'short-hair-v1',durationMs:100,
    samples:[{t:0,poseId:'front',headPose:{yaw:0,pitch:0},coefficients:sanitizeChannels({})},
      {t:100,poseId:'view-right',headPose:{yaw:1,pitch:.4},coefficients:sanitizeChannels({})}]};
  h.run('savedClip=testClip;playClip();');h.step(0);const draw=h.context.renderContinuousShortHairStudio;
  h.context.renderContinuousShortHairStudio=()=>({didDraw:false});h.step(100);
  assert.equal(h.run('rendered.headPose.yaw'),0);assert.equal(h.run('source'),'clip');assert.equal(h.frames.size,1);
  h.context.renderContinuousShortHairStudio=draw;h.step(117);
  assert.equal(h.run('rendered.headPose.yaw'),1);assert.equal(h.run('source'),'manual');assert.equal(h.frames.size,0);
});

const plain=value=>JSON.parse(JSON.stringify(value));
function cameraSample(pose={x:.1,y:.03},channels={}) {
  return {faceMotion:{pose},faceBlendshapes:[{categories:Object.entries(channels).map(([categoryName,score])=>({categoryName,score}))}]};
}
function attachCamera(h,sample=cameraSample()) {
  h.context.frameInput=sample;
  h.run('source="camera";camera.active=true;signalGate.reset(calls.now);camera.poll=()=>frameInput;');
}
function calibrationFrames(h,end=3000) {
  for(let now=0;now<=end;now+=100){h.calls.now=now;h.run(`cameraFrame(${now},.1)`);}
}

test('a rejected closed-eye calibration preserves the previously useful face and head baseline',()=>{
  const h=harness();h.prepare();attachCamera(h,cameraSample({x:.1,y:.03},{eyeBlinkLeft:.95,eyeBlinkRight:.9,jawOpen:.04}));
  h.run('session.neutral.eyeBlinkLeft=.08;session.neutral.eyeBlinkRight=.09;session.neutral.jawOpen=.06;neutralPose={x:.12,y:-.04};');
  const previousChannels=plain(h.run('session.neutral')),previousPose=plain(h.run('neutralPose'));
  h.run('beginCalibration();');calibrationFrames(h);
  assert.deepEqual(plain(h.run('session.neutral')),previousChannels);assert.deepEqual(plain(h.run('neutralPose')),previousPose);
  assert.equal(h.run('calibrationUntil'),0);assert.equal(h.run('calibrationBackup'),null);assert.equal(h.run('session.samples.length'),0);
  assert.match(h.elements.get('#motionStatus').textContent,/眼睛闭合/);assert.equal(h.run('source'),'camera');
});

test('calibration lost near its end retains its previous baseline and explains the failure',()=>{
  const h=harness();h.prepare();attachCamera(h);
  h.run('session.neutral.jawOpen=.06;neutralPose={x:.12,y:-.04};beginCalibration();');calibrationFrames(h,1500);
  h.context.frameInput=null;h.calls.now=3000;h.run('cameraFrame(3000,.1);');
  assert.equal(h.run('session.neutral.jawOpen'),.06);assert.deepEqual(plain(h.run('neutralPose')),{x:.12,y:-.04});
  assert.match(h.elements.get('#motionStatus').textContent,/校准结束时/);assert.equal(h.run('calibrationUntil'),0);
});

test('manual pause, hidden-page interruption and hardware loss all restore an unfinished calibration',()=>{
  for(const mode of ['pause','hidden','hardware']){
    const h=harness();h.prepare();attachCamera(h);
    h.run('session.neutral.jawOpen=.08;neutralPose={x:.16,y:-.07};beginCalibration();');calibrationFrames(h,1000);
    if(mode==='pause')h.run('stopActive();');
    else if(mode==='hidden'){h.document.hidden=true;h.documentEvents.visibilitychange();}
    else h.run('camera.active=false;camera.onState({status:"stopped",message:"disconnected"});');
    assert.equal(h.run('session.neutral.jawOpen'),.08,mode);assert.deepEqual(plain(h.run('neutralPose')),{x:.16,y:-.07},mode);
    assert.equal(h.run('calibrationUntil'),0,mode);assert.equal(h.run('calibrationBackup'),null,mode);
    assert.equal(h.run('source'),'manual',mode);assert.equal(h.frames.size,0,mode);
  }
});

test('face loss and two fresh recovery samples update both the target and the recovery message',()=>{
  const h=harness();h.prepare();h.elements.get('#followHead').checked=true;attachCamera(h,cameraSample({x:.16,y:0}));
  h.run('cameraFrame(0,1/60);cameraFrame(40,1/60);');assert.equal(h.run('trackingStatus'),'tracking');
  h.context.frameInput=null;h.run('cameraFrame(700,1/60);');
  assert.equal(h.run('poseMotion.target.yaw'),0);assert.equal(h.run('trackingStatus'),'lost');assert.match(h.elements.get('#motionStatus').textContent,/寻找面部/);
  h.context.frameInput=cameraSample({x:.18,y:0});h.run('cameraFrame(740,1/60);');
  assert.equal(h.run('poseMotion.target.yaw'),0);assert.equal(h.run('trackingStatus'),'recovering');
  h.run('cameraFrame(780,1/60);');
  assert.ok(Math.abs(h.run('poseMotion.target.yaw')-.4)<1e-12);assert.equal(h.run('poseMotion.current.yaw'),0);
  assert.equal(h.run('trackingStatus'),'tracking');assert.match(h.elements.get('#motionStatus').textContent,/跟踪已恢复/);
});

test('a single wrong landmark angle cannot move the head target or postpone its stale timeout',()=>{
  const h=harness();h.prepare();h.elements.get('#followHead').checked=true;attachCamera(h,cameraSample({x:.1,y:0}));
  h.run('cameraFrame(0,1/60);cameraFrame(40,1/60);');const target=h.run('poseMotion.target.yaw');assert.ok(target>0);
  h.context.frameInput=cameraSample({x:.95,y:0},{jawOpen:1});h.run('cameraFrame(80,1);');
  assert.equal(h.run('poseMotion.target.yaw'),target);assert.ok(h.run('coefficients.jawOpen')>.9,'expression samples need not wait for a head jump confirmation');
  h.context.frameInput=null;for(const now of [120,180,240])h.run(`cameraFrame(${now},1/60);`);
  assert.equal(h.run('poseMotion.target.yaw'),target);h.run('cameraFrame(281,1/60);');assert.equal(h.run('poseMotion.target.yaw'),0);
});

test('pausing optional micro-motion freezes its displayed frame and resuming continues its phase',()=>{
  const h=harness();h.prepare();h.run('toggleSecondary();');h.step(0);h.step(100);
  const shown=plain(h.run('secondaryMotion.current')),phase=h.run('secondaryMotion.elapsed');assert.ok(shown.breath>0);
  h.run('toggleSecondary();');h.step(500);
  assert.equal(h.run('secondaryRunning'),false);assert.deepEqual(plain(h.run('rendered.secondary')),shown);
  assert.equal(h.run('secondaryMotion.elapsed'),phase);assert.equal(h.frames.size,0);
  h.calls.now=600;h.run('toggleSecondary();');h.step(600);
  assert.ok(h.run('secondaryMotion.elapsed')>phase);assert.ok(h.run('secondaryMotion.elapsed')<phase+.11);
});

test('hiding a micro-motion session freezes it and visibility cannot restart it',()=>{
  const h=harness();h.prepare();h.run('toggleSecondary();');h.step(0);h.step(100);
  const shown=plain(h.run('secondaryMotion.current')),phase=h.run('secondaryMotion.elapsed');
  h.document.hidden=true;h.documentEvents.visibilitychange();
  assert.equal(h.run('secondaryRunning'),false);assert.equal(h.frames.size,0);
  h.document.hidden=false;h.documentEvents.visibilitychange();
  assert.deepEqual(plain(h.run('rendered.secondary')),shown);assert.equal(h.run('secondaryMotion.elapsed'),phase);assert.equal(h.frames.size,0);
});

test('hardware camera termination freezes optional micro-motion and clears its running UI',()=>{
  const h=harness();h.prepare();h.run('toggleSecondary();');h.step(0);h.step(100);
  const shown=plain(h.run('secondaryMotion.current'));attachCamera(h);
  h.run('camera.active=false;camera.onState({status:"stopped",message:"disconnected"});');
  assert.equal(h.run('secondaryRunning'),false);assert.deepEqual(plain(h.run('secondaryMotion.current')),shown);
  assert.equal(h.elements.get('#secondaryToggle').textContent,'开启微动');assert.equal(h.frames.size,0);assert.equal(h.run('isAnimating()'),false);
});

test('PNG, frame and project exports freeze exactly the displayed micro-motion',async()=>{
  for(const action of ['savePng','exportFrame','saveProject']){
    const h=harness();h.prepare();h.run('toggleSecondary();');h.step(0);h.step(100);
    const shown=plain(h.run('rendered.secondary'));let pngSecondary;
    h.elements.get('#studioCanvas').toBlob=callback=>{pngSecondary=plain(h.run('secondaryMotion.current'));callback(new Blob(['png'],{type:'image/png'}));};
    h.run(`${action}();`);
    assert.equal(h.run('secondaryRunning'),false,action);assert.equal(h.frames.size,0,action);
    assert.deepEqual(plain(h.run('rendered.secondary')),shown,action);
    if(action==='savePng')assert.deepEqual(pngSecondary,shown);
    else assert.deepEqual(JSON.parse(await h.calls.downloads[0].text()).secondary,shown,action);
  }
});

test('a failed draw commits neither micro-motion nor head movement nor a new output heartbeat',()=>{
  const h=harness();h.prepare();h.elements.get('#outputToggle').checked=true;h.elements.get('#outputToggle').events.change();
  h.run('toggleSecondary();choosePose("view-right");');h.step(0);
  const head=h.run('poseMotion'),secondary=h.run('secondaryMotion'),committed=plain(h.calls.published.at(-1));
  const draw=h.context.renderContinuousShortHairStudio;h.context.renderContinuousShortHairStudio=()=>({didDraw:false});h.step(34);
  assert.equal(h.run('poseMotion'),head);assert.equal(h.run('secondaryMotion'),secondary);assert.equal(h.run('graphicsPending'),true);
  h.run('publishOutput();');assert.deepEqual(plain(h.calls.published.at(-1)),committed);
  h.context.renderContinuousShortHairStudio=draw;h.step(51);
  assert.ok(h.run('poseMotion.current.yaw')>head.current.yaw);assert.ok(h.run('secondaryMotion.elapsed')>secondary.elapsed);
  assert.equal(h.run('graphicsPending'),false);
});

test('setting micro-motion intensity to zero waits for a successful reset draw before committing it',()=>{
  const h=harness();h.prepare();h.run('toggleSecondary();');h.step(0);h.step(100);
  const shown=plain(h.run('rendered.secondary')),before=h.run('secondaryMotion'),draw=h.context.renderContinuousShortHairStudio;
  assert.ok(shown.breath>0);h.context.renderContinuousShortHairStudio=()=>({didDraw:false});
  h.elements.get('#secondaryIntensity').value='0';h.elements.get('#secondaryIntensity').events.input();
  assert.equal(h.run('secondaryMotion'),before);assert.deepEqual(plain(h.run('rendered.secondary')),shown);
  assert.equal(h.run('secondaryRunning'),false);assert.equal(h.run('graphicsPending'),true);
  h.context.renderContinuousShortHairStudio=draw;h.step(117);
  assert.deepEqual(plain(h.run('secondaryMotion.current')),{breath:0,sway:0,hair:0});
  assert.deepEqual(plain(h.run('rendered.secondary')),{breath:0,sway:0,hair:0});assert.equal(h.run('graphicsPending'),false);
});

test('v3 replay uses recorded micro-motion once and retains its final endpoint after a failed draw',()=>{
  const h=harness();h.prepare();h.context.testClip={schemaVersion:3,kind:'moemotion-short-hair-tracking-clip',characterId:'short-hair-v1',durationMs:100,
    samples:[{t:0,poseId:'front',headPose:{yaw:0,pitch:0},secondary:{breath:-.4,sway:.1,hair:.8},coefficients:sanitizeChannels({})},
      {t:100,poseId:'view-right',headPose:{yaw:1,pitch:.4},secondary:{breath:.6,sway:-.3,hair:-.4},coefficients:sanitizeChannels({})}]};
  let simulationCalls=0;const advance=h.context.advanceSecondaryMotion;
  h.context.advanceSecondaryMotion=(...args)=>{simulationCalls++;return advance(...args);};
  h.run('toggleSecondary();savedClip=testClip;playClip();');h.step(0);h.step(50);
  assert.equal(h.run('secondaryRunning'),false);assert.equal(simulationCalls,0);assert.equal(h.run('rendered.headPose.yaw'),.5);
  assert.ok(Math.abs(h.run('rendered.secondary.breath')-.1)<1e-12);assert.ok(Math.abs(h.run('rendered.secondary.hair')-.2)<1e-12);
  const shown=plain(h.run('secondaryMotion.current')),draw=h.context.renderContinuousShortHairStudio;
  h.context.renderContinuousShortHairStudio=()=>({didDraw:false});h.step(100);
  assert.deepEqual(plain(h.run('secondaryMotion.current')),shown);assert.equal(h.run('source'),'clip');
  h.context.renderContinuousShortHairStudio=draw;h.step(117);
  assert.deepEqual(plain(h.run('rendered.secondary')),{breath:.6,sway:-.3,hair:-.4});assert.equal(h.run('rendered.headPose.yaw'),1);
  assert.equal(simulationCalls,0);assert.equal(h.run('source'),'manual');assert.equal(h.frames.size,0);
});

test('composition changes update only output framing and never advance or mirror the rig controls',()=>{
  const h=harness();h.prepare();h.run('poseMotion=createStudioPoseMotion({yaw:.31,pitch:-.22});paint({snap:true});');
  h.elements.get('#outputToggle').checked=true;h.elements.get('#outputToggle').events.change();
  const head=h.run('poseMotion'),secondary=h.run('secondaryMotion'),drawCount=h.calls.draws.length,display=plain(h.run('rendered'));
  h.elements.get('#outputScale').value='1.4';h.elements.get('#outputScale').events.input();
  h.elements.get('#outputX').value='-.3';h.elements.get('#outputX').events.input();
  h.elements.get('#outputMirror').checked=true;h.elements.get('#outputMirror').events.change();
  assert.equal(h.run('poseMotion'),head);assert.equal(h.run('secondaryMotion'),secondary);assert.equal(h.calls.draws.length,drawCount);
  assert.deepEqual(plain(h.run('rendered')),display);assert.equal(h.frames.size,0);
  const output=h.calls.published.at(-1);assert.deepEqual(plain(output.headPose),{yaw:.31,pitch:-.22});
  assert.deepEqual(plain(output.composition),{scale:1.4,x:-.3,y:0,mirror:true});
  assert.deepEqual(h.calls.compositions.at(-1).composition,{scale:1.4,x:-.3,y:0,mirror:true});
});

test('a pending project or clip import cannot cancel a newer explicit micro-motion action',async()=>{
  for(const kind of ['project','clip']){
    const h=harness();h.prepare();let complete;
    const waiting=new Promise(resolve=>{complete=resolve;});let pending;
    if(kind==='project'){
      h.context.input={files:[{size:200,text:()=>waiting}],value:'file'};pending=h.run('readInputFile(input,"project")');
    }else{
      h.elements.get('#clipFile').files=[{size:200,text:()=>waiting}];pending=h.run('openClipFile()');
    }
    h.run('toggleSecondary();');
    complete(JSON.stringify(kind==='project'?model.createStudioProject({name:'older file'}):trackingClip()));await pending;
    assert.equal(h.run('secondaryRunning'),true,kind);assert.equal(h.run('savedClip'),null,kind);
    assert.notEqual(h.run('project.name'),'older file',kind);assert.equal(h.frames.size,1,kind);
  }
});

test('assets completing after page exit are disposed without rebuilding or reviving the studio',async()=>{
  const h=harness();let disposed=0,built=0;
  h.context.buildControls=()=>{built++;};assert.equal(h.calls.assetResolvers.length,1);
  h.windowEvents.pagehide();h.calls.assetResolvers[0]({flowRenderer:{dispose(){disposed++;}}});
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(disposed,1);assert.equal(built,0);assert.equal(h.run('ready'),false);assert.equal(h.frames.size,0);
  assert.equal(h.run('camera.starts'),0);assert.equal(h.run('assets'),undefined);
});

test('page exit cannot schedule graphics recovery or accept a late animation callback',()=>{
  const h=harness();h.prepare();h.run('graphicsPending=true;ensureAnimation();');
  const late=[...h.frames.values()][0],draws=h.calls.draws.length;
  assert.equal(h.frames.size,1);h.windowEvents.pagehide();
  assert.equal(h.run('ready'),false);assert.equal(h.frames.size,0);
  late(1000);assert.equal(h.calls.draws.length,draws);assert.equal(h.frames.size,0);
});

test('pausing micro-motion immediately updates the source badge and persists the exact frozen frame',()=>{
  const h=harness();h.prepare();h.run('toggleSecondary();');h.step(0);h.step(100);
  assert.equal(h.elements.get('#sourceBadge').textContent,'自然微动');const shown=plain(h.run('rendered.secondary'));
  h.run('toggleSecondary();');assert.equal(h.elements.get('#sourceBadge').textContent,'手动 · 静止');
  assert.equal(h.elements.get('#secondaryToggle').textContent,'开启微动');
  const saved=JSON.parse(h.calls.saved.at(-1).value);
  assert.deepEqual(saved.secondary,shown);assert.equal(saved.secondarySettings.enabled,false);
  h.context.restoreInput=saved;h.run('restoreProject(restoreInput);');
  assert.equal(h.run('secondaryRunning'),false);assert.equal(h.frames.size,0);assert.deepEqual(plain(h.run('rendered.secondary')),shown);
});
