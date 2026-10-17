// 網格幾何工具：用平面切網格得到截面、算布尺長度（截面凸包周長）、體積、平滑。
// 頂點座標存放在 Float32Array（x, y, z 連續），面是四邊形索引。

export type V3 = [number, number, number];

export interface Plane {
  /** 平面上的一點 */
  p: V3;
  /** 單位法向量 */
  n: V3;
}

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const dist = (a: V3, b: V3) => len(sub(a, b));

export function vert(P: Float32Array, i: number): V3 {
  return [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
}

/** 一組頂點的中心（例如關節輔助點的 8 個頂點） */
export function centroid(P: Float32Array, start: number, count: number): V3 {
  const c: V3 = [0, 0, 0];
  for (let i = start; i < start + count; i++) {
    c[0] += P[i * 3];
    c[1] += P[i * 3 + 1];
    c[2] += P[i * 3 + 2];
  }
  return scale(c, 1 / count);
}

/** 平面上的兩個正交方向，用來把截面點換成平面座標 */
export function planeBasis(n: V3): [V3, V3] {
  const ref: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(ref, n));
  return [u, cross(n, u)];
}

export const horizontal = (y: number): Plane => ({ p: [0, y, 0], n: [0, 1, 0] });

/**
 * 用平面切一組四邊形面，回傳截面的各個封閉（或因面集合邊界而斷開的）折線。
 */
export function slice(P: Float32Array, quads: Uint16Array, faces: Uint32Array, plane: Plane): V3[][] {
  const [px, py, pz] = plane.p;
  const [nx, ny, nz] = plane.n;
  const pts = new Map<number, V3>();
  const links = new Map<number, number[]>();
  const sd = (i: number) => (P[i * 3] - px) * nx + (P[i * 3 + 1] - py) * ny + (P[i * 3 + 2] - pz) * nz;
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  const vs = [0, 0, 0, 0];
  const ds = [0, 0, 0, 0];
  const hits: number[] = [];
  for (let f = 0; f < faces.length; f++) {
    const q = faces[f] * 4;
    let pos = 0, neg = 0;
    for (let k = 0; k < 4; k++) {
      vs[k] = quads[q + k];
      ds[k] = sd(vs[k]);
      if (ds[k] >= 0) pos++;
      else neg++;
    }
    if (!pos || !neg) continue;
    hits.length = 0;
    for (let k = 0; k < 4; k++) {
      const a = vs[k], b = vs[(k + 1) & 3];
      const da = ds[k], db = ds[(k + 1) & 3];
      if (da >= 0 === db >= 0) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo * 65536 + hi;
      if (!pts.has(key)) {
        const t = da / (da - db);
        pts.set(key, [
          P[a * 3] + (P[b * 3] - P[a * 3]) * t,
          P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t,
          P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t,
        ]);
      }
      hits.push(key);
    }
    if (hits.length === 2) link(hits[0], hits[1]);
    else if (hits.length === 4) {
      link(hits[0], hits[1]);
      link(hits[2], hits[3]);
    }
  }
  // 把線段串成折線：先從端點（只連一條）開始走，剩下的是封閉迴圈
  const used = new Set<number>();
  const chains: V3[][] = [];
  const walk = (start: number) => {
    const chain: number[] = [start];
    used.add(start);
    let cur = start;
    for (;;) {
      const next = (links.get(cur) ?? []).find((k) => !used.has(k));
      if (next === undefined) break;
      used.add(next);
      chain.push(next);
      cur = next;
    }
    chains.push(chain.map((k) => pts.get(k)!));
  };
  for (const [k, l] of links) if (l.length === 1 && !used.has(k)) walk(k);
  for (const k of links.keys()) if (!used.has(k)) walk(k);
  return chains;
}

/** 把 3D 點投影到平面座標 */
export function project(points: V3[], plane: Plane): [number, number][] {
  const [u, v] = planeBasis(plane.n);
  return points.map((p) => {
    const d = sub(p, plane.p);
    return [dot(d, u), dot(d, v)];
  });
}

