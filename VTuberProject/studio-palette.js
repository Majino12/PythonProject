const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = (min, max, value) => {
  const t = clamp((value - min) / (max - min));
  return t * t * (3 - 2 * t);
};
const luminance = (r, g, b) => (.2126 * r + .7152 * g + .0722 * b) / 255;

function parseColor(hex) {
  if (typeof hex !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
    throw new TypeError("Recoloring requires a #RGB or #RRGGBB color.");
  }
  const value = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join("") : hex.slice(1);
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}

/** Return recolored pixels without mutating the source; alpha is unchanged.
 * Unlike material multiplication, relative-luminance recoloring can turn dark
 * brown hair silver while retaining its shadows, ink lines and highlights.
 */
export function recolorPixels(rgba, targetHex, { kind = "hair" } = {}) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length % 4) {
    throw new TypeError("Expected an RGBA byte array.");
  }
  if (!["hair", "eyes", "outfit"].includes(kind)) throw new TypeError("Unknown recoloring kind.");
  const target = parseColor(targetHex);
  const output = new Uint8ClampedArray(rgba);
  const histogram = new Float64Array(256);
  let population = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const light = luminance(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (rgba[i + 3] < 8 || (kind === "outfit" ? light <= 0 : light < .04 || light > .97)) continue;
    const weight = rgba[i + 3] / 255;
    histogram[Math.round(light * 255)] += weight;
    population += weight;
  }
  if (!population) return output;
  let accumulated = 0;
  let anchor = .4;
  for (let i = 0; i < histogram.length; i += 1) {
    accumulated += histogram[i];
    if (accumulated >= population * .5) {
      anchor = kind === "outfit" ? clamp(i / 255, .012, 1) : clamp(i / 255, .10, .90);
      break;
    }
  }
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue;
    const light = luminance(rgba[i], rgba[i + 1], rgba[i + 2]);
    // White cloth is its base pigment, not an eye/hair reflection. Recolor the
    // full cloth atlas, using relative darkness to keep its seams and shading.
    const weight = kind === "outfit"
      ? smoothstep(Math.min(.035, anchor * .07), Math.min(.13, anchor * .32), light)
      : smoothstep(.035, .13, light) * (1 - smoothstep(.965, .995, light));
    const shadow = Math.pow(clamp(light / anchor), .82);
    const highlight = Math.pow(clamp((light - anchor) / Math.max(1e-6, 1 - anchor)), 1.08)
      * (kind === "outfit" ? .28 : 1);
    for (let channel = 0; channel < 3; channel += 1) {
      const colored = light <= anchor
        ? target[channel] * shadow
        : target[channel] + (255 - target[channel]) * highlight;
      output[i + channel] = rgba[i + channel] + (colored - rgba[i + channel]) * weight;
    }
  }
  return output;
}

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const ADAPTATION_NOTICE = "Recolored using MoeMotion. The recoloring contributions are licensed under VRM Public License 1.0 (https://vrm.dev/en/licenses/1.0/) with the same unchanged License Settings as the original work. No additional restrictions. Original author and original license remain unchanged.";
const align4 = (length) => Math.ceil(length / 4) * 4;
const copyJson = (value) => JSON.parse(JSON.stringify(value));

function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Expected an ArrayBuffer or byte view.");
}

