import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateSideExpressionManifest} from './side-expression-renderer.js';
import {SIDE_MOUTH_STATES,selectSideMouthExpression} from './side-mouth-model.js';
import {SIDE_BROW_STATES} from './side-brow-model.js';

const read=file=>JSON.parse(readFileSync(new URL(file,import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=read('./assets/short-hair-complete-poses-v1/manifest.json');
const approved=read('./assets/short-hair-pitch-brows-v1/manifest.json');
const approval=read('./assets/short-hair-pitch-brows-v1/approval.json');
const registration=read('./assets/short-hair-complete-poses-v1/validation/registration.json');
const provenanceURL=new URL(manifest.provenance,import.meta.url);
const provenance=JSON.parse(readFileSync(provenanceURL));
const POSES=['view-down','view-right-down','view-up'];
const STATES=['neutral','half-small','closed-wide','pucker','press','shiftLeft','shiftRight','innerUp','outerUp','down','eye-whites','irises-fill'];

test('three completed poses own thirty-six distinct native source paintings and all expression capabilities',()=>{
  validateSideExpressionManifest(manifest);
  assert.equal(manifest.id,'short-hair-complete-poses-v1'); assert.equal(manifest.status,'candidate');
  assert.equal(manifest.poseFamily,'completePitch'); assert.equal(manifest.extends,approved.id);
  assert.deepEqual(Object.keys(manifest.poses).sort(),POSES);
  assert.deepEqual(manifest.mouthArt,{version:1,states:[...SIDE_MOUTH_STATES]});
  assert.deepEqual(manifest.browArt,{version:1,states:[...SIDE_BROW_STATES]});
  assert.equal(Object.keys(manifest.sources).length,36);
  const hashes=new Set(),paths=new Set(),oldHashes=new Set(Object.values(approved.sources).map(source=>source.sha256));
  for(const poseId of POSES) for(const state of STATES){
    const key=`${poseId}-${state}`,source=manifest.sources[key]; assert.ok(source,key); assert.equal(source.pose,poseId);
    const bytes=readFileSync(new URL(source.src,import.meta.url));
    assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]),key);
    assert.equal(bytes.readUInt32BE(16),1122,key);assert.equal(bytes.readUInt32BE(20),1402,key);
    assert.equal(source.width,1122,key);assert.equal(source.height,1402,key);assert.equal(sha(bytes),source.sha256,key);
    assert.ok(!oldHashes.has(source.sha256),`${key}: own new pose rather than old pose reuse`);
    hashes.add(source.sha256);paths.add(source.src);
  }
  assert.equal(hashes.size,36);assert.equal(paths.size,36);
});

test('accepted earlier pose artwork and reusable behavior remain exactly frozen',()=>{
  assert.equal(approved.status,'approved');assert.equal(approval.assetId,approved.id);
  assert.deepEqual(approved.sources,approval.approvedSources);
  for(const source of Object.values(approved.sources))assert.equal(sha(readFileSync(new URL(source.src,import.meta.url))),source.sha256);
  for(const[field,name]of Object.entries({poses:'Poses',gaze:'Gaze',mouthArt:'MouthArt',browArt:'BrowArt'}))assert.equal(sha(JSON.stringify(approved[field])),approval[`approved${name}Sha256`],field);
  for(const kind of ['Gaze','SharedGaze','Expression','Mouth','Brow','BrowExclusion','GazeSnapshot']){
    const file=approval[`approved${kind}RuntimePath`];
    assert.equal(sha(readFileSync(new URL(file,import.meta.url))),approval[`approved${kind}RuntimeSha256`],file);
  }
});

test('each new pose uses local native-scale eyelids, separately authored mouth directions and independent anatomical brows',()=>{
  for(const poseId of POSES){
    const pose=manifest.poses[poseId];assert.equal(pose.reference,`${poseId}-neutral`);
    assert.deepEqual(pose.faceView.slice(2),[630,460],'matching review scale across approved and new poses');
    for(const[group,states]of Object.entries(pose.patches))for(const[state,p]of Object.entries(states)){
      assert.equal(manifest.sources[p.source].pose,poseId,`${poseId}/${group}/${state}`);
      assert.equal(p.transform,'translation-only');assert.deepEqual(p.rect.slice(2),p.destination.slice(2));
      assert.ok(Array.isArray(p.clip)&&p.clip.length>=3);
      if(group.startsWith('eye')||group.startsWith('brow'))assert.deepEqual(p.rect,p.destination,`${group}/${state}: no artificial movement`);
    }
    for(const state of ['half','closed'])assert.equal(pose.patches.eyeLeft[state].source,pose.patches.eyeRight[state].source);
    for(const state of SIDE_BROW_STATES){
      const left=pose.patches.browLeft[state],right=pose.patches.browRight[state];
      assert.equal(left.source,`${poseId}-${state}`);assert.equal(right.source,left.source);
      assert.ok(left.destination[0]>=right.destination[0]+right.destination[2]);
    }
    for(const[state,p]of Object.entries(pose.patches.mouth)){
      assert.equal(p.anchor.kind,'upper-lip');
      assert.deepEqual(p.anchor.source.map((value,axis)=>value+p.destination[axis]-p.rect[axis]),p.anchor.destination);
      assert.equal(p.anchor.destination[1],pose.mouthReference[1]);
      const dx=p.anchor.destination[0]-pose.mouthReference[0];
      if(state==='shiftLeft')assert.ok(dx>0&&dx<=24,'character left is canvas right');
      else if(state==='shiftRight')assert.ok(dx<0&&dx>=-24,'character right is canvas left');
      else assert.equal(dx,0,`${state}: fixed non-shift anchor`);
      assert.ok(p.destination[1]+p.destination[3]<registration.poses[poseId].landmarks.chin[1],`${poseId}/${state}: preserve chin`);
    }
    assert.notEqual(pose.patches.mouth.shiftLeft.source,pose.patches.mouth.shiftRight.source);
  }
  // The wide-mouth source keeps its own nose; fixed lip registration must not copy
  // that source nose into the original portrait's empty philtrum.
  const downWide=manifest.poses['view-down'].patches.mouth.openWide;
  const sourceNose=registration.poses['view-down'].mouthSourceNoseRepair.sourceNoseFragment;
  const notch=registration.poses['view-down'].mouthSourceNoseRepair.centralDestinationNotch;
  const sourceToDestination=downWide.destination[1]-downWide.rect[1];
  assert.ok(notch[0]<sourceNose[0]&&notch[0]+notch[2]>sourceNose[0]+sourceNose[2],'notch spans the actual nose fragment');
  assert.ok(notch[1]+notch[3]>=sourceNose[1]+sourceNose[3]+sourceToDestination+2,'exclude the complete source nose fragment with an antialias margin');
  assert.ok(notch[1]+notch[3]+downWide.feather<downWide.anchor.destination[1],'preserve the actual upper-lip ink with a conservative margin below the notch');
  assert.ok(downWide.clip.some(([x,y])=>x<notch[0]&&y===693)&&downWide.clip.some(([x,y])=>x>notch[0]+notch[2]&&y===693),'retain the upper clearing coverage at both original smile corners');
});