function pointInPolygon(pt: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 從截面中挑出圍繞 ref 點的那一圈；找不到時取中心最近的 */
export function pickLoop(loops: V3[][], plane: Plane, ref: V3): V3[] | null {
  if (!loops.length) return null;
  const [refUV] = project([ref], plane);
  let best: V3[] | null = null;
  let bestD = Infinity;
  for (const loop of loops) {
    if (loop.length < 3) continue;
    const uv = project(loop, plane);
    if (pointInPolygon(refUV, uv)) return loop;
    const c = uv.reduce((s, p) => [s[0] + p[0] / uv.length, s[1] + p[1] / uv.length], [0, 0]);
    const d = Math.hypot(c[0] - refUV[0], c[1] - refUV[1]);
    if (d < bestD) {
      bestD = d;
      best = loop;
    }
  }
  return best;
}

/** 凸包（回傳原始點的索引，逆時針） */
export function hull2(pts: [number, number][]): number[] {
  const idx = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0] || pts[a][1] - pts[b][1]);
  if (idx.length < 3) return idx;
  const cr = (o: number, a: number, b: number) =>
    (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1]) - (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export interface Tape {
  /** 布尺長度（截面凸包周長） */
  length: number;
  /** 布尺路徑（凸包頂點，3D） */
  path: V3[];
}

/** 截面的布尺長度：拉緊的布尺會跨過凹處，所以取凸包周長 */
export function tape(loop: V3[], plane: Plane): Tape {
  const uv = project(loop, plane);
  const h = hull2(uv);
  let length = 0;
  for (let k = 0; k < h.length; k++) {
    const a = uv[h[k]], b = uv[h[(k + 1) % h.length]];
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return { length, path: h.map((i) => loop[i]) };
}

/** 封閉四邊形網格的體積（散度定理） */
export function meshVolume(P: Float32Array, quads: Uint16Array): number {
  let v = 0;
  const tri = (a: number, b: number, c: number) => {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  };
  for (let q = 0; q < quads.length; q += 4) {
    tri(quads[q], quads[q + 1], quads[q + 2]);
    tri(quads[q], quads[q + 2], quads[q + 3]);
  }
  return Math.abs(v / 6);
}

/** 頂點的鄰接表（沿四邊形的邊） */
export function adjacency(quads: Uint16Array, nVerts: number): number[][] {
  const adj: Set<number>[] = Array.from({ length: nVerts }, () => new Set<number>());
  for (let q = 0; q < quads.length; q += 4) {
    for (let k = 0; k < 4; k++) {
      const a = quads[q + k], b = quads[q + ((k + 1) & 3)];
      adj[a].add(b);
      adj[b].add(a);
    }
  }
  return adj.map((s) => [...s]);
}

/** 拉普拉斯平滑，只移動 verts 裡的頂點 */
export function smooth(P: Float32Array, adj: number[][], verts: Uint32Array, iterations: number, factor = 0.5): void {
  const tmp = new Float32Array(verts.length * 3);
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < verts.length; k++) {
      const i = verts[k];
      const nb = adj[i];
      let x = 0, y = 0, z = 0;
      for (const j of nb) {
        x += P[j * 3];
        y += P[j * 3 + 1];
        z += P[j * 3 + 2];
      }
      const m = 1 / nb.length;
      tmp[k * 3] = P[i * 3] + (x * m - P[i * 3]) * factor;
      tmp[k * 3 + 1] = P[i * 3 + 1] + (y * m - P[i * 3 + 1]) * factor;
      tmp[k * 3 + 2] = P[i * 3 + 2] + (z * m - P[i * 3 + 2]) * factor;
    }
    for (let k = 0; k < verts.length; k++) {
      const i = verts[k];
      P[i * 3] = tmp[k * 3];
      P[i * 3 + 1] = tmp[k * 3 + 1];
      P[i * 3 + 2] = tmp[k * 3 + 2];
    }
  }
}

/** 頂點法向量（四邊形拆成兩個三角形，面積加權） */
export function vertexNormals(P: Float32Array, quads: Uint16Array, nVerts: number): Float32Array {
  const N = new Float32Array(nVerts * 3);
  const tri = (a: number, b: number, c: number) => {
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      N[i * 3] += nx;
      N[i * 3 + 1] += ny;
      N[i * 3 + 2] += nz;
    }
  };
  for (let q = 0; q < quads.length; q += 4) {
    tri(quads[q], quads[q + 1], quads[q + 2]);
    tri(quads[q], quads[q + 2], quads[q + 3]);
  }
  // 讓法向量朝外：整體體積為負時翻轉
  let sign = 0;
  for (let i = 0; i < nVerts; i++) sign += N[i * 3] * P[i * 3] + N[i * 3 + 2] * P[i * 3 + 2];
  const flip = sign < 0 ? -1 : 1;
  for (let i = 0; i < nVerts; i++) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
    N[i * 3] *= flip / l;
    N[i * 3 + 1] *= flip / l;
    N[i * 3 + 2] *= flip / l;
  }
  return N;
}

/** 每個頂點分到的表面積（四邊形面積平均分給四個角） */
export function vertexAreas(P: Float32Array, quads: Uint16Array, nVerts: number): Float32Array {
  const A = new Float32Array(nVerts);
  const area = (a: number, b: number, c: number) => {
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  };
  for (let q = 0; q < quads.length; q += 4) {
    const s = area(quads[q], quads[q + 1], quads[q + 2]) + area(quads[q], quads[q + 2], quads[q + 3]);
    for (let k = 0; k < 4; k++) A[quads[q + k]] += s / 4;
  }
  return A;
}

/** 純量場的拉普拉斯平滑（讓分區權重的邊界變柔和） */
export function smoothField(F: Float32Array, adj: number[][], iterations: number): void {
  const tmp = new Float32Array(F.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < F.length; i++) {
      const nb = adj[i];
      let s = F[i];
      for (const j of nb) s += F[j];
      tmp[i] = s / (nb.length + 1);
    }
    F.set(tmp);
  }
}
