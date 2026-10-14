import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./avatar3d.js", import.meta.url), "utf8");
const vector = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } });
const transform = () => ({ position: vector(), rotation: vector(), scale: vector(), visible: true });

function harness() {
  let now = 100;
  const context = { performance: { now: () => (now += 1000 / 60) } };
  vm.createContext(context);
  const constants = source.slice(source.indexOf("const clamp ="), source.indexOf("function material("));
  const appearanceMethod = source.slice(source.indexOf("  setAppearance("), source.indexOf("  setBackground("));
  const updateMethod = source.slice(source.indexOf("  update("), source.indexOf("  render("));
  vm.runInContext(`${constants}\nfunction ${appearanceMethod.trim()}\nfunction ${updateMethod.trim()}`, context);
  const eye = () => ({ ...transform(), userData: { gaze: transform() } });
  const arm = (side) => ({ ...transform(), userData: { side, elbow: transform(), hand: transform(), angle: 0, bend: 0 } });
  const leg = (side) => ({ ...transform(), userData: { side, knee: transform() } });
  const fixture = {
    appearance: { hairStyle: "bob", faceWidth: 1, eyeScale: 1 },
    secondary: { yaw: 0, roll: 0 },
    hairStyles: { bob: transform(), long: transform(), short: transform() },
    headContent: transform(), avatar: transform(), rigRoot: transform(), body: transform(), head: transform(),
    eyeLeft: eye(), eyeRight: eye(), browLeft: transform(), browRight: transform(),
    mouthRig: transform(), mouth: transform(), lip: transform(), teeth: transform(), tongue: transform(),
    armLeft: arm(1), armRight: arm(-1), legLeft: leg(1), legRight: leg(-1),
    materials: { blush: { opacity: 0 } }, userYaw: 0,
    setPalette(palette) { this.palette = palette; },
  };
  return { fixture, appearance: (value) => context.setAppearance.call(fixture, value), update: (motion, intensity) => context.update.call(fixture, motion, intensity) };
}

test("appearance switches real hair groups and clamps proportions", () => {
  const h = harness();
  h.appearance({ hairStyle: "long", faceWidth: 9, eyeScale: .1, palette: { hair: "#123456" } });
  assert.equal(h.fixture.hairStyles.long.visible, true);
  assert.equal(h.fixture.hairStyles.bob.visible, false);
  assert.equal(h.fixture.hairStyles.short.visible, false);
  assert.equal(h.fixture.headContent.scale.x, 1.15);
  assert.equal(h.fixture.appearance.eyeScale, .85);
  assert.equal(h.fixture.palette.hair, "#123456");
  h.appearance({ hairStyle: "untrusted", faceWidth: NaN, eyeScale: Infinity });
  assert.equal(h.fixture.appearance.hairStyle, "long");
  assert.equal(h.fixture.headContent.scale.x, 1.15);
  h.update({ armCosL: 1, armCosR: 1 }, {});
  assert.equal(h.fixture.eyeLeft.scale.x, .85);
});

test("invalid motion and excessive sensitivity cannot produce non-finite transforms", () => {
  const h = harness();
  h.update({ x: Infinity, y: NaN, armSinL: NaN, armCosL: Infinity, bodyLean: 999, lookX: NaN }, { head: Infinity, body: NaN, expression: -10 });
  const inspect = (value) => {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "number") assert.ok(Number.isFinite(child), `${key} is finite`);
      else if (child && typeof child === "object") inspect(child);
    }
  };
  inspect(h.fixture);
  assert.ok(Math.abs(h.fixture.rigRoot.rotation.z) <= .12);
});

test("shoulder and elbow changes ease in instead of snapping in a single frame", () => {
  const h = harness();
  h.update({ armSinL: 1, armCosL: 0, elbowL: 1 }, { body: .85 });
  const first = h.fixture.armLeft.userData.angle;
  assert.ok(first > 0 && first < .35);
  assert.ok(h.fixture.armLeft.userData.bend > 0 && h.fixture.armLeft.userData.bend < .2);
  for (let i = 0; i < 90; i += 1) h.update({ armSinL: 1, armCosL: 0, elbowL: 1 }, { body: .85 });
  assert.ok(Math.abs(h.fixture.armLeft.userData.angle - Math.PI / 2) < .005);
  assert.ok(Math.abs(h.fixture.armLeft.userData.elbow.rotation.z) <= 1.80);
});

test("half-strength overhead arms keep their direction without vector interpolation flips", () => {
  const h = harness();
  for (let i = 0; i < 90; i += 1) h.update({ armSinL: .001, armCosL: -1 }, { body: .425 });
  assert.ok(h.fixture.armLeft.userData.angle > 1.5 && h.fixture.armLeft.userData.angle < 1.6);
});

