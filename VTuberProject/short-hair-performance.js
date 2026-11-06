import {CHANNELS,sanitizeChannels} from './expression-model.js';

export const PERFORMANCE_PRESET_LIMIT=8;
export const PERFORMANCE_FADE_MS=300;
const MIXER_ENTRY_LIMIT=PERFORMANCE_PRESET_LIMIT*2;
export const PERFORMANCE_GROUPS=Object.freeze(['eyes','mouth','brows','gaze']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const unit=value=>finite(value)&&value>=0&&value<=1;
const ownKeys=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,48}$/.test(value);
const freezePreset=preset=>Object.freeze({...preset,groups:Object.freeze([...preset.groups]),channels:Object.freeze({...preset.channels})});

/** Strict persisted/imported presets, using only channels already backed by this character. */
export function validatePerformancePreset(value){
  if(!ownKeys(value,['id','name','groups','channels'])||!validId(value.id)||typeof value.name!=='string'
    ||!value.name.trim()||value.name!==value.name.trim()||value.name.length>40
    ||!Array.isArray(value.groups)||!value.groups.length||value.groups.length>PERFORMANCE_GROUPS.length
    ||new Set(value.groups).size!==value.groups.length||value.groups.some(group=>!PERFORMANCE_GROUPS.includes(group))
    ||!ownKeys(value.channels,CHANNELS.map(channel=>channel.key))||CHANNELS.some(({key})=>!unit(value.channels[key])))
    throw new TypeError('表情预设无效：需要名称、明确部位和完整的 0–1 通道。');
  return {id:value.id,name:value.name,groups:[...value.groups],channels:{...value.channels}};
}
export function validatePerformancePresets(value){
  if(!Array.isArray(value)||value.length>PERFORMANCE_PRESET_LIMIT)throw new TypeError('最多保存 8 个表情预设。');
  const presets=value.map(validatePerformancePreset);
  if(new Set(presets.map(preset=>preset.id)).size!==presets.length)throw new TypeError('表情预设标识不能重复。');
  return presets;
}

/** Friendly UI save path. Imported presets must use the strict validator instead. */
export function createPerformancePreset({id,name,groups,channels}={}){
  return validatePerformancePreset({id,name:typeof name==='string'?name.trim().slice(0,40):'',groups,channels:sanitizeChannels(channels)});
}
export const DEFAULT_PERFORMANCE_PRESETS=Object.freeze([
  {id:'half-eyes',name:'半闭眼',groups:['eyes'],channels:{eyeBlinkLeft:.5,eyeBlinkRight:.5}},
  {id:'pucker',name:'噘嘴',groups:['mouth'],channels:{mouthPucker:1}},
  {id:'inner-brows',name:'抬眉头',groups:['brows'],channels:{browInnerUp:1}},
  {id:'wink-left',name:'左眼眨眼',groups:['eyes'],channels:{eyeBlinkLeft:1}},
].map(value=>freezePreset(createPerformancePreset(value))));

const channelKeys=CHANNELS.map(channel=>channel.key);
const smooth=value=>value*value*(3-2*value);
const freezeHandoff=handoff=>handoff?Object.freeze({elapsedMs:handoff.elapsedMs,
  fromScale:Object.freeze({...handoff.fromScale}),fromOffset:Object.freeze({...handoff.fromOffset})}):null;
