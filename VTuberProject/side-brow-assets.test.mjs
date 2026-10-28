import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SIDE_BROW_STATES} from './side-brow-model.js';
import {validateSideExpressionManifest} from './side-expression-renderer.js';
import {rasterizeBrowExclusion} from './side-brow-exclusion.js';

const manifest = JSON.parse(readFileSync(new URL('./assets/short-hair-side-brows-v1/manifest.json', import.meta.url)));
const approved = JSON.parse(readFileSync(new URL('./assets/short-hair-side-mouth-v1/manifest.json', import.meta.url)));
const approval = JSON.parse(readFileSync(new URL('./assets/short-hair-side-mouth-v1/approval.json', import.meta.url)));
const browApproval = JSON.parse(readFileSync(new URL('./assets/short-hair-side-brows-v1/approval.json', import.meta.url)));
const provenanceURL = new URL('./assets/short-hair-side-brows-v1/provenance.json', import.meta.url);
const provenance = JSON.parse(readFileSync(provenanceURL));
const sourceBytes = source => readFileSync(new URL(source.src, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const POSES = ['view-left', 'view-right'];
const GROUPS = ['browLeft', 'browRight'];
const newKeys = Object.keys(manifest.sources).filter(key => !Object.hasOwn(approved.sources, key)).sort();

test('approved side brow pack registers six new double-brow paintings and all twenty-four PNG dimensions and hashes match their files', () => {
  validateSideExpressionManifest(manifest);
  assert.equal(manifest.status, 'approved'); assert.notEqual(manifest.id, approved.id);
  assert.equal(manifest.extends, approved.id); assert.equal(approved.id, 'short-hair-side-mouth-v1');
  assert.deepEqual(manifest.browArt, {version: 1, states: [...SIDE_BROW_STATES]});
  assert.deepEqual(Object.keys(manifest.poses).sort(), POSES);
  assert.equal(Object.keys(manifest.sources).length, 24); assert.equal(newKeys.length, 6);
  for (const [key, source] of Object.entries(manifest.sources)) {
    const png = sourceBytes(source);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), key);
    assert.equal(source.width, 1122, key); assert.equal(source.height, 1402, key);
    assert.equal(png.readUInt32BE(16), source.width, key); assert.equal(png.readUInt32BE(20), source.height, key);
    assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.equal(sha256(png), source.sha256, key);
  }
});

test('brow extension preserves all eighteen approved sources, gaze registration, mouth capability and accepted mouth selector', () => {
  assert.equal(approved.status, 'approved'); assert.equal(approval.assetId, approved.id);
  for (const [key, source] of Object.entries(approved.sources)) {
    assert.deepEqual(manifest.sources[key], source, key);
    assert.deepEqual(manifest.sources[key], approval.approvedSources[key], key);
    assert.equal(sha256(sourceBytes(source)), approval.approvedSources[key].sha256, key);
  }
  assert.deepEqual(manifest.gaze, approved.gaze);
  assert.equal(sha256(JSON.stringify(manifest.gaze)), approval.approvedGazeSha256);
  assert.deepEqual(manifest.mouthArt, approved.mouthArt);
  assert.equal(sha256(JSON.stringify(manifest.mouthArt)), approval.approvedMouthArtSha256);
  assert.equal(sha256(readFileSync(new URL(approval.approvedMouthRuntimePath, import.meta.url))), approval.approvedMouthRuntimeSha256);
});

test('every existing pose registration and eye/mouth patch stays unchanged apart from adding the brow groups and their detail view', () => {
  const originals = structuredClone(manifest.poses);
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], old = approved.poses[poseId];
    for (const group of ['eyeLeft', 'eyeRight', 'mouth']) assert.deepEqual(pose.patches[group], old.patches[group], `${poseId}/${group}`);
    for (const group of GROUPS) delete originals[poseId].patches[group];
    assert.ok(Array.isArray(pose.detailViews.brows));
    delete originals[poseId].detailViews.brows;
  }
  assert.deepEqual(originals, approved.poses);
  assert.equal(sha256(JSON.stringify(originals)), approval.approvedPosesSha256);
});

