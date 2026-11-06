/** Output framing is independent of the character rig and motion state. */
export const DEFAULT_OUTPUT_COMPOSITION = Object.freeze({scale:1,x:0,y:0,mirror:false});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bounded=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;

/** Strict import/relay boundary: partial or unknown fields are rejected. */
export function validateOutputComposition(value) {
  if(!object(value)||Object.keys(value).length!==4||!['scale','x','y','mirror'].every(key=>Object.hasOwn(value,key))||!bounded(value.scale,.5,2.5)
    ||!bounded(value.x,-1,1)||!bounded(value.y,-1,1)||typeof value.mirror!=='boolean')
    throw new Error('直播构图无效：缩放应为 0.5–2.5，位置应为 -1–1，镜像应为布尔值。');
  return {scale:value.scale,x:value.x,y:value.y,mirror:value.mirror};
}

/** UI/default normalization; strict validation remains mandatory on imported data. */
export function normalizeOutputComposition(value) {
  const source=object(value)?value:{};
  const number=(key,min,max)=>typeof source[key]==='number'&&Number.isFinite(source[key])
    ?Math.max(min,Math.min(max,source[key])):DEFAULT_OUTPUT_COMPOSITION[key];
  return {scale:number('scale',.5,2.5),x:number('x',-1,1),y:number('y',-1,1),mirror:source.mirror===true};
}

/** x/y move by half the output canvas; mirroring keeps the composed center fixed. */
export function layoutOutputComposition(target,source,composition) {
  const value=normalizeOutputComposition(composition);
  const fit=Math.min(target.width/source.width,target.height/source.height)*value.scale;
  return {width:source.width*fit,height:source.height*fit,
    centerX:target.width*(1+value.x)/2,centerY:target.height*(1+value.y)/2,mirror:value.mirror};
}
