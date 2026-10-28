const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const insideRect = (p, r) => p[0] >= r[0] && p[0] <= r[0] + r[2] && p[1] >= r[1] && p[1] <= r[1] + r[3];
const area = polygon => polygon.reduce((sum, p, i) => {
  const next = polygon[(i + 1) % polygon.length];
  return sum + p[0] * next[1] - next[0] * p[1];
}, 0) / 2;

/** Optional fixed alpha exclusions belong only to newly registered brow patches.
 * Points may lie outside the outer clip, but never outside the destination crop. */
export function validateBrowExclusion(patch, group) {
  if (patch.exclude === undefined && patch.excludeFeather === undefined) return;
  if (!['browLeft', 'browRight'].includes(group) || !Array.isArray(patch.exclude) || patch.exclude.length === 0
    || !Number.isFinite(patch.excludeFeather) || patch.excludeFeather <= 0 || patch.excludeFeather > 3
    || patch.exclude.some(polygon => !Array.isArray(polygon) || polygon.length < 3
      || polygon.some(p => !point(p) || !insideRect(p, patch.destination)) || Math.abs(area(polygon)) < 1e-9)) {
    throw new Error('眉部局部排除区域或内侧羽化宽度无效。');
  }
}

function polygonDistance(x, y, polygon) {
  let inside = false, nearestSquared = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    const vx = bx - ax, vy = by - ay, lengthSquared = vx * vx + vy * vy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / lengthSquared));
    const dx = x - (ax + t * vx), dy = y - (ay + t * vy);
    nearestSquared = Math.min(nearestSquared, dx * dx + dy * dy);
  }
  return inside ? Math.sqrt(nearestSquared) : 0;
}

/** Exclusion coverage, not replacement pixels. Consumes validated polygons.
 * Coverage is zero outside/on each boundary and grows only inward. Overlapping
 * exclusions use max coverage, so an overlap never doubles the feather. */
export function browExclusionCoverage(x, y, polygons, feather) {
  let coverage = 0;
  for (const polygon of polygons) {
    const t = Math.min(1, polygonDistance(x, y, polygon) / feather);
    coverage = Math.max(coverage, t * t * (3 - 2 * t));
  }
  return coverage;
}

/** Native-resolution retained alpha, sampled at pixel centers in destination
 * coordinates. Multiplying an already clipped patch by this cannot expand it. */
export function rasterizeBrowExclusion(width, height, destination, polygons, feather) {
  const alpha = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const coverage = browExclusionCoverage(destination[0] + x + .5, destination[1] + y + .5, polygons, feather);
    alpha[y * width + x] = Math.round(255 * (1 - coverage));
  }
  return alpha;
}
