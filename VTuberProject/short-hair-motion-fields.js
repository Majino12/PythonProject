import {CONTINUOUS_EDGES} from './short-hair-continuous-model.js';
import {STUDIO_HEAD_POSES} from './short-hair-pose-motion.js';

export const MOTION_FIELDS_URL='./assets/short-hair-motion-v1/manifest.json';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const edgeKey=(a,b)=>[a,b].sort().join('|');

/** Fixed, bounded model data. It never causes code/model downloads at runtime. */
export function validateMotionFieldsManifest(value) {
  const times=[.125,.25,.375,.5,.625,.75,.875];
  if(!object(value)||value.schemaVersion!==1||value.id!=='short-hair-rife-v4.6-fields-v1'
    ||JSON.stringify(value.fieldSize)!=='[144,180]'||JSON.stringify(value.times)!==JSON.stringify(times)
    ||!Array.isArray(value.edges)||value.edges.length!==16||!object(value.sources)
    ||value.model?.name!=='RIFE v4.6'||value.model?.license!=='MIT'
    ||value.model?.commit!=='a7532fc3f9f8f008cd6eecd6f2ffe2a9698e0cf7'
    ||value.model?.weights?.['flownet.bin']!=='f334ed2260149ce0188a6dcf049844e8b0cdd912e01cbcfb63553157d2508958'
    ||value.model?.weights?.['flownet.param']!=='724569596bcd1e7b9fa50455c604777ebed99746d2ef40aa86e31b5725f1053c')throw new Error('连续转头模型素材登记无效。');
  const expected=new Set(CONTINUOUS_EDGES.map(({from,to})=>edgeKey(from,to))),seen=new Set();
  for(const {id} of STUDIO_HEAD_POSES) {
    const source=value.sources[id];
    if(!object(source)||!hash(source.sha256)||!/^\.\/assets\/[a-zA-Z0-9_/-]+\.png$/.test(source.path))throw new Error('运动场原画来源无效。');
  }
  for(const edge of value.edges) {
    const key=edgeKey(edge.from,edge.to);
    if(edge.id!==`${edge.from}__${edge.to}`||!expected.has(key)||seen.has(key))throw new Error('运动场缺少相邻方向或重复登记。');seen.add(key);
    for(const [kind,bytes] of [['flow',1451520],['mask',181440]]) {
      const file=edge[kind];
      if(!object(file)||file.bytes!==bytes||!hash(file.sha256)
        ||file.path!==`${edge.from}--${edge.to}.${kind}.bin`)throw new Error('运动场文件路径、大小或校验无效。');
    }
  }
  return value;
}

export async function loadShortHairMotionFields() {
  const response=await fetch(MOTION_FIELDS_URL,{cache:'no-store'});
  if(!response.ok)throw new Error('无法载入连续转头模型素材。');
  const manifest=validateMotionFieldsManifest(await response.json());
  const base=MOTION_FIELDS_URL.slice(0,MOTION_FIELDS_URL.lastIndexOf('/')+1);
  const read=async record=>{
    const file=await fetch(base+record.path);if(!file.ok)throw new Error(`运动场无法载入：${record.path}`);
    const buffer=await file.arrayBuffer();if(buffer.byteLength!==record.bytes)throw new Error('运动场文件长度不匹配。');
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),n=>n.toString(16).padStart(2,'0')).join('');
    if(digest!==record.sha256)throw new Error('运动场文件校验失败，请恢复对应版本素材。');
    return buffer;
  };
  const edges=await Promise.all(manifest.edges.map(async edge=>{
    const [flow,mask]=await Promise.all([read(edge.flow),read(edge.mask)]);
    return {...edge,flowData:new Uint16Array(flow),maskData:new Uint8Array(mask)};
  }));
  return {manifest,edges};
}

export function findMotionField(fields,from,to) {
  const edge=fields.edges.find(edge=>edge.from===from&&edge.to===to||edge.from===to&&edge.to===from);
  if(!edge)throw new Error(`缺少 ${from} 到 ${to} 的模型运动场。`);
  return {edge,reversed:edge.from!==from};
}
