import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SIDE_BROW_STATES} from './side-brow-model.js';
import {validateSideExpressionManifest} from './side-expression-renderer.js';
import {rasterizeBrowExclusion} from './side-brow-exclusion.js';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)));
const manifest = read('./assets/short-hair-pitch-brows-v1/manifest.json');
const approved = read('./assets/short-hair-pitch-mouth-v1/manifest.json');
const approval = read('./assets/short-hair-pitch-mouth-v1/approval.json');
const sideBrowApproval = read('./assets/short-hair-side-brows-v1/approval.json');
const pitchBrowApproval = read('./assets/short-hair-pitch-brows-v1/approval.json');
const provenanceURL = new URL(manifest.provenance, import.meta.url);
const provenance = JSON.parse(readFileSync(provenanceURL));
const bytesFor = source => readFileSync(new URL(source.src, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const POSES = ['view-left-down','view-left-up','view-right-up'];
const GROUPS = ['browLeft','browRight'];
const newKeys = Object.keys(manifest.sources).filter(key => !Object.hasOwn(approved.sources, key)).sort();

test('approved pitch eyebrow pack has three poses and nine actual new paintings among thirty-six verified native PNG sources', () => {
  validateSideExpressionManifest(manifest);
  assert.equal(manifest.id, 'short-hair-pitch-brows-v1'); assert.equal(manifest.status, 'approved');
  assert.equal(manifest.poseFamily, 'pitch'); assert.equal(manifest.extends, approved.id);
  assert.deepEqual(Object.keys(manifest.poses).sort(), POSES);
  assert.deepEqual(manifest.browArt, {version:1, states:[...SIDE_BROW_STATES]});
  assert.equal(Object.keys(manifest.sources).length, 36); assert.equal(newKeys.length, 9);
  for (const [key, source] of Object.entries(manifest.sources)) {
    const bytes = bytesFor(source);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]), key);
    assert.equal(bytes.readUInt32BE(16),1122,key); assert.equal(bytes.readUInt32BE(20),1402,key);
    assert.equal(source.width,1122,key); assert.equal(source.height,1402,key);
    assert.equal(sha(bytes),source.sha256,key);
  }
});

test('new pitch eyebrows preserve all approved mouth sources, complete gaze registration and mouth capabilities', () => {
  assert.equal(approved.status,'approved'); assert.equal(approval.assetId,approved.id);
  for (const [key,source] of Object.entries(approved.sources)) {
    assert.deepEqual(manifest.sources[key],source,key);
    assert.deepEqual(source,approval.approvedSources[key],key);
  }
  assert.deepEqual(manifest.gaze,approved.gaze);
  assert.equal(sha(JSON.stringify(manifest.gaze)),approval.approvedGazeSha256);
  assert.deepEqual(manifest.mouthArt,approved.mouthArt);
  assert.equal(sha(JSON.stringify(manifest.mouthArt)),approval.approvedMouthArtSha256);
});

test('removing only new brow patches and their detail view restores every approved pitch pose field', () => {
  const originals = structuredClone(manifest.poses);
  for (const poseId of POSES) {
    for (const group of ['eyeLeft','eyeRight','mouth']) assert.deepEqual(manifest.poses[poseId].patches[group],approved.poses[poseId].patches[group],`${poseId}/${group}`);
    for (const group of GROUPS) delete originals[poseId].patches[group];
    assert.ok(Array.isArray(originals[poseId].detailViews.brows));
    delete originals[poseId].detailViews.brows;
  }
  assert.deepEqual(originals,approved.poses);
  assert.equal(sha(JSON.stringify(originals)),approval.approvedPosesSha256);
});

test('nine distinct double-brow sources supply eighteen anatomical brow crops with fixed native positions', () => {
  const used = new Set(), hashes = new Set(); let patchCount = 0;
  const oldHashes = new Set(Object.values(approved.sources).map(source => source.sha256));
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], poseSources = new Set();
    for (const group of GROUPS) assert.deepEqual(Object.keys(pose.patches[group]).sort(),[...SIDE_BROW_STATES].sort());
    for (const state of SIDE_BROW_STATES) {
      const left = pose.patches.browLeft[state], right = pose.patches.browRight[state];
      assert.equal(left.source,right.source,`${poseId}/${state}`);
      assert.ok(newKeys.includes(left.source)); assert.equal(manifest.sources[left.source].pose,poseId);
      assert.ok(!oldHashes.has(manifest.sources[left.source].sha256));
      assert.ok(left.rect[0] >= right.rect[0] + right.rect[2],`${poseId}/${state}: anatomical left is canvas-right`);
      for (const patch of [left,right]) {
        assert.equal(patch.transform,'translation-only');
        assert.deepEqual(patch.rect,patch.destination,`${poseId}/${state}: no artificial motion or scale`);
        assert.ok(Array.isArray(patch.clip) && patch.clip.length >= 3);
        patchCount++;
      }
      used.add(left.source); poseSources.add(left.source); hashes.add(manifest.sources[left.source].sha256);
    }
    assert.equal(poseSources.size,3);
  }
  assert.equal(patchCount,18); assert.equal(hashes.size,9); assert.deepEqual([...used].sort(),newKeys);
});