test("elbow direction transitions continuously through ambiguous tracking", () => {
  const h = harness();
  for (let i = 0; i < 90; i += 1) h.update({ elbowL: 1, elbowSideL: 1, armCosL: 1 }, { body: .85 });
  const before = h.fixture.armLeft.userData.elbow.rotation.z;
  h.update({ elbowL: 1, elbowSideL: -1, armCosL: 1 }, { body: .85 });
  assert.ok(Math.abs(h.fixture.armLeft.userData.elbow.rotation.z - before) < .45);
  assert.ok(h.fixture.armLeft.userData.direction > 0);
  for (let i = 0; i < 90; i += 1) h.update({ elbowL: 1, elbowSideL: -.1, armCosL: 1 }, { body: .85 });
  assert.ok(Math.abs(h.fixture.armLeft.userData.direction + .1) < .005);
  const nearThreshold = h.fixture.armLeft.userData.elbow.rotation.z;
  h.update({ elbowL: 1, elbowSideL: -.3, armCosL: 1 }, { body: .85 });
  assert.ok(Math.abs(h.fixture.armLeft.userData.elbow.rotation.z - nearThreshold) < .06);
});

test("fringe and side-strip root corners stay inside the rounded crown silhouette", () => {
  const helper = source.slice(source.indexOf("function conformHairRoot("), source.indexOf("// A curved, softly crowned strip"));
  const context = {};
  vm.createContext(context);
  vm.runInContext(helper, context);
  for (const name of ["Swept_Fringe_0", "bob_Side_1_0"]) {
    for (const [x, y] of [[-.42, .49], [.12, .65], [.48, .32], [-.35, .53]]) {
      const vertex = { x, y, z: .25 };
      context.conformHairRoot(vertex, name, .2);
      assert.ok(Math.hypot(vertex.x / .498, (vertex.y - .018) / .56) <= .975001);
      assert.ok(Number.isFinite(vertex.z));
    }
  }
});

test("blouse follows the exact jacket profile without sinking into the lower torso", () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("const TORSO_PROFILE"), source.indexOf("function material(")), context);
  for (const [height, radius] of [[.04, .265], [.25, .29], [.405, .3125], [.56, .335], [.705, .375], [.85, .415], [.895, .3925], [.94, .37], [.9775, .26], [1.015, .15], [1.03, .15]]) {
    assert.ok(Math.abs(context.torsoRadius(height) - radius) < 1e-9);
    for (const x of [-.12, 0, .12]) {
      const actualSurface = Math.sqrt(radius ** 2 - x ** 2) * .64;
      assert.ok(context.garmentSurface(x, height) >= actualSurface + .0149);
    }
  }
});

test("export lock leaves motion transforms unchanged", () => {
  const h = harness();
  h.fixture.exporting = true;
  const before = JSON.stringify(h.fixture);
  h.update({ x: 1, mouth: 1, armSinL: 1 }, { body: 1 });
  assert.equal(JSON.stringify(h.fixture), before);
});

test("disposing shared eye maps releases texture memory once", () => {
  const helper = source.slice(source.indexOf("function disposeObject("), source.indexOf("export class Avatar3D"));
  const context = {};
  vm.createContext(context);
  vm.runInContext(helper, context);
  let textureCalls = 0;
  const texture = { dispose() { textureCalls += 1; } };
  const object = { traverse(callback) {
    callback({ material: { map: texture, dispose() {} } });
    callback({ material: { map: texture, dispose() {} } });
  } };
  context.disposeObject(object);
  assert.equal(textureCalls, 1);
});

test("portrait and full framing keep a finite camera and a useful head-to-hips view", () => {
  const method = source.slice(source.indexOf("  setFraming("), source.indexOf("  update("));
  const context = {};
  vm.createContext(context);
  vm.runInContext(`function ${method.trim()}`, context);
  let updates = 0;
  const camera = { position: vector(), target: vector(), lookAt(x, y, z) { this.target.set(x, y, z); }, updateProjectionMatrix() { updates += 1; } };
  const fixture = { camera };
  context.setFraming.call(fixture, "portrait");
  assert.equal(fixture.framing, "portrait");
  assert.equal(camera.position.z, 5.15);
  assert.equal(camera.target.y, .86);
  context.setFraming.call(fixture, "full");
  assert.equal(camera.position.z, 8.7);
  assert.equal(camera.target.y, .09);
  context.setFraming.call(fixture, "unknown");
  assert.equal(fixture.framing, "portrait");
  assert.equal(updates, 3);
});
