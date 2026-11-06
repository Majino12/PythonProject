import test from 'node:test';
import assert from 'node:assert/strict';
import {STUDIO_HEAD_POSES,poseHeadCoordinates} from './short-hair-pose-motion.js';
import {CONTINUOUS_EDGES,locateHeadTriangle,continuousViewport} from './short-hair-continuous-model.js';

const distance = (a,b) => Math.hypot(a.yaw-b.yaw,a.pitch-b.pitch);
const weights = head => Object.fromEntries(STUDIO_HEAD_POSES.map(pose =>
  [pose.id,locateHeadTriangle(head).vertices.find(vertex=>vertex.poseId===pose.id)?.weight || 0]));
const reconstructed = head => locateHeadTriangle(head).vertices.reduce((sum,vertex)=>{
  const pose=poseHeadCoordinates(vertex.poseId);
  return {yaw:sum.yaw+pose.yaw*vertex.weight,pitch:sum.pitch+pose.pitch*vertex.weight};
},{yaw:0,pitch:0});

test('sixteen unique model edges consist of twelve axes and four top-left-to-bottom-right diagonals',()=>{
  assert.equal(CONTINUOUS_EDGES.length,16);
  assert.equal(new Set(CONTINUOUS_EDGES.map(edge=>[edge.from,edge.to].sort().join('|'))).size,16);
  let axes=0,diagonals=0;
  for(const edge of CONTINUOUS_EDGES) {
    const a=poseHeadCoordinates(edge.from),b=poseHeadCoordinates(edge.to);
    const dx=b.yaw-a.yaw,dy=b.pitch-a.pitch;
    if(dx===1&&dy===-1)diagonals++;
    else {assert.ok(dx===1&&dy===0 || dx===0&&dy===-1);axes++;}
  }
  assert.equal(axes,12);assert.equal(diagonals,4);
});

test('every authored vertex resolves exactly to its own painting',()=>{
  for(const pose of STUDIO_HEAD_POSES) {
    const active=locateHeadTriangle(poseHeadCoordinates(pose.id)).vertices.filter(vertex=>vertex.weight>0);
    assert.deepEqual(active,[{poseId:pose.id,weight:1}]);
  }
});

test('triangle weights are nonnegative, sum to one and reconstruct all fractional grid coordinates',()=>{
  const edgeSet=new Set(CONTINUOUS_EDGES.map(edge=>[edge.from,edge.to].sort().join('|')));
  for(let y=0;y<=80;y++)for(let x=0;x<=80;x++) {
    const head={yaw:x/40-1,pitch:y/40-1},vertices=locateHeadTriangle(head).vertices;
    assert.equal(vertices.length,3);assert.equal(new Set(vertices.map(v=>v.poseId)).size,3);
    assert.ok(vertices.every(v=>v.weight>=0&&v.weight<=1));
    assert.ok(Math.abs(vertices.reduce((sum,v)=>sum+v.weight,0)-1)<1e-12);
    assert.ok(distance(reconstructed(head),head)<1e-12);
    for(let a=0;a<3;a++)for(let b=a+1;b<3;b++)
      assert.ok(edgeSet.has([vertices[a].poseId,vertices[b].poseId].sort().join('|')));
  }
});

test('all diagonal seams use only their two endpoints and converge from both triangles',()=>{
  const epsilon=1e-8;
  for(const top of [1,0])for(const left of [-1,0])for(const t of [.1,.25,.5,.75,.9]) {
    const head={yaw:left+t,pitch:top-t},center=weights(head);
    const expected=new Set([STUDIO_HEAD_POSES.find(p=>p.yaw===left&&p.pitch===top).id,
      STUDIO_HEAD_POSES.find(p=>p.yaw===left+1&&p.pitch===top-1).id]);
    for(const [id,weight] of Object.entries(center))if(weight>1e-12)assert.ok(expected.has(id));
    for(const side of [-1,1]) {
      const nearby=weights({...head,pitch:head.pitch+side*epsilon});
      for(const id of Object.keys(center))assert.ok(Math.abs(center[id]-nearby[id])<epsilon*2);
    }
  }
});

test('internal horizontal and vertical cell seams have continuous weights with no third-pose pop',()=>{
  const epsilon=1e-8;
  for(const value of [-.9,-.6,-.2,0,.2,.6,.9])for(const axis of ['yaw','pitch']) {
    const head=axis==='yaw'?{yaw:0,pitch:value}:{yaw:value,pitch:0},center=weights(head);
    for(const direction of [-1,1]) {
      const near=weights({...head,[axis]:direction*epsilon});
      for(const id of Object.keys(center))assert.ok(Math.abs(center[id]-near[id])<epsilon*3);
      assert.ok(distance(reconstructed({...head,[axis]:direction*epsilon}),head)<epsilon*2);
    }
  }
});

test('viewport stays in one source coordinate system throughout turns and cannot be mutated globally',()=>{
  for(const pose of STUDIO_HEAD_POSES) {
    assert.deepEqual(continuousViewport(poseHeadCoordinates(pose.id)),[200,270,780,600]);
    assert.deepEqual(continuousViewport(poseHeadCoordinates(pose.id),{faceOnly:false}),[0,0,1122,1402]);
  }
  const view=continuousViewport({yaw:.4,pitch:-.25});view[0]=999;
  assert.equal(continuousViewport({yaw:0,pitch:0})[0],200);
  assert.throws(()=>continuousViewport({yaw:0,pitch:0},{faceOnly:'yes'}));
});

test('invalid head coordinates fail before locating model edges or a viewport',()=>{
  for(const invalid of [null,{yaw:0},{yaw:0,pitch:NaN},{yaw:0,pitch:1.01},{yaw:0,pitch:0,path:'remote'}]) {
    assert.throws(()=>locateHeadTriangle(invalid));assert.throws(()=>continuousViewport(invalid));
  }
});
