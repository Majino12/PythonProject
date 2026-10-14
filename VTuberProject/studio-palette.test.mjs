import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recolorPixels, rebuildVrmWithTextures } from "./studio-palette.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64"));
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const ADAPTATION_NOTICE = "Recolored using MoeMotion. The recoloring contributions are licensed under VRM Public License 1.0 (https://vrm.dev/en/licenses/1.0/) with the same unchanged License Settings as the original work. No additional restrictions. Original author and original license remain unchanged.";
const rgba = (...pixels) => new Uint8ClampedArray(pixels.flat());
const light = (pixels, index = 0) => .2126 * pixels[index] + .7152 * pixels[index + 1] + .0722 * pixels[index + 2];

function fixture({ duplicateName = false, legacy = false } = {}) {
  const json = {
    asset: { version: "2.0", generator: "fixture" },
    extensionsUsed: [legacy ? "VRM" : "VRMC_vrm", "VRMC_materials_mtoon", "CUSTOM_extension"],
    extensions: {
      [legacy ? "VRM" : "VRMC_vrm"]: {
        meta: { name: "Original", authors: ["Original artist"], copyrightInformation: "Copyright Original artist", licenseUrl: "https://vrm.dev/licenses/1.0/", allowRedistribution: true },
        humanoid: { humanBones: { head: { node: 0 } } },
        expressions: { preset: { blink: { morphTargetBinds: [{ node: 0, index: 1, weight: 1 }] } } },
      },
      CUSTOM_extension: { retained: true, unknownData: [1, "test"] },
    },
    nodes: [{ name: "head", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 8 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
    images: [{ name: "Shared original", bufferView: 0, mimeType: "image/png" }],
    textures: [{ source: 0, sampler: 0, extras: { keep: true }, extensions: { KHR_texture_basisu: { source: 0 }, CUSTOM_texture: { keep: true } } }],
    samplers: [{ magFilter: 9729 }],
    materials: [
      {
        name: "Hair_00_HAIR",
        pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1, extensions: { KHR_texture_transform: { offset: [.1, .2] } } }, roughnessFactor: .5 },
        extensions: { VRMC_materials_mtoon: { specVersion: "1.0", shadeMultiplyTexture: { index: 0 }, outlineWidthFactor: .001 }, CUSTOM_material: { keep: true } },
      },
      { name: duplicateName ? "Hair_00_HAIR" : "Face_00_SKIN", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
    ],
  };
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const data = new Uint8Array(Math.ceil(encoded.length / 4) * 4).fill(32);
  data.set(encoded);
  const chunks = [{ type: JSON_CHUNK, data }, { type: BIN_CHUNK, data: Uint8Array.of(11, 22, 33, 44, 55, 66, 77, 88) }, { type: 0x12345678, data: Uint8Array.of(1, 2, 3, 4) }];
  const buffer = new ArrayBuffer(12 + chunks.reduce((sum, chunk) => sum + chunk.data.length + 8, 0));
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, buffer.byteLength, true);
  let offset = 12;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.data.length, true);
    view.setUint32(offset + 4, chunk.type, true);
    new Uint8Array(buffer, offset + 8, chunk.data.length).set(chunk.data);
    offset += chunk.data.length + 8;
  }
  return buffer;
}

