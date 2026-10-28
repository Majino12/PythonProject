import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {validateSideExpressionManifest} from './side-expression-renderer.js';

const manifest = JSON.parse(readFileSync(new URL('./assets/short-hair-side-gaze-v1/manifest.json', import.meta.url)));
const approved = JSON.parse(readFileSync(new URL('./assets/short-hair-side-expressions-v1/manifest.json', import.meta.url)));
const approval = JSON.parse(readFileSync(new URL('./assets/short-hair-side-expressions-v1/approval.json', import.meta.url)));
const gazeApproval = JSON.parse(readFileSync(new URL('./assets/short-hair-side-gaze-v1/approval.json', import.meta.url)));
const provenanceURL = new URL('./assets/short-hair-side-gaze-v1/provenance.json', import.meta.url);
const provenance = JSON.parse(readFileSync(provenanceURL));
const sourceBytes = source => readFileSync(new URL(source.src, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const POSES = ['view-left', 'view-right'];
const EYES = ['eyeLeft', 'eyeRight'];

// Read-only alpha decoding for the saved noninterlaced 8-bit RGBA sprites.
// Verifies real transparency, not an opaque image of a checkerboard background.
function readAlpha(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8); assert.equal(bytes[25], 6); assert.equal(bytes[28], 0);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const data = inflateSync(Buffer.concat(chunks)), stride = width * 4;
  assert.equal(data.length, height * (stride + 1));
  const alpha = new Uint8Array(width * height);
  let previous = new Uint8Array(stride);
  const paeth = (a, b, c) => {
    const prediction = a + b - c, da = Math.abs(prediction - a), db = Math.abs(prediction - b), dc = Math.abs(prediction - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)], row = new Uint8Array(stride);
    assert.ok(filter >= 0 && filter <= 4);
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? row[i - 4] : 0, above = previous[i], upperLeft = i >= 4 ? previous[i - 4] : 0;
      const prediction = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
      row[i] = (data[y * (stride + 1) + 1 + i] + prediction) & 255;
      if (i % 4 === 3) alpha[y * width + (i - 3) / 4] = row[i];
    }
    previous = row;
  }
  return {width, height, alpha};
}

test('approved side gaze validates both independently registered poses and all ten actual PNG dimensions and hashes', () => {
  validateSideExpressionManifest(manifest);
  assert.equal(manifest.status, 'approved');
  assert.notEqual(manifest.id, approved.id);
  assert.equal(manifest.extends, approved.id);
  assert.deepEqual(Object.keys(manifest.gaze.poses).sort(), POSES);
  assert.equal(Object.keys(manifest.sources).length, 10);
  for (const [key, source] of Object.entries(manifest.sources)) {
    const png = sourceBytes(source);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), key);
    assert.equal(png.readUInt32BE(16), source.width, key); assert.equal(png.readUInt32BE(20), source.height, key);
    assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.equal(sha256(png), source.sha256, key);
  }
});

test('side gaze approval preserves the exact accepted sources, poses and gaze registration without accepting future mouth artwork', () => {
  assert.equal(gazeApproval.assetId, manifest.id);
  assert.equal(manifest.approval, './assets/short-hair-side-gaze-v1/approval.json');
  assert.equal(gazeApproval.userFeedback, '做得很好！请继续！');
  assert.deepEqual(Object.keys(gazeApproval.approvedSources).sort(), Object.keys(manifest.sources).sort());
  for (const [key, source] of Object.entries(manifest.sources)) {
    assert.deepEqual(gazeApproval.approvedSources[key], source, key);
    assert.equal(sha256(sourceBytes(source)), gazeApproval.approvedSources[key].sha256, key);
  }
  assert.equal(sha256(JSON.stringify(manifest.poses)), gazeApproval.approvedPosesSha256);
  assert.equal(sha256(JSON.stringify(manifest.gaze)), gazeApproval.approvedGazeSha256);
  for (const pose of Object.values(manifest.poses)) {
    assert.deepEqual(Object.keys(pose.patches.mouth).sort(), ['openSmall', 'openWide']);
  }
  assert.match(gazeApproval.pendingScope, /New side-angle pucker, press, mouthLeft\/mouthRight/);
});

test('the approved side gaze runtime remains unchanged while new expression packs extend the shared player', () => {
  // This locks the accepted gaze behavior itself, not the shared player or
  // new mouth selector whose separately reviewed additions may evolve.
  assert.equal(gazeApproval.approvedGazeRuntimePath, './side-gaze.js');
  assert.equal(sha256(readFileSync(new URL(gazeApproval.approvedGazeRuntimePath, import.meta.url))), gazeApproval.approvedGazeRuntimeSha256);
});

