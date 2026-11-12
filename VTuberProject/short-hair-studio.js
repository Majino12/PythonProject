import {DEFAULT_PERFORMANCE_PRESETS,PERFORMANCE_PRESET_LIMIT,createPerformancePreset,createPerformanceMixer,setPerformancePreset,clearPerformancePresets,freezePerformanceMixer,isPerformancePresetActive,proposePerformanceFrame,matchPerformanceShortcut} from './short-hair-performance.js';
import {createIdleBlink,advanceIdleBlink,applyIdleBlink} from './short-hair-idle-blink.js';
import {selectShortHairStudioState} from './short-hair-studio-renderer.js';
import {loadContinuousShortHairAssets,renderContinuousShortHairStudio} from './short-hair-continuous-renderer.js';
import {poseHeadCoordinates,normalizeCameraHeadPose,nearestStudioPoseId,createStudioPoseMotion,targetStudioPoseMotion,advanceStudioPoseMotion,freezeStudioPoseMotion} from './short-hair-pose-motion.js';
import {createShortHairLayerInspection} from './short-hair-layer-inspector.js';
import {exportShortHairLayers} from './short-hair-alpha.js';
import {STUDIO_CHANNELS, STUDIO_STORAGE_KEY, STUDIO_PRESETS, createStudioProject, parseStudioProject,
  parseStudioFrame, applyStudioPreset, gazeChannels, selectStudioPose, sampleStudioDemo} from './short-hair-studio-model.js';
import {sanitizeChannels} from './expression-model.js';
import {FaceSession} from './face-session.js';
import {extractFaceMotion} from './motion.js';
import {ShortHairStudioCamera} from './short-hair-studio-camera.js';
import {STUDIO_RENDER_FPS, StudioFrameClock, createStudioMotion, advanceStudioMotion} from './short-hair-studio-timing.js';
import {normalizeTrackingSettings,createFaceSessionSettings,StudioPoseStabilizer,TrackingClipRecorder,TrackingClipPlayer,parseTrackingClip,TRACKING_CLIP_LIMITS} from './short-hair-studio-tracking.js';
import {loadShortHairCharacterPack,summarizeShortHairCharacterPack} from './short-hair-character-pack.js';
import {StudioOutputPublisher} from './short-hair-studio-publisher.js';
import {StudioTrackingSignalGate,StudioCalibrationQuality} from './short-hair-tracking-quality.js';
import {normalizeSecondarySettings,createSecondaryMotion,rebaseSecondaryMotion,advanceSecondaryMotion,freezeSecondaryMotion} from './short-hair-secondary-motion.js';
import {normalizeOutputComposition} from './short-hair-composition.js';
import {drawOutputFrame} from './short-hair-studio-output-model.js';

const turnReviewEnabled=/(?:^|[?&])turn-review=1(?:&|$)/.test(window.location?.search||'');
if(turnReviewEnabled)void import('./short-hair-turn-review.js');
const nodes = new Map();
const $ = selector => {if (!nodes.has(selector)) nodes.set(selector, document.querySelector(selector)); return nodes.get(selector);};
const setText = (node, value) => {if (node.textContent !== value) node.textContent = value;};
const setAttribute = (node, key, value) => {if (node.getAttribute?.(key) !== value) node.setAttribute(key, value);};
const channelByKey = new Map(STUDIO_CHANNELS.map(channel => [channel.key, channel]));
const presetById = new Map(STUDIO_PRESETS.map(preset => [preset.id, preset]));
let controls = {poses:[], sliders:[], labels:[], actions:[], gaze:[], views:Array.from(document.querySelectorAll('[data-view]'))};
const canvas = $('#studioCanvas'), session = new FaceSession();
const LABELS = {open:'睁眼', quarter:'轻闭', half:'半闭', threeQuarter:'将闭', closed:'闭眼', neutral:'自然',
  parted:'微张', openSmall:'小张', openMedium:'中张', openWide:'大张', pucker:'噘嘴', press:'抿嘴',
  shiftLeft:'角色左移', shiftRight:'角色右移', up:'抬起', innerUp:'眉头抬', outerUp:'眉尾抬', down:'压低'};
let assets, ready = false, project = createStudioProject(), poseId = 'front', coefficients = sanitizeChannels({});
let previousState = {}, rendered = null, faceOnly = true, source = 'manual', animationFrame = 0;
let demoStartedAt = 0, demoBasePose = 'front', revision = 0, loadRequest = 0;
const frameClock = new StudioFrameClock({targetFps:STUDIO_RENDER_FPS});
let frameMotion = createStudioMotion(), transitionPending = false;
let poseMotion = createStudioPoseMotion(), transparent = true;
let calibrationUntil = 0, neutralPose = {x:0,y:0}, lastFaceAt = -Infinity, trackedPose = {yaw:0,pitch:0};
let recorder = null, recordingStream = null, recordingCanvas = null, recordingStartedAt = 0;
let motionProfile = 'natural', trackingSettings = normalizeTrackingSettings(), characterPack = null;
let savedClip = null, clipReadRequest = 0, clipFinished = false, outputHeartbeat = 0, committedOutput = null, pendingClipFrame = null;
const poseStabilizer = new StudioPoseStabilizer(trackingSettings);
const signalGate=new StudioTrackingSignalGate(), calibrationQuality=new StudioCalibrationQuality();
let calibrationBackup=null, trackingStatus='acquiring', graphicsPending=false;
let secondaryMotion=createSecondaryMotion(),secondarySettings=normalizeSecondarySettings(),secondaryRunning=false;
let composition=normalizeOutputComposition(),layerInspection=null,pendingSecondary=null;
let performancePresets=project.performancePresets||DEFAULT_PERFORMANCE_PRESETS.map(preset=>({...preset}));
let performanceMixer=createPerformanceMixer(),performanceMoving=false,performanceButtons=[];
let idleBlinkEnabled=false,idleBlinkMotion=createIdleBlink();
const clipRecorder = new TrackingClipRecorder(), clipPlayer = new TrackingClipPlayer();
const publisher = new StudioOutputPublisher({onState(event) {
  setText($('#outputStatus'),event.message);$('#outputStatus').classList.toggle('warning',event.status==='error');
  $('#outputToggle').checked=publisher.enabled;
  if(!publisher.enabled&&outputHeartbeat){clearInterval(outputHeartbeat);outputHeartbeat=0;}
}});
session.setSettings(createFaceSessionSettings(trackingSettings));
const camera = new ShortHairStudioCamera($('#cameraVideo'), {onState(event) {
  if (event.status === 'stopped' || event.status === 'error') {
    if (source === 'camera' || source === 'camera-pending') {
      finishClipRecording();
      idleBlinkEnabled=false;performanceMixer=freezePerformanceMixer(performanceMixer);performanceMoving=false;syncPerformanceControls();
      pendingSecondary=null;secondaryRunning=false;secondaryMotion=freezeSecondaryMotion(secondaryMotion,poseMotion.current);syncSecondaryControls();
      source = 'manual'; poseMotion=freezeStudioPoseMotion(poseMotion); transitionPending = false; frameMotion = createStudioMotion(rendered?.state || null); frameClock.reset();
      cancelAnimationFrame(animationFrame); animationFrame = 0;
      if (recorder?.state === 'recording') ensureAnimation();
      syncFrameStats();
      syncTrackingStats();
    }
    cancelCalibration();
  }
  motionMessage(event.message, event.status === 'error'); syncSourceControls();
}});

function motionMessage(message, warning = false) {
  setText($('#motionStatus'), message); $('#motionStatus').classList.toggle('warning', warning);
}
function frameDescription(state) {
  if (!state) return '';
  return `左眼 ${LABELS[state.eyeLeft] || state.eyeLeft} · 右眼 ${LABELS[state.eyeRight] || state.eyeRight}\n嘴 ${LABELS[state.mouth] || state.mouth} · 左眉 ${LABELS[state.browLeft] || state.browLeft} · 右眉 ${LABELS[state.browRight] || state.browRight}`;
}
function poseMeta() { return assets?.poses.find(pose => pose.id === poseId); }