function readGlb(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const chunks = [];
  for (let offset = 12; offset < bytes.length;) {
    const length = view.getUint32(offset, true);
    chunks.push({ type: view.getUint32(offset + 4, true), bytes: bytes.slice(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  return { json: JSON.parse(new TextDecoder().decode(chunks[0].bytes)), chunks, bin: chunks.find((chunk) => chunk.type === BIN_CHUNK).bytes };
}

function assertExtensionsRetained(before, after) {
  const expected = structuredClone(before.json.extensions);
  expected.VRMC_vrm.meta.copyrightInformation += `\n${ADAPTATION_NOTICE}`;
  assert.deepEqual(after.json.extensions, expected);
}

test("recoloring can brighten original brown hair to silver without multiplying it dark", () => {
  const original = rgba([120, 76, 45, 255], [120, 76, 45, 255], [120, 76, 45, 255]);
  const snapshot = original.slice();
  const result = recolorPixels(original, "#dce2f2", { kind: "hair" });
  assert.deepEqual(original, snapshot);
  assert.ok(light(result) > 210 && light(result) - light(original) > 100);
  assert.ok(result[2] > result[0], "silver target has a cool blue tint");
});

test("recoloring retains alpha, transparent pixels, dark lineart and white highlights", () => {
  const original = rgba([120, 80, 40, 0], [5, 6, 7, 255], [255, 255, 255, 255], [120, 80, 40, 128]);
  const result = recolorPixels(original, "#bce", { kind: "eyes" });
  assert.deepEqual(result.slice(0, 12), original.slice(0, 12));
  assert.equal(result[15], 128);
  assert.notDeepEqual(result.slice(12, 15), original.slice(12, 15));
});

test("shadow-to-highlight ordering survives recoloring", () => {
  const original = rgba([45, 45, 45, 255], [110, 110, 110, 255], [170, 170, 170, 255], [220, 220, 220, 255]);
  const result = recolorPixels(original, "#6688cc");
  for (let i = 4; i < result.length; i += 4) assert.ok(light(result, i) > light(result, i - 4));
});

test("outfit recoloring dyes white cloth navy and dark cloth purple while retaining seam shadows", () => {
  const white = rgba([255, 255, 255, 255], [255, 255, 255, 255], [210, 210, 210, 255], [3, 3, 3, 255]);
  const navy = recolorPixels(white, "#39374e", { kind: "outfit" });
  assert.ok(light(navy) < 115, "white base must not be mistaken for a protected highlight");
  assert.ok(navy[2] > navy[0]);
  assert.ok(light(navy, 8) < light(navy), "folds stay darker than the base fabric");
  assert.deepEqual(navy.slice(12), white.slice(12), "dark ink seam is preserved");
  const dark = rgba([18, 18, 18, 255], [18, 18, 18, 255], [30, 30, 30, 255], [10, 10, 10, 128]);
  const purple = recolorPixels(dark, "#8765c2", { kind: "outfit" });
  assert.ok(light(purple) > 100, "dark neutral cloth can brighten instead of just multiply");
  assert.ok(purple[2] > purple[0] && purple[0] > purple[1]);
  assert.equal(purple[15], 128);
  assert.ok(light(purple, 8) > light(purple));
});

test("recoloring is deterministic and rejects invalid pixel data or settings", () => {
  const original = rgba([150, 100, 50, 255]);
  assert.deepEqual(recolorPixels(original, "#abc"), recolorPixels(original, "#aabbcc"));
  assert.deepEqual(recolorPixels(new Uint8Array(), "#fff"), new Uint8ClampedArray());
  assert.throws(() => recolorPixels(new Uint8Array(3), "#fff"));
  assert.throws(() => recolorPixels([1, 2, 3, 4], "#fff"));
  assert.throws(() => recolorPixels(original, "red"));
  assert.throws(() => recolorPixels(original, "#fff", { kind: "skin" }));
});

test("unchanged VRM round-trip is byte-identical and returns an independent buffer", () => {
  const original = fixture();
  const result = rebuildVrmWithTextures(original);
  assert.notEqual(result, original);
  assert.deepEqual(new Uint8Array(result), new Uint8Array(original));
});

test("VRM recolor export preserves license, extensions, rig, original binary and shared skin", () => {
  const original = fixture();
  const snapshot = new Uint8Array(original).slice();
  const before = readGlb(original);
  const result = rebuildVrmWithTextures(original, {
    materialChanges: { Hair_00_HAIR: { baseColorFactor: [1, 1, 1, 1], shadeColorFactor: [.8, .8, .9], outlineColorFactor: [.1, .1, .15] } },
    textureReplacements: [{ materialName: "Hair_00_HAIR", bytes: PNG }],
  });
  const after = readGlb(result);
  assert.deepEqual(new Uint8Array(original), snapshot);
  assertExtensionsRetained(before, after);
  assert.deepEqual(after.json.extensionsUsed, before.json.extensionsUsed);
  assert.deepEqual(after.json.nodes, before.json.nodes);
  assert.deepEqual(after.json.meshes, before.json.meshes);
  assert.deepEqual(after.json.materials[1], before.json.materials[1]);
  assert.deepEqual(after.json.images[0], before.json.images[0]);
  assert.deepEqual(after.json.textures[0], before.json.textures[0]);
  assert.deepEqual(after.bin.slice(0, before.bin.length), before.bin);
  assert.deepEqual(after.chunks[2], before.chunks[2]);
  const hair = after.json.materials[0];
  const baseInfo = hair.pbrMetallicRoughness.baseColorTexture;
  const shadeInfo = hair.extensions.VRMC_materials_mtoon.shadeMultiplyTexture;
  assert.notEqual(baseInfo.index, shadeInfo.index);
  assert.deepEqual(baseInfo.extensions, before.json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions);
  assert.equal(baseInfo.texCoord, 1);
  assert.equal(hair.pbrMetallicRoughness.roughnessFactor, .5);
  assert.equal(hair.extensions.VRMC_materials_mtoon.outlineWidthFactor, .001);
  for (const index of [baseInfo.index, shadeInfo.index]) {
    const texture = after.json.textures[index];
    assert.equal(texture.sampler, 0);
    assert.deepEqual(texture.extensions, { CUSTOM_texture: { keep: true } });
    const image = after.json.images[texture.source];
    const view = after.json.bufferViews[image.bufferView];
    assert.equal(view.byteOffset % 4, 0);
    assert.deepEqual(after.bin.slice(view.byteOffset, view.byteOffset + view.byteLength), PNG);
  }
});

test("material indices, single slots and VRM 0.x metadata are supported", () => {
  const original = fixture({ legacy: true });
  const before = readGlb(original);
  const after = readGlb(rebuildVrmWithTextures(original, {
    materialChanges: { 0: { emissiveFactor: [.1, .2, .3] } },
    textureReplacements: [{ materialIndex: 0, bytes: PNG.buffer, mimeType: "image/png", slots: ["baseColorTexture"] }],
  }));
  assert.deepEqual(after.json.extensions.VRM, before.json.extensions.VRM);
  assert.deepEqual(after.json.materials[0].emissiveFactor, [.1, .2, .3]);
  assert.equal(after.json.materials[0].extensions.VRMC_materials_mtoon.shadeMultiplyTexture.index, 0);
  assert.equal(after.json.textures.length, 2);
});

test("factor-only exports preserve original binary bytes without adding textures", () => {
  const before = readGlb(fixture());
  const after = readGlb(rebuildVrmWithTextures(fixture(), { materialChanges: { 0: { baseColorFactor: [.1, .2, .3, 1] } } }));
  assert.deepEqual(after.bin, before.bin);
  assert.deepEqual(after.json.textures, before.json.textures);
  assert.deepEqual(after.json.images, before.json.images);
  assertExtensionsRetained(before, after);
});

test("adaptation terms retain original copyright, preserve all other meta fields, and are not duplicated", () => {
  const original = fixture();
  const change = { materialChanges: { 0: { baseColorFactor: [.1, .2, .3, 1] } } };
  const first = rebuildVrmWithTextures(original, change);
  const second = rebuildVrmWithTextures(first, change);
  const before = readGlb(original).json.extensions.VRMC_vrm.meta;
  const firstMeta = readGlb(first).json.extensions.VRMC_vrm.meta;
  const secondMeta = readGlb(second).json.extensions.VRMC_vrm.meta;
  assert.equal(firstMeta.copyrightInformation, `${before.copyrightInformation}\n${ADAPTATION_NOTICE}`);
  assert.deepEqual(secondMeta, firstMeta);
  assert.deepEqual({ ...firstMeta, copyrightInformation: before.copyrightInformation }, before);
  const emptyChange = readGlb(rebuildVrmWithTextures(original, { materialChanges: { 0: {} } }));
  assert.deepEqual(emptyChange.json.extensions.VRMC_vrm.meta, before);
});

test("VRM export rejects invalid files and unsafe or ambiguous edits", () => {
  const original = fixture();
  assert.throws(() => rebuildVrmWithTextures(new ArrayBuffer(4)));
  const invalid = original.slice(0);
  new DataView(invalid).setUint32(8, 0, true);
  assert.throws(() => rebuildVrmWithTextures(invalid));
  const replacement = { materialIndex: 0, bytes: PNG };
  for (const bad of [
    { ...replacement, materialName: "Hair_00_HAIR" },
    { ...replacement, materialIndex: 50 },
    { ...replacement, bytes: Uint8Array.of(1, 2, 3) },
    { ...replacement, mimeType: "image/svg+xml" },
    { ...replacement, slots: ["normalTexture"] },
    { ...replacement, slots: ["baseColorTexture", "baseColorTexture"] },
  ]) assert.throws(() => rebuildVrmWithTextures(original, { textureReplacements: [bad] }));
  assert.throws(() => rebuildVrmWithTextures(fixture({ duplicateName: true }), { textureReplacements: [{ materialName: "Hair_00_HAIR", bytes: PNG }] }));
  assert.throws(() => rebuildVrmWithTextures(original, { materialChanges: { 0: { license: "MIT" } } }));
  assert.throws(() => rebuildVrmWithTextures(original, { materialChanges: { 0: { baseColorFactor: [NaN, 1, 1, 1] } } }));
});

test("bundled pixiv VRM retains every original license and runtime extension on recolor export", () => {
  const original = readFileSync(new URL("./assets/pixiv-vrm1-sample.vrm", import.meta.url));
  const before = readGlb(original);
  const result = rebuildVrmWithTextures(original, {
    materialChanges: { Hair_00_HAIR: { baseColorFactor: [1, 1, 1, 1], shadeColorFactor: [.8, .8, .9] } },
    textureReplacements: [{ materialName: "Hair_00_HAIR", bytes: PNG }],
  });
  const after = readGlb(result);
  assertExtensionsRetained(before, after);
  assert.equal(after.json.extensions.VRMC_vrm.meta.allowRedistribution, true);
  assert.equal(after.json.extensions.VRMC_vrm.meta.modification, "allowModificationRedistribution");
  assert.deepEqual(after.bin.slice(0, before.bin.length), before.bin);
  const skinIndex = before.json.materials.findIndex((material) => material.name === "Face_00_SKIN");
  assert.deepEqual(after.json.materials[skinIndex], before.json.materials[skinIndex]);
});
