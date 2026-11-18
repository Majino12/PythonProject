import {STUDIO_HEAD_POSES} from './short-hair-pose-motion.js';
import {ARTICULATION_EYES,ARTICULATION_JAW,ARTICULATION_SPECIAL_MOUTHS,ARTICULATION_BROWS,ARTICULATION_DEFAULT_STATE} from './short-hair-articulation.js';

export const FEATURE_GROUPS=Object.freeze(['nose','eyeLeft','eyeRight','mouth','browLeft','browRight']);
export const FEATURE_TEXTURE_WIDTH=12;
export const FEATURE_TEXTURE_HEIGHT=42;
export const FEATURE_SOURCE_COUNT=6;
export const FEATURE_ROWS_PER_GROUP=7;
const SIZE=Object.freeze([1122,1402]);
const finite=Number.isFinite;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const array=(value,n)=>Array.isArray(value)&&value.length===n&&value.every(finite);
const mix=(a,b,t)=>a+(b-a)*t;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const statesFor=name=>name==='nose'?['neutral']:name.startsWith('eye')?ARTICULATION_EYES:name==='mouth'?[...ARTICULATION_JAW,...ARTICULATION_SPECIAL_MOUTHS]:ARTICULATION_BROWS;
const exactKeys=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function validSource(source,hash){
  return typeof source==='string'&&/^\.\/assets\/[a-z0-9_./-]+\.(?:png|webp|jpe?g)$/i.test(source)
    &&source.slice(2).split('/').every(part=>part!=='.'&&part!=='..'&&part!=='')
    &&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash);
}

/** Runtime charts have an explicit knot at each corresponding landmark. Missing
 * crease geometry is a non-active fallback, never an invented visible crease. */
function completeChart(value){
  if(!object(value)||![0,1].includes(value.axis)||!array(value.range,2)||value.range[1]<=value.range[0]
    ||!array(value.upper,9)||!array(value.lower,9)||!array(value.pads,4)||value.pads.some(v=>v<0||v>100))
    throw new TypeError('五官图表结构无效。');
  const knots=value.knots??Array.from({length:9},(_,i)=>mix(value.range[0],value.range[1],i/8));
  const crease=value.crease??value.upper.map(v=>v-19);
  const includeCrease=value.axis===0&&value.crease!==undefined&&value.includeCrease===true;
  if(!array(knots,9)||!array(crease,9)||knots.some((v,i)=>i>0&&v<=knots[i-1])
    ||Math.abs(knots[0]-value.range[0])>1e-6||Math.abs(knots[8]-value.range[1])>1e-6
    ||value.lower.some((v,i)=>v-value.upper[i]<2-1e-6)
    ||includeCrease&&crease.some((v,i)=>value.upper[i]-v<2-1e-6))
    throw new TypeError('五官图表节点必须单调且条带不可塌缩。');
  return {...value,knots,crease,includeCrease};
}