function syncSourceControls() {
  $('#manualButton').setAttribute('aria-pressed', String(source === 'manual'));
  $('#demoButton').setAttribute('aria-pressed', String(source === 'demo'));
  $('#demoButton').textContent = source === 'demo' ? '暂停演示' : '播放演示';
  $('#cameraButton').setAttribute('aria-pressed', String(camera.active || camera.starting));
  $('#cameraButton').textContent = camera.starting ? '取消连接' : camera.active ? '关闭摄像头' : '开启摄像头';
  $('#cameraPanel').hidden = !camera.active;
  $('#calibrateButton').disabled = !camera.active || calibrationUntil > 0;
  $('#sourceBadge').textContent = source === 'clip' ? '片段重放' : source === 'demo' ? '自动演示' : source === 'camera' ? '面部跟踪' : source === 'camera-pending' ? '连接中' : secondaryRunning||idleBlinkActive()?'自然待机':'手动 · 静止';
}
function syncControls() {
  setText($('#sourceBadge'), source === 'clip' ? '片段重放' : source === 'demo' ? '自动演示' : source === 'camera' ? '面部跟踪' : source === 'camera-pending' ? '连接中' : transitionPending ? '手动 · 动作衔接' : secondaryRunning||idleBlinkActive()?'自然待机':'手动 · 静止');
  for (const button of controls.poses) setAttribute(button, 'aria-pressed', String(button.dataset.pose === poseId));
  for (const slider of controls.sliders) {
    const value = coefficients[slider.dataset.channel];
    if (slider.value !== String(value)) slider.value = String(value); setText(slider.studioOutput, value.toFixed(2));
  }
  for (const label of controls.labels) {
    const channel = channelByKey.get(label.dataset.channelLabel);
    setText(label, poseId === 'front' ? channel.label : channel.label.replace('（整眉近似）', ''));
  }
  for (const button of controls.actions) {
    const preset = presetById.get(button.dataset.action);
    const relevant = STUDIO_CHANNELS.filter(channel => channel.group === preset.group);
    const active = relevant.every(({key}) => Math.abs(coefficients[key] - (preset.channels[key] || 0)) < .015);
    setAttribute(button, 'aria-pressed', String(active));
  }
  for (const button of controls.gaze) {
    const target = gazeChannels(Number(button.dataset.gazeX), Number(button.dataset.gazeY));
    setAttribute(button, 'aria-pressed', String(Object.entries(target).every(([key, value]) => Math.abs(coefficients[key] - value) < .015)));
  }
  for (const button of controls.views) setAttribute(button, 'aria-pressed', String((button.dataset.view === 'face') === faceOnly));
  setText($('#poseTitle'), $('#originalToggle').checked?`最近原稿 · ${assets?.poses.find(pose=>pose.id===nearestStudioPoseId(poseMotion.current))?.label||'正面'}`:poseMeta()?.label || '正面');
  for(const [axis,id] of [['yaw','Yaw'],['pitch','Pitch']]) {
    const value=poseMotion.target[axis];if($('#head'+id).value!==String(value))$('#head'+id).value=String(value);
    setText($('#head'+id+'Value'),poseMotion.current[axis].toFixed(2));
  }
  setText($('#stateReadout'), `${poseMeta()?.label || poseId}\n${frameDescription(rendered?.state)}${$('#originalToggle').checked ? '\n当前显示原画；输入与目标表情保留。' : ''}`);
  if (rendered) setAttribute(canvas, 'aria-label', `${poseMeta()?.label || poseId}，${frameDescription(rendered.state)}`);
}

