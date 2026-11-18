import test from 'node:test';
import assert from 'node:assert/strict';
import {FEATURE_DIAGNOSTIC_EPSILON,FEATURE_DIAGNOSTIC_PIXEL_LIMIT,FEATURE_DIAGNOSTIC_DRAW_LIMIT,
  featurePoseCases,featureHeadSeams,featureVertexApproaches,buildFeatureDiagnosticPlan,compareFeaturePixels,featureActionSample,
  featureJointEndpointCases,selectFeatureSeamConvergenceCases,featureSeamPointsAtEpsilon,FEATURE_CONVERGENCE_EPSILONS} from './short-hair-feature-diagnostics.js';
import {STUDIO_HEAD_POSES} from './short-hair-pose-motion.js';
import {validateSecondaryFrame} from './short-hair-secondary-motion.js';
import {locateHeadTriangle} from './short-hair-continuous-model.js';
import {ARTICULATION_EYES,ARTICULATION_JAW,ARTICULATION_SPECIAL_MOUTHS,articulationFromState,validateArticulationState,validateArticulation} from './short-hair-articulation.js';

function fixture(){
  const patches=(front=false)=>Object.fromEntries(Object.entries({eyeLeft:ARTICULATION_EYES.slice(1),eyeRight:ARTICULATION_EYES.slice(1),
    mouth:[...ARTICULATION_JAW.slice(1),...ARTICULATION_SPECIAL_MOUTHS],browLeft:front?['up','down']:['innerUp','outerUp','down'],browRight:front?['up','down']:['innerUp','outerUp','down']})
    .map(([group,states])=>[group,Object.fromEntries(states.map(state=>[state,{src:`registered-${group}-${state}`}]))]));
  return {poses:STUDIO_HEAD_POSES.map(pose=>({...pose,sourceFamily:pose.id==='front'?'front':'side'})),front:{manifest:{patches:patches(true)}},
    side:{manifest:{poses:Object.fromEntries(STUDIO_HEAD_POSES.filter(pose=>pose.id!=='front').map(pose=>[pose.id,{patches:patches()}]))}}};
}
const image=(width,height,data)=>({width,height,data:new Uint8ClampedArray(data)});

test('full diagnostic covers nine actual source inventories within a strict sub-1000 draw budget',()=>{
  const assets=fixture(),plan=buildFeatureDiagnosticPlan(assets);
  assert.equal(plan.renderCalls,919);assert.ok(plan.renderCalls<=FEATURE_DIAGNOSTIC_DRAW_LIMIT);assert.ok(FEATURE_DIAGNOSTIC_DRAW_LIMIT<1000);
  assert.equal(plan.poses.length,9);assert.equal(plan.poses.reduce((sum,pose)=>sum+pose.endpoints.length,0),143);
  assert.equal(plan.poses.reduce((sum,pose)=>sum+pose.edges.length,0),134);
  for(const pose of plan.poses){
    for(const eye of ARTICULATION_EYES)for(const group of ['eyeLeft','eyeRight'])assert.ok(pose.endpoints.some(state=>state[group]===eye),`${pose.poseId}/${group}/${eye}`);
    for(const mouth of [...ARTICULATION_JAW,...ARTICULATION_SPECIAL_MOUTHS])assert.ok(pose.endpoints.some(state=>state.mouth===mouth));
    const realBrows=pose.poseId==='front'?['neutral','up','down']:['neutral','innerUp','outerUp','down'];
    for(const brow of realBrows)for(const group of ['browLeft','browRight'])assert.ok(pose.endpoints.some(state=>state[group]===brow));
    for(const state of pose.endpoints)assert.doesNotThrow(()=>articulationFromState(state));
    for(const edge of pose.edges){
      const a={...articulationFromState()},b={...articulationFromState()};
      for(const group of edge.groups){a[group]={from:edge.from,to:edge.to,t:FEATURE_DIAGNOSTIC_EPSILON};b[group]={from:edge.from,to:edge.to,t:1-FEATURE_DIAGNOSTIC_EPSILON};}
      assert.notDeepEqual(a,b);
    }
  }
});

