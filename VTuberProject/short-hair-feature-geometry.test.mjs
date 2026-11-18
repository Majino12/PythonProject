import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {FEATURE_GROUPS,FEATURE_TEXTURE_WIDTH,FEATURE_TEXTURE_HEIGHT,FEATURE_SOURCE_COUNT,FEATURE_ROWS_PER_GROUP,
  validateFeatureManifest,featureChartsForState,blendFeatureCharts,blendFeatureSets,packFeatureGeometry,
  chartPoint,mapFeaturePoint,featureSourceUVCPU,featureInfluenceCPU,featureBounds} from './short-hair-feature-geometry.js';
const root=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(readFileSync(resolve(root,'assets/short-hair-features-v1/manifest.json'),'utf8'));
const state=(eye='open',mouth='neutral')=>({eyeLeft:eye,eyeRight:eye,mouth,browLeft:'neutral',browRight:'neutral'});
const set=(pose,eye='open',mouth='neutral')=>featureChartsForState(manifest,pose,state(eye,mouth));
const near=(actual,expected,eps=1e-8)=>{assert.equal(actual.length,expected.length);actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<=eps,`${actual} != ${expected} at ${i}`));};
const native=(c,along,across)=>c.axis===1?[across,along]:[along,across];

test('actual nine-pose geometry has every eye/jaw state and hashes actual source pixels',()=>{
  assert.equal(validateFeatureManifest(manifest),manifest);assert.equal(Object.keys(manifest.poses).length,9);
  const sources=new Map();let chartCount=0;
  const remember=(path,sha)=>{if(sources.has(path))assert.equal(sources.get(path),sha);sources.set(path,sha);};
  for(const pose of Object.values(manifest.poses)){
    remember(pose.source,pose.sourceSha256);
    assert.equal(Object.keys(pose.features.eyeLeft.states).length,5);assert.equal(Object.keys(pose.features.eyeRight.states).length,5);assert.equal(Object.keys(pose.features.mouth.states).length,9);
    for(const f of Object.values(pose.features))for(const c of Object.values(f.states)){remember(c.source,c.sourceSha256);chartCount++;}
  }
  assert.ok(chartCount>=180);
  for(const [path,sha] of sources)assert.equal(createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex'),sha,`Source pixels changed: ${path}`);
});

test('manifest rejects missing poses/artwork, untrusted paths and folding charts',()=>{
  for(const mutate of [
    m=>delete m.poses['view-right-down'],m=>m.poses.unknown=structuredClone(m.poses.front),
    m=>delete m.poses.front.features.eyeLeft.states.closed,m=>delete m.poses.front.features.mouth.states.openMedium,
    m=>m.poses.front.features.mouth.states.unsupported=structuredClone(m.poses.front.features.mouth.states.neutral),
    m=>m.poses.front.features.nose.axis=0,m=>m.poses.front.sourceSha256='0',
    m=>m.poses.front.features.mouth.states.neutral.source='./assets/../secret.png',
    m=>m.poses.front.features.mouth.states.neutral.sourceSha256='not-a-sha256',
    m=>m.poses.front.foregroundProtection.source=m.poses['view-left'].source,
    m=>m.poses.front.foregroundProtection.sourceSha256='0'.repeat(64),
    m=>m.poses.front.foregroundProtection.polygons[0][0]=[-1,0],
    m=>m.poses.front.features.nose.states.neutral.knots[4]=m.poses.front.features.nose.states.neutral.knots[3],
    m=>m.poses.front.features.eyeLeft.states.closed.lower[4]=m.poses.front.features.eyeLeft.states.closed.upper[4],
    m=>m.poses.front.features.eyeLeft.states.closed.crease[4]=m.poses.front.features.eyeLeft.states.closed.upper[4],
    m=>delete m.poses.front.features.eyeLeft.states.closed.crease,m=>m.poses.front.features.mouth.pads=[1,2,3,Infinity],
  ]){const m=structuredClone(manifest);mutate(m);assert.throws(()=>validateFeatureManifest(m));}
});

test('every registered source is an exact endpoint at landmarks and outside the feature core',()=>{
  for(const [poseId,pose] of Object.entries(manifest.poses))for(const [name,f] of Object.entries(pose.features))for(const frame of Object.keys(f.states)){
    const c=featureChartsForState(manifest,poseId,{...state(),[name]:frame})[FEATURE_GROUPS.indexOf(name)];
    for(const u of [-.2,0,.125,.33,.5,.875,1,1.2])for(const v of [-2,0,.5,1,3]){const p=chartPoint(c,u,v);near(mapFeaturePoint(c,c,p),p);}
    for(let i=0;i<9;i++){const p=native(c,c.knots[i],c.crease[i]);near(mapFeaturePoint(c,c,p),p);near(featureSourceUVCPU(c,c,p),[p[0]/1122,p[1]/1402]);}
  }
});

test('nonuniform bridge knots preserve the primary nose segment instead of stretching it',()=>{
  const a=set('front')[0],b=set('view-right-down')[0],target=blendFeatureCharts([a,b],[.37,.63]);
  assert.notEqual((target.knots[4]-target.knots[0])/(target.knots[8]-target.knots[0]),.5);
  for(const source of [a,b])for(let i=0;i<9;i++)for(const key of ['upper','lower'])near(mapFeaturePoint(target,source,native(target,target.knots[i],target[key][i])),native(source,source.knots[i],source[key][i]));
  near(mapFeaturePoint(target,b,chartPoint(target,.5,.5)),chartPoint(b,.5,.5));
  let previous=-Infinity;for(let i=0;i<=200;i++){const y=target.knots[0]+(target.knots[8]-target.knots[0])*i/200,p=mapFeaturePoint(target,b,[750,y]);assert.ok(p[1]>previous);previous=p[1];}
});

test('crease/upper/lower each align to their source line, continuously and without folds',()=>{
  const a=set('front','closed')[1],b=set('view-right-down','threeQuarter')[1],target=blendFeatureCharts([a,b],[.45,.55]);assert.equal(target.includeCrease,true);
  for(let i=0;i<9;i++)for(const source of [a,b]){
    for(const key of ['crease','upper','lower'])near(mapFeaturePoint(target,source,[target.knots[i],target[key][i]]),[source.knots[i],source[key][i]]);
    near(mapFeaturePoint(target,source,[target.knots[i],(target.crease[i]+target.upper[i])/2]),[source.knots[i],(source.crease[i]+source.upper[i])/2]);
    near(mapFeaturePoint(target,source,[target.knots[i],target.crease[i]-8]),[source.knots[i],source.crease[i]-8]);
    let previous=-Infinity;for(let step=0;step<=100;step++){const y=target.crease[i]-20+(target.lower[i]-target.crease[i]+40)*step/100,p=mapFeaturePoint(target,source,[target.knots[i],y]);assert.ok(p[1]>previous);previous=p[1];}
  }
  for(let i=1;i<8;i++){const x=target.knots[i],y=target.upper[i],l=mapFeaturePoint(target,b,[x-1e-6,y]),r=mapFeaturePoint(target,b,[x+1e-6,y]);assert.ok(Math.hypot(l[0]-r[0],l[1]-r[1])<.001);}
});

test('six packed slots are target,A0,B0,A1,B1,A2,B2 with independent bbox/curve texels',()=>{
  const sources=[set('front','open'),set('front','closed'),set('view-left','quarter','parted'),set('view-left','half','openSmall'),set('view-right','threeQuarter','openMedium'),set('view-right','closed','openWide')];
  const target=blendFeatureSets(sources,[.1,.2,.15,.15,.2,.2]),data=packFeatureGeometry(target,sources);
  assert.deepEqual([FEATURE_TEXTURE_WIDTH,FEATURE_TEXTURE_HEIGHT,FEATURE_ROWS_PER_GROUP,FEATURE_SOURCE_COUNT],[12,42,7,6]);assert.equal(data.length,12*42*4);
  for(let f=0;f<6;f++)for(let row=0;row<7;row++){
    const c=row===0?target[f]:sources[row-1][f],o=(f*7+row)*12*4;if(!c){assert.equal(data[o+2],-1);continue;}
    near([...data.slice(o,o+4)],[...c.range,c.axis,c.includeCrease?1:0],1e-4);near([...data.slice(o+8,o+12)],featureBounds(c),1e-4);
    for(let i=0;i<9;i++)near([...data.slice(o+(i+3)*4,o+(i+4)*4)],[c.upper[i],c.lower[i],c.crease[i],c.knots[i]],1e-4);
  }
  assert.throws(()=>packFeatureGeometry(target,sources.slice(0,3)));
});

test('nose/mouth have no fake crease influence; actual eye crease and smooth feather are covered',()=>{
  const charts=set('front','closed');for(const f of [0,3]){const c=charts[f];assert.equal(c.includeCrease,false);near(c.crease,c.upper.map(v=>v-19));assert.equal(featureBounds(c)[c.axis===1?0:1],Math.min(...c.upper)-c.pads[2]-c.pads[3]);}
  const eye=charts[1];for(let i=0;i<9;i++)assert.equal(featureInfluenceCPU(eye,[eye.knots[i],eye.crease[i]]),1);
  const box=featureBounds(eye);assert.equal(featureInfluenceCPU(eye,[box[0]-1,box[1]]),0);assert.equal(featureInfluenceCPU(eye,[box[2]+1,box[3]]),0);
  const y=eye.crease[4]-eye.pads[2]-eye.pads[3]/2;assert.ok(Math.abs(featureInfluenceCPU(eye,[eye.knots[4],y])-.5)<1e-8);
});

test('zero-weight missing geometry preserves endpoints, but active missing geometry fails closed',()=>{
  const source=set('front'),missing=Array(6).fill(null),endpoint=blendFeatureSets([source,missing],[1,0]);
  for(let f=0;f<4;f++)near(chartPoint(endpoint[f],.5,.5),chartPoint(source[f],.5,.5));
  assert.throws(()=>blendFeatureSets([source,missing],[.5,.5]));assert.throws(()=>blendFeatureCharts([source[0],source[1]],[.5,.5]));assert.throws(()=>blendFeatureCharts([source[0]],[.9]));
});
