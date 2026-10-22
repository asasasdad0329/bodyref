/** 線段穿過三角形內部；端點接觸不算穿插，共面接觸交由折面檢查處理。 */
function crosses(P: Float32Array, a: number, b: number, c: number, d: number, e: number): boolean {
  a *= 3; b *= 3; c *= 3; d *= 3; e *= 3;
  const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
  const ux = P[d] - P[c], uy = P[d + 1] - P[c + 1], uz = P[d + 2] - P[c + 2];
  const vx = P[e] - P[c], vy = P[e + 1] - P[c + 1], vz = P[e + 2] - P[c + 2];
  const hx = dy * vz - dz * vy, hy = dz * vx - dx * vz, hz = dx * vy - dy * vx;
  const det = ux * hx + uy * hy + uz * hz;
  if (Math.abs(det) < 1e-9) return false;
  const sx = P[a] - P[c], sy = P[a + 1] - P[c + 1], sz = P[a + 2] - P[c + 2];
  const u = (sx * hx + sy * hy + sz * hz) / det;
  if (u < 0 || u > 1) return false;
  const qx = sy * uz - sz * uy, qy = sz * ux - sx * uz, qz = sx * uy - sy * ux;
  const v = (dx * qx + dy * qy + dz * qz) / det;
  if (v < 0 || u + v > 1) return false;
  const t = (vx * qx + vy * qy + vz * qz) / det;
  return t > 1e-6 && t < 1 - 1e-6;
}

/** 空間分桶只縮小候選集合；最後仍以實際三角面相交判定，不用包圍盒冒充穿插。 */
export function intersectionPairs(P: Float32Array, quads: Uint16Array, faces: Uint32Array): Set<number> {
  const count = quads.length / 4, grid = new Map<string, number[]>(), seen = new Set<number>(), hits = new Set<number>();
  const bounds = new Float32Array(count * 6);
  const triangles = (f: number) => {
    const q = f * 4;
    return [[quads[q], quads[q + 1], quads[q + 2]], [quads[q], quads[q + 2], quads[q + 3]]];
  };
  for (const f of faces) {
    const q = f * 4, off = f * 6;
    for (let k = 0; k < 3; k++) {
      let low = Infinity, high = -Infinity;
      for (let j = 0; j < 4; j++) { const x = P[quads[q + j] * 3 + k]; low = Math.min(low, x); high = Math.max(high, x); }
      bounds[off + k] = low; bounds[off + 3 + k] = high;
    }
    for (let x = Math.floor(bounds[off] / 4); x <= Math.floor(bounds[off + 3] / 4); x++)
      for (let y = Math.floor(bounds[off + 1] / 4); y <= Math.floor(bounds[off + 4] / 4); y++)
        for (let z = Math.floor(bounds[off + 2] / 4); z <= Math.floor(bounds[off + 5] / 4); z++) {
          const key = `${x},${y},${z}`, cell = grid.get(key) ?? [];
          for (const g of cell) {
            const pair = f * count + g;
            if (seen.has(pair)) continue;
            seen.add(pair);
            let adjacent = false, separated = false;
            for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (quads[q + i] === quads[g * 4 + j]) adjacent = true;
            if (adjacent) continue;
            for (let k = 0; k < 3; k++) if (bounds[off + k] > bounds[g * 6 + 3 + k] || bounds[off + 3 + k] < bounds[g * 6 + k]) separated = true;
            if (separated) continue;
            const a = triangles(f), b = triangles(g);
            if (a.some(t => b.some(s => [0, 1, 2].some(i =>
              crosses(P, t[i], t[(i + 1) % 3], s[0], s[1], s[2]) || crosses(P, s[i], s[(i + 1) % 3], t[0], t[1], t[2]))))) hits.add(pair);
          }
          cell.push(f); grid.set(key, cell);
        }
  }
  return hits;
}