function mixerState(entries=[],serial=0,paused=false,handoff=null){
  return Object.freeze({serial,paused,handoff:freezeHandoff(handoff),
    entries:Object.freeze(entries.map(entry=>Object.freeze({...entry,preset:freezePreset(entry.preset)})))});
}
function validateMixer(mixer){
  if(!object(mixer)||!Object.hasOwn(mixer,'serial')||!Object.hasOwn(mixer,'entries')
    ||Object.keys(mixer).some(key=>!['serial','entries','paused','handoff'].includes(key))
    ||Object.hasOwn(mixer,'paused')&&typeof mixer.paused!=='boolean'||!Number.isSafeInteger(mixer.serial)||mixer.serial<0
    ||!Array.isArray(mixer.entries)||mixer.entries.length>MIXER_ENTRY_LIMIT
    ||mixer.entries.filter(entry=>entry?.target===1).length>PERFORMANCE_PRESET_LIMIT
    ||mixer.entries.some(entry=>!ownKeys(entry,['preset','weight','target','order'])||!unit(entry.weight)
      ||![0,1].includes(entry.target)||!Number.isSafeInteger(entry.order)||entry.order<1||entry.order>mixer.serial))
    throw new TypeError('表情混合状态无效。');
  mixer.entries.forEach(entry=>validatePerformancePreset(entry.preset));
  if(new Set(mixer.entries.map(entry=>entry.preset.id)).size!==mixer.entries.length)throw new TypeError('表情混合状态包含重复预设。');
  if(Object.hasOwn(mixer,'handoff')&&mixer.handoff!==null){
    const h=mixer.handoff;
    if(!ownKeys(h,['fromScale','fromOffset','elapsedMs'])||!finite(h.elapsedMs)||h.elapsedMs<0||h.elapsedMs>=PERFORMANCE_FADE_MS
      ||!ownKeys(h.fromScale,channelKeys)||!ownKeys(h.fromOffset,channelKeys)
      ||channelKeys.some(key=>!unit(h.fromScale[key])||!unit(h.fromOffset[key])||h.fromScale[key]+h.fromOffset[key]>1+1e-12))
      throw new TypeError('表情优先级交接状态无效。');
  }
}

/** Every expression stack is an affine function of the live source: a*base+b.
 * A priority handoff blends two such functions, so input remains live and a
 * rapid restart never jumps gaze or grows a nested history of snapshots. */
function rawAffine(entries){
  const scale=Object.fromEntries(channelKeys.map(key=>[key,1])),offset=sanitizeChannels();
  for(const entry of entries){const weight=smooth(entry.weight);
    for(const {key,group} of CHANNELS)if(entry.preset.groups.includes(group)){
      scale[key]*=1-weight;offset[key]=offset[key]*(1-weight)+entry.preset.channels[key]*weight;
    }
  }
  return {scale,offset};
}
function currentAffine(mixer){
  const result=rawAffine(mixer.entries),h=mixer.handoff;
  if(h){const weight=smooth(h.elapsedMs/PERFORMANCE_FADE_MS);
    for(const key of channelKeys){result.scale[key]=h.fromScale[key]*(1-weight)+result.scale[key]*weight;
      result.offset[key]=h.fromOffset[key]*(1-weight)+result.offset[key]*weight;}
  }
  return result;
}
function handoffForOrderChange(mixer,entries){
  const before=rawAffine(mixer.entries),after=rawAffine(entries);
  if(channelKeys.every(key=>Math.abs(before.scale[key]-after.scale[key])<1e-12&&Math.abs(before.offset[key]-after.offset[key])<1e-12))return mixer.handoff||null;
  const shown=currentAffine(mixer);return {fromScale:shown.scale,fromOffset:shown.offset,elapsedMs:0};
}
export function createPerformanceMixer(){return mixerState();}

/** Freeze a displayed transition without clearing its expression intent. */
export function freezePerformanceMixer(mixer){
  validateMixer(mixer);return mixerState(mixer.entries,mixer.serial,true,mixer.handoff);
}