export function validateFeatureManifest(value){
  const ids=STUDIO_HEAD_POSES.map(p=>p.id);
  if(value?.schemaVersion!==1||value.kind!=='authored-feature-geometry'||value.width!==SIZE[0]||value.height!==SIZE[1]||!exactKeys(value.poses,ids))
    throw new Error('五官几何登记必须包含九个已登记方向。');
  let browCoverage;
  for(const id of ids){
    const pose=value.poses[id];
    if(!object(pose)||!validSource(pose.source,pose.sourceSha256)||!object(pose.features))throw new Error(`五官来源无效：${id}`);
    if(pose.foregroundProtection!==undefined){
      const protection=pose.foregroundProtection;
      if(!object(protection)||protection.source!==pose.source||protection.sourceSha256!==pose.sourceSha256
        ||!Array.isArray(protection.polygons)||protection.polygons.length>12
        ||protection.polygons.some(poly=>!Array.isArray(poly)||poly.length<3||poly.length>32
          ||poly.some(point=>!array(point,2)||point[0]<0||point[0]>SIZE[0]||point[1]<0||point[1]>SIZE[1])))
        throw new Error(`前景保护来源或轮廓无效：${id}`);
    }
    const names=Object.keys(pose.features),hasBrows=Object.hasOwn(pose.features,'browLeft');
    if(names.some(name=>!FEATURE_GROUPS.includes(name))||!['nose','eyeLeft','eyeRight','mouth'].every(name=>Object.hasOwn(pose.features,name))
      ||hasBrows!==Object.hasOwn(pose.features,'browRight')||browCoverage!==undefined&&hasBrows!==browCoverage)
      throw new Error(`五官登记不完整：${id}`);
    browCoverage=hasBrows;
    for(const [name,feature] of Object.entries(pose.features)){
      if(!object(feature)||feature.axis!==(name==='nose'?1:0)||!array(feature.pads,4)||feature.pads.some(v=>v<0||v>100)
        ||!exactKeys(feature.states,statesFor(name)))throw new Error(`五官状态不完整：${id}/${name}`);
      for(const [state,chart] of Object.entries(feature.states)){
        if(!object(chart)||!array(chart.knots,9)||!validSource(chart.source,chart.sourceSha256)
          ||chart.includeCrease!==undefined&&typeof chart.includeCrease!=='boolean'
          ||chart.includeCrease===true&&(!array(chart.crease,9)||feature.axis!==0))throw new Error(`五官画稿来源或节点无效：${id}/${name}/${state}`);
        const checked=completeChart({...chart,axis:feature.axis,pads:feature.pads});
        const alongLimit=SIZE[feature.axis],acrossLimit=SIZE[1-feature.axis];
        if(checked.range[0]<0||checked.range[1]>alongLimit||[...checked.upper,...checked.lower,...(checked.includeCrease?checked.crease:[])].some(v=>v<0||v>acrossLimit))
          throw new Error(`五官坐标越界：${id}/${name}/${state}`);
      }
    }
  }
  return value;
}
export async function loadFeatureGeometry(){
  const response=await fetch('./assets/short-hair-features-v1/manifest.json',{cache:'no-store'});
  if(!response.ok)throw new Error('无法读取五官轮廓。');
  return validateFeatureManifest(await response.json());
}
function validateWeights(values,weights){
  if(!Array.isArray(values)||!values.length||!Array.isArray(weights)||values.length!==weights.length
    ||weights.some(w=>!finite(w)||w<0)||Math.abs(weights.reduce((a,b)=>a+b,0)-1)>1e-6)throw new Error('五官几何权重无效。');
}
export function blendFeatureCharts(charts,weights){
  validateWeights(charts,weights);
  const checked=charts.map(completeChart);
  if(checked.some(c=>c.axis!==checked[0].axis))throw new Error('五官图表轴向不一致。');
  const blend=key=>checked[0][key].map((_,i)=>checked.reduce((sum,c,j)=>sum+c[key][i]*weights[j],0));
  return completeChart({axis:checked[0].axis,range:blend('range'),knots:blend('knots'),upper:blend('upper'),lower:blend('lower'),crease:blend('crease'),pads:blend('pads'),
    includeCrease:checked.every((c,i)=>weights[i]===0||c.includeCrease)});
}
export function featureChartsForState(manifest,poseId,state=ARTICULATION_DEFAULT_STATE){
  const pose=manifest.poses[poseId];if(!pose)throw new Error('五官登记缺少姿态。');
  return FEATURE_GROUPS.map(name=>{
    const feature=pose.features[name];if(!feature)return null;
    const key=name==='nose'?'neutral':state[name],chart=feature.states[key];
    if(!chart)throw new Error(`五官登记缺少 ${poseId}/${name}/${key}`);
    return completeChart({...chart,axis:feature.axis,pads:feature.pads});
  });
}
export function blendFeatureSets(sets,weights){
  validateWeights(sets,weights);
  if(sets.some(set=>!Array.isArray(set)||set.length!==FEATURE_GROUPS.length))throw new Error('五官集合必须有六个固定槽位。');
  return FEATURE_GROUPS.map((_,i)=>{
    const active=sets.filter((_,j)=>weights[j]>0);
    if(active.every(set=>set[i]===null))return null;
    if(active.some(set=>!set[i]))throw new Error('五官集合的登记范围不一致。');
    const present=sets.map((set,j)=>({chart:set[i],weight:weights[j]})).filter(entry=>entry.weight>0);
    return blendFeatureCharts(present.map(v=>v.chart),present.map(v=>v.weight));
  });
}

/** Bbox is in native pixel x/y and includes the zero-influence feather edge. */
export function featureBounds(value){
  const c=completeChart(value),along=c.pads[0]+c.pads[1],across=c.pads[2]+c.pads[3];
  const low=Math.min(...(c.includeCrease?c.crease:c.upper))-across,high=Math.max(...c.lower)+across;
  return c.axis===1?[low,c.range[0]-along,high,c.range[1]+along]:[c.range[0]-along,low,c.range[1]+along,high];
}
/** Seven rows per feature: target,A0,B0,A1,B1,A2,B2. Each curve texel is
 * [upper,lower,crease,alongKnot]. Header texel2 is a native-pixel bbox. */
