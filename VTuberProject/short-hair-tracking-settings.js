/** Shared by the 2D project reader and camera mapper; no model/render imports. */
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bounded=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export const TRACKING_SETTING_DEFAULTS=Object.freeze({preset:'balanced',eyeSensitivity:1,mouthSensitivity:1,eyeInputMax:.85,mouthInputMax:.85});
export function normalizeTrackingSettings(raw={}) {
  const value=object(raw)?raw:{};
  const number=(key,min,max)=>typeof value[key]==='number'&&Number.isFinite(value[key])?clamp(value[key],min,max):TRACKING_SETTING_DEFAULTS[key];
  return {preset:['balanced','responsive','stable'].includes(value.preset)?value.preset:'balanced',
    eyeSensitivity:number('eyeSensitivity',.7,1.4),mouthSensitivity:number('mouthSensitivity',.7,1.4),
    eyeInputMax:number('eyeInputMax',.2,1),mouthInputMax:number('mouthInputMax',.2,1)};
}
export function validateTrackingSettings(value) {
  if(!object(value)||Object.keys(value).some(key=>!Object.hasOwn(TRACKING_SETTING_DEFAULTS,key)))throw new Error('跟踪设置包含未知字段。');
  if(Object.hasOwn(value,'preset')&&!['balanced','responsive','stable'].includes(value.preset))throw new Error('跟踪手感设置无效。');
  for(const key of ['eyeSensitivity','mouthSensitivity'])if(Object.hasOwn(value,key)&&!bounded(value[key],.7,1.4))throw new Error('跟踪灵敏度需要 0.7–1.4。');
  for(const key of ['eyeInputMax','mouthInputMax'])if(Object.hasOwn(value,key)&&!bounded(value[key],.2,1))throw new Error('有效输入上限需要 0.2–1。');
  return normalizeTrackingSettings(value);
}