/** Activation/deactivation only changes intent; advancing a proposed frame does not commit it. */
export function setPerformancePreset(mixer,preset,active){
  validateMixer(mixer);const checked=validatePerformancePreset(preset),old=mixer.entries.find(entry=>entry.preset.id===checked.id);
  const nextActive=active===undefined?old?.target!==1:active;
  if(typeof nextActive!=='boolean')throw new TypeError('表情启用状态需要布尔值。');
  if(!old&&!nextActive)return mixer.paused?mixerState(mixer.entries,mixer.serial,false,mixer.handoff):mixer;
  if(!old&&mixer.entries.length>=MIXER_ENTRY_LIMIT)throw new TypeError('前一批表情仍在淡出，请稍候再叠加。');
  if(nextActive&&old?.target!==1&&mixer.entries.filter(entry=>entry.target===1).length>=PERFORMANCE_PRESET_LIMIT)
    throw new TypeError('同时最多启用 8 个表情预设，请先取消一个。');
  if(old&&old.target===Number(nextActive))return mixer.paused?mixerState(mixer.entries,mixer.serial,false,mixer.handoff):mixer;
  const serial=nextActive?mixer.serial+1:mixer.serial;
  if(!Number.isSafeInteger(serial))throw new TypeError('表情激活序号已超出范围。');
  const updated={preset:old?.preset||checked,weight:old?.weight||0,target:Number(nextActive),order:nextActive?serial:old.order};
  const entries=mixer.entries.filter(entry=>entry.preset.id!==checked.id);entries.push(updated);entries.sort((a,b)=>a.order-b.order);
  return mixerState(entries,serial,false,handoffForOrderChange(mixer,entries));
}
export function clearPerformancePresets(mixer){
  validateMixer(mixer);return mixerState(mixer.entries.map(entry=>({...entry,target:0})),mixer.serial,false,mixer.handoff);
}
export function isPerformancePresetActive(mixer,id){return mixer.entries.some(entry=>entry.preset.id===id&&entry.target===1);}

/** Propose, render, then commit result.mixer only after a successful draw.
 * The latest activated preset has priority only in its named groups. Every
 * outgoing layer fades back to the CURRENT source, never a saved camera frame.
 * This changes coefficients, not artwork pixels; the existing painter chooses
 * supported frames and applies its authored-frame transition timing afterward. */
export function proposePerformanceFrame(mixer,baseCoefficients,dtMs){
  validateMixer(mixer);if(!finite(dtMs)||dtMs<0)throw new TypeError('表情混合间隔需要非负有限毫秒数。');
  const step=mixer.paused?0:dtMs/PERFORMANCE_FADE_MS;
  const advance=entry=>{const weight=entry.target===1?Math.min(1,entry.weight+step):Math.max(0,entry.weight-step);
    return Math.abs(weight-entry.target)<1e-12?entry.target:weight;};
  const entries=mixer.entries.map(entry=>({...entry,weight:advance(entry)}))
    .filter(entry=>entry.target===1||entry.weight>0);
  let handoff=mixer.handoff||null;
  if(handoff&&!mixer.paused){const elapsedMs=handoff.elapsedMs+dtMs;
    handoff=elapsedMs>=PERFORMANCE_FADE_MS?null:{...handoff,elapsedMs};}
  const next=mixerState(entries,mixer.serial,mixer.paused===true,handoff),affine=currentAffine(next);
  const effectiveCoefficients=sanitizeChannels(baseCoefficients);
  for(const key of channelKeys)effectiveCoefficients[key]=Math.max(0,Math.min(1,effectiveCoefficients[key]*affine.scale[key]+affine.offset[key]));
  return {mixer:next,effectiveCoefficients,
    moving:!mixer.paused&&(entries.some(entry=>entry.weight!==entry.target)||handoff!==null),activeIds:entries.filter(entry=>entry.target===1).map(entry=>entry.preset.id)};
}

/** Page-focused shortcuts only. The caller supplies visibility/focus state;
 * native event targets are read without any global document dependency. */
export function matchPerformanceShortcut(event,{hidden=false,editable=false,focused=true}={}){
  const target=event?.target,tag=String(target?.tagName||'').toLowerCase();
  if(!event||hidden||!focused||editable||event.defaultPrevented||event.repeat||event.isComposing
    ||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||target?.isContentEditable
    ||['input','textarea','select'].includes(tag)||target?.closest?.('[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))return null;
  if(event.key==='Escape'||event.code==='Escape')return 'clear';
  const code=/^(?:Digit|Numpad)([1-8])$/.exec(event.code||'');
  if(code)return Number(code[1])-1;
  return typeof event.key==='string'&&/^[1-8]$/.test(event.key)?Number(event.key)-1:null;
}