export function packFeatureGeometry(target,sources){
  if(!Array.isArray(target)||target.length!==6||!Array.isArray(sources)||sources.length!==FEATURE_SOURCE_COUNT
    ||sources.some(set=>!Array.isArray(set)||set.length!==6))throw new Error('五官纹理需要目标与六个完整来源集合。');
  const data=new Float32Array(FEATURE_TEXTURE_WIDTH*FEATURE_TEXTURE_HEIGHT*4);
  for(let feature=0;feature<6;feature++)for(let row=0;row<FEATURE_ROWS_PER_GROUP;row++){
    const raw=row===0?target[feature]:sources[row-1][feature],offset=(feature*FEATURE_ROWS_PER_GROUP+row)*FEATURE_TEXTURE_WIDTH*4;
    if(raw===null){data[offset+2]=-1;continue;}
    const c=completeChart(raw);
    data.set([c.range[0],c.range[1],c.axis,c.includeCrease?1:0],offset);data.set(c.pads,offset+4);data.set(featureBounds(c),offset+8);
    for(let i=0;i<9;i++)data.set([c.upper[i],c.lower[i],c.crease[i],c.knots[i]],offset+(i+3)*4);
  }
  return data;
}

// Along-coordinate inversion uses the actual target knot intervals. In
// particular bridge indices0..4 cannot consume or stretch primary indices4..8.
function intervalForAlong(knots,along){
  let i=0;for(let j=1;j<8;j++)if(along>=knots[j])i=j;
  return {i,t:(along-knots[i])/(knots[i+1]-knots[i])};
}
function intervalForU(u){const z=u*8,i=clamp(Math.floor(z),0,7);return {i,t:z-i};}
function curveAt(c,u){
  const {i,t}=intervalForU(clamp(u,0,1));
  return {upper:mix(c.upper[i],c.upper[i+1],t),lower:mix(c.lower[i],c.lower[i+1],t),crease:mix(c.crease[i],c.crease[i+1],t)};
}
export function chartPoint(value,u,v){
  if(!finite(u)||!finite(v))throw new TypeError('五官图表坐标无效。');
  const c=completeChart(value),{i,t}=intervalForU(u),curve=curveAt(c,u),along=mix(c.knots[i],c.knots[i+1],t),across=mix(curve.upper,curve.lower,v);
  return c.axis===1?[across,along]:[along,across];
}
/** CPU mirror of featureSourceUV, returning native pixels before UV division. */
export function mapFeaturePoint(target,source,pixel){
  if(!array(pixel,2))throw new TypeError('五官像素坐标无效。');
  if(target===null||source===null)return [...pixel];
  const a=completeChart(target),b=completeChart(source);
  if(a.axis!==b.axis)throw new Error('五官图表轴向不一致。');
  const q=a.axis===1?[pixel[1],pixel[0]]:pixel,{i,t}=intervalForAlong(a.knots,q[0]),u=(i+t)/8,ca=curveAt(a,u),cb=curveAt(b,u);
  const along=mix(b.knots[i],b.knots[i+1],t),hasCrease=a.includeCrease&&b.includeCrease;
  let across;
  if(hasCrease&&q[1]<ca.upper)across=q[1]<ca.crease?cb.crease+q[1]-ca.crease:mix(cb.crease,cb.upper,(q[1]-ca.crease)/(ca.upper-ca.crease));
  else if(q[1]<ca.upper)across=cb.upper+q[1]-ca.upper;
  else if(q[1]>ca.lower)across=cb.lower+q[1]-ca.lower;
  else across=mix(cb.upper,cb.lower,(q[1]-ca.upper)/(ca.lower-ca.upper));
  return a.axis===1?[across,along]:[along,across];
}
export function featureSourceUVCPU(target,source,pixel){return mapFeaturePoint(target,source,pixel).map((v,i)=>v/SIZE[i]);}
const smoothstep=(low,high,value)=>{const t=clamp((value-low)/(high-low),0,1);return t*t*(3-2*t);};
export function featureInfluenceCPU(value,pixel){
  if(value===null)return 0;if(!array(pixel,2))throw new TypeError('五官像素坐标无效。');
  const c=completeChart(value),bbox=featureBounds(c);
  if(pixel[0]<bbox[0]||pixel[1]<bbox[1]||pixel[0]>bbox[2]||pixel[1]>bbox[3])return 0;
  const q=c.axis===1?[pixel[1],pixel[0]]:pixel,{i,t}=intervalForAlong(c.knots,q[0]),curve=curveAt(c,(i+t)/8);
  const along=Math.max(c.range[0]-q[0],q[0]-c.range[1],0),across=Math.max((c.includeCrease?curve.crease:curve.upper)-q[1],q[1]-curve.lower,0);
  return (1-smoothstep(c.pads[0],c.pads[0]+Math.max(.01,c.pads[1]),along))*(1-smoothstep(c.pads[2],c.pads[2]+Math.max(.01,c.pads[3]),across));
}