function idleBlinkActive(){return idleBlinkEnabled&&source==='manual'&&!$('#originalToggle').checked;}
function isAnimating() {return performanceMoving || idleBlinkActive() || graphicsPending || secondaryRunning || source === 'demo' || source === 'camera' || source === 'clip' || clipRecorder.recording || transitionPending || recorder?.state === 'recording';}
function syncFrameStats(now = performance.now()) {
  if (!isAnimating()) {setText($('#frameStats'), `静止 · 目标 ${frameClock.targetFps} fps`); return;}
  const stats = frameClock.snapshot(now);
  const detail = stats.measuredFps === null ? '正在测量绘制帧率…'
    : `实测 ${stats.measuredFps.toFixed(1)} fps · 平均 ${stats.averageRenderMs.toFixed(1)} ms/帧`;
  setText($('#frameStats'), `目标 ${stats.targetFps} fps · ${detail}`);
}
function paint({now = performance.now(), dt = 0, snap = false, hold = false, measure = false,headPoseOverride=null,secondaryOverride=null} = {}) {
  if (!ready) return false;
  try {
    const started = performance.now();
    const poseProposal=headPoseOverride?{motion:createStudioPoseMotion(headPoseOverride),headPose:headPoseOverride,moving:false}:advanceStudioPoseMotion(poseMotion,dt*1000,{preset:trackingSettings.preset,mode:source==='camera'?'tracking':'turn'});
    secondaryOverride ||= pendingSecondary;
    const secondaryProposal=secondaryOverride?{motion:rebaseSecondaryMotion(poseProposal.headPose,secondaryOverride),secondary:{...secondaryOverride}}
      :secondaryRunning?advanceSecondaryMotion(secondaryMotion,poseProposal.headPose,dt*1000,{...secondarySettings,enabled:true})
      :{motion:freezeSecondaryMotion(secondaryMotion,poseProposal.headPose),secondary:{...secondaryMotion.current}};
    const performanceProposal=source==='clip'?{mixer:performanceMixer,effectiveCoefficients:coefficients,moving:false}
      :proposePerformanceFrame(performanceMixer,coefficients,hold?0:dt*1000);
    const blinkProposal=idleBlinkActive()?advanceIdleBlink(idleBlinkMotion,dt*1000):{motion:idleBlinkMotion,closure:0};
    const paintedCoefficients=hold&&rendered&&committedOutput?{...committedOutput.coefficients}
      :idleBlinkActive()?applyIdleBlink(performanceProposal.effectiveCoefficients,blinkProposal.closure):performanceProposal.effectiveCoefficients;
    const selection = selectShortHairStudioState(assets, poseId, paintedCoefficients, previousState);
    const proposed = hold && rendered ? {frameState:rendered.state, moving:false, motion:frameMotion}
      : advanceStudioMotion(snap ? createStudioMotion(selection.targetState) : frameMotion,
        selection.targetState, dt * 1000, selection.availableSequences, {profile:motionProfile});
    const next = renderContinuousShortHairStudio(canvas, assets, poseId, paintedCoefficients, previousState,
      {faceOnly, original:$('#originalToggle').checked, stateOverride:proposed.frameState,headPose:poseProposal.headPose,transparent,secondary:secondaryProposal.secondary});
    if (next.didDraw === false) {
      graphicsPending=true;setText($('#interpolationStatus'),'画面暂时中断，正在恢复图形资源；保留最后画面。');ensureAnimation();
      // Keep the last displayed frame committed; retry the same proposal.
      transitionPending = !$('#originalToggle').checked && (poseProposal.moving || proposed.moving
        || Object.entries(proposed.frameState).some(([key,value])=>rendered?.state[key]!==value));
      return false;
    }
    if(graphicsPending){graphicsPending=false;setText($('#interpolationStatus'),'连续转头已恢复 · 可继续操作');}
    pendingSecondary=null;secondaryMotion=$('#originalToggle').checked?rebaseSecondaryMotion(poseProposal.headPose,{breath:0,sway:0,hair:0}):{...secondaryProposal.motion,current:{...(next.secondary||secondaryProposal.secondary)}};
    performanceMixer=performanceProposal.mixer;performanceMoving=performanceProposal.moving;idleBlinkMotion=blinkProposal.motion;
    rendered = next; previousState = selection.targetState;
    frameMotion = proposed.motion; poseMotion = poseProposal.motion; transitionPending = !$('#originalToggle').checked && (proposed.moving || poseProposal.moving);
    paintRecordingFrame();
    committedOutput={poseId:$('#originalToggle').checked?nearestStudioPoseId(next.headPose||poseMotion.current):poseId,
      coefficients:{...paintedCoefficients},state:{...rendered.state},faceOnly,original:$('#originalToggle').checked,
      headPose:{...(next.headPose||poseMotion.current)},transparent,secondary:{...secondaryMotion.current},composition:{...composition}};
    paintCompositionPreview();
    publishOutput();
    if(clipRecorder.recording){
      clipRecorder.capture({coefficients:{...paintedCoefficients},poseId,headPose:{...poseMotion.current},secondary:{...secondaryMotion.current}},now);
      if(!clipRecorder.recording){savedClip=clipRecorder.stop();syncClipControls('已记录60秒，片段已停止；可下载或重放。');}
    }
    if (measure) frameClock.recordFrame(now, performance.now() - started);
    if(turnReviewEnabled)document.dispatchEvent(new CustomEvent('studio-frame-painted',{detail:{headPose:{...poseMotion.current},target:{...poseMotion.target},at:performance.now(),costMs:performance.now()-started,moving:transitionPending}}));
    return true;
  } catch (error) { fail(error); return false; }
}
function fail(error) {
  ready = false; stopActive(); stopRecording();
  for (const id of ['#projectName','#openProject','#saveProject']) $(id).disabled = true;
  $('#studioControls').disabled = true; $('#loadStatus').hidden = false; $('#loadStatus').className = 'notice error';
  $('#loadStatus').textContent = `角色未能完整载入或绘制：${error?.message || '未知错误'}。请重新载入。`;
  $('#retryLoad').hidden = false; $('#stagePlaceholder').hidden = false; canvas.hidden = true;
}
function persistProject(includeCurrent = true) {
  project = createStudioProject({...project, name:$('#projectName').value, faceOnly,
    motionProfile, trackingSettings, transparent, composition, performancePresets, secondarySettings:{...secondarySettings,enabled:false},secondary:secondaryMotion.current,
    followHead:$('#followHead').checked, tourPoses:$('#tourPoses').checked,
    ...(includeCurrent ? {poseId, coefficients:committedOutput?.coefficients||coefficients,headPose:poseMotion.current} : {})});
  try { localStorage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(project)); $('#saveStatus').textContent = '已保存到本机'; $('#saveStatus').classList.remove('warning'); }
  catch { $('#saveStatus').textContent = '本机保存不可用，请下载项目'; $('#saveStatus').classList.add('warning'); }
}
function stopActive(message = '已暂停，可以继续手动搭配动作。', {preserveMotion = false, preserveClip = false, preserveSecondary = false} = {}) {
  const shouldStopCamera=camera.active||camera.starting;
  source = 'manual'; cancelCalibration();
  if(!preserveSecondary){idleBlinkEnabled=false;if(!preserveMotion){performanceMixer=freezePerformanceMixer(performanceMixer);performanceMoving=false;}syncPerformanceControls();}
  if(!preserveSecondary){pendingSecondary=null;secondaryRunning=false;secondaryMotion=freezeSecondaryMotion(secondaryMotion,poseMotion.current);syncSecondaryControls();}
  if (shouldStopCamera) camera.stop();
  clipPlayer.stop();clipFinished=false;pendingClipFrame=null;
  if(!preserveClip)finishClipRecording();
  cancelAnimationFrame(animationFrame); animationFrame = 0;
  session.clearTest(); transitionPending = false; if(!preserveMotion){frameMotion = createStudioMotion(rendered?.state || null);poseMotion=freezeStudioPoseMotion(poseMotion);} frameClock.reset();
  syncSourceControls(); motionMessage(message); syncFrameStats();syncTrackingStats();
  if (isAnimating()&&!document.hidden) ensureAnimation();
}
function setManual(next, {reset = true, message = '已应用动作，可以继续叠加其他部位。', persist = true} = {}) {
  stopActive(message,{preserveMotion:source==='manual',preserveClip:true,preserveSecondary:true}); ++revision; coefficients = sanitizeChannels(next);
  if (reset) previousState = {};
  $('#originalToggle').checked = false; paint(); syncControls(); syncFrameStats();
  if (isAnimating()) ensureAnimation();
  if (ready && persist) persistProject();
}
function choosePose(next) {
  if (!ready || !assets.poses.some(pose => pose.id === next)) return;
  stopActive('正在平滑转向，保留当前表情。',{preserveMotion:source==='manual'||source==='demo',preserveClip:true,preserveSecondary:true}); ++revision; poseId = next; previousState = {};poseStabilizer.reset();
  poseMotion=targetStudioPoseMotion(poseMotion,poseHeadCoordinates(next));
  $('#originalToggle').checked = false; paint(); syncControls(); syncFrameStats(); if (ready) persistProject();
  if(isAnimating())ensureAnimation();
}

