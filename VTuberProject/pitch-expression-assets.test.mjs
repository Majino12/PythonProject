import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateSideExpressionManifest} from './side-expression-renderer.js';

const manifest = JSON.parse(readFileSync(new URL('./assets/short-hair-pitch-expressions-v1/manifest.json', import.meta.url)));
const approval = JSON.parse(readFileSync(new URL('./assets/short-hair-pitch-expressions-v1/approval.json', import.meta.url)));
const provenanceURL = new URL(manifest.provenance, import.meta.url);
const provenance = JSON.parse(readFileSync(provenanceURL));
const designApproval = JSON.parse(readFileSync(new URL('./assets/short-hair-v1/design-approval.json', import.meta.url)));
const staticReview = JSON.parse(readFileSync(new URL('./assets/short-hair-v1/review.json', import.meta.url)));
const POSES = ['view-left-down', 'view-left-up', 'view-right-up'];
const sourceBytes = source => readFileSync(new URL(source.src, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const referenceKeys = new Set(Object.values(manifest.poses).map(pose => pose.reference));
const expressionKeys = Object.keys(manifest.sources).filter(key => !referenceKeys.has(key)).sort();

test('approved pitch base contains three explicit poses and nine actual PNGs with matching dimensions and hashes', () => {
  validateSideExpressionManifest(manifest);
  assert.equal(manifest.id, 'short-hair-pitch-expressions-v1');
  assert.equal(manifest.status, 'approved'); assert.equal(manifest.poseFamily, 'pitch');
  assert.deepEqual(Object.keys(manifest.poses).sort(), POSES);
  assert.equal(Object.keys(manifest.sources).length, 9); assert.equal(expressionKeys.length, 6);
  for (const unsupported of ['gaze', 'mouthArt', 'browArt']) assert.equal(manifest[unsupported], undefined);
  for (const [key, source] of Object.entries(manifest.sources)) {
    const png = sourceBytes(source);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), key);
    assert.equal(source.width, 1122, key); assert.equal(source.height, 1402, key);
    assert.equal(png.readUInt32BE(16), source.width, key); assert.equal(png.readUInt32BE(20), source.height, key);
    assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.equal(sha256(png), source.sha256, key);
  }
});

test('accepted pitch snapshot freezes nine source paintings and the approved per-pose eye and upper-lip registration', () => {
  assert.equal(approval.assetId, manifest.id);
  assert.equal(approval.date, '2026-10-26');
  assert.equal(approval.userFeedback, '太棒了，若已完成请修改原项目，若还有需要进行的，请先运行');
  assert.equal(manifest.approval, './assets/short-hair-pitch-expressions-v1/approval.json');
  assert.equal(Object.keys(approval.approvedSources).length, 9);
  assert.deepEqual(manifest.sources, approval.approvedSources);
  for (const [key, source] of Object.entries(approval.approvedSources)) {
    assert.equal(sha256(sourceBytes(source)), source.sha256, `${key}: approved source bytes`);
  }
  assert.equal(sha256(JSON.stringify(manifest.poses)), approval.approvedPosesSha256);
  assert.deepEqual(Object.keys(manifest.poses).sort(), POSES);
  assert.match(approval.pendingScope, /New pitch gaze/);
  assert.match(approval.pendingScope, /right-down expressions/);
  assert.match(approval.pendingScope, /final integrated software acceptance/);
  const history = designApproval.approvals.find(item => item.id === 'pitch-expressions-v1-2026-10-26');
  assert.equal(history.userFeedback, approval.userFeedback);
  assert.equal(history.evidenceFile, 'assets/short-hair-pitch-expressions-v1/approval.json');
});

test('approved pitch eye and jaw selection keeps its accepted expression runtime implementation', () => {
  assert.equal(approval.approvedExpressionRuntimePath, './side-expression-model.js');
  assert.equal(sha256(readFileSync(new URL(approval.approvedExpressionRuntimePath, import.meta.url))), approval.approvedExpressionRuntimeSha256);
});

test('all three pitch references remain the approved static illustrations and the unimplemented right-down pose is not borrowed', () => {
  const approval = designApproval.approvals.find(item => item.id === 'six-static-angles-2026-10-23');
  assert.ok(approval);
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], source = manifest.sources[pose.reference];
    const approved = approval.approvedImages.find(item => item.id === poseId);
    assert.equal(source.pose, poseId); assert.equal(source.src, `./${approved.file}`);
    assert.equal(sha256(sourceBytes(source)), approved.sha256);
  }
  assert.ok(!Object.values(manifest.sources).some(source => source.pose === 'view-right-down'));
  for (const approved of approval.approvedImages) assert.equal(sha256(readFileSync(new URL(`./${approved.file}`, import.meta.url))), approved.sha256, approved.id);
});