test('diagnostics refuse missing authored states and unsupported or duplicate pose inventories',()=>{
  const assets=fixture();delete assets.side.manifest.poses['view-left'].patches.eyeRight.quarter;
  assert.throws(()=>buildFeatureDiagnosticPlan(assets),/实际画稿/);
  for(const change of [poses=>poses.slice(1),poses=>[...poses.slice(1),poses[1]],poses=>poses.map((pose,index)=>index?pose:{...pose,id:'invented'})]){
    const bad=fixture();bad.poses=change(bad.poses);assert.throws(()=>buildFeatureDiagnosticPlan(bad),/九个/);
  }
  assert.throws(()=>featurePoseCases({},fixture().poses[0]),/清单/);
});

test('all four quadrants and internal axis seams compare different neighboring triangles',()=>{
  const seams=featureHeadSeams();assert.equal(seams.length,24);
  assert.equal(new Set(seams.map(seam=>seam.id)).size,24);
  assert.equal(seams.filter(seam=>seam.id.startsWith('diagonal')).length,12);
  const effective=head=>locateHeadTriangle(head).vertices.filter(vertex=>vertex.weight>0).map(vertex=>vertex.poseId).sort().join(',');
  for(const seam of seams){
    assert.notEqual(effective(seam.before),effective(seam.after),seam.id);
    for(const axis of ['yaw','pitch'])assert.ok(Math.abs((seam.before[axis]+seam.after[axis])/2-seam.center[axis])<1e-12);
    for(const point of [seam.before,seam.center,seam.after])assert.ok(Math.abs(point.yaw)<=1&&Math.abs(point.pitch)<=1);
  }
  assert.throws(()=>featureHeadSeams(0));assert.throws(()=>featureHeadSeams(NaN));
});

test('every pose vertex is approached from all valid neighboring directions, including corner diagonals',()=>{
  const vertices=featureVertexApproaches();assert.equal(vertices.length,9);assert.equal(vertices.reduce((sum,vertex)=>sum+vertex.approaches.length,0),40);
  for(const vertex of vertices){
    const {yaw,pitch}=vertex.center,expected=(Math.abs(yaw)===1?2:3)*(Math.abs(pitch)===1?2:3)-1;
    assert.equal(vertex.approaches.length,expected);
    for(const approach of vertex.approaches){assert.notDeepEqual(approach,vertex.center);assert.ok(Math.abs(approach.yaw)<=1&&Math.abs(approach.pitch)<=1);}
  }
  assert.throws(()=>featureVertexApproaches(Infinity));
});

test('raw RGBA metrics retain real outliers and never silently weaken the fixed two-level check',()=>{
  const a=image(2,1,[10,20,30,255,0,0,0,0]),identical=compareFeaturePixels(a,a);
  assert.equal(identical.exact,true);assert.equal(identical.maxAbsRgba,0);assert.equal(identical.boundsAbove2,null);
  const b=image(2,1,[12,19,30,253,200,0,0,0]),metrics=compareFeaturePixels(a,b);
  assert.equal(FEATURE_DIAGNOSTIC_PIXEL_LIMIT,2);assert.equal(metrics.maxAbsRgba,200);assert.equal(metrics.withinFixedTwoLevels,false);
  assert.equal(metrics.maxVisibleRgb,2);assert.equal(metrics.maxAlpha,2);assert.equal(metrics.changedPixels,2);assert.equal(metrics.pixelsAbove2,1);
  assert.equal(metrics.fractionAbove2,.5);assert.deepEqual(metrics.boundsAbove2,{left:1,top:0,right:1,bottom:0});assert.equal(metrics.meanAbsRgba,205/8);
  const two=compareFeaturePixels(a,image(2,1,[12,20,30,255,0,0,0,0]));assert.equal(two.exact,false);assert.equal(two.withinFixedTwoLevels,true);
  const three=compareFeaturePixels(a,image(2,1,[13,20,30,255,0,0,0,0]));assert.equal(three.withinFixedTwoLevels,false);
  assert.throws(()=>compareFeaturePixels(a,image(1,1,[0,0,0,0])));assert.throws(()=>compareFeaturePixels(image(0,0,[]),image(0,0,[])));
});