test('every new painting records the real generation prompt and same-pose reference chain back to an approved original', () => {
  assert.equal(provenance.tool,'Built-in image_gen'); assert.equal(provenance.assets.length,9);
  assert.deepEqual(provenance.assets.map(asset => asset.key).sort(),newKeys);
  const used = new Set(Object.values(manifest.sources).map(source => new URL(source.src,import.meta.url).href));
  const intermediates = new Map();
  const verifiedFile = entry => {
    const url = new URL(entry.file,provenanceURL);
    assert.equal(url.protocol,'file:'); assert.ok(url.pathname.endsWith('.png'));
    assert.equal(sha(readFileSync(url)),entry.sha256,entry.file);
    assert.equal(typeof entry.generationId,'string'); assert.ok(entry.generationId.length > 10);
    assert.equal(typeof entry.prompt,'string'); assert.ok(entry.prompt.length > 100);
    return url.href;
  };
  for (const intermediate of provenance.intermediateSources || []) {
    const href = verifiedFile(intermediate);
    assert.ok(POSES.includes(intermediate.pose)); assert.ok(!used.has(href));
    assert.ok(!intermediates.has(href)); intermediates.set(href,intermediate);
  }
  const trace = (reference,poseId,visited) => {
    const url = new URL(reference,provenanceURL), original = approved.sources[approved.poses[poseId].reference];
    if (url.href === new URL(original.src,import.meta.url).href) {
      assert.equal(sha(readFileSync(url)),approval.approvedSources[approved.poses[poseId].reference].sha256); return;
    }
    assert.ok(!visited.has(url.href),`${poseId}: no reference cycle`);
    const previous = intermediates.get(url.href);
    assert.ok(previous,`${reference}: actual intermediate source must be retained`);
    assert.equal(previous.pose,poseId); trace(previous.reference,poseId,new Set([...visited,url.href]));
  };
  for (const asset of provenance.assets) {
    const source = manifest.sources[asset.key], href = verifiedFile(asset);
    assert.equal(href,new URL(source.src,import.meta.url).href); assert.equal(asset.sha256,source.sha256);
    trace(asset.reference,source.pose,new Set([href]));
  }
  for (const [href,intermediate] of intermediates) trace(intermediate.reference,intermediate.pose,new Set([href]));
});

test('accepted gaze snapshots, expression and mouth selection, eyebrow actions and fine-hair exclusion remain frozen', () => {
  for (const kind of ['Gaze','SharedGaze','Expression','Mouth','GazeSnapshot']) {
    const runtime = approval[`approved${kind}RuntimePath`];
    assert.equal(sha(readFileSync(new URL(runtime,import.meta.url))),approval[`approved${kind}RuntimeSha256`],runtime);
  }
  for (const kind of ['Brow','BrowExclusion']) {
    const runtime = sideBrowApproval[`approved${kind}RuntimePath`];
    assert.equal(sha(readFileSync(new URL(runtime,import.meta.url))),sideBrowApproval[`approved${kind}RuntimeSha256`],runtime);
  }
});

test('original anatomical protection regions are registered separately from candidate brow clip geometry', () => {
  const registration = read('./assets/short-hair-pitch-brows-v1/validation/registration.json');
  assert.deepEqual(Object.keys(registration.poses).sort(),POSES);
  for (const poseId of POSES) {
    const pose = registration.poses[poseId];
    for (const region of ['eyes','mouth','nose','hair']) {
      assert.ok(pose.protection[region].length > 0,`${poseId}/${region}`);
      for (const polygon of pose.protection[region]) {
        assert.ok(polygon.length >= 3);
        for (const point of polygon) assert.ok(point.length === 2 && point.every(Number.isFinite));
      }
    }
    for (const group of GROUPS) assert.deepEqual(pose.patches[group],manifest.poses[poseId].patches[group]);
  }
  // Integrity and independent geometry checks do not grant artistic approval.
});

