// A conservative, region-based style estimate, not a reconstruction of hidden geometry.
// Rig boxes use centre x/y and width/height in the same pixels as imageData.
export const DEFAULT_APPEARANCE = Object.freeze({
  palette: Object.freeze({ skin: "#f2c8bd", hair: "#353047", outfit: "#6f70bb", eyes: "#8b71ce", accent: "#d6b4e8" }),
  hairStyle: "bob", faceWidth: 1, eyeScale: 1, confidence: 0,
});

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const saturation = (rgb) => (Math.max(...rgb) - Math.min(...rgb)) / Math.max(1, ...rgb);
const lightness = (rgb) => (Math.max(...rgb) + Math.min(...rgb)) / 510;
const keyFor = (rgb) => rgb.map((channel) => Math.floor(channel / 24)).join(",");
const hex = (rgb) => `#${rgb.map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0")).join("")}`;
const freshDefaults = () => ({ ...DEFAULT_APPEARANCE, palette: { ...DEFAULT_APPEARANCE.palette } });

function validBox(box, width, height) {
  return box && [box.x, box.y, box.w, box.h].every(Number.isFinite)
    && box.x >= 0 && box.x < width && box.y >= 0 && box.y < height
    && box.w >= 2 && box.h >= 2 && box.w <= width && box.h <= height;
}

function addBin(bins, rgb, weight) {
  const key = keyFor(rgb);
  const bin = bins.get(key) || { weight: 0, count: 0, sum: [0, 0, 0] };
  bin.weight += weight;
  bin.count += 1;
  rgb.forEach((channel, index) => { bin.sum[index] += channel * weight; });
  bins.set(key, bin);
}

function bestBin(bins) {
  let best = null;
  for (const bin of bins.values()) if (!best || bin.weight > best.weight) best = bin;
  return best ? { rgb: best.sum.map((channel) => channel / best.weight), count: best.count } : null;
}

function backgroundMask(data, width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  const border = [];
  for (let x = 0; x < width; x += 1) { border.push(x, (height - 1) * width + x); }
  for (let y = 1; y < height - 1; y += 1) { border.push(y * width, y * width + width - 1); }
  const bins = new Map();
  let opaque = 0;
  for (const index of border) {
    const offset = index * 4;
    if (data[offset + 3] < 192) continue;
    const rgb = [data[offset], data[offset + 1], data[offset + 2]];
    if (!rgb.every(Number.isFinite)) continue;
    opaque += 1;
    addBin(bins, rgb, 1);
  }
  const background = bestBin(bins);
  // Only a strongly uniform border is safe to call background. Flood filling
  // preserves matching colours inside the character (e.g. white shirt/black hair).
  if (!background || opaque < border.length * .6 || background.count < opaque * .55) return mask;
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const enqueue = (index) => {
    if (mask[index]) return;
    const offset = index * 4;
    if (data[offset + 3] < 96 || distance([data[offset], data[offset + 1], data[offset + 2]], background.rgb) <= 34) {
      mask[index] = 1;
      queue[tail++] = index;
    }
  };
  border.forEach(enqueue);
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    if (x) enqueue(index - 1);
    if (x < width - 1) enqueue(index + 1);
    if (index >= width) enqueue(index - width);
    if (index < total - width) enqueue(index + width);
  }
  return mask;
}

/**
 * Estimate a matching palette and modest style proportions from local RGBA pixels.
 * Input is ImageData-like {data, width, height}; an optional rig uses these pixel
 * dimensions, not normalized or original-resolution coordinates. No pixels leave
 * the caller. Invalid/empty images return a fresh, complete default appearance.
 */
