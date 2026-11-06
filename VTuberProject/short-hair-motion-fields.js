import {CONTINUOUS_EDGES} from './short-hair-continuous-model.js';
import {STUDIO_HEAD_POSES} from './short-hair-pose-motion.js';

export const MOTION_FIELDS_URL='./assets/short-hair-motion-v1/manifest.json';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const edgeKey=(a,b)=>[a,b].sort().join('|');

/** Fixed, bounded model data. It never causes code/model downloads at runtime. */
export function validateMotionFieldsManifest(value) {
  const times=[.125,.25,.375,.5,.625,.75,.875];
  if(!object(value)||value.schemaVersion!==1||value.id!=='short-hair-rife-v4.25-fields-v1'
    ||JSON.stringify(value.fieldSize)!=='[144,180]'||JSON.stringify(value.times)!==JSON.stringify(times)
    ||!Array.isArray(value.edges)||value.edges.length!==16||!object(value.sources)
    ||Object.keys(value.sources).length!==9
    ||JSON.stringify(value.inferenceSize)!=='[576,720]'||value.padding!=='right/bottom zero to multiples of 64'
    ||value.flowFormat!=='little-endian float16, [time][y][x][dx0,dy0,dx1,dy1]'
    ||value.flowUnits!=='normalized image UV displacement; positive y points down'
    ||value.maskFormat!=='uint8, [time][y][x], endpoint0 weight / 255'
    ||value.sampling!=='pixel-centred bilinear; fields are downsampled from neural outputs'
    ||value.model?.name!=='RIFE v4.25'||value.model?.license!=='MIT'
    ||value.model?.implementation!=='hzwer/Practical-RIFE'
    ||value.model?.commit!=='bbfd2ea90910789a860ea3e2b32a240cd577b75e'
    ||value.model?.url!=='https://github.com/hzwer/Practical-RIFE/tree/bbfd2ea90910789a860ea3e2b32a240cd577b75e'
    ||value.model?.weightArchiveUrl!=='https://drive.google.com/uc?export=download&id=1ZKjcbmt1hypiFprJPIKW0Tt0lr_2i7bg'
    ||value.model?.weightArchiveSha256!=='e63d481b7ae5d4a4e6ad7ac5b410ff78f3bf7be3b51b2e38ca8152747abde5b4'
    ||value.model?.flowOutput!=='flow_list[-1]'||value.model?.maskOutput!=='sigmoid(mask_logits)'
    ||JSON.stringify(value.model?.scaleList)!=='[16,8,4,2,1]'
    ||!object(value.model?.weights)||Object.keys(value.model.weights).length!==3
    ||value.model.weights['train_log/flownet.pkl']!=='6615790efd627772917205db291f51cd392528a157ecbb2ecaeec3bff8eb6de2'
    ||value.model.weights['train_log/IFNet_HDv3.py']!=='655b4c772b037967b86c2dd31c8fa3b5323b79dd9a0e0088708d89149bbc8a32'
    ||value.model.weights['model/warplayer.py']!=='feb3af9475b724749b023d1913c3b135431eff13d0045b8efb472a699058385f')throw new Error('连续转头模型素材登记无效。');
  const expected=new Set(CONTINUOUS_EDGES.map(({from,to})=>edgeKey(from,to))),seen=new Set();
  for(const {id} of STUDIO_HEAD_POSES) {
    const source=value.sources[id];
    if(!object(source)||!hash(source.sha256)||!/^\.\/assets\/[a-zA-Z0-9_/-]+\.png$/.test(source.path))throw new Error('运动场原画来源无效。');
  }
  for(const edge of value.edges) {
    if(!object(edge))throw new Error('运动场边记录无效。');
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