function readGlb(value) {
  const bytes = bytesOf(value);
  if (bytes.length < 20) throw new TypeError("VRM/GLB header is incomplete.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.length) throw new TypeError("Invalid VRM/GLB header.");
  const chunks = [];
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new TypeError("Incomplete VRM/GLB chunk.");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > bytes.length) throw new TypeError("Invalid VRM/GLB chunk length.");
    chunks.push({ type, bytes: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  if (chunks[0]?.type !== JSON_CHUNK || chunks.filter((chunk) => chunk.type === JSON_CHUNK).length !== 1
    || chunks.filter((chunk) => chunk.type === BIN_CHUNK).length > 1) {
    throw new TypeError("Unexpected VRM/GLB chunk layout.");
  }
  const json = JSON.parse(new TextDecoder().decode(chunks[0].bytes));
  if (!json.extensions?.VRMC_vrm && !json.extensions?.VRM) throw new TypeError("The file does not contain VRM metadata.");
  return { bytes, chunks, json };
}

function materialIndex(json, selector) {
  const materials = json.materials || [];
  if (typeof selector === "number") {
    if (Number.isInteger(selector) && selector >= 0 && selector < materials.length) return selector;
    throw new RangeError("Material index is out of range.");
  }
  const matches = materials.map((material, index) => material.name === selector ? index : -1).filter((index) => index >= 0);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new TypeError("Material name is ambiguous; use its index.");
  if (typeof selector === "string" && /^(0|[1-9]\d*)$/.test(selector)) return materialIndex(json, Number(selector));
  throw new TypeError(`Unknown material: ${String(selector)}`);
}

function factor(value, length, label) {
  if (!Array.isArray(value) || value.length !== length
    || !value.every((number) => Number.isFinite(number) && number >= 0 && number <= 1)) {
    throw new TypeError(`${label} must contain ${length} values between 0 and 1.`);
  }
  return [...value];
}

function changeMaterial(material, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new TypeError("Invalid material changes.");
  for (const [key, value] of Object.entries(changes)) {
    if (key === "baseColorFactor") {
      material.pbrMetallicRoughness ||= {};
      material.pbrMetallicRoughness.baseColorFactor = factor(value, 4, key);
    } else if (key === "emissiveFactor") {
      material.emissiveFactor = factor(value, 3, key);
    } else if (key === "shadeColorFactor" || key === "outlineColorFactor") {
      const mtoon = material.extensions?.VRMC_materials_mtoon;
      if (!mtoon) throw new TypeError("This material has no VRM 1.0 MToon extension.");
      mtoon[key] = factor(value, 3, key);
    } else {
      throw new TypeError(`Unsupported material change: ${key}`);
    }
  }
}

/**
 * Keep a VRM's full JSON (including license, rig and expression extensions) and
 * existing binary data. Append recolored PNGs and clone only selected texture
 * references so shared skin/face textures cannot change accidentally.
 *
 * materialChanges: { [materialNameOrIndex]: {
 *   baseColorFactor?, emissiveFactor?, shadeColorFactor?, outlineColorFactor?
 * } }
 * textureReplacements: [{ materialName OR materialIndex, bytes, mimeType?,
 *   slots?: ["baseColorTexture", "shadeMultiplyTexture"] }]
 */
export function rebuildVrmWithTextures(originalArrayBuffer, {
  materialChanges = {}, textureReplacements = [],
} = {}) {
  const { bytes, chunks, json } = readGlb(originalArrayBuffer);
  if (!materialChanges || typeof materialChanges !== "object" || Array.isArray(materialChanges)
    || !Array.isArray(textureReplacements)) throw new TypeError("Invalid VRM palette changes.");
  if (!Object.keys(materialChanges).length && !textureReplacements.length) return bytes.slice().buffer;
  for (const [selector, changes] of Object.entries(materialChanges)) {
    changeMaterial(json.materials[materialIndex(json, selector)], changes);
  }
  const originalBin = chunks.find((chunk) => chunk.type === BIN_CHUNK)?.bytes || new Uint8Array();
  let binaryLength = originalBin.length;
  const additions = [];
  if (textureReplacements.length) {
    if (json.buffers?.[0]?.uri || (json.buffers?.[0]?.byteLength || 0) > originalBin.length) {
      throw new TypeError("VRM textures must use an embedded GLB buffer.");
    }
    json.buffers ||= [{ byteLength: 0 }];
    if (!json.buffers.length) json.buffers.push({ byteLength: 0 });
    json.bufferViews ||= [];
    json.images ||= [];
    json.textures ||= [];
  }
  for (const replacement of textureReplacements) {
    if (!replacement || typeof replacement !== "object"
      || (replacement.materialName === undefined) === (replacement.materialIndex === undefined)) {
      throw new TypeError("Specify exactly one materialName or materialIndex.");
    }
    const index = materialIndex(json, replacement.materialName ?? replacement.materialIndex);
    const material = json.materials[index];
    const png = bytesOf(replacement.bytes);
    if ((replacement.mimeType || "image/png") !== "image/png" || png.length < 8
      || PNG_MAGIC.some((byte, position) => png[position] !== byte)) throw new TypeError("Texture replacement must be PNG data.");
    const slots = replacement.slots ?? ["baseColorTexture", "shadeMultiplyTexture"];
    if (!Array.isArray(slots) || !slots.length || new Set(slots).size !== slots.length
      || slots.some((slot) => !["baseColorTexture", "shadeMultiplyTexture"].includes(slot))) {
      throw new TypeError("Unsupported or duplicate texture slot.");
    }
    const offset = align4(binaryLength);
    const bufferView = json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: png.length }) - 1;
    const image = json.images.push({ bufferView, mimeType: "image/png", name: `${material.name || index}_MoeMotion_palette` }) - 1;
    additions.push({ offset, bytes: png });
    binaryLength = offset + png.length;
    for (const slot of slots) {
      let holder;
      if (slot === "baseColorTexture") {
        material.pbrMetallicRoughness ||= {};
        holder = material.pbrMetallicRoughness;
      } else {
        holder = material.extensions?.VRMC_materials_mtoon;
        if (!holder) throw new TypeError("This material has no MToon shade texture slot.");
      }
      const previousInfo = holder[slot] || {};
      const previousTexture = previousInfo.index === undefined ? {} : json.textures[previousInfo.index];
      if (!previousTexture) throw new TypeError("The existing texture index is invalid.");
      const texture = copyJson(previousTexture);
      texture.source = image;
      // An alternate compressed source would otherwise override the new PNG.
      if (texture.extensions) {
        for (const key of ["KHR_texture_basisu", "EXT_texture_webp", "EXT_texture_avif"]) delete texture.extensions[key];
        if (!Object.keys(texture.extensions).length) delete texture.extensions;
      }
      holder[slot] = { ...copyJson(previousInfo), index: json.textures.push(texture) - 1 };
    }
  }
  let newBin = originalBin;
  if (additions.length) {
    newBin = new Uint8Array(align4(binaryLength));
    newBin.set(originalBin);
    for (const addition of additions) newBin.set(addition.bytes, addition.offset);
    json.buffers[0].byteLength = binaryLength;
  }
  const hasMaterialChanges = Object.values(materialChanges).some((changes) => Object.keys(changes).length > 0);
  if (hasMaterialChanges || additions.length) {
    const meta = json.extensions?.VRMC_vrm?.meta;
    if (meta) {
      const originalCopyright = typeof meta.copyrightInformation === "string" ? meta.copyrightInformation : "";
      if (!originalCopyright.includes(ADAPTATION_NOTICE)) {
        meta.copyrightInformation = originalCopyright ? `${originalCopyright}\n${ADAPTATION_NOTICE}` : ADAPTATION_NOTICE;
      }
    }
  }
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonBytes = new Uint8Array(align4(encoded.length)).fill(0x20);
  jsonBytes.set(encoded);
  const outputChunks = chunks.map((chunk) => chunk.type === JSON_CHUNK
    ? { type: JSON_CHUNK, bytes: jsonBytes }
    : chunk.type === BIN_CHUNK ? { type: BIN_CHUNK, bytes: newBin } : chunk);
  if (additions.length && !chunks.some((chunk) => chunk.type === BIN_CHUNK)) {
    outputChunks.splice(1, 0, { type: BIN_CHUNK, bytes: newBin });
  }
  const total = 12 + outputChunks.reduce((sum, chunk) => sum + 8 + chunk.bytes.length, 0);
  if (total > 0xffffffff) throw new RangeError("The exported VRM exceeds the GLB size limit.");
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let offset = 12;
  for (const chunk of outputChunks) {
    view.setUint32(offset, chunk.bytes.length, true);
    view.setUint32(offset + 4, chunk.type, true);
    output.set(chunk.bytes, offset + 8);
    offset += 8 + chunk.bytes.length;
  }
  return output.buffer;
}