export const FEATURE_GLSL=`
uniform sampler2D featureGeometry;
uniform bool featureEnabled;
vec4 featureTex(int feature,int row,int x){return texelFetch(featureGeometry,ivec2(x,feature*7+row),0);}
float featureAlongU(int feature,int row,float along){
  int first=0,last=8;
  for(int step=0;step<3;step++){
    int middle=(first+last)/2;
    if(along>=featureTex(feature,row,middle+3).w)first=middle;else last=middle;
  }
  float lo=featureTex(feature,row,first+3).w,hi=featureTex(feature,row,first+4).w;
  return (float(first)+(along-lo)/max(.000001,hi-lo))/8.0;
}
vec4 featureCurve(int feature,int row,float u){
  float z=clamp(u,0.0,1.0)*8.0;int i=min(7,int(floor(z)));float t=z-float(i);
  return mix(featureTex(feature,row,i+3),featureTex(feature,row,i+4),t);
}
float featureAlong(int feature,int row,float u){
  float z=u*8.0;int i=int(clamp(floor(z),0.0,7.0));float t=z-float(i);
  return mix(featureTex(feature,row,i+3).w,featureTex(feature,row,i+4).w,t);
}
float featureInfluence(int f,vec2 pixel){
  vec4 meta=featureTex(f,0,0);if(meta.z<0.0)return 0.0;
  vec4 bbox=featureTex(f,0,2);if(any(lessThan(pixel,bbox.xy))||any(greaterThan(pixel,bbox.zw)))return 0.0;
  vec2 q=meta.z>.5?pixel.yx:pixel;vec4 pads=featureTex(f,0,1),curve=featureCurve(f,0,featureAlongU(f,0,q.x));
  float first=meta.z<.5&&meta.w>.5?curve.z:curve.x;
  float along=max(max(meta.x-q.x,q.x-meta.y),0.0),across=max(max(first-q.y,q.y-curve.y),0.0);
  return (1.0-smoothstep(pads.x,pads.x+max(.01,pads.y),along))*(1.0-smoothstep(pads.z,pads.z+max(.01,pads.w),across));
}
vec2 featureSourceUV(int f,int slot,vec2 pixel){
  vec4 target=featureTex(f,0,0),source=featureTex(f,slot+1,0);
  if(target.z<0.0||source.z<0.0)return pixel/vec2(1122.0,1402.0);
  vec2 q=target.z>.5?pixel.yx:pixel;float u=featureAlongU(f,0,q.x);
  vec4 a=featureCurve(f,0,u),b=featureCurve(f,slot+1,u);float across;
  if(target.z<.5&&target.w>.5&&source.w>.5&&q.y<a.x){
    across=q.y<a.z?b.z+(q.y-a.z):mix(b.z,b.x,(q.y-a.z)/max(.000001,a.x-a.z));
  }else if(q.y<a.x)across=b.x+(q.y-a.x);
  else if(q.y>a.y)across=b.y+(q.y-a.y);
  else across=mix(b.x,b.y,(q.y-a.x)/max(.000001,a.y-a.x));
  vec2 outPoint=vec2(featureAlong(f,slot+1,u),across);
  return (target.z>.5?outPoint.yx:outPoint)/vec2(1122.0,1402.0);
}
int strongestFeature(vec2 pixel,out float amount){
  amount=0.0;int selected=0;
  if(featureEnabled)for(int f=0;f<6;f++){float next=featureInfluence(f,pixel);if(next>amount){amount=next;selected=f;}}
  return selected;
}
`;