test('each pose has three distinct double-brow sources and twelve independently registered brow crops in total', () => {
  const allSources = new Set(), hashes = new Set();
  const oldHashes = new Set(Object.values(approved.sources).map(source => sha256(sourceBytes(source))));
  let patches = 0;
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], poseSources = new Set();
    for (const group of GROUPS) assert.deepEqual(Object.keys(pose.patches[group]).sort(), [...SIDE_BROW_STATES].sort());
    for (const state of SIDE_BROW_STATES) {
      const left = pose.patches.browLeft[state], right = pose.patches.browRight[state];
      assert.equal(left.source, right.source, `${poseId}/${state}: the corresponding double-brow drawing supplies both crops`);
      assert.ok(newKeys.includes(left.source));
      const source = manifest.sources[left.source], hash = sha256(sourceBytes(source));
      assert.equal(source.pose, poseId); assert.ok(!oldHashes.has(hash));
      assert.ok(left.rect[0] >= right.rect[0] + right.rect[2], `${poseId}/${state}: anatomical left brow is on canvas-right`);
      assert.notDeepEqual(left.rect, right.rect);
      allSources.add(left.source); poseSources.add(left.source); hashes.add(hash); patches += 2;
    }
    assert.equal(poseSources.size, 3);
  }
  assert.equal(patches, 12); assert.equal(hashes.size, 6);
  assert.deepEqual([...allSources].sort(), newKeys);
});

test('new eyebrows retain native source positions, fixed one-to-one scale and explicit local clipping', () => {
  for (const poseId of POSES) for (const group of GROUPS) for (const state of SIDE_BROW_STATES) {
    const p = manifest.poses[poseId].patches[group][state];
    assert.equal(p.transform, 'translation-only');
    assert.deepEqual(p.rect, p.destination, `${poseId}/${group}/${state}: no synthetic brow translation or scale`);
    assert.ok(Array.isArray(p.clip) && p.clip.length >= 3, `${poseId}/${group}/${state}: clips preserve actual eyelids and foreground hair`);
    if (p.anchor !== undefined) assert.deepEqual(p.anchor.source.map((v, axis) => v + p.destination[axis] - p.rect[axis]), p.anchor.destination);
  }
});

test('all six final brow sources retain their actual generation prompts and corresponding approved pose references', () => {
  assert.equal(provenance.tool, 'Built-in image_gen'); assert.equal(provenance.assets.length, 6);
  assert.deepEqual(provenance.assets.map(asset => asset.key).sort(), newKeys);
  assert.equal(new Set(provenance.assets.map(asset => asset.generationId)).size, 6);
  for (const asset of provenance.assets) {
    const source = manifest.sources[asset.key], pose = manifest.poses[source.pose];
    assert.equal(new URL(asset.file, provenanceURL).href, new URL(source.src, import.meta.url).href);
    assert.equal(new URL(asset.reference, provenanceURL).href, new URL(manifest.sources[pose.reference].src, import.meta.url).href);
    assert.equal(typeof asset.generationId, 'string'); assert.ok(asset.generationId.length > 10);
    assert.equal(typeof asset.prompt, 'string'); assert.ok(asset.prompt.length > 100);
  }
  const used = new Set(Object.values(manifest.sources).map(source => new URL(source.src, import.meta.url).href));
  for (const intermediate of provenance.intermediateSources || []) {
    if (typeof intermediate.file === 'string') assert.ok(!used.has(new URL(intermediate.file, provenanceURL).href));
  }
  // These tests check source integrity and registrations, not artistic approval.
});