test('new gaze pack preserves approved expression sources and complete pose registrations exactly', () => {
  for (const [key, source] of Object.entries(approved.sources)) {
    assert.deepEqual(manifest.sources[key], source, key);
    assert.equal(sha256(sourceBytes(manifest.sources[key])), approval.approvedSources[key].sha256, key);
  }
  assert.deepEqual(manifest.poses, approved.poses);
  assert.equal(sha256(JSON.stringify(manifest.poses)), approval.approvedPosesSha256);
});

test('both side poses have their own distinct painted eye whites and complete iris sprites with exact prompt provenance', () => {
  const additions = Object.keys(manifest.sources).filter(key => !Object.hasOwn(approved.sources, key)).sort();
  assert.equal(additions.length, 4);
  assert.equal(new Set(additions.map(key => sha256(sourceBytes(manifest.sources[key])))).size, 4);
  assert.deepEqual(provenance.assets.map(asset => asset.key).sort(), additions);
  const referenced = POSES.flatMap(poseId => [manifest.gaze.poses[poseId].whiteSource, manifest.gaze.poses[poseId].irisSource]).sort();
  assert.deepEqual(referenced, additions);
  for (const asset of provenance.assets) {
    const source = manifest.sources[asset.key], pose = manifest.poses[source.pose];
    assert.equal(new URL(asset.file, provenanceURL).href, new URL(source.src, import.meta.url).href);
    assert.equal(new URL(asset.reference, provenanceURL).href, new URL(manifest.sources[pose.reference].src, import.meta.url).href);
    assert.equal(typeof asset.generationId, 'string'); assert.ok(asset.generationId.length > 10);
    assert.equal(typeof asset.prompt, 'string'); assert.ok(asset.prompt.length > 100);
  }
});

test('actual iris files contain two antialiased painted sprites on real transparent backgrounds', () => {
  for (const poseId of POSES) {
    const p = manifest.gaze.poses[poseId], {alpha, width, height} = readAlpha(sourceBytes(manifest.sources[p.irisSource]));
    let transparent = 0, opaque = 0, antialiased = 0, visible = 0, outside = 0;
    const rects = EYES.map(eye => p.eyes[eye].irisRect), inside = (x, y, r) => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];
    const visibleInCrop = [0, 0];
    for (let i = 0; i < alpha.length; i++) {
      const a = alpha[i], x = i % width, y = Math.floor(i / width);
      if (a === 0) transparent++;
      if (a === 255) opaque++;
      if (a > 0 && a < 255) antialiased++;
      if (a > 10) {
        visible++;
        if (!rects.some(rect => inside(x, y, rect))) outside++;
        rects.forEach((rect, index) => {if (inside(x, y, rect)) visibleInCrop[index]++;});
      }
    }
    assert.ok(transparent > alpha.length * .8, `${poseId}: most of the portrait is genuinely transparent`);
    assert.ok(opaque > 100 && antialiased > 20, `${poseId}: painted opaque interior and a soft alpha edge exist`);
    assert.ok(visibleInCrop.every(count => count > 100), `${poseId}: both registered crops contain actual painted irises`);
    // Ignore isolated very faint generation specks; substantive iris pixels
    // must be in one of the two source registrations, not silently truncated.
    assert.ok(outside <= Math.max(20, visible * .01), `${poseId}: ${outside}/${visible} visible pixels fall outside the two iris crops`);
    for (const index of [0, width - 1, width * (height - 1), alpha.length - 1]) assert.equal(alpha[index], 0);
  }
});

test('actual side registrations keep distinct near/far anatomy and an aperture for each visible authored eyelid state', () => {
  for (const poseId of POSES) {
    const p = manifest.gaze.poses[poseId], pose = manifest.poses[poseId];
    const near = p.eyes[poseId === 'view-left' ? 'eyeLeft' : 'eyeRight'];
    const far = p.eyes[poseId === 'view-left' ? 'eyeRight' : 'eyeLeft'];
    assert.ok(near.irisDestination[2] > far.irisDestination[2], `${poseId}: foreshortened far iris stays narrower`);
    assert.ok(p.eyes.eyeLeft.irisDestination[0] > p.eyes.eyeRight.irisDestination[0], `${poseId}: anatomical left stays on canvas-right`);
    for (const eye of EYES) {
      const e = p.eyes[eye];
      assert.deepEqual(Object.keys(e.frames).sort(), ['half', 'open']);
      assert.equal(e.frames.open.source, pose.reference); assert.equal(e.frames.half.source, pose.patches[eye].half.source);
      assert.notDeepEqual(e.frames.open.aperture, e.frames.half.aperture);
      assert.ok(e.bounds[1] + e.bounds[3] < pose.mouthReference[1], 'eye layers cannot reach the mouth or chin');
    }
  }
  // These tests establish resource and registration integrity, not appearance.
});