test('each pitch pose uses two independent expression paintings through six separate local eye and mouth patches', () => {
  const usedExpressions = new Set(); let count = 0;
  assert.equal(new Set(Object.values(manifest.sources).map(source => sha256(sourceBytes(source)))).size, 9);
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], localSources = new Set();
    assert.deepEqual(Object.keys(pose.patches).sort(), ['eyeLeft', 'eyeRight', 'mouth']);
    for (const group of ['eyeLeft', 'eyeRight', 'mouth']) {
      assert.deepEqual(Object.keys(pose.patches[group]).sort(), group === 'mouth' ? ['openSmall', 'openWide'] : ['closed', 'half']);
      for (const patch of Object.values(pose.patches[group])) {
        assert.ok(expressionKeys.includes(patch.source));
        assert.equal(manifest.sources[patch.source].pose, poseId);
        usedExpressions.add(patch.source); localSources.add(patch.source); count++;
      }
    }
    assert.equal(localSources.size, 2);
    for (const [eyeState, mouthState] of [['half', 'openSmall'], ['closed', 'openWide']]) {
      assert.equal(pose.patches.eyeLeft[eyeState].source, pose.patches.eyeRight[eyeState].source);
      assert.equal(pose.patches.eyeLeft[eyeState].source, pose.patches.mouth[mouthState].source);
    }
  }
  assert.equal(count, 18); assert.deepEqual([...usedExpressions].sort(), expressionKeys);
});

test('pitch eye crops preserve anatomical sides and all local drawings keep native scale and stay above the approved chin', () => {
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId], chin = staticReview.poses.find(item => item.id === poseId).landmarks.chin;
    for (const left of Object.values(pose.patches.eyeLeft)) for (const right of Object.values(pose.patches.eyeRight)) {
      assert.ok(left.destination[0] >= right.destination[0] + right.destination[2], `${poseId}: separately registered anatomical eyes`);
    }
    for (const states of Object.values(pose.patches)) for (const p of Object.values(states)) {
      assert.equal(p.transform, 'translation-only');
      assert.deepEqual(p.rect.slice(2), p.destination.slice(2));
      assert.ok(p.destination[1] + p.destination[3] < chin[1], `${poseId}: the local crop must not replace the chin or torso`);
      assert.ok(Array.isArray(p.clip) && p.clip.length >= 3, `${poseId}: eye/skin/hair boundaries have an explicit fixed local mask`);
    }
  }
});

test('small and wide mouth drawings register to each pitch pose’s own stable upper-lip anchor', () => {
  assert.equal(new Set(Object.values(manifest.poses).map(p => JSON.stringify(p.mouthReference))).size, 3);
  for (const poseId of POSES) {
    const pose = manifest.poses[poseId];
    for (const p of Object.values(pose.patches.mouth)) {
      assert.equal(p.anchor.kind, 'upper-lip');
      assert.deepEqual(p.anchor.destination, pose.mouthReference);
      assert.deepEqual(p.anchor.source.map((v, axis) => v + p.destination[axis] - p.rect[axis]), pose.mouthReference);
      assert.ok(p.destination[1] + p.destination[3] > pose.mouthReference[1], `${poseId}: the crop includes room below the upper lip`);
    }
  }
});

test('six pitch paintings record actual generation prompts and the matching approved pose references', () => {
  assert.equal(provenance.tool, 'Built-in image_gen'); assert.equal(provenance.assets.length, 6);
  assert.deepEqual(provenance.assets.map(asset => asset.key).sort(), expressionKeys);
  for (const asset of provenance.assets) {
    const source = manifest.sources[asset.key], pose = manifest.poses[source.pose];
    assert.equal(new URL(asset.file, provenanceURL).href, new URL(source.src, import.meta.url).href);
    assert.equal(new URL(asset.reference, provenanceURL).href, new URL(manifest.sources[pose.reference].src, import.meta.url).href);
    assert.equal(typeof asset.generationId, 'string'); assert.ok(asset.generationId.length > 10);
    assert.equal(typeof asset.prompt, 'string'); assert.ok(asset.prompt.length > 100);
  }
  const used = new Set(Object.values(manifest.sources).map(source => new URL(source.src, import.meta.url).href));
  for (const intermediate of provenance.intermediateSources || []) if (typeof intermediate.file === 'string') {
    assert.ok(!used.has(new URL(intermediate.file, provenanceURL).href));
  }
  // Resource integrity and registration checks do not establish artistic quality.
});