export function extractAppearance(imageData, rig = null) {
  const result = freshDefaults();
  const { data, width, height } = imageData || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
    || width > 4096 || height > 4096 || width * height > 1_048_576
    || !(ArrayBuffer.isView(data) || Array.isArray(data)) || data.length !== width * height * 4) return result;

  const mask = backgroundMask(data, width, height);
  const hasFace = validBox(rig?.face, width, height);
  const face = hasFace ? rig.face : { x: width * .5, y: height * .42, w: width * .42, h: height * .5 };
  const { x: cx, y: cy, w: fw, h: fh } = face;
  const sample = (regions, score) => {
    const bins = new Map();
    const visited = new Set();
    for (const [x0, y0, x1, y1] of regions) {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y += 1) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x += 1) {
          const index = y * width + x;
          if (mask[index] || visited.has(index)) continue;
          visited.add(index);
          const offset = index * 4;
          const alpha = data[offset + 3];
          const rgb = [data[offset], data[offset + 1], data[offset + 2]];
          if (!Number.isFinite(alpha) || alpha < 96 || !rgb.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) continue;
          const weight = score(rgb) * alpha / 255;
          if (weight > 0) addBin(bins, rgb, weight);
        }
      }
    }
    const found = bestBin(bins);
    return found && found.count >= 3 ? found.rgb : null;
  };
  const relative = (left, top, right, bottom) => [cx + fw * left, cy + fh * top, cx + fw * right, cy + fh * bottom];
  const skin = sample([
    relative(-.35, .04, -.12, .24), relative(.12, .04, .35, .24), relative(-.13, -.3, .13, -.16),
  ], (rgb) => {
    const l = lightness(rgb), s = saturation(rgb);
    if (l < .15 || l > .96 || s > .88) return 0;
    return (rgb[0] >= rgb[1] * .94 && rgb[0] >= rgb[2] * .94 ? 1.8 : .65) * (1 - s * .25);
  });
  const hair = sample([
    relative(-.44, -.64, .44, -.34), relative(-.68, -.28, -.44, .3), relative(.44, -.28, .68, .3),
  ], (rgb) => (skin && distance(rgb, skin) < 48 ? .08 : 1) * (lightness(rgb) < .18 ? 1.15 : 1));
  const torsoRegions = [relative(-.6, .7, .6, 1.55)];
  const outfit = sample(torsoRegions, (rgb) => (skin && distance(rgb, skin) < 48 ? .08 : 1) * (1 + saturation(rgb) * .65));
  const eyes = [rig?.leftEye, rig?.rightEye].filter((box) => validBox(box, width, height));
  const eyeRegions = eyes.length ? eyes.map((box) => [box.x - box.w * .38, box.y - box.h * .4, box.x + box.w * .38, box.y + box.h * .4])
    : [relative(-.32, -.15, -.08, -.02), relative(.08, -.15, .32, -.02)];
  const iris = sample(eyeRegions, (rgb) => {
    const l = lightness(rgb), s = saturation(rgb);
    if (l < .14 || l > .88 || s < .18 || (skin && distance(rgb, skin) < 55)) return 0;
    return s * s * 4;
  });
  const accent = sample(torsoRegions, (rgb) => {
    if (saturation(rgb) < .25 || lightness(rgb) < .2 || (skin && distance(rgb, skin) < 55) || (outfit && distance(rgb, outfit) < 70)) return 0;
    return saturation(rgb);
  });
  for (const [name, rgb] of Object.entries({ skin, hair, outfit, eyes: iris, accent: accent || iris })) {
    if (rgb) result.palette[name] = hex(rgb);
  }
  const matched = [skin, hair, outfit, iris].filter(Boolean).length;
  result.confidence = Math.round(matched / 4 * 100) / 100;
  if (hasFace && matched >= 2) result.faceWidth = clamp(fw / fh / .82, .9, 1.08);
  if (hasFace && eyes.length === 2 && iris) result.eyeScale = clamp((eyes[0].w + eyes[1].w) / 2 / fw / .275, .92, 1.12);

  // Length is inferred only from a separated silhouette and distinct hair/outfit;
  // otherwise retain a neutral bob instead of inventing unsupported geometry.
  const separated = mask.some(Boolean) || data.some((value, index) => index % 4 === 3 && value < 96);
  if (separated && hair && outfit && distance(hair, outfit) > 65) {
    const hairCoverage = (top, bottom) => {
      let considered = 0, matching = 0;
      for (let y = Math.max(0, Math.floor(cy + fh * top)); y < Math.min(height, cy + fh * bottom); y += 1) {
        for (let x = Math.max(0, Math.floor(cx - fw * .86)); x < Math.min(width, cx + fw * .86); x += 1) {
          if (Math.abs(x - cx) < fw * .48) continue;
          considered += 1;
          const index = y * width + x, offset = index * 4;
          if (!mask[index] && data[offset + 3] >= 128 && distance([data[offset], data[offset + 1], data[offset + 2]], hair) < 52) matching += 1;
        }
      }
      return considered > 12 ? matching / considered : null;
    };
    const upper = hairCoverage(.1, .38), lower = hairCoverage(.65, 1.05);
    if (upper !== null && lower !== null && upper > .16 && lower > .18) result.hairStyle = "long";
    else if (upper !== null && lower !== null && upper < .035 && lower < .035) result.hairStyle = "short";
  }
  return result;
}
