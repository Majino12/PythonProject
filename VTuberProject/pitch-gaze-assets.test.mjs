import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {validateSideExpressionManifest} from './side-expression-renderer.js';
import {sideGazeOffset} from './side-gaze.js';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)));
const manifest = read('./assets/short-hair-pitch-gaze-v1/manifest.json');
const approved = read('./assets/short-hair-pitch-expressions-v1/manifest.json');
const approval = read('./assets/short-hair-pitch-expressions-v1/approval.json');
const gazeApproval = read('./assets/short-hair-pitch-gaze-v1/approval.json');
const provenanceURL = new URL(manifest.provenance, import.meta.url);
const provenance = JSON.parse(readFileSync(provenanceURL));
const POSES = ['view-left-down', 'view-left-up', 'view-right-up'], EYES = ['eyeLeft', 'eyeRight'];
const bytesFor = source => readFileSync(new URL(source.src, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const newKeys = Object.keys(manifest.sources).filter(key => !Object.hasOwn(approved.sources, key)).sort();

// Decode only the saved alpha channel for real sprite-transparency checks.
function readAlpha(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8); assert.equal(bytes[25], 6); assert.equal(bytes[28], 0);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const data = inflateSync(Buffer.concat(chunks)), stride = width * 4, alpha = new Uint8Array(width * height);
  assert.equal(data.length, height * (stride + 1));
  const paeth = (a, b, c) => {const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c;};
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)], row = new Uint8Array(stride);
    assert.ok(filter >= 0 && filter <= 4);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0, b = previous[i], c = i >= 4 ? previous[i - 4] : 0;
      row[i] = (data[y * (stride + 1) + 1 + i] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]) & 255;
      if (i % 4 === 3) alpha[y * width + (i - 3) / 4] = row[i];
    }
    previous = row;
  }
  return {width, height, alpha};
}

test('approved pitch gaze registers the same three poses and fifteen actual PNG dimensions and fingerprints', () => {
  validateSideExpressionManifest(manifest);
  assert.equal(manifest.id, 'short-hair-pitch-gaze-v1'); assert.equal(manifest.status, 'approved');
  assert.equal(manifest.poseFamily, 'pitch'); assert.equal(manifest.extends, approved.id);
  assert.deepEqual(Object.keys(manifest.poses).sort(), POSES); assert.deepEqual(Object.keys(manifest.gaze.poses).sort(), POSES);
  assert.equal(Object.keys(manifest.sources).length, 15); assert.equal(newKeys.length, 6);
  assert.equal(manifest.mouthArt, undefined); assert.equal(manifest.browArt, undefined);
  for (const [key, source] of Object.entries(manifest.sources)) {
    const png = bytesFor(source);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), key);
    assert.equal(source.width, 1122, key); assert.equal(source.height, 1402, key);
    assert.equal(png.readUInt32BE(16), source.width, key); assert.equal(png.readUInt32BE(20), source.height, key);
    assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.equal(sha256(png), source.sha256, key);
  }
});

test('accepted pitch gaze snapshot freezes fifteen source paintings and the full pose and gaze registration', () => {
  assert.equal(gazeApproval.assetId, manifest.id);
  assert.equal(gazeApproval.date, '2026-10-26');
  assert.equal(gazeApproval.userFeedback, '太棒了！请继续进行');
  assert.equal(manifest.approval, './assets/short-hair-pitch-gaze-v1/approval.json');
  assert.equal(Object.keys(gazeApproval.approvedSources).length, 15);
  assert.deepEqual(manifest.sources, gazeApproval.approvedSources);
  for (const [key, source] of Object.entries(gazeApproval.approvedSources)) {
    assert.equal(sha256(bytesFor(source)), source.sha256, `${key}: approved source bytes`);
  }
  assert.equal(sha256(JSON.stringify(manifest.poses)), gazeApproval.approvedPosesSha256);
  assert.equal(sha256(JSON.stringify(manifest.gaze)), gazeApproval.approvedGazeSha256);
  assert.deepEqual(Object.keys(manifest.gaze.poses).sort(), POSES);
  assert.match(gazeApproval.pendingScope, /New pitch pucker\/press\/directional-mouth/);
  assert.match(gazeApproval.pendingScope, /right-down expressions and gaze/);
  const design = read('./assets/short-hair-v1/design-approval.json');
  const history = design.approvals.find(item => item.id === 'pitch-gaze-v1-2026-10-26');
  assert.equal(history.userFeedback, gazeApproval.userFeedback);
  assert.equal(history.evidenceFile, 'assets/short-hair-pitch-gaze-v1/approval.json');
});

test('accepted pitch iris compiler, shared gaze drawing and eye-mouth selection retain their frozen runtimes', () => {
  const runtimes = {Gaze: './pitch-gaze.js', SharedGaze: './side-gaze.js', Expression: './side-expression-model.js'};
  for (const [name, file] of Object.entries(runtimes)) {
    assert.equal(gazeApproval[`approved${name}RuntimePath`], file);
    assert.equal(sha256(readFileSync(new URL(file, import.meta.url))), gazeApproval[`approved${name}RuntimeSha256`], file);
  }
});