function cancelCalibration() {
  if(calibrationBackup){session.neutral={...calibrationBackup.channels};neutralPose={...calibrationBackup.pose};session.samples=[];session.filter.reset();}
  calibrationBackup=null;calibrationUntil=0;calibrationQuality.active=false;
}
function beginCalibration() {
  if (!camera.active) return;
  cancelCalibration();calibrationBackup={channels:{...session.neutral},pose:{...neutralPose}};
  const now=performance.now();session.beginCalibration();calibrationQuality.begin(now);signalGate.reset(now);
  trackedPose={yaw:0,pitch:0};poseStabilizer.reset();trackingStatus='acquiring';
  calibrationUntil=now+3000;lastFaceAt=-Infinity;
  motionMessage('请保持正脸、眼睛自然睁开，放松嘴巴约 3 秒。');syncSourceControls();
}
function centerTrackedPose(pose) {
  return {yaw: Math.max(-1, Math.min(1, pose.x - neutralPose.x)), pitch: Math.max(-1, Math.min(1, -(pose.y - neutralPose.y)))};
}
function cameraFrame(now, dt) {
  try {
    const result=camera.poll(now),face=result?extractFaceMotion(result):null;
    if(face){
      const sampleTime=Number.isFinite(result.trackingSampleTimeMs)?Math.min(now,result.trackingSampleTimeMs):now;
      lastFaceAt=sampleTime;session.receive(result,sampleTime,calibrationUntil>0);signalGate.push(face.pose,sampleTime);
      if(calibrationUntil)calibrationQuality.add({pose:face.pose,channels:session.cameraFrame},sampleTime);
    }
  } catch {
    stopActive();motionMessage('面部识别已中断，摄像头已关闭；可重新开启，当前表情保留。',true);return;
  }
  if(calibrationUntil&&now>=calibrationUntil){
    const quality=calibrationQuality.finish(now);
    if(quality.ok){session.finishCalibration();neutralPose={...quality.neutralPose};calibrationBackup=null;calibrationUntil=0;}
    else cancelCalibration();
    trackingStatus=signalGate.snapshot(now).status;syncSourceControls();motionMessage(quality.message,!quality.ok);
  }
  const signal=signalGate.snapshot(now);
  if(signal.pose)trackedPose=centerTrackedPose(signal.pose);
  coefficients=sanitizeChannels(calibrationUntil?{}:session.update({},'camera',now,dt));
  if(!calibrationUntil&&$('#followHead').checked){
    const target=normalizeCameraHeadPose(signal.pose?trackedPose:{yaw:0,pitch:0});
    poseMotion=targetStudioPoseMotion(poseMotion,target);
    const next=nearestStudioPoseId(target);if(next!==poseId){poseId=next;previousState={};}
  }
  if(!calibrationUntil&&signal.status!==trackingStatus){
    if(signal.status==='lost')motionMessage('寻找面部中；请让脸保持在镜头范围内。');
    else if(signal.status==='tracking'&&['lost','recovering'].includes(trackingStatus))motionMessage('面部跟踪已恢复。');
    trackingStatus=signal.status;
  }
}
function tick(now) {
  animationFrame = 0;
  if (!ready || document.hidden || !isAnimating()) return;
  const frame = frameClock.advance(now);
  if (frame.render) {
    const wasAnimating = isAnimating();let playbackHead=null,playbackSecondary=null;
    if (source === 'demo') {
      const sample = sampleStudioDemo(now - demoStartedAt, demoBasePose, $('#tourPoses').checked);
      if (sample.poseId !== poseId) {poseId = sample.poseId; previousState = {};}
      poseMotion=targetStudioPoseMotion(poseMotion,poseHeadCoordinates(sample.poseId));
      coefficients = sample.coefficients;
      if (frame.updateUi) motionMessage(`正在演示：${sample.label}${$('#tourPoses').checked ? ' · 依次查看九个方向' : ' · 方向固定'}`);
    } else if (source === 'clip') {
      const sampled=clipPlayer.sample(now);if(sampled)pendingClipFrame=sampled;
      const sample=pendingClipFrame;
      if(sample){
        if(sample.poseId!==poseId){poseId=sample.poseId;previousState={};}
        playbackHead=sample.headPose||poseHeadCoordinates(sample.poseId);playbackSecondary=sample.secondary;
        coefficients=sample.coefficients;clipFinished=sample.done;
        if(frame.updateUi)setText($('#clipStatus'),`重放中 · ${(sample.elapsedMs/1000).toFixed(1)} / ${(sample.durationMs/1000).toFixed(1)} 秒`);
      }
    } else if (source === 'camera') {
      cameraFrame(now, frame.dt);
      if (source !== 'camera') {syncControls(); syncFrameStats(now); if(isAnimating())ensureAnimation(); return;}
    }
    if (!isAnimating()) {syncControls(); syncFrameStats(now); return;}
    const didPaint=paint({now, dt:frame.dt, hold:source==='manual'&&!transitionPending&&!performanceMoving&&!idleBlinkActive(), measure:wasAnimating,headPoseOverride:playbackHead,secondaryOverride:playbackSecondary});
    if(didPaint)pendingClipFrame=null;
    if(source==='clip'&&clipFinished&&didPaint&&!transitionPending){source='manual';clipPlayer.stop();clipFinished=false;pendingClipFrame=null;syncSourceControls();syncClipControls('动作片段重放完成。');}
    if (frame.updateUi || !isAnimating()) {
      syncControls(); syncFrameStats(now);
      syncTrackingStats(now);
      if(clipRecorder.recording)setText($('#clipStatus'),`正在记录系数 · ${(clipRecorder.durationMs/1000).toFixed(1)} 秒 · 最长60秒`);
      if (recorder?.state === 'recording') setText($('#recordStatus'), `录制中 · ${Math.floor((now-recordingStartedAt)/1000)} 秒 · 请求 ${frameClock.targetFps} fps · 不录制声音`);
    }
  }
  if (ready && isAnimating()) ensureAnimation();
  else {frameClock.reset(); syncFrameStats(now);if(source==='manual')persistProject();}
}
function ensureAnimation() {if (!animationFrame && ready && !document.hidden) animationFrame = requestAnimationFrame(tick);}
function toggleDemo() {
  if (!ready) return;
  if (source === 'demo') {stopActive(); syncControls(); return;}
  stopActive(undefined,{preserveSecondary:true}); ++revision; source = 'demo'; demoBasePose = poseId; demoStartedAt = performance.now(); frameClock.reset();
  $('#originalToggle').checked = false; syncSourceControls(); ensureAnimation();
}
async function toggleCamera() {
  if (!ready) return;
  if (camera.active || camera.starting) {stopActive('摄像头已关闭，当前表情保留。'); return;}
  stopActive(undefined,{preserveSecondary:true}); ++revision; source = 'camera-pending'; $('#originalToggle').checked = false;
  if (await camera.start()) {source = 'camera'; frameClock.reset(); beginCalibration(); ensureAnimation();}
  syncSourceControls();
}