test('real generation provenance preserves all multi-image references and refinement chains to frozen original art',()=>{
  assert.equal(provenance.tool,'Built-in image_gen');assert.equal(provenance.assets.length,36);
  const all=new Map(),originals=new Map();
  for(const original of provenance.originalReferenceSources){
    const url=new URL(original.file,provenanceURL);assert.equal(sha(readFileSync(url)),original.sha256,original.file);
    originals.set(url.href,original);
  }
  assert.ok(originals.size>=1);
  for(const asset of [...provenance.assets,...provenance.intermediateSources]){
    const url=new URL(asset.file,provenanceURL);assert.ok(!all.has(url.href));
    assert.equal(sha(readFileSync(url)),asset.sha256,asset.file);
    assert.ok(POSES.includes(asset.pose));assert.ok(Array.isArray(asset.references)&&asset.references.length>0);
    assert.equal(typeof asset.prompt,'string');assert.ok(asset.prompt.length>100);
    assert.equal(typeof asset.generationId,'string');assert.ok(asset.generationId.length>10);
    all.set(url.href,asset);
  }
  const trace=(href,visited)=>{
    if(originals.has(href))return;
    assert.ok(!visited.has(href),'no generation reference cycle');
    const source=all.get(href);assert.ok(source,`${href}: actual generated reference retained`);
    for(const reference of source.references){
      const target=new URL(reference,provenanceURL).href;
      if(all.has(target))assert.equal(all.get(target).pose,source.pose,'generated variants stay within same pose');
      trace(target,new Set([...visited,href]));
    }
  };
  for(const[href,asset]of all)trace(href,new Set());
  for(const asset of provenance.assets){
    const source=manifest.sources[asset.key];assert.ok(source);assert.equal(asset.sha256,source.sha256);
    assert.equal(new URL(asset.file,provenanceURL).href,new URL(source.src,import.meta.url).href);
  }
  const repaired=provenance.assets.find(asset=>asset.key==='view-right-down-neutral');
  assert.ok(repaired.references.length>=3,'repair records fixed-body front and both pitch references');
});

test('new anatomical protection and detail windows are registered from actual art independently of paint clips',()=>{
  assert.deepEqual(Object.keys(registration.poses).sort(),POSES);
  for(const poseId of POSES){
    const pose=registration.poses[poseId];assert.deepEqual(pose.patches,manifest.poses[poseId].patches);
    for(const region of ['eyes','mouth','nose','hair','chin']){
      assert.ok(pose.protection[region].length>0,`${poseId}/${region}`);
      for(const polygon of pose.protection[region]){
        assert.ok(polygon.length>=3);
        for(const point of polygon)assert.ok(point.length===2&&point.every(Number.isFinite));
      }
    }
    for(const kind of ['eyes','mouth','brows'])assert.deepEqual(pose.detailViews[kind],manifest.poses[poseId].detailViews[kind]);
    assert.ok(pose.landmarks.chin.length===2);assert.ok(pose.landmarks.upperLip.length===2);
  }
  // Structural and pixel protection checks supplement, never replace, visual review.
});

test('pure lateral inputs reach two distinct real paintings while combined pucker behavior stays explicit',()=>{
  for(const poseId of POSES){
    const pose=manifest.poses[poseId],painting=signals=>{
      const selected=selectSideMouthExpression(signals,{}, {mouthArt:true});
      return pose.patches.mouth[selected.mouth]?.source;
    };
    assert.equal(painting({mouthLeft:1}),`${poseId}-shiftLeft`);
    assert.equal(painting({mouthRight:1}),`${poseId}-shiftRight`);
    assert.notEqual(painting({mouthLeft:1}),painting({mouthRight:1}));
    assert.equal(painting({mouthPucker:1,mouthLeft:1}),`${poseId}-pucker`);
    assert.equal(painting({mouthPucker:1,mouthRight:1}),`${poseId}-pucker`);
  }
  assert.ok(manifest.limitations.some(value=>value.includes('噘嘴和移嘴同时输入时优先噘嘴')));
});
