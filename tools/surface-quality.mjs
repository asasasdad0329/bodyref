// 維護用穿插診斷：空間格篩選後，檢查不相鄰三角形的嚴格內部穿越。
// 不含共面重疊與共享頂點的面；結果須與原版接觸區、多視角一起判讀。
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function crosses(a, b, triangle) {
  const edge1 = sub(triangle[1], triangle[0]), edge2 = sub(triangle[2], triangle[0]);
  const direction = sub(b, a), h = cross(direction, edge2), determinant = dot(edge1, h);
  if (Math.abs(determinant) < 1e-9) return false;
  const offset = sub(a, triangle[0]), u = dot(offset, h) / determinant;
  if (u < 1e-6 || u > 1 - 1e-6) return false;
  const q = cross(offset, edge1), v = dot(direction, q) / determinant;
  if (v < 1e-6 || u + v > 1 - 1e-6) return false;
  const t = dot(edge2, q) / determinant;
  return t > 1e-6 && t < 1 - 1e-6;
}

export function surfaceQuality(P, index, asset) {
  const triangles = [], grid = new Map(), pairs = new Set(), intersections = [];
  let collapsed = 0;
  const step = 4;
  for (let i = 0; i < index.length; i += 3) {
    const ids = [index[i], index[i + 1], index[i + 2]];
    const points = ids.map(id => [P[id * 3], P[id * 3 + 1], P[id * 3 + 2]]);
    if (Math.hypot(...cross(sub(points[1], points[0]), sub(points[2], points[0]))) < 1e-7) collapsed++;
    const lo = [0, 1, 2].map(k => Math.min(...points.map(p => p[k])));
    const hi = [0, 1, 2].map(k => Math.max(...points.map(p => p[k])));
    const n = triangles.length;
    triangles.push({ ids, points, lo, hi });
    for (let x = Math.floor(lo[0] / step); x <= Math.floor(hi[0] / step); x++) {
      for (let y = Math.floor(lo[1] / step); y <= Math.floor(hi[1] / step); y++) {
        for (let z = Math.floor(lo[2] / step); z <= Math.floor(hi[2] / step); z++) {
          const key = `${x},${y},${z}`, neighbors = grid.get(key) ?? [];
          for (const j of neighbors) {
            // 三角形總數固定作配對基數，避免不同迴圈產生相同鍵。
            const pairKey = j * (index.length / 3) + n;
            if (pairs.has(pairKey)) continue;
            pairs.add(pairKey);
            const other = triangles[j];
            if (ids.some(id => other.ids.includes(id)) || lo.some((v, k) => v > other.hi[k] || hi[k] < other.lo[k])) continue;
            let hit = false;
            for (let edge = 0; edge < 3 && !hit; edge++) {
              hit = crosses(points[edge], points[(edge + 1) % 3], other.points)
                || crosses(other.points[edge], other.points[(edge + 1) % 3], points);
            }
            if (hit) intersections.push({ triangles: [j, n],
              regions: [...new Set([...ids, ...other.ids].map(id => asset.regions[asset.region[id]]))], point: points[0] });
          }
          neighbors.push(n); grid.set(key, neighbors);
        }
      }
    }
  }
  return { collapsed, intersectionPairs: intersections.length, intersections };
}