test('pitch gaze preserves all nine approved source paintings, every eye/mouth patch and the frozen expression selector', () => {
  assert.equal(approved.status, 'approved'); assert.equal(approval.assetId, approved.id);
  for (const [key, source] of Object.entries(approved.sources)) {
    assert.deepEqual(manifest.sources[key], source, key); assert.deepEqual(source, approval.approvedSources[key], key);
    assert.equal(sha256(bytesFor(source)), approval.approvedSources[key].sha256, key);
  }
  assert.deepEqual(manifest.poses, approved.poses);
  assert.equal(sha256(JSON.stringify(manifest.poses)), approval.approvedPosesSha256);
  assert.equal(sha256(readFileSync(new URL(approval.approvedExpressionRuntimePath, import.meta.url))), approval.approvedExpressionRuntimeSha256);
});

test('six new pitch white/iris sources are independent paintings with their exact generation prompts and pose references', () => {
  assert.equal(provenance.tool, 'Built-in image_gen'); assert.equal(provenance.assets.length, 6);
  assert.deepEqual(provenance.assets.map(asset => asset.key).sort(), newKeys);
  assert.equal(new Set(newKeys.map(key => sha256(bytesFor(manifest.sources[key])))).size, 6);
  assert.deepEqual(POSES.flatMap(id => [manifest.gaze.poses[id].whiteSource, manifest.gaze.poses[id].irisSource]).sort(), newKeys);
  const oldHashes = new Set(Object.values(approved.sources).map(source => source.sha256));
  for (const asset of provenance.assets) {
    const source = manifest.sources[asset.key], pose = manifest.poses[source.pose];
    assert.ok(!oldHashes.has(source.sha256));
    assert.equal(new URL(asset.file, provenanceURL).href, new URL(source.src, import.meta.url).href);
    assert.equal(new URL(asset.reference, provenanceURL).href, new URL(manifest.sources[pose.reference].src, import.meta.url).href);
    assert.equal(typeof asset.generationId, 'string'); assert.ok(asset.generationId.length > 10);
    assert.equal(typeof asset.prompt, 'string'); assert.ok(asset.prompt.length > 100);
  }
});

test('actual pitch iris files contain two painted sprites on genuine transparent backgrounds without substantial cropped-away pixels', () => {
  for (const poseId of POSES) {
    const p = manifest.gaze.poses[poseId], {width, height, alpha} = readAlpha(bytesFor(manifest.sources[p.irisSource]));
    const rects = EYES.map(eye => p.eyes[eye].irisRect), counts = [0, 0];
    let transparent = 0, opaque = 0, soft = 0, visible = 0, outside = 0;
    for (let i = 0; i < alpha.length; i++) {
      const a = alpha[i], x = i % width, y = Math.floor(i / width);
      if (a === 0) transparent++; if (a === 255) opaque++; if (a > 0 && a < 255) soft++;
      if (a > 10) {
        visible++; let contained = false;
        for (const [index, r] of rects.entries()) if (x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]) {counts[index]++; contained = true;}
        if (!contained) outside++;
      }
    }
    assert.ok(transparent > alpha.length * .8, `${poseId}: real transparent background`);
    assert.ok(opaque > 100 && soft > 20, `${poseId}: opaque paint and antialiased edge`);
    assert.ok(counts.every(count => count > 100), `${poseId}: two visible sprites in their registered crops`);
    assert.ok(outside <= Math.max(20, visible * .01), `${poseId}: ${outside}/${visible} substantive pixels outside iris crops`);
    for (const index of [0, width - 1, width * (height - 1), alpha.length - 1]) assert.equal(alpha[index], 0);
  }
});

test('actual pitch gaze registrations retain per-eye anatomy and separate open/half apertures without closed-eye iris layers', () => {
  for (const poseId of POSES) {
    const p = manifest.gaze.poses[poseId], pose = manifest.poses[poseId];
    assert.ok(p.eyes.eyeLeft.irisDestination[0] > p.eyes.eyeRight.irisDestination[0], `${poseId}: anatomical left stays on canvas-right`);
    const near = p.eyes[poseId === 'view-right-up' ? 'eyeRight' : 'eyeLeft'];
    const far = p.eyes[poseId === 'view-right-up' ? 'eyeLeft' : 'eyeRight'];
    assert.ok(near.irisDestination[2] > far.irisDestination[2], `${poseId}: far iris is foreshortened`);
    for (const eye of EYES) {
      const e = p.eyes[eye];
      assert.deepEqual(Object.keys(e.frames).sort(), ['half', 'open']);
      assert.equal(e.frames.open.source, pose.reference); assert.equal(e.frames.half.source, pose.patches[eye].half.source);
      assert.notDeepEqual(e.frames.open.aperture, e.frames.half.aperture);
      assert.ok(e.bounds[1] + e.bounds[3] < pose.mouthReference[1]);
      assert.ok(Math.abs(e.irisRect[2] / e.irisRect[3] - e.irisDestination[2] / e.irisDestination[3]) < 1e-9);
      assert.deepEqual(sideGazeOffset({}, e), {x: 0, y: 0}, `${poseId}/${eye}: neutral does not recenter the approved pose's gaze`);
    }
  }
});

test('actual pitch travel remains bounded in each registered eye axis at all maximum cardinal and diagonal gaze inputs', () => {
  for (const poseId of POSES) for (const eye of EYES) {
    const e = manifest.gaze.poses[poseId].eyes[eye], slope = e.basis?.horizontal[1] || 0;
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
      const offset = sideGazeOffset({x, y}, e), localY = offset.y - offset.x * slope;
      assert.ok((offset.x / e.maxShift.x) ** 2 + (localY / (y < 0 ? e.maxShift.up : e.maxShift.down)) ** 2 <= 1 + 1e-12, `${poseId}/${eye}`);
    }
  }
  // Passing these tests does not establish visual acceptance of the new gaze.
});