function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function syncSecondaryControls(){
  setText($('#secondaryToggle'),secondaryRunning?'暂停微动':'开启微动');
  setAttribute($('#secondaryToggle'),'aria-pressed',String(secondaryRunning));
  $('#secondaryIntensity').value=String(secondarySettings.intensity);setText($('#secondaryIntensityValue'),`${Math.round(secondarySettings.intensity*100)}%`);
}
function toggleSecondary(){
  if(!ready)return;++revision;
  if(source==='clip')stopActive('片段已暂停，可开始自然微动。');
  secondaryRunning=!secondaryRunning&&secondarySettings.intensity>0;
  secondaryMotion=freezeSecondaryMotion(secondaryMotion,poseMotion.current);
  $('#originalToggle').checked=false;syncSecondaryControls();syncControls();syncFrameStats();if(!secondaryRunning)persistProject(source==='manual');
  if(secondaryRunning)ensureAnimation();
}
function paintCompositionPreview(){if(ready&&committedOutput)drawOutputFrame($('#outputPreview'),canvas,{transparent:committedOutput.transparent,composition});}
function syncCompositionControls(){
  for(const [key,id] of [['scale','Scale'],['x','X'],['y','Y']]){
    $('#output'+id).value=String(composition[key]);setText($('#output'+id+'Value'),key==='scale'?`${composition[key].toFixed(2)}×`:composition[key].toFixed(2));
  }
  $('#outputMirror').checked=composition.mirror;
}
function changeComposition(next){
  ++revision;composition=normalizeOutputComposition(next);syncCompositionControls();paintCompositionPreview();
  if(committedOutput)committedOutput={...committedOutput,composition:{...composition}};
  publishOutput();persistProject(source==='manual');
}
function syncPreferenceControls() {
  syncSecondaryControls();syncCompositionControls();
  syncPerformanceControls();
  $('#motionProfile').value=motionProfile;$('#trackingPreset').value=trackingSettings.preset;
  $('#eyeSensitivity').value=String(trackingSettings.eyeSensitivity);$('#mouthSensitivity').value=String(trackingSettings.mouthSensitivity);
  setText($('#eyeSensitivityValue'),`${trackingSettings.eyeSensitivity.toFixed(2)}×`);
  setText($('#mouthSensitivityValue'),`${trackingSettings.mouthSensitivity.toFixed(2)}×`);
  for(const key of ['eyeInputMax','mouthInputMax']){$('#'+key).value=String(trackingSettings[key]);setText($('#'+key+'Value'),Number(trackingSettings[key]).toFixed(2));}
}
function applyTrackingSettings(persist=true) {
  session.setSettings(createFaceSessionSettings(trackingSettings));poseStabilizer.setSettings(trackingSettings);
  syncPreferenceControls();if(persist)persistProject(source==='manual');
}
function syncTrackingStats(now=performance.now()) {
  if(source!=='camera'){setText($('#trackingStats'),'摄像头关闭 · 未测量识别速度');return;}
  const metrics=camera.getMetrics(now),rate=metrics.inferenceFps===null?'正在测量':`${metrics.inferenceFps.toFixed(1)} 次/秒`;
  const cost=metrics.meanInferenceMs===null?'':` · 识别平均 ${metrics.meanInferenceMs.toFixed(1)} ms`;
  setText($('#trackingStats'),`${metrics.signalStale?'未找到新的人脸信号':'人脸信号正常'} · ${rate}${cost}${metrics.inferenceBudgetFps?' · 预算 '+metrics.inferenceBudgetFps+' Hz':''}${metrics.inferenceMode==='worker'?' · 后台识别':metrics.inferenceMode==='main-thread'?' · 主线程识别':''}${Number.isFinite(metrics.resultLatencyMs)?' · 结果延迟 '+metrics.resultLatencyMs.toFixed(0)+' ms':''}`);
}
function syncClipControls(message) {
  $('#recordClip').textContent=clipRecorder.recording?'停止记录':'记录动作片段';
  $('#recordClip').setAttribute('aria-pressed',String(clipRecorder.recording));
  $('#playClip').disabled=!savedClip||clipRecorder.recording;
  $('#saveClip').disabled=!savedClip||clipRecorder.recording;
  if(message)setText($('#clipStatus'),message);
}
function finishClipRecording() {
  if(!clipRecorder.recording)return;
  savedClip=clipRecorder.stop(performance.now());
  syncClipControls(savedClip?`已记录 ${(savedClip.durationMs/1000).toFixed(1)} 秒，可重放或下载。`:'没有可用的动作片段。');
}
function toggleClipRecording() {
  if(!ready)return;
  if(clipRecorder.recording){finishClipRecording();return;}
  ++revision;++clipReadRequest;
  if(source==='clip')stopActive();
  savedClip=null;const now=performance.now();clipRecorder.start(now);
  clipRecorder.capture({coefficients:{...(committedOutput?.coefficients||coefficients)},poseId,headPose:{...poseMotion.current},secondary:{...secondaryMotion.current}},now);
  syncClipControls('正在记录动作系数；可操作表情，或记录正在运行的演示/跟踪。');ensureAnimation();
}
function playClip() {
  if(!ready||!savedClip)return;
  stopActive('正在重放动作片段；摄像头保持关闭。');++revision;
  performanceMixer=createPerformanceMixer();performanceMoving=false;syncPerformanceControls();
  clipPlayer.start(savedClip,performance.now());source='clip';clipFinished=false;$('#originalToggle').checked=false;
  frameMotion=createStudioMotion(rendered?.state||null);frameClock.reset();syncSourceControls();ensureAnimation();
}
async function openClipFile() {
  const file=$('#clipFile').files?.[0];if(!file)return;
  const request=++clipReadRequest,expectedRevision=revision;
  try {
    if(file.size>TRACKING_CLIP_LIMITS.maxBytes)throw new Error('动作片段不能超过2 MB。');
    const clip=parseTrackingClip(await file.text());
    if(request!==clipReadRequest||expectedRevision!==revision)return;
    stopActive('动作片段已打开，点击重放开始。');savedClip=clip;
    syncClipControls(`已打开 ${(clip.durationMs/1000).toFixed(1)} 秒的动作片段。`);
  }catch(error){if(request===clipReadRequest&&expectedRevision===revision)setText($('#clipStatus'),`未打开：${error.message}`);}
  finally{$('#clipFile').value='';}
}
function publishOutput() {
  if(!publisher.enabled||!ready||!committedOutput)return;
  publisher.publish({...committedOutput,coefficients:{...committedOutput.coefficients},state:{...committedOutput.state},headPose:{...committedOutput.headPose},secondary:{...committedOutput.secondary},composition:{...committedOutput.composition}});
}
function toggleOutput() {
  if($('#outputToggle').checked&&ready){
    publisher.start();publishOutput();
    if(!outputHeartbeat)outputHeartbeat=setInterval(publishOutput,1000);
  }else{
    if(outputHeartbeat)clearInterval(outputHeartbeat);outputHeartbeat=0;
    void publisher.stop();setText($('#outputStatus'),'直播画面已停止。');
  }
}
async function copyOutputUrl() {
  try{await navigator.clipboard.writeText($('#outputUrl').value);setText($('#outputStatus'),'已复制；粘贴到 OBS 的浏览器源 URL。');}
  catch{$('#outputUrl').select();setText($('#outputStatus'),'请复制已选中的地址。');}
}
function exportFrame() {
  stopActive(); paint({hold:true}); syncControls(); if (!ready) return;
  const payload = {schemaVersion:3, kind:'moemotion-short-hair-frame', characterId:'short-hair-v1', poseId:committedOutput.poseId,headPose:{...committedOutput.headPose},secondary:{...committedOutput.secondary},
    coefficients:{...committedOutput.coefficients}, supportedChannels:STUDIO_CHANNELS.map(channel => channel.key),
    renderedState:rendered.state, renderedGaze:rendered.gaze, targetState:rendered.targetState, targetGaze:rendered.targetGaze,
    preview:{faceOnly, original:$('#originalToggle').checked,transparent}, source:'manual', exportedAt:new Date().toISOString()};
  download(new Blob([JSON.stringify(payload,null,2)], {type:'application/json'}), `short-hair-frame-${stamp()}.json`);
  $('#importStatus').textContent = '已导出当前单帧，包含原始系数与实际显示状态。';
}
function savePng() {
  stopActive(); paint({hold:true}); syncControls(); if (!ready) return;
  const filename = `short-hair-${poseId}-${stamp()}.png`;
  try {canvas.toBlob(blob => {if (blob) download(blob, filename); else motionMessage('PNG 导出失败，请重试。',true);}, 'image/png');}
  catch {motionMessage('PNG 导出失败，请重试。',true);}
}
function saveProject() {
  stopActive(); paint({hold:true}); syncControls(); if (!ready) return; persistProject();
  download(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}), `short-hair-project-${stamp()}.json`);
}
function applyFrame(text) {
  try {
    const frame = parseStudioFrame(text);
    if(frame.headPose){stopActive();poseMotion=createStudioPoseMotion(frame.headPose);poseId=frame.poseId;}
    if(frame.secondary){stopActive();secondaryMotion=rebaseSecondaryMotion(poseMotion.current,frame.secondary);}
    if(frame.transparent!==undefined){transparent=frame.transparent;$('#transparentToggle').checked=transparent;}
    setManual(frame.coefficients, {message:'已应用导入系数。'}); if (!ready) return;
    $('#importStatus').textContent = `已应用 22 通道；未提供值设为 0。${frame.ignored.length ? `已忽略：${frame.ignored.join('、')}。` : ''}`;
    $('#importStatus').classList.toggle('warning', frame.ignored.length > 0);
  } catch(error) {$('#importStatus').textContent = `未应用：${error.message}`; $('#importStatus').classList.add('warning');}
}
function restoreProject(next, persist = false) {
  stopActive('项目已打开，摄像头保持关闭。'); stopRecording(); ++revision; project = next;
  performancePresets=project.performancePresets.map(preset=>({...preset}));performanceMixer=createPerformanceMixer();performanceMoving=false;idleBlinkEnabled=false;idleBlinkMotion=createIdleBlink();buildPerformanceControls();
  poseId = project.poseId; poseMotion=createStudioPoseMotion(project.headPose||poseHeadCoordinates(poseId));
  transparent=project.transparent!==false;$('#transparentToggle').checked=transparent; coefficients = sanitizeChannels(project.coefficients); faceOnly = project.faceOnly; previousState = {};
  composition=normalizeOutputComposition(project.composition);secondarySettings=normalizeSecondarySettings(project.secondarySettings);secondaryRunning=false;secondaryMotion=rebaseSecondaryMotion(poseMotion.current,project.secondary||{breath:0,sway:0,hair:0});
  motionProfile=project.motionProfile || 'natural';trackingSettings=normalizeTrackingSettings(project.trackingSettings);applyTrackingSettings(false);syncPreferenceControls();
  $('#projectName').value = project.name; $('#followHead').checked = project.followHead; $('#tourPoses').checked = project.tourPoses;
  $('#originalToggle').checked = false; paint({snap:true}); syncControls(); syncFrameStats(); if (persist && ready) persistProject();
}
async function readInputFile(input, kind) {
  const file = input.files?.[0]; if (!file) return;
  const requestRevision = ++revision;
  try {
    if (file.size > 65536) throw new Error('文件不能超过 64 KB。');
    const text = await file.text(); if (requestRevision !== revision) return;
    if (kind === 'project') restoreProject(parseStudioProject(text), true); else applyFrame(text);
  } catch(error) {
    if (requestRevision !== revision) return;
    if (kind === 'project') motionMessage(`未打开项目：${error.message}`, true);
    else {$('#importStatus').textContent = `未应用：${error.message}`; $('#importStatus').classList.add('warning');}
  } finally {input.value = '';}
}

