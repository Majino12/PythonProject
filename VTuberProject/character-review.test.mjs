import test from "node:test";
import assert from "node:assert/strict";
import { validateReviewManifest, reviewStorageKey, emptyReview, readReview, serializeReview, exportReview, faceViewBox } from "./character-review-model.js";

function fixture() {
  const pose = { id: "front", label: "正面", group: "front", src: "./assets/short-hair-v1/front.png", width: 1100, height: 1400,
    approved: true, notes: [], landmarks: { eyeOuterViewerLeft: [320, 500], eyeInnerViewerLeft: [460, 520],
      eyeInnerViewerRight: [640, 520], eyeOuterViewerRight: [780, 500], noseTip: [550, 600], upperLip: [550, 665], chin: [550, 760] } };
  return { version: 1, assetRevision: "candidate-v1", characterName: "短发角色", referenceId: "front",
    poses: [pose, { ...pose, id: "left", label: "朝画面左侧", src: "./assets/short-hair-v1/left.png", group: "yaw", approved: false }] };
}

test("review manifest keeps missing or hidden landmarks absent", () => {
  const manifest = validateReviewManifest(fixture());
  assert.equal(manifest.poses[0].landmarks.philtrum, undefined);
  assert.deepEqual(manifest.poses[0].landmarks.noseTip, [550, 600]);
  assert.equal(manifest.assetRevision, "candidate-v1");
});

test("invalid image dimensions, landmarks, identities and remote assets fail before rendering", () => {
  for (const mutate of [
    (data) => { data.poses[0].width = 0; },
    (data) => { data.poses[0].landmarks.noseTip = [1500, 600]; },
    (data) => { data.poses[1].id = "front"; },
    (data) => { data.poses[0].approved = false; },
    (data) => { data.poses[1].src = "https://example.com/left.png"; },
    (data) => { data.poses[1].src = "./assets/../left.png"; },
  ]) {
    const data = fixture();
    mutate(data);
    assert.throws(() => validateReviewManifest(data));
  }
});

test("feedback round trips exact note text and does not add editable approval to reference", () => {
  const manifest = validateReviewManifest(fixture());
  const review = emptyReview(manifest);
  assert.deepEqual(Object.keys(review), ["left"]);
  review.left = { status: "revise", note: "远眼偏高\n上唇位置需要重新检查。", updatedAt: "2026-10-23T08:00:00.000Z" };
  assert.deepEqual(readReview(manifest, serializeReview(manifest, review)), review);
});

test("unknown saved status and old asset revisions cannot become approvals", () => {
  const manifest = validateReviewManifest(fixture());
  const invalid = { schemaVersion: 1, assetSet: reviewStorageKey(manifest), review: { left: { status: "complete", note: "ignored" }, front: { status: "revise" } } };
  assert.deepEqual(readReview(manifest, invalid), emptyReview(manifest));
  const changed = { ...manifest, assetRevision: "candidate-v2" };
  assert.notEqual(reviewStorageKey(changed), reviewStorageKey(manifest));
  assert.throws(() => readReview(changed, serializeReview(manifest, emptyReview(manifest))));
});

test("conversation approval preserves browser feedback and never fabricates a pass", () => {
  const previous = validateReviewManifest(fixture());
  const feedback = emptyReview(previous);
  feedback.left = { status: "revise", note: "保留这条补充观察", updatedAt: "2026-10-23T08:00:00.000Z" };
  const data = fixture();
  data.poses[1].approved = true;
  const approved = validateReviewManifest(data);
  assert.equal(reviewStorageKey(approved), reviewStorageKey(previous));
  assert.deepEqual(readReview(approved, serializeReview(previous, feedback)), feedback);
  assert.equal(emptyReview(approved).left.status, "undecided");
  const exported = exportReview(approved, feedback);
  assert.equal(exported.poses[0].approved, true);
  assert.equal(exported.poses[0].review.status, "revise");
  assert.equal(exported.poses[0].review.note, "保留这条补充观察");
});

test("export includes image dimensions, landmarks and feedback without claiming runtime readiness", () => {
  const manifest = validateReviewManifest(fixture());
  const review = emptyReview(manifest);
  review.left.status = "pass";
  const exported = exportReview(manifest, review, "2026-10-23T08:00:00.000Z");
  assert.equal(exported.reference.id, "front");
  assert.equal(exported.poses.length, 1);
  assert.equal(exported.poses[0].width, 1100);
  assert.deepEqual(exported.poses[0].landmarks.upperLip, [550, 665]);
  assert.equal(exported.poses[0].review.statusLabel, "通过");
  assert.match(exported.purpose, /不代表表情或动画验收/);
});

test("face crop encloses observed landmarks, stays in source canvas, and does not mutate them", () => {
  const manifest = validateReviewManifest(fixture());
  const pose = manifest.poses[1];
  const before = JSON.stringify(pose.landmarks);
  const [x, y, width, height] = faceViewBox(pose);
  assert.ok(x >= 0 && y >= 0 && x + width <= pose.width && y + height <= pose.height);
  for (const [px, py] of Object.values(pose.landmarks)) assert.ok(px >= x && px <= x + width && py >= y && py <= y + height);
  assert.equal(JSON.stringify(pose.landmarks), before);
});

test("face magnification preserves relative face sizes instead of fitting each landmark span", () => {
  const pose = validateReviewManifest(fixture()).poses[1];
  const smallerFace = { ...pose, landmarks: Object.fromEntries(Object.entries(pose.landmarks)
    .map(([key, [x, y]]) => [key, [550 + (x - 550) * 0.45, 630 + (y - 630) * 0.45]])) };
  const noLandmarks = { ...pose, landmarks: {} };
  assert.deepEqual(faceViewBox(pose).slice(2), [704, 704]);
  assert.deepEqual(faceViewBox(smallerFace).slice(2), faceViewBox(pose).slice(2));
  assert.deepEqual(faceViewBox(noLandmarks).slice(2), faceViewBox(pose).slice(2));
  const largerSource = { ...pose, width: 2200, height: 2800,
    landmarks: Object.fromEntries(Object.entries(pose.landmarks).map(([key, point]) => [key, point.map((coordinate) => coordinate * 2)])) };
  assert.deepEqual(faceViewBox(largerSource).map((coordinate) => coordinate / 2), faceViewBox(pose));
});