test('timed action loop requests authored blinks, jaw, special mouths and both brows across continuous head motion',()=>{
  const sampled=Array.from({length:800},(_,i)=>featureActionSample(i*10));
  for(const sample of sampled){assert.doesNotThrow(()=>validateArticulationState(sample.state));assert.ok(Math.abs(sample.headPose.yaw)<1&&Math.abs(sample.headPose.pitch)<1);}
  for(const mouth of ['neutral','openWide',...ARTICULATION_SPECIAL_MOUTHS])assert.ok(sampled.some(sample=>sample.state.mouth===mouth),mouth);
  for(const eye of ['eyeLeft','eyeRight'])assert.ok(sampled.some(sample=>sample.state[eye]==='closed'));
  for(const brow of ['browLeft','browRight'])assert.ok(sampled.some(sample=>sample.state[brow]==='down'));
  for(let i=1;i<sampled.length;i++)for(const axis of ['yaw','pitch'])assert.ok(Math.abs(sampled[i].headPose[axis]-sampled[i-1].headPose[axis])<.011);
  assert.deepEqual(featureActionSample(8000),featureActionSample(0));assert.throws(()=>featureActionSample(-1));assert.throws(()=>featureActionSample(NaN));
});

test('premultiplied and opaque diagnostics explain transparent RGB without changing raw failures',()=>{
  const barelyA=image(2,1,[255,80,0,1,20,30,40,255]),barelyB=image(2,1,[0,0,0,1,23,30,40,255]);
  const metrics=compareFeaturePixels(barelyA,barelyB);
  assert.equal(metrics.maxAbsRgba,255);assert.equal(metrics.withinFixedTwoLevels,false);assert.equal(metrics.exact,false);
  assert.equal(metrics.maxAbsPremultipliedRgb,3);assert.equal(metrics.withinFixedTwoPremultipliedRgbLevels,false);
  assert.equal(metrics.opaqueAlphaMinimum,250);assert.equal(metrics.opaquePixels,1);assert.equal(metrics.maxAbsOpaqueRgb,3);assert.equal(metrics.maxAbsOpaqueRgba,3);
  assert.equal(metrics.opaquePixelsAbove2,1);assert.equal(metrics.withinFixedTwoOpaqueLevels,false);
  const transparent=compareFeaturePixels(image(1,1,[255,255,255,1]),image(1,1,[0,0,0,1]));
  assert.equal(transparent.maxAbsRgba,255);assert.equal(transparent.withinFixedTwoLevels,false);
  assert.equal(transparent.maxAbsPremultipliedRgb,1);assert.equal(transparent.withinFixedTwoPremultipliedRgbaLevels,true);
  assert.equal(transparent.opaquePixels,0);assert.equal(transparent.maxAbsOpaqueRgba,null);assert.equal(transparent.withinFixedTwoOpaqueLevels,null);
  const alpha=compareFeaturePixels(image(1,1,[255,255,255,255]),image(1,1,[255,255,255,250]));
  assert.equal(alpha.maxAbsPremultipliedRgb,5);assert.equal(alpha.maxAlpha,5);assert.equal(alpha.maxAbsOpaqueRgb,0);assert.equal(alpha.maxAbsOpaqueRgba,5);
  assert.equal(alpha.withinFixedTwoPremultipliedRgbaLevels,false);assert.equal(alpha.withinFixedTwoOpaqueLevels,false);
  const oneOpaque=compareFeaturePixels(image(1,1,[255,255,255,255]),image(1,1,[255,255,255,249]));
  assert.equal(oneOpaque.opaquePixels,0);assert.equal(oneOpaque.maxAbsOpaqueRgb,null);
});


test('joint endpoint probes isolate each group while all four other groups retain distinct fractional progress',()=>{
  const cases=featureJointEndpointCases();assert.equal(cases.length,30);assert.equal(cases.length*2,60);
  assert.deepEqual(new Set(cases.map(item=>item.poseId)),new Set(['front','view-left-up','view-right-down']));
  for(const item of cases){
    assert.doesNotThrow(()=>validateArticulation(item.near));assert.doesNotThrow(()=>validateArticulation(item.expected));
    const peers=Object.keys(item.near).filter(group=>group!==item.group);
    for(const group of peers){assert.deepEqual(item.near[group],item.expected[group]);assert.ok(item.near[group].t>0&&item.near[group].t<1);}
    assert.equal(new Set(peers.map(group=>item.near[group].t)).size,4);
    assert.equal(item.expected[item.group].from,item.expected[item.group].to);assert.equal(item.expected[item.group].t,0);
    assert.equal(item.near[item.group].t,item.end?1-FEATURE_DIAGNOSTIC_EPSILON:FEATURE_DIAGNOSTIC_EPSILON);
    assert.equal(item.expected[item.group].from,item.near[item.group][item.end?'to':'from']);
  }
});