test('measured thin-hair exclusions restore the original crossing strands below all authored brow strokes', () => {
  const registration = read('./assets/short-hair-pitch-brows-v1/validation/registration.json');
  const inside = (x,y,polygon) => {
    let yes = false;
    for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
      const [ax,ay]=polygon[i],[bx,by]=polygon[j];
      if ((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax) yes=!yes;
    }
    return yes;
  };
  // Native y limits and brow samples were read from the original/new stroke
  // union before designing the masks; they are not derived from mask output.
  for (const [poseId,top,sample,feather] of [
    ['view-left-up',352,[543,349],1.5],
    ['view-left-down',489,[540,486],2.5],
  ]) {
    const g=registration.poses[poseId],fix=g.fineHairRepair,core=fix.protectedCore;
    const states=manifest.poses[poseId].patches.browLeft;
    assert.equal(fix.minimumY,top); assert.deepEqual(fix.preservedBrowSample,sample);
    assert.ok(g.protection.hair.some(polygon=>JSON.stringify(polygon)===JSON.stringify(core)));
    for (const state of SIDE_BROW_STATES) {
      const p=states[state],[x,y,w,h]=p.destination;
      const tapered=poseId==='view-left-down'&&state==='outerUp';
      if(tapered)assert.notDeepEqual(p.exclude,states.innerUp.exclude,'outerUp uses its measured opaque-hair taper');
      else assert.deepEqual(p.exclude,states.innerUp.exclude,`${poseId}/${state}: same fixed foreground restoration`);
      assert.equal(p.excludeFeather,feather);
      assert.ok(p.exclude.every(polygon=>polygon.every(point=>point[1]>=(tapered?470:top))));
      const alpha=rasterizeBrowExclusion(w,h,p.destination,p.exclude,p.excludeFeather);
      let corePixels=0,insideClip=0;
      for(let py=0;py<h;py++)for(let px=0;px<w;px++) {
        if(!inside(x+px+.5,y+py+.5,core))continue;
        assert.equal(alpha[py*w+px],0,`${poseId}/${state}: preserve fine-hair core at${x+px},${y+py}`);
        corePixels++;
        if(inside(x+px+.5,y+py+.5,p.clip))insideClip++;
      }
      assert.ok(corePixels>=10,`${poseId}: substantial independent hair core`);
      assert.ok(insideClip>=8,`${poseId}: comparison is inside the otherwise painted crop`);
      const preserved=tapered?[540,466]:sample;
      assert.equal(alpha[(preserved[1]-y)*w+preserved[0]-x],255,`${poseId}/${state}: painted brow above remains intact`);
      if(tapered){
        const upperCore=[[535,479],[539,480],[543,483],[539,484],[536,482]];
        assert.deepEqual(fix.stateSpecific.outerUp.protectedOpaqueHairCore,upperCore);
        assert.deepEqual(fix.stateSpecific.outerUp.preservedBrowSample,preserved);
        let upperPixels=0;
        for(let py=0;py<h;py++)for(let px=0;px<w;px++)if(inside(x+px+.5,y+py+.5,upperCore)){
          assert.equal(alpha[py*w+px],0,`outerUp: preserve measured opaque-hair core at${x+px},${y+py}`);
          upperPixels++;
        }
        assert.ok(upperPixels>=12,'outerUp upper core covers a substantive original hair section');
      }
    }
  }
  for (const poseId of POSES) for (const [group,states] of Object.entries(manifest.poses[poseId].patches)) {
    if(!GROUPS.includes(group) || (group==='browLeft'&&poseId!=='view-right-up'))continue;
    for(const p of Object.values(states))assert.equal(p.exclude,undefined,`${poseId}/${group}: no unrelated restoration mask`);
  }
});

test('accepted pitch eyebrows freeze their36 sources, delivered pose registrations and reusable runtime behavior', () => {
  assert.equal(pitchBrowApproval.assetId,manifest.id);
  assert.equal(pitchBrowApproval.date,'2026-10-27');
  assert.equal(pitchBrowApproval.userFeedback,'非常棒，若完成可以修改原项目了，若还有未完成请优先做完');
  assert.equal(manifest.approval,'./assets/short-hair-pitch-brows-v1/approval.json');
  assert.deepEqual(manifest.sources,pitchBrowApproval.approvedSources);
  for(const source of Object.values(pitchBrowApproval.approvedSources))assert.equal(sha(bytesFor(source)),source.sha256);
  for(const[field,name]of Object.entries({poses:'Poses',gaze:'Gaze',mouthArt:'MouthArt',browArt:'BrowArt'}))assert.equal(sha(JSON.stringify(manifest[field])),pitchBrowApproval[`approved${name}Sha256`],field);
  for(const kind of ['Gaze','SharedGaze','Expression','Mouth','Brow','BrowExclusion','GazeSnapshot']){
    const runtime=pitchBrowApproval[`approved${kind}RuntimePath`];
    assert.equal(sha(readFileSync(new URL(runtime,import.meta.url))),pitchBrowApproval[`approved${kind}RuntimeSha256`],runtime);
  }
  assert.match(pitchBrowApproval.pendingScope,/pure frontal up\/down/);
  assert.match(pitchBrowApproval.pendingScope,/Original-project replacement is authorized after/);
});
