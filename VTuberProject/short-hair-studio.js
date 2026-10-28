import {loadShortHairStudioAssets, renderShortHairStudio, selectShortHairStudioState} from './short-hair-studio-renderer.js';
import {STUDIO_CHANNELS, STUDIO_STORAGE_KEY, STUDIO_PRESETS, createStudioProject, parseStudioProject,
  parseStudioFrame, applyStudioPreset, gazeChannels, selectStudioPose, sampleStudioDemo} from './short-hair-studio-model.js';
import {sanitizeChannels} from './expression-model.js';
import {FaceSession} from './face-session.js';
import {extractFaceMotion} from './motion.js';
import {ShortHairStudioCamera} from './short-hair-studio-camera.js';
import {STUDIO_RENDER_FPS, StudioFrameClock, createStudioMotion, advanceStudioMotion} from './short-hair-studio-timing.js';

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
let calibrationUntil = 0, poseSamples = [], neutralPose = {x:0,y:0}, lastFaceAt = -Infinity, trackedPose = {yaw:0,pitch:0};
let recorder = null, recordingStream = null, recordingCanvas = null, recordingStartedAt = 0;
const camera = new ShortHairStudioCamera($('#cameraVideo'), {onState(event) {
  if (event.status === 'stopped' || event.status === 'error') {
    if (source === 'camera' || source === 'camera-pending') {
      source = 'manual'; transitionPending = false; frameMotion = createStudioMotion(rendered?.state || null); frameClock.reset();
      cancelAnimationFrame(animationFrame); animationFrame = 0;
      if (recorder?.state === 'recording') ensureAnimation();
      syncFrameStats();
    }
    calibrationUntil = 0;
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
  $('#sourceBadge').textContent = source === 'demo' ? '自动演示' : source === 'camera' ? '面部跟踪' : source === 'camera-pending' ? '连接中' : '手动 · 静止';
}
function syncControls() {
  setText($('#sourceBadge'), source === 'demo' ? '自动演示' : source === 'camera' ? '面部跟踪' : source === 'camera-pending' ? '连接中' : transitionPending ? '手动 · 逐稿动作' : '手动 · 静止');
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
  setText($('#poseTitle'), poseMeta()?.label || '正面');
  setText($('#stateReadout'), `${poseMeta()?.label || poseId}\n${frameDescription(rendered?.state)}${$('#originalToggle').checked ? '\n当前显示原画；输入与目标表情保留。' : ''}`);
  if (rendered) setAttribute(canvas, 'aria-label', `${poseMeta()?.label || poseId}，${frameDescription(rendered.state)}`);
}

function isAnimating() {return source === 'demo' || source === 'camera' || transitionPending || recorder?.state === 'recording';}
function syncFrameStats(now = performance.now()) {
  if (!isAnimating()) {setText($('#frameStats'), `静止 · 目标 ${frameClock.targetFps} fps`); return;}
  const stats = frameClock.snapshot(now);
  const detail = stats.measuredFps === null ? '正在测量绘制帧率…'
    : `实测 ${stats.measuredFps.toFixed(1)} fps · 平均 ${stats.averageRenderMs.toFixed(1)} ms/帧`;
  setText($('#frameStats'), `目标 ${stats.targetFps} fps · ${detail}`);
}
function paint({now = performance.now(), dt = 0, snap = false, hold = false, measure = false} = {}) {
  if (!ready) return false;
  try {
    const started = performance.now();
    const selection = selectShortHairStudioState(assets, poseId, coefficients, previousState);
    const proposed = hold && rendered ? {frameState:rendered.state, moving:false, motion:frameMotion}
      : advanceStudioMotion(snap ? createStudioMotion(selection.targetState) : frameMotion,
        selection.targetState, dt * 1000, selection.availableSequences);
    const next = renderShortHairStudio(canvas, assets, poseId, coefficients, previousState,
      {faceOnly, original:$('#originalToggle').checked, stateOverride:proposed.frameState});
    if (next.didDraw === false) {
      // Keep the last displayed frame committed; retry the same proposal.
      transitionPending = !$('#originalToggle').checked && (proposed.moving
        || Object.entries(proposed.frameState).some(([key,value])=>rendered?.state[key]!==value));
      return false;
    }
    rendered = next; previousState = selection.targetState;
    frameMotion = proposed.motion; transitionPending = !$('#originalToggle').checked && proposed.moving;
    paintRecordingFrame();
    if (measure) frameClock.recordFrame(now, performance.now() - started);
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
    followHead:$('#followHead').checked, tourPoses:$('#tourPoses').checked,
    ...(includeCurrent ? {poseId, coefficients} : {})});
  try { localStorage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(project)); $('#saveStatus').textContent = '已保存到本机'; $('#saveStatus').classList.remove('warning'); }
  catch { $('#saveStatus').textContent = '本机保存不可用，请下载项目'; $('#saveStatus').classList.add('warning'); }
}
function stopActive(message = '已暂停，可以继续手动搭配动作。') {
  if (camera.active || camera.starting) camera.stop();
  source = 'manual'; calibrationUntil = 0;
  cancelAnimationFrame(animationFrame); animationFrame = 0;
  session.clearTest(); transitionPending = false; frameMotion = createStudioMotion(rendered?.state || null); frameClock.reset();
  syncSourceControls(); motionMessage(message); syncFrameStats();
  if (recorder?.state === 'recording') ensureAnimation();
}
function setManual(next, {reset = true, message = '已应用动作，可以继续叠加其他部位。', persist = true} = {}) {
  stopActive(message); ++revision; coefficients = sanitizeChannels(next);
  if (reset) previousState = {};
  $('#originalToggle').checked = false; paint(); syncControls(); syncFrameStats();
  if (transitionPending) ensureAnimation();
  if (ready && persist) persistProject();
}
function choosePose(next) {
  if (!ready || !assets.poses.some(pose => pose.id === next)) return;
  stopActive('方向已切换，保留当前表情。'); ++revision; poseId = next; previousState = {};
  $('#originalToggle').checked = false; paint({snap:true}); syncControls(); syncFrameStats(); if (ready) persistProject();
}

function beginCalibration() {
  if (!camera.active) return;
  session.beginCalibration(); poseSamples = []; neutralPose = {x:0,y:0}; trackedPose = {yaw:0,pitch:0};
  calibrationUntil = performance.now() + 3000; lastFaceAt = -Infinity;
  motionMessage('请保持正脸、眼睛自然睁开，放松嘴巴约 3 秒。'); syncSourceControls();
}
function centerTrackedPose(pose) {
  return {yaw: Math.max(-1, Math.min(1, pose.x - neutralPose.x)), pitch: Math.max(-1, Math.min(1, -(pose.y - neutralPose.y)))};
}
function cameraFrame(now, dt) {
  try {
    const result = camera.poll(now), face = result ? extractFaceMotion(result) : null;
    if (face) {
      lastFaceAt = now; session.receive(result, now, calibrationUntil > 0);
      if (calibrationUntil) {poseSamples.push(face.pose); if (poseSamples.length > 120) poseSamples.shift();}
      trackedPose = centerTrackedPose(face.pose);
    }
  } catch {
    stopActive(); motionMessage('面部识别已中断，摄像头已关闭；可重新开启，当前表情保留。', true); return;
  }
  if (calibrationUntil && now >= calibrationUntil) {
    const enough = session.samples.length >= 5;
    session.finishCalibration();
    if (enough) for (const key of ['x','y']) {
      const values = poseSamples.map(pose => pose[key]).sort((a,b) => a-b); neutralPose[key] = values[Math.floor(values.length / 2)] || 0;
    }
    if (enough && poseSamples.length) trackedPose = centerTrackedPose(poseSamples.at(-1));
    calibrationUntil = 0; syncSourceControls();
    motionMessage(enough ? '校准完成。现在可以眨眼、张嘴或抬眉。' : '没有收集到足够人脸数据；请正对镜头后重新校准。', !enough);
  }
  coefficients = sanitizeChannels(calibrationUntil ? {} : session.update({}, 'camera', now, dt));
  if (!calibrationUntil && $('#followHead').checked) {
    const next = selectStudioPose(now - lastFaceAt <= 240 ? trackedPose : {}, poseId);
    if (next !== poseId) {poseId = next; previousState = {}; frameMotion = createStudioMotion();}
  }
  if (!calibrationUntil && now - lastFaceAt > 600) motionMessage('寻找面部中；请让脸保持在镜头范围内。');
}
function tick(now) {
  animationFrame = 0;
  if (!ready || document.hidden || !isAnimating()) return;
  const frame = frameClock.advance(now);
  if (frame.render) {
    const wasAnimating = isAnimating();
    if (source === 'demo') {
      const sample = sampleStudioDemo(now - demoStartedAt, demoBasePose, $('#tourPoses').checked);
      if (sample.poseId !== poseId) {poseId = sample.poseId; previousState = {}; frameMotion = createStudioMotion();}
      coefficients = sample.coefficients;
      if (frame.updateUi) motionMessage(`正在演示：${sample.label}${$('#tourPoses').checked ? ' · 依次查看九个方向' : ' · 方向固定'}`);
    } else if (source === 'camera') {
      cameraFrame(now, frame.dt);
      if (source !== 'camera') {syncControls(); syncFrameStats(now); if(isAnimating())ensureAnimation(); return;}
    }
    if (!isAnimating()) {syncControls(); syncFrameStats(now); return;}
    paint({now, dt:frame.dt, hold:source==='manual'&&!transitionPending, measure:wasAnimating});
    if (frame.updateUi || !isAnimating()) {
      syncControls(); syncFrameStats(now);
      if (recorder?.state === 'recording') setText($('#recordStatus'), `录制中 · ${Math.floor((now-recordingStartedAt)/1000)} 秒 · 请求 ${frameClock.targetFps} fps · 不录制声音`);
    }
  }
  if (ready && isAnimating()) ensureAnimation();
  else {frameClock.reset(); syncFrameStats(now);}
}
function ensureAnimation() {if (!animationFrame && ready) animationFrame = requestAnimationFrame(tick);}
function toggleDemo() {
  if (!ready) return;
  if (source === 'demo') {stopActive(); syncControls(); return;}
  stopActive(); ++revision; source = 'demo'; demoBasePose = poseId; demoStartedAt = performance.now(); frameClock.reset();
  $('#originalToggle').checked = false; syncSourceControls(); ensureAnimation();
}
async function toggleCamera() {
  if (!ready) return;
  if (camera.active || camera.starting) {stopActive('摄像头已关闭，当前表情保留。'); return;}
  stopActive(); ++revision; source = 'camera-pending'; $('#originalToggle').checked = false;
  if (await camera.start()) {source = 'camera'; frameClock.reset(); beginCalibration(); ensureAnimation();}
  syncSourceControls();
}

function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function exportFrame() {
  stopActive(); paint({snap:true}); syncControls(); if (!ready) return;
  const payload = {schemaVersion:1, kind:'moemotion-short-hair-frame', characterId:'short-hair-v1', poseId,
    coefficients:{...coefficients}, supportedChannels:STUDIO_CHANNELS.map(channel => channel.key),
    renderedState:rendered.state, renderedGaze:rendered.gaze, targetState:rendered.targetState, targetGaze:rendered.targetGaze,
    preview:{faceOnly, original:$('#originalToggle').checked}, source:'manual', exportedAt:new Date().toISOString()};
  download(new Blob([JSON.stringify(payload,null,2)], {type:'application/json'}), `short-hair-frame-${stamp()}.json`);
  $('#importStatus').textContent = '已导出当前单帧，包含原始系数与实际显示状态。';
}
function savePng() {
  stopActive(); paint({snap:true}); syncControls(); if (!ready) return;
  const filename = `short-hair-${poseId}-${stamp()}.png`;
  try {canvas.toBlob(blob => {if (blob) download(blob, filename); else motionMessage('PNG 导出失败，请重试。',true);}, 'image/png');}
  catch {motionMessage('PNG 导出失败，请重试。',true);}
}
function saveProject() {
  stopActive(); paint({snap:true}); syncControls(); if (!ready) return; persistProject();
  download(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}), `short-hair-project-${stamp()}.json`);
}
function applyFrame(text) {
  try {
    const frame = parseStudioFrame(text); setManual(frame.coefficients, {message:'已应用导入系数。'}); if (!ready) return;
    $('#importStatus').textContent = `已应用 22 通道；未提供值设为 0。${frame.ignored.length ? `已忽略：${frame.ignored.join('、')}。` : ''}`;
    $('#importStatus').classList.toggle('warning', frame.ignored.length > 0);
  } catch(error) {$('#importStatus').textContent = `未应用：${error.message}`; $('#importStatus').classList.add('warning');}
}
function restoreProject(next, persist = false) {
  stopActive('项目已打开，摄像头保持关闭。'); stopRecording(); ++revision; project = next;
  poseId = project.poseId; coefficients = sanitizeChannels(project.coefficients); faceOnly = project.faceOnly; previousState = {};
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
  $('#frameArtSummary').textContent=`${allFive ? '九个方向的眨眼与张嘴均有五档画稿' : '眨眼与张嘴按各方向实际准备的画稿'}，动作逐张切换。转头采用九个固定方向；噘嘴、抿嘴和移嘴分别使用独立画稿。正面抬眉使用整眉近似，抿嘴为整嘴动作；暂未提供噘嘴与移嘴同时发生的复合稿。`;
}
async function loadAssets() {
  const request=++loadRequest; ready=false; $('#studioControls').disabled=true; $('#loadStatus').hidden=false;
  for (const id of ['#projectName','#openProject','#saveProject']) $(id).disabled = true;
  $('#loadStatus').className='notice';$('#loadStatus').textContent='正在准备九个方向的角色画稿…';$('#retryLoad').hidden=true;
  try {
    const loaded=await loadShortHairStudioAssets();if(request!==loadRequest)return;assets=loaded;buildControls();ready=true;
    restoreProject(project);if(!ready)return;$('#studioControls').disabled=false;$('#loadStatus').hidden=true;$('#stagePlaceholder').hidden=true;canvas.hidden=false;
    for (const id of ['#projectName','#openProject','#saveProject']) $(id).disabled = false;
    motionMessage('选择方向，搭配眼睛、嘴巴和眉毛；摄像头尚未开启。');
  }catch(error){if(request===loadRequest)fail(error);}
}

function init() {
  try {const saved=localStorage.getItem(STUDIO_STORAGE_KEY);if(saved) {project=parseStudioProject(saved);$('#saveStatus').textContent='已恢复本机项目';}}
  catch {$('#saveStatus').textContent='旧项目无法读取，已打开默认角色';}
  $('#manualButton').addEventListener('click',()=>{stopActive();syncControls();});
  $('#demoButton').addEventListener('click',toggleDemo);$('#cameraButton').addEventListener('click',toggleCamera);
  $('#stopCamera').addEventListener('click',()=>stopActive('摄像头已关闭，当前表情保留。'));$('#calibrateButton').addEventListener('click',beginCalibration);
  $('#resetExpression').addEventListener('click',()=>setManual({},{message:'所有表情已放松，方向保持不变。'}));
  $('#originalToggle').addEventListener('change',()=>{stopActive();paint({snap:true});syncControls();});
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
  $('#retryLoad').addEventListener('click',loadAssets);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopActive('页面已隐藏，摄像头和演示已暂停。');stopRecording();}});
  window.addEventListener('pagehide',()=>{stopActive();stopRecording();camera.dispose();});
  loadAssets();
}
init();
