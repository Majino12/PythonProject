import test from 'node:test';
import assert from 'node:assert/strict';
import {createHairMeshBinding,validateHairMeshBinding,serializeHairMeshBinding,deformHairMesh,sampleHairMeshDisplacement,HAIR_MESH_POSES} from './short-hair-mesh-model.js';

const spec=(extra={})=>({schemaVersion:1,kind:'short-hair-mesh-binding',poseId:'front',sourceSha256:'1'.repeat(64),bounds:[200,200,700,500],grid:{columns:17,rows:13},rootLine:[[200,250],[900,250]],tipLine:[[200,580],[900,580]],travel:{x:5.8,y:1},revealMarginPx:8,runtimeValidated:true,protectedRegions:[],...extra});
const close=(a,b,epsilon=1e-8)=>assert.ok(Math.abs(a-b)<=epsilon,`${a} != ${b}`);

test('registered native mesh is immutable, deterministic and serializes without geometry or hidden approval claims',()=>{
  const raw=spec(),binding=createHairMeshBinding(raw),again=validateHairMeshBinding(serializeHairMeshBinding(binding));
  assert.deepEqual(binding,again);assert.equal(binding.positions.length/2,binding.weights.length);
  assert.equal(binding.triangles.length/3,2*(binding.xStops.length-1)*(binding.yStops.length-1));
  assert.ok(Object.isFrozen(binding)&&Object.isFrozen(binding.positions)&&Object.isFrozen(binding.rootLine[0]));
  raw.rootLine[0][1]=499;raw.travel.x=12;assert.equal(binding.rootLine[0][1],250);assert.equal(binding.travel.x,5.8);
  assert.equal(Object.hasOwn(serializeHairMeshBinding(binding),'positions'),false);assert.equal(Object.hasOwn(binding,'approved'),false);
});

test('rest, original, disabled and unvalidated states preserve the exact coordinate array',()=>{
  for(const extra of [{},{runtimeValidated:false,revealMarginPx:0}]){
    const b=createHairMeshBinding(spec(extra));
    for(const [control,options]of [[{x:0,y:0},{}],[{x:1,y:1},{original:true}],[{x:1,y:1},{enabled:false}]]){
      const f=deformHairMesh(b,control,options);assert.equal(f.moved,false);assert.strictEqual(f.positions,b.positions);
    }
    if(!b.runtimeValidated)assert.strictEqual(deformHairMesh(b,{x:1,y:1}).positions,b.positions);
  }
  assert.deepEqual(deformHairMesh(null,{x:1,y:1}),{binding:null,positions:null,moved:false,maxDisplacementPx:0,minimumAreaRatio:1});
});

test('all controls obey the revealed-band displacement bound without temporal state or folding',()=>{
  const b=createHairMeshBinding(spec()),baseline=[...b.positions];
  assert.ok(b.minimumAreaRatio>=.5-1e-8);
  for(let x=-1;x<=1;x+=.2)for(let y=-1;y<=1;y+=.2){
    const f=deformHairMesh(b,{x,y});assert.ok(f.minimumAreaRatio>=.5-1e-8);assert.ok(f.maxDisplacementPx+2<=b.revealMarginPx+1e-8);
    for(let i=0;i<b.weights.length;i++){
      const dx=f.positions[i*2]-b.positions[i*2],dy=f.positions[i*2+1]-b.positions[i*2+1];
      assert.ok(Math.hypot(dx,dy)<=Math.hypot(5.8,1)+1e-8);
      if(b.positions[i*2+1]<=250)assert.equal(Math.hypot(dx,dy),0);
    }
  }
  assert.deepEqual(b.positions,baseline);assert.deepEqual(deformHairMesh(b,{x:.35,y:-.4}),deformHairMesh(b,{x:.35,y:-.4}));
});

test('piecewise sloping roots remain pinned along every segment, including inside triangles',()=>{
  const rootLine=[[200,240],[430,300],[600,250],[900,320]],b=createHairMeshBinding(spec({rootLine})),f=deformHairMesh(b,{x:1,y:1});
  for(let i=0;i<rootLine.length-1;i++)for(let k=0;k<=40;k++){
    const t=k/40,a=rootLine[i],z=rootLine[i+1],x=a[0]+t*(z[0]-a[0]),y=a[1]+t*(z[1]-a[1]);
    const value=sampleHairMeshDisplacement(b,f,x,y);close(value.x,0);close(value.y,0);
    const above=sampleHairMeshDisplacement(b,f,x,y-1);close(above.x,0);close(above.y,0);
  }
  assert.ok(sampleHairMeshDisplacement(b,f,550,650).x>5);
});