function paintRecordingFrame() {
  if (!recordingCanvas) return;
  const context = recordingCanvas.getContext('2d'), scale = Math.min(recordingCanvas.width / canvas.width, recordingCanvas.height / canvas.height);
  const width = canvas.width * scale, height = canvas.height * scale;
  context.fillStyle = '#bfc6d3'; context.fillRect(0,0,recordingCanvas.width,recordingCanvas.height);
  context.drawImage(canvas,(recordingCanvas.width-width)/2,(recordingCanvas.height-height)/2,width,height);
}
function startRecording() {
  if (!ready || recorder) return;
  if (typeof MediaRecorder !== 'function' || typeof canvas.captureStream !== 'function') {
    $('#recordStatus').textContent = '当前浏览器不支持录像，仍可保存 PNG。'; return;
  }
  try {
    const types = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm','video/mp4'];
    const mimeType = types.find(type => MediaRecorder.isTypeSupported(type));
    recordingCanvas = document.createElement('canvas'); recordingCanvas.width = canvas.width; recordingCanvas.height = canvas.height;
    paintRecordingFrame(); recordingStream = recordingCanvas.captureStream(frameClock.targetFps);
    const localStream = recordingStream, localRecorder = new MediaRecorder(localStream, mimeType ? {mimeType} : undefined), chunks = [];
    let failed = false;
    recorder = localRecorder; recordingStartedAt = performance.now();
    localRecorder.ondataavailable = event => {if (event.data.size) chunks.push(event.data);};
    localRecorder.onerror = () => {failed = true; if (recorder === localRecorder) {$('#recordStatus').textContent = '录像发生错误，请重试或保存 PNG。'; stopRecording();}};
    localRecorder.onstop = () => {
      localStream.getTracks().forEach(track => track.stop());
      if (recorder !== localRecorder) return;
      recordingStream = null; recordingCanvas = null; recorder = null;
      $('#recordButton').textContent = '录制动画'; $('#recordButton').setAttribute('aria-pressed','false');
      for (const button of controls.views) button.disabled = false;
      $('#renderRate').disabled = false;
      if (failed) $('#recordStatus').textContent = '录像发生错误，未保存可能损坏的文件；请重试或保存 PNG。';
      else if (chunks.length) {
        const type = localRecorder.mimeType || chunks[0].type || 'video/webm';
        download(new Blob(chunks,{type}), `short-hair-${stamp()}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
        $('#recordStatus').textContent = '录像已准备下载；可以继续使用角色。';
      } else $('#recordStatus').textContent = '没有录到有效画面，请重试。';
      if (!isAnimating()) {cancelAnimationFrame(animationFrame); animationFrame = 0; frameClock.reset(); syncFrameStats();}
    };
    localRecorder.start(1000);
    $('#recordButton').textContent = '停止并保存'; $('#recordButton').setAttribute('aria-pressed','true');
    for (const button of controls.views) button.disabled = true;
    $('#renderRate').disabled = true; frameClock.reset();
    ensureAnimation();
  } catch(error) {
    recordingStream?.getTracks().forEach(track => track.stop()); recordingStream = null; recordingCanvas = null; recorder = null;
    $('#renderRate').disabled = false;
    $('#recordStatus').textContent = '浏览器未能开始录像，仍可保存 PNG。';
  }
}
function stopRecording() {
  if (recorder?.state === 'recording') recorder.stop();
  if (!isAnimating()) {cancelAnimationFrame(animationFrame); animationFrame = 0; frameClock.reset(); syncFrameStats();}
}

async function exportLayers(){
  if(!ready)return;const selectedPose=nearestStudioPoseId(poseMotion.current);
  $('#exportLayers').disabled=true;setText($('#layerStatus'),'正在整理透明图层…');
  try{const result=await exportShortHairLayers(assets,selectedPose,$('#originalToggle').checked?{}:committedOutput?.coefficients||coefficients,{state:rendered?.state});
    download(result.blob,result.filename);setText($('#layerStatus'),result.hasFringe?`已导出 ${selectedPose} 的脸部补画候选、前发、其余头发、修正层和绑定；ZIP 内含原位重组说明。`:`已导出 ${selectedPose} 原画方向的可见图层；此方向尚无前发补画分解。`);
  }catch(error){setText($('#layerStatus'),`未导出：${error.message}`);}
  finally{$('#exportLayers').disabled=false;}
}

function showInspectedLayer(){
  if(!layerInspection)return;
  const key=$('#layerSelect').value,layer=layerInspection.layers[key];if(!layer)return;
  const target=$('#layerPreview');target.width=layer.width;target.height=layer.height;
  target.getContext('2d').drawImage(layer,0,0);
  $('#layerPreviewPanel').hidden=false;
  const description=layerInspection.descriptors[key]?.description;
  setText($('#layerPreviewStatus'),`${layerInspection.poseId} · ${$('#layerSelect').selectedOptions[0].textContent} · ${layer.width}×${layer.height} · 检查时的画面快照${description?'。'+description:''}`);
}
function inspectLayers(){
  if(!ready)return;
  try{layerInspection=createShortHairLayerInspection(assets,nearestStudioPoseId(poseMotion.current),$('#originalToggle').checked?{}:committedOutput?.coefficients||coefficients,{state:rendered?.state});
    const selected=$('#layerSelect').value,labels={character:'透明角色',head:'头部可见层',torso:'躯干可见层',eyeLeft:'角色左眼',eyeRight:'角色右眼',browLeft:'角色左眉',browRight:'角色右眉',mouth:'嘴部'};
    $('#layerSelect').replaceChildren(...Object.keys(layerInspection.layers).map(key=>{const option=document.createElement('option');option.value=key;option.textContent=layerInspection.descriptors[key]?.label||labels[key]||key;return option;}));
    $('#layerSelect').value=Object.hasOwn(layerInspection.layers,selected)?selected:'character';showInspectedLayer();
    setText($('#layerStatus'),layerInspection.fringe?'已生成当前方向的透明分层快照；补画与头发归属仍为派生候选，可切换图层核验后导出。':'已生成可见图层快照；此方向尚无已登记的前发补画分解。');
  }
  catch(error){setText($('#layerStatus'),`图层检查未完成：${error.message}`);}
}
function syncPerformanceControls(){
  for(const button of performanceButtons)setAttribute(button,'aria-pressed',String(isPerformancePresetActive(performanceMixer,button.dataset.performance)));
  $('#idleBlinkToggle').checked=idleBlinkEnabled;
}
function buildPerformanceControls(){
  performanceButtons=[];
  $('#performancePresets').replaceChildren(...performancePresets.map((preset,index)=>{
    const row=document.createElement('div');row.className='performance-card';
    const button=document.createElement('button');button.type='button';button.dataset.performance=preset.id;
    button.textContent=`${index+1} · ${preset.name}`;button.setAttribute('aria-pressed','false');button.addEventListener('click',()=>togglePerformance(index));performanceButtons.push(button);
    const remove=document.createElement('button');remove.type='button';remove.textContent='移除';remove.setAttribute('aria-label',`移除表情 ${preset.name}`);
    remove.addEventListener('click',()=>{++revision;performanceMixer=setPerformancePreset(performanceMixer,preset,false);performanceMoving=true;performancePresets=performancePresets.filter(item=>item.id!==preset.id);buildPerformanceControls();persistProject(false);ensureAnimation();});
    row.append(button,remove);return row;
  }));syncPerformanceControls();
}
function togglePerformance(index){
  const preset=performancePresets[index];if(!ready||!preset)return;
  if(source==='clip'){setText($('#performanceStatus'),'请先暂停片段，再叠加表情。');return;}
  try { performanceMixer=setPerformancePreset(performanceMixer,preset); }
  catch(error){setText($('#performanceStatus'),`暂未切换：${error.message}`);return;}
  ++revision;performanceMoving=true;
  $('#originalToggle').checked=false;paint();syncPerformanceControls();syncControls();ensureAnimation();
  setText($('#performanceStatus'),`${preset.name}已${isPerformancePresetActive(performanceMixer,preset.id)?'叠加':'取消'}；当前动作来源继续运行。`);
}
function clearPerformance(){
  if(!ready)return;++revision;performanceMixer=clearPerformancePresets(performanceMixer);performanceMoving=performanceMixer.entries.length>0;
  paint();syncPerformanceControls();if(isAnimating())ensureAnimation();setText($('#performanceStatus'),'正在取消叠加表情，回到当前输入。');
}
function savePerformancePreset(){
  if(!ready)return;
  try{
    if(performancePresets.length>=PERFORMANCE_PRESET_LIMIT)throw new Error('最多保存 8 个预设，请先移除不需要的预设。');
    const groups=['eyes','mouth','brows','gaze'].filter(group=>$('#capture-'+group).checked);
    const preset=createPerformancePreset({id:`saved-${Date.now()}-${revision++}`,name:$('#performanceName').value,groups,channels:committedOutput?.coefficients||coefficients});
    performancePresets=[...performancePresets,preset];buildPerformanceControls();persistProject(false);setText($('#performanceStatus'),`已保存“${preset.name}”，只覆盖选中的部位。`);
  }catch(error){setText($('#performanceStatus'),`未保存：${error.message}`);}
}
function toggleIdleBlink(){
  if(!ready)return;++revision;idleBlinkEnabled=$('#idleBlinkToggle').checked;
  if(idleBlinkEnabled){idleBlinkMotion=createIdleBlink(Date.now()>>>0);$('#originalToggle').checked=false;}
  else {frameMotion=createStudioMotion(rendered?.state||null);paint();}
  syncPerformanceControls();syncControls();syncFrameStats();if(isAnimating())ensureAnimation();
}
function buildControls() {
  $('#poseButtons').replaceChildren(...assets.poses.map(pose => {
    const button = document.createElement('button'); button.type='button'; button.dataset.pose=pose.id; button.textContent=pose.shortLabel;
    button.setAttribute('aria-label', pose.label); button.addEventListener('click',()=>choosePose(pose.id)); return button;
  }));
  const groupLabels = {eyes:'眼睛',mouth:'嘴巴',brows:'眉毛'};
  $('#quickActions').replaceChildren(...Object.entries(groupLabels).map(([group,label]) => {
    const section=document.createElement('div'); section.className='action-group';
    const heading=document.createElement('h3'); heading.textContent=label;
    const buttons=document.createElement('div'); buttons.className='action-buttons'; buttons.setAttribute('role','group'); buttons.setAttribute('aria-label',`${label}动作`);
    for (const preset of STUDIO_PRESETS.filter(item=>item.group===group)) {
      const button=document.createElement('button'); button.type='button'; button.dataset.action=preset.id; button.textContent=preset.label;
      button.addEventListener('click',()=>setManual(applyStudioPreset(coefficients,preset.id))); buttons.append(button);
    }
    section.append(heading,buttons); return section;
  }));
  const arrows=['↖','↑','↗','←','居中','→','↙','↓','↘'], names=['左上','上方','右上','左方','居中','右方','左下','下方','右下'];
  $('#gazeButtons').replaceChildren(...arrows.map((label,index)=>{
    const x=(index%3-1)*.75,y=(Math.floor(index/3)-1)*.75,button=document.createElement('button');
    button.type='button';button.textContent=label;button.dataset.gazeX=String(x);button.dataset.gazeY=String(y);
    button.setAttribute('aria-label',`看画面${names[index]}`);button.addEventListener('click',()=>setManual({...coefficients,...gazeChannels(x,y)}));return button;
  }));
  $('#channelSliders').replaceChildren(...STUDIO_CHANNELS.map(channel=>{
    const label=document.createElement('label');label.className='channel-control';
    const title=document.createElement('span'),copy=document.createElement('span');copy.dataset.channelLabel=channel.key;copy.textContent=channel.label;
    const output=document.createElement('output');output.textContent='0.00';title.append(copy,output);
    const code=document.createElement('code');code.textContent=channel.key;
    const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max='1';slider.step='.01';slider.value='0';slider.dataset.channel=channel.key;slider.studioOutput=output;slider.id=`studio-${channel.key}`;output.htmlFor=slider.id;
    slider.addEventListener('input',()=>setManual({...coefficients,[channel.key]:Number(slider.value)},{reset:false}));
    label.append(title,code,slider);return label;
  }));
  controls = {poses:Array.from(document.querySelectorAll('[data-pose]')), sliders:Array.from(document.querySelectorAll('[data-channel]')),
    labels:Array.from(document.querySelectorAll('[data-channel-label]')), actions:Array.from(document.querySelectorAll('[data-action]')),
    gaze:Array.from(document.querySelectorAll('[data-gaze-x]')), views:controls.views};
  const candidates=assets.poses.filter(pose=>pose.assetStatus!=='approved');
  $('#assetSummary').textContent=candidates.length
    ? `当前九个方向已接入；${candidates.map(pose=>pose.shortLabel).join('、')}的最新画稿仍待视觉验收，工作台不会自动将它们标记为通过。`
    : '当前九个方向的画稿均已有确认记录；新的整合行为仍需实际使用检查。';
  const stageCounts=assets.poses.map(pose=>{
    const {availableSequences}=selectShortHairStudioState(assets,pose.id,{},{});
    return [availableSequences.eyeLeft.length,availableSequences.eyeRight.length,availableSequences.mouth.length];
  });
  const allFive=stageCounts.every(counts=>counts.every(count=>count===5));
  $('#frameArtSummary').textContent=`${allFive ? '九个方向的眨眼与张嘴均有五档画稿' : '眨眼与张嘴按各方向实际准备的画稿'}，动作逐张切换。转头在九个原画锚点之间连续变化；噘嘴、抿嘴和移嘴分别使用独立画稿。正面抬眉使用整眉近似，抿嘴为整嘴动作；暂未提供噘嘴与移嘴同时发生的复合稿。`;
}
async function loadAssets() {
  const request=++loadRequest; ready=false; $('#studioControls').disabled=true; $('#loadStatus').hidden=false;
  for (const id of ['#projectName','#openProject','#saveProject']) $(id).disabled = true;
  $('#loadStatus').className='notice';$('#loadStatus').textContent='正在准备九个方向的角色画稿…';$('#retryLoad').hidden=true;
  let loaded;
  try {
    loaded=await loadContinuousShortHairAssets();if(request!==loadRequest){loaded.flowRenderer.dispose();loaded.fringeRenderer?.dispose();return;}
    const pack=await loadShortHairCharacterPack();if(request!==loadRequest){loaded.flowRenderer.dispose();loaded.fringeRenderer?.dispose();return;}
    const coverage=summarizeShortHairCharacterPack(pack.pack,loaded);characterPack=pack;
    assets?.flowRenderer?.dispose();assets?.fringeRenderer?.dispose();assets=loaded;buildControls();ready=true;
    setText($('#interpolationStatus'),'连续转头已就绪 · 拖动滑块可停在任意中间角度');
    setText($('#packSummary'),`${coverage.poseCount} 个方向 · ${coverage.artworkFileCount} 张采用画稿 · 9 组透明遮罩 · 16 组转头运动场`);
    setText($('#assetSummary'),'九方向已接入；抬头、低头、右下的基础稿和八个非正面方向的新增中间稿仍保持候选状态，具体批准范围见素材清单。');
    $('#assetCoverage').replaceChildren(...coverage.poses.map(pose=>{
      const row=document.createElement('tr');
      for(const value of [pose.label,`${pose.eyeStages} / ${pose.jawStages}`,String(pose.specialMouths.length),`${pose.browStates.length}`,pose.extensionStatus==='candidate'||pose.baseStatus==='candidate'?'含待确认画稿':'已有对应批准记录']){
        const cell=document.createElement('td');cell.textContent=value;row.append(cell);
      }return row;
    }));
    restoreProject(project);if(!ready)return;$('#studioControls').disabled=false;$('#loadStatus').hidden=true;$('#stagePlaceholder').hidden=true;canvas.hidden=false;
    for (const id of ['#projectName','#openProject','#saveProject']) $(id).disabled = false;
    motionMessage('选择方向，搭配眼睛、嘴巴和眉毛；摄像头尚未开启。');
  }catch(error){if(loaded&&loaded!==assets){loaded.flowRenderer.dispose();loaded.fringeRenderer?.dispose();}if(request===loadRequest)fail(error);}
}

function init() {
  try {const saved=localStorage.getItem(STUDIO_STORAGE_KEY);if(saved) {project=parseStudioProject(saved);$('#saveStatus').textContent='已恢复本机项目';}}
  catch {$('#saveStatus').textContent='旧项目无法读取，已打开默认角色';}
  $('#manualButton').addEventListener('click',()=>{stopActive();syncControls();});
  $('#demoButton').addEventListener('click',toggleDemo);$('#cameraButton').addEventListener('click',toggleCamera);
  $('#stopCamera').addEventListener('click',()=>stopActive('摄像头已关闭，当前表情保留。'));$('#calibrateButton').addEventListener('click',beginCalibration);
  $('#resetExpression').addEventListener('click',()=>setManual({},{message:'所有表情已放松，方向保持不变。'}));
  $('#originalToggle').addEventListener('change',()=>{stopActive();paint({snap:true});syncControls();});
  $('#transparentToggle').addEventListener('change',()=>{++revision;transparent=$('#transparentToggle').checked;paint({hold:true});persistProject(source==='manual');});
  for(const [axis,id] of [['yaw','Yaw'],['pitch','Pitch']])$('#head'+id).addEventListener('input',()=>{
    stopActive('正在连续调整头部角度。',{preserveMotion:true,preserveClip:true,preserveSecondary:true});++revision;
    poseMotion=targetStudioPoseMotion(poseMotion,{...poseMotion.target,[axis]:Number($('#head'+id).value)});
    poseId=nearestStudioPoseId(poseMotion.target);$('#originalToggle').checked=false;paint();syncControls();
    if(isAnimating())ensureAnimation();persistProject();
  });
  for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>{faceOnly=button.dataset.view==='face';paint({snap:source==='manual'});syncControls();persistProject(source==='manual');});
  $('#projectName').addEventListener('input',()=>persistProject(false));
  for(const id of ['#followHead','#tourPoses'])$(id).addEventListener('change',()=>persistProject(false));
  $('#savePng').addEventListener('click',savePng);$('#saveProject').addEventListener('click',saveProject);$('#exportFrame').addEventListener('click',exportFrame);
  $('#openProject').addEventListener('click',()=>{if(ready){$('#projectFile').value='';$('#projectFile').click();}});
  $('#projectFile').addEventListener('change',()=>readInputFile($('#projectFile'),'project'));
  $('#openFrame').addEventListener('click',()=>{$('#frameFile').value='';$('#frameFile').click();});
  $('#frameFile').addEventListener('change',()=>readInputFile($('#frameFile'),'frame'));
  $('#applyFrame').addEventListener('click',()=>applyFrame($('#frameJson').value));
  $('#recordButton').addEventListener('click',()=>recorder?stopRecording():startRecording());
  $('#renderRate').value=String(frameClock.targetFps);
  $('#renderRate').addEventListener('change',()=>{
    if(recorder){$('#renderRate').value=String(frameClock.targetFps);return;}
    const target=Number($('#renderRate').value);
    if(target!==30&&target!==60){$('#renderRate').value=String(frameClock.targetFps);return;}
    frameClock.setTargetFps(target);syncFrameStats();
  });
  $('#motionProfile').addEventListener('change',()=>{
    ++revision;motionProfile=$('#motionProfile').value==='quick'?'quick':'natural';persistProject(source==='manual');
  });
  for(const id of ['#trackingPreset','#eyeSensitivity','#mouthSensitivity','#eyeInputMax','#mouthInputMax'])$(id).addEventListener('change',()=>{
    ++revision;
    trackingSettings=normalizeTrackingSettings({preset:$('#trackingPreset').value,eyeSensitivity:Number($('#eyeSensitivity').value),mouthSensitivity:Number($('#mouthSensitivity').value),eyeInputMax:Number($('#eyeInputMax').value),mouthInputMax:Number($('#mouthInputMax').value)});
    applyTrackingSettings();
  });
  $('#resetTracking').addEventListener('click',()=>{trackingSettings=normalizeTrackingSettings();applyTrackingSettings();if(camera.active)beginCalibration();});
  $('#recordClip').addEventListener('click',toggleClipRecording);$('#playClip').addEventListener('click',playClip);
  $('#saveClip').addEventListener('click',()=>{if(savedClip)download(new Blob([JSON.stringify(savedClip)],{type:'application/json'}),`short-hair-motion-${stamp()}.json`);});
  $('#openClip').addEventListener('click',()=>{$('#clipFile').value='';$('#clipFile').click();});$('#clipFile').addEventListener('change',openClipFile);
  $('#outputUrl').value=`${window.location?.origin||''}/short-hair-output.html`;
  $('#openOutput').href=$('#outputUrl').value;
  $('#copyOutput').addEventListener('click',copyOutputUrl);$('#outputToggle').addEventListener('change',toggleOutput);
  $('#secondaryToggle').addEventListener('click',toggleSecondary);
  $('#secondaryIntensity').addEventListener('input',()=>{++revision;secondarySettings=normalizeSecondarySettings({intensity:Number($('#secondaryIntensity').value)});if(secondarySettings.intensity===0){secondaryRunning=false;pendingSecondary={breath:0,sway:0,hair:0};paint({hold:true});}syncSecondaryControls();persistProject(source==='manual');});
  for(const [key,id] of [['scale','Scale'],['x','X'],['y','Y']])$('#output'+id).addEventListener('input',()=>changeComposition({...composition,[key]:Number($('#output'+id).value)}));
  $('#outputMirror').addEventListener('change',()=>changeComposition({...composition,mirror:$('#outputMirror').checked}));
  $('#resetComposition').addEventListener('click',()=>changeComposition({}));
  $('#inspectLayers').addEventListener('click',inspectLayers);$('#layerSelect').addEventListener('change',showInspectedLayer);
  $('#exportLayers').addEventListener('click',exportLayers);
  $('#exportPack').addEventListener('click',()=>{if(characterPack)download(new Blob([JSON.stringify({schemaVersion:2,kind:'short-hair-runtime-material-index',version:'0.20.1',artworkInventory:characterPack.pack,derivedAlpha:assets.alpha.manifest,derivedMotion:assets.motionFields.manifest,derivedFringe:assets.fringe.manifest,note:'原画登记描述原稿本身；透明与连续转头能力由独立派生素材提供，不改变原画批准记录。'},null,2)],{type:'application/json'}),'short-hair-runtime-materials.json');});
  syncPreferenceControls();syncClipControls();syncTrackingStats();
  $('#savePerformance').addEventListener('click',savePerformancePreset);$('#clearPerformance').addEventListener('click',clearPerformance);
  $('#idleBlinkToggle').addEventListener('change',toggleIdleBlink);
  document.addEventListener('keydown',event=>{if(!ready)return;const action=matchPerformanceShortcut(event,{hidden:document.hidden,focused:document.hasFocus?.()!==false});if(action===null||typeof action==='number'&&!performancePresets[action])return;event.preventDefault();if(action==='clear')clearPerformance();else togglePerformance(action);});
  $('#retryLoad').addEventListener('click',loadAssets);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopActive('页面已隐藏，摄像头和演示已暂停。');stopRecording();}else if(graphicsPending)ensureAnimation();});
  window.addEventListener('pagehide',()=>{++loadRequest;ready=false;stopActive();stopRecording();camera.dispose();assets?.flowRenderer?.dispose();assets?.fringeRenderer?.dispose();if(outputHeartbeat)clearInterval(outputHeartbeat);void publisher.stop();});
  loadAssets();
}
init();