test('measured right-pose hair junction masks restore their protected cores without erasing the neutral or newly painted brow strokes', () => {
  const registration = JSON.parse(readFileSync(new URL('./assets/short-hair-side-brows-v1/validation/registration.json', import.meta.url)));
  const cores = registration.poses['view-right'].protection.hair.slice(-2);
  const inside = (x, y, polygon) => {
    let yes = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [ax, ay] = polygon[i], [bx, by] = polygon[j];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) yes = !yes;
    }
    return yes;
  };
  // These two y limits and brow samples come from the inspected union of the
  // neutral/new brow strokes, not from the exclusion algorithm's own output.
  for (const [group, coreIndex, top, browSample] of [['browRight', 0, 431, [518, 428]], ['browLeft', 1, 419, [772, 417]]]) {
    const states = manifest.poses['view-right'].patches[group], first = states.innerUp, core = cores[coreIndex];
    for (const state of SIDE_BROW_STATES) {
      const p = states[state], [x, y, w, h] = p.destination;
      assert.deepEqual(p.exclude, first.exclude, `${group}/${state}: stable junction across all authored states`);
      assert.equal(p.excludeFeather, 1.5);
      assert.ok(p.exclude.every(poly => poly.every(pt => pt[1] >= top)), `${group}: exclusion remains below all measured brow strokes`);
      const alpha = rasterizeBrowExclusion(w, h, p.destination, p.exclude, p.excludeFeather);
      let corePixels = 0;
      for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        if (!inside(x + px + .5, y + py + .5, core)) continue;
        assert.equal(alpha[py * w + px], 0, `${group}/${state}: restore fine-hair core at ${x + px},${y + py}`);
        corePixels++;
      }
      assert.ok(corePixels > 10, `${group}: the independent protection region is substantive`);
      assert.equal(alpha[(browSample[1] - y) * w + browSample[0] - x], 255, `${group}: the eyebrow crossing above the repair remains fully painted`);
    }
  }
  for (const group of GROUPS) for (const p of Object.values(manifest.poses['view-left'].patches[group])) {
    assert.equal(p.exclude, undefined); assert.equal(p.excludeFeather, undefined);
  }
});

test('accepted eyebrow snapshot freezes all source bytes and the delivered pose, gaze, mouth and brow registration', () => {
  assert.equal(browApproval.assetId, manifest.id);
  assert.equal(browApproval.userFeedback, '太棒了！可以进行下一步了');
  assert.equal(browApproval.date, '2026-10-26');
  assert.equal(manifest.approval, './assets/short-hair-side-brows-v1/approval.json');
  assert.deepEqual(manifest.sources, browApproval.approvedSources);
  for (const [key, source] of Object.entries(browApproval.approvedSources)) {
    assert.equal(sha256(sourceBytes(source)), source.sha256, `${key}: approved source bytes`);
  }
  assert.equal(sha256(JSON.stringify(manifest.poses)), browApproval.approvedPosesSha256);
  assert.equal(sha256(JSON.stringify(manifest.gaze)), browApproval.approvedGazeSha256);
  assert.equal(sha256(JSON.stringify(manifest.mouthArt)), browApproval.approvedMouthArtSha256);
  assert.equal(sha256(JSON.stringify(manifest.browArt)), browApproval.approvedBrowArtSha256);
  assert.deepEqual(Object.keys(manifest.poses).sort(), ['view-left', 'view-right']);
  assert.match(browApproval.pendingScope, /pitch\/diagonal expressions/);
  assert.match(browApproval.pendingScope, /continuous head movement/);
});

test('approved eyebrow action selection and fine-hair exclusion keep their accepted runtime implementations', () => {
  assert.equal(browApproval.approvedBrowRuntimePath, './side-brow-model.js');
  assert.equal(browApproval.approvedBrowExclusionRuntimePath, './side-brow-exclusion.js');
  for (const kind of ['Brow', 'BrowExclusion']) {
    const path = browApproval[`approved${kind}RuntimePath`];
    assert.equal(sha256(readFileSync(new URL(path, import.meta.url))), browApproval[`approved${kind}RuntimeSha256`], path);
  }
});