test('small and diagonal feature polygons pin intersecting triangles rather than testing vertices only',()=>{
  const polygon=[[510,470],[516,472],[534,535],[529,537]],b=createHairMeshBinding(spec({grid:{columns:3,rows:3},protectedRegions:[{polygon,padding:8}]}));
  const f=deformHairMesh(b,{x:1,y:-1});assert.ok(b.protectedTriangleVertexCount>0);
  for(let n=0;n<=40;n++){
    const t=n/40,x=513+t*18.5,y=472+t*62;
    const d=sampleHairMeshDisplacement(b,f,x,y);close(d.x,0);close(d.y,0);
  }
  assert.ok(f.moved);assert.ok(f.minimumAreaRatio>=.5-1e-8);
});

test('feature guards keep the central hair gap movable and do not shift existing face features',()=>{
  const b=createHairMeshBinding(spec({grid:{columns:33,rows:25},protectedRegions:[
    {rect:[347,448,167,116],padding:16},{rect:[606,448,155,116],padding:16},
    {polygon:[[368,397],[506,397],[506,464],[468,461],[420,453],[368,450]],padding:16},
    {polygon:[[592,395],[750,395],[750,450],[705,450],[655,458],[608,463],[592,463]],padding:16},
  ]})),f=deformHairMesh(b,{x:1,y:.18});
  for(const [x,y]of [[400,500],[680,500],[470,430],[600,425]])assert.deepEqual(sampleHairMeshDisplacement(b,f,x,y),{x:0,y:0});
  assert.ok(sampleHairMeshDisplacement(b,f,560,530).x>4.5);
});

test('weight limiting keeps sharp protected transitions safe without increasing any displacement',()=>{
  const b=createHairMeshBinding(spec({protectedRegions:[{rect:[450,450,100,100],padding:0}]}));
  assert.ok(b.slopeLimitedVertexCount>0);assert.ok(b.minimumAreaRatio>=.5-1e-8);
  for(const x of [-1,1])for(const y of [-1,1])assert.ok(deformHairMesh(b,{x,y}).minimumAreaRatio>=.5-1e-8);
  assert.ok(b.weights.every(value=>value>=0&&value<=1));
});

test('nine registered pose identifiers are accepted without reusing or mirroring their coordinates',()=>{
  for(const [index,poseId]of HAIR_MESH_POSES.entries()){
    const b=createHairMeshBinding(spec({poseId,rootLine:[[200,250+index],[900,250+index]],sourceSha256:String(index+1).repeat(64)}));
    assert.equal(b.poseId,poseId);assert.equal(b.rootLine[0][1],250+index);assert.equal(b.sourceSha256,String(index+1).repeat(64));
  }
});

test('invalid or underspecified registration, polygons, source identity and controls fail closed',()=>{
  const cases=[{schemaVersion:2},{kind:'anything'},{poseId:'unknown'},{sourceSha256:'no hash'}, {runtimeValidated:'yes'},
    {bounds:[0,0,1123,1402]},{bounds:[0,0,NaN,5]}, {grid:{columns:1,rows:17}},{grid:{columns:65,rows:17}},
    {rootLine:[[200,580],[900,580]]},{tipLine:[[201,600],[900,600]]},{travel:{x:13,y:1}},{revealMarginPx:7},
    {protectedRegions:[{rect:[1,1,-2,3],padding:8}]},{protectedRegions:[{polygon:[[1,1],[3,3],[1,3],[3,1]],padding:8}]},
    {protectedRegions:[{rect:[1,1,2,3],polygon:[[1,1],[3,1],[3,3]],padding:8}]}, {approval:'approved'}];
  for(const value of cases)assert.throws(()=>createHairMeshBinding(spec(value)),JSON.stringify(value));
  const b=createHairMeshBinding(spec());
  for(const c of [{x:NaN,y:0},{x:1.1,y:0},{x:'1',y:0},{x:1},{x:1,y:1,z:1}])assert.throws(()=>deformHairMesh(b,c));
  assert.throws(()=>deformHairMesh(spec(),{x:1,y:0}));assert.throws(()=>deformHairMesh(b,{x:0,y:0},{enabled:1}));
  const inherited=Object.assign(Object.create({poseId:'front'}),spec());delete inherited.poseId;assert.throws(()=>createHairMeshBinding(inherited));
});
