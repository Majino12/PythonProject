import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./studio-avatar.js", import.meta.url), "utf8");

test("studio runtime uses the bundled licensed VRM and the official loader", () => {
  assert.match(source, /\.\/assets\/pixiv-vrm1-sample\.vrm/);
  assert.match(source, /VRMLoaderPlugin/);
  assert.match(source, /VRMUtils\.deepDispose/);
  assert.doesNotMatch(source, /GLTFExporter/);
});

test("recoloring is restricted to explicit hair eye and clothing materials", () => {
  for (const material of [
    "Hair_00_HAIR", "HairBack_00_HAIR", "EyeIris_00_EYE",
    "Tops_01_CLOTH", "Bottoms_01_CLOTH", "Shoes_01_CLOTH",
  ]) assert.match(source, new RegExp(material));
  assert.doesNotMatch(source, /Face_00_SKIN:\s*"skin"/);
  assert.doesNotMatch(source, /Body_00_SKIN:\s*"skin"/);
});

test("VRM export rebuilds original bytes rather than generic glTF export", () => {
  assert.match(source, /this\.originalVrm/);
  assert.match(source, /rebuildVrmWithTextures\(this\.originalVrm/);
  assert.match(source, /this\.exportExtension = "vrm"/);
});

test("dispose keeps the shared canvas context reusable", () => {
  assert.match(source, /this\.renderer\.dispose\(\)/);
  assert.doesNotMatch(source, /\.forceContextLoss\s*\(/);
});

test("unchanged palette colors reuse texture work without dropping export factors", () => {
  assert.match(source, /lastColor:\s*null,\s*exportChange:\s*null/);
  assert.match(source, /entry\.lastColor\s*!==\s*normalizedTarget\s*\|\|\s*!entry\.exportChange/);
  assert.match(source, /exportMaterialChanges\[entry\.materialName\]\s*=\s*entry\.exportChange/);
});