test('convergence probes retain original failures, rank distinct visible cases and use only fixed smaller offsets',()=>{
  const seams=featureHeadSeams(),state={...ARTICULATION_EYES};
  const cases=Array.from({length:12},(_,index)=>({kind:'triangle-seam',id:'case-'+index,seam:seams[index],state,side:'across',
    metrics:{maxAbsOpaqueRgba:index,maxAbsPremultipliedRgb:index/2,maxAbsRgba:255,withinFixedTwoLevels:false}}));
  cases.push({...cases[11],id:'duplicate-side',side:'before',metrics:{...cases[11].metrics,maxAbsOpaqueRgba:14}});
  const before=structuredClone(cases),selected=selectFeatureSeamConvergenceCases(cases);
  assert.deepEqual(cases,before);assert.equal(selected.length,8);assert.equal(selected[0].score,14);assert.equal(selected[0].originalCases.length,2);
  assert.equal(new Set(selected.map(item=>item.seam.id)).size,8);assert.equal(selected.at(-1).score,4);
  assert.deepEqual(FEATURE_CONVERGENCE_EPSILONS,[1e-5,1e-6,1e-7]);
  for(const seam of seams)for(const epsilon of FEATURE_CONVERGENCE_EPSILONS){
    const points=featureSeamPointsAtEpsilon(seam,epsilon);assert.deepEqual(points.center,seam.center);
    const span=Math.max(Math.abs(points.before.yaw-points.after.yaw),Math.abs(points.before.pitch-points.after.pitch));
    assert.ok(Math.abs(span-2*epsilon)<1e-15);
    const priorSide=Math.sign(seam.before.yaw-seam.center.yaw)||Math.sign(seam.before.pitch-seam.center.pitch);
    const nextSide=Math.sign(points.before.yaw-points.center.yaw)||Math.sign(points.before.pitch-points.center.pitch);assert.equal(nextSide,priorSide);
  }
  assert.throws(()=>featureSeamPointsAtEpsilon(seams[0],1e-8));assert.throws(()=>selectFeatureSeamConvergenceCases(cases,9));
});


test('eight-second playback overlaps eye, mouth and brow targets while exercising bounded retained fringe motion',()=>{
  const blink=featureActionSample(950);
  assert.equal(blink.state.eyeLeft,'closed');assert.equal(blink.state.eyeRight,'closed');
  assert.equal(blink.state.browLeft,'up');assert.equal(blink.state.browRight,'down');
  assert.ok(Math.abs(blink.secondary.hair)>.3);
  const jaw=featureActionSample(2100);
  assert.equal(jaw.state.mouth,'openWide');assert.equal(jaw.state.eyeRight,'closed');assert.equal(jaw.state.eyeLeft,'open');assert.equal(jaw.state.browLeft,'down');
  assert.ok(Math.abs(jaw.secondary.hair)>.5);
  const late=featureActionSample(7000);assert.equal(late.state.eyeLeft,'closed');assert.equal(late.state.browRight,'up');
  const samples=Array.from({length:801},(_,i)=>featureActionSample(i*10));
  for(const sample of samples){
    assert.doesNotThrow(()=>validateSecondaryFrame(sample.secondary));
    assert.ok(Math.abs(sample.secondary.breath)<=.3);assert.ok(Math.abs(sample.secondary.sway)<=.2);assert.ok(Math.abs(sample.secondary.hair)<=.6);
  }
  for(let i=1;i<samples.length;i++)for(const key of ['breath','sway','hair'])assert.ok(Math.abs(samples[i].secondary[key]-samples[i-1].secondary[key])<.005);
  assert.ok(samples.some(sample=>sample.secondary.hair>.59));assert.ok(samples.some(sample=>sample.secondary.hair<-.59));
  assert.deepEqual(featureActionSample(0).secondary,{breath:0,sway:0,hair:0});assert.deepEqual(featureActionSample(8000).secondary,{breath:0,sway:0,hair:0});
});
