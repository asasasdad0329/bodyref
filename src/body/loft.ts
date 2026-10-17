import { Vector3 } from 'three';
import type { Pt } from './section';

// 放樣：把一串關鍵截面（每圈點數相同）用向心 Catmull-Rom 曲線串起來，
// 補出中間的截面，得到一個「列 × 欄」的網格。關鍵截面會原封不動地出現在網格裡，
// 所以量測位置上的圍度和輸入值一致。

export interface Frame {
  c: Vector3;
  /** 截面的 u 軸（左右） */
  U: Vector3;
  /** 截面的 v 軸（前後，+v 為前） */
  V: Vector3;
}

export interface KeyRing {
  frame: Frame;
  pts: Vector3[];
}

export interface Loft {
  cols: number;
  rows: number;
  /** rows × cols × 3 */
  positions: Float32Array;
  /** 每一列的中心點，rows × 3 */
  centers: Float32Array;
  /** 每個關鍵截面在網格中的列號 */
  keyRows: number[];
  capStart: Vector3 | null;
  capEnd: Vector3 | null;
}

const FRONT = new Vector3(0, 0, 1);

/** 由截面法線方向（沿著身體部位往前進的方向）建立截面座標系 */
export function frameFromAxis(c: Vector3, axis: Vector3, front: Vector3 = FRONT): Frame {
  const t = axis.clone().normalize();
  const V = front.clone().sub(t.clone().multiplyScalar(front.dot(t))).normalize();
  const U = new Vector3().crossVectors(t, V).normalize();
  return { c, U, V };
}

export function placeRing(pts: Pt[], f: Frame): Vector3[] {
  return pts.map(([u, v]) => f.c.clone().addScaledVector(f.U, u).addScaledVector(f.V, v));
}

/** 向心 Catmull-Rom（alpha = 0.5），對單一座標分量內插 */
function crKnots(p0: number[], p1: number[], p2: number[], p3: number[]): [number, number, number] {
  const d = (a: number[], b: number[]) =>
    Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
  const t1 = d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  return [t1, t2, t3];
}

function crPoint(p0: number[], p1: number[], p2: number[], p3: number[], knots: [number, number, number], s: number, out: number[]): void {
  const [t1, t2, t3] = knots;
  const t = t1 + (t2 - t1) * s;
  for (let k = 0; k < 3; k++) {
    const a1 = ((t1 - t) / t1) * p0[k] + (t / t1) * p1[k];
    const a2 = ((t2 - t) / (t2 - t1)) * p1[k] + ((t - t1) / (t2 - t1)) * p2[k];
    const a3 = ((t3 - t) / (t3 - t2)) * p2[k] + ((t - t2) / (t3 - t2)) * p3[k];
    const b1 = ((t2 - t) / t2) * a1 + (t / t2) * a2;
    const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
    out[k] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
  }
}

const arr = (v: Vector3) => [v.x, v.y, v.z];

export function loft(keys: KeyRing[], step: number, capStart: Vector3 | null = null, capEnd: Vector3 | null = null): Loft {
  const cols = keys[0].pts.length;
  const K = keys.length;
  const pts = keys.map((k) => k.pts.map(arr));
  const ctr = keys.map((k) => arr(k.frame.c));
  const ghost = (a: number[], b: number[]) => [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];

  const subdiv: number[] = [];
  for (let i = 0; i < K - 1; i++) {
    const dist = keys[i].frame.c.distanceTo(keys[i + 1].frame.c);
    subdiv.push(Math.max(1, Math.ceil(dist / step)));
  }
  const rows = subdiv.reduce((a, b) => a + b, 0) + 1;
  const positions = new Float32Array(rows * cols * 3);
  const centers = new Float32Array(rows * 3);
  const keyRows: number[] = [];
  const tmp = [0, 0, 0];

  let row = 0;
  const emit = (P: number[][][], C: number[][], i: number, s: number) => {
    for (let j = 0; j < cols; j++) {
      const p0 = i > 0 ? P[i - 1][j] : ghost(P[0][j], P[1][j]);
      const p3 = i + 2 < K ? P[i + 2][j] : ghost(P[K - 1][j], P[K - 2][j]);
      const kn = crKnots(p0, P[i][j], P[i + 1][j], p3);
      crPoint(p0, P[i][j], P[i + 1][j], p3, kn, s, tmp);
      positions.set(tmp, (row * cols + j) * 3);
    }
    const c0 = i > 0 ? C[i - 1] : ghost(C[0], C[1]);
    const c3 = i + 2 < K ? C[i + 2] : ghost(C[K - 1], C[K - 2]);
    crPoint(c0, C[i], C[i + 1], c3, crKnots(c0, C[i], C[i + 1], c3), s, tmp);
    centers.set(tmp, row * 3);
    row++;
  };

  for (let i = 0; i < K - 1; i++) {
    keyRows.push(row);
    for (let s = 0; s < subdiv[i]; s++) {
      if (s === 0) {
        // 關鍵截面直接寫入，避免數值誤差
        for (let j = 0; j < cols; j++) positions.set(pts[i][j], (row * cols + j) * 3);
        centers.set(ctr[i], row * 3);
        row++;
      } else {
        emit(pts, ctr, i, s / subdiv[i]);
      }
    }
  }
  keyRows.push(row);
  for (let j = 0; j < cols; j++) positions.set(pts[K - 1][j], (row * cols + j) * 3);
  centers.set(ctr[K - 1], row * 3);

  return { cols, rows, positions, centers, keyRows, capStart, capEnd };
}

export interface MeshData {
  positions: Float32Array;
  index: Uint32Array;
}

/** 由放樣網格建立封閉的三角網格，並確保法線朝外 */
export function buildMesh(l: Loft): MeshData {
  const { rows, cols } = l;
  const gridCount = rows * cols;
  const extra = (l.capStart ? 1 : 0) + (l.capEnd ? 1 : 0);
  const positions = new Float32Array((gridCount + extra) * 3);
  positions.set(l.positions);
  let next = gridCount;
  const startIdx = l.capStart ? next++ : -1;
  const endIdx = l.capEnd ? next++ : -1;
  if (l.capStart) positions.set(arr(l.capStart), startIdx * 3);
  if (l.capEnd) positions.set(arr(l.capEnd), endIdx * 3);

  const tris: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let j = 0; j < cols; j++) {
      const a = r * cols + j;
      const b = r * cols + ((j + 1) % cols);
      const c = (r + 1) * cols + j;
      const d = (r + 1) * cols + ((j + 1) % cols);
      tris.push(a, c, b, b, c, d);
    }
  }
  for (let j = 0; j < cols; j++) {
    const jn = (j + 1) % cols;
    if (startIdx >= 0) tris.push(startIdx, j, jn);
    if (endIdx >= 0) tris.push(endIdx, (rows - 1) * cols + jn, (rows - 1) * cols + j);
  }
  const index = new Uint32Array(tris);
  if (signedVolume(positions, index) < 0) {
    for (let i = 0; i < index.length; i += 3) {
      const t = index[i + 1];
      index[i + 1] = index[i + 2];
      index[i + 2] = t;
    }
  }
  return { positions, index };
}

export function signedVolume(p: Float32Array, index: Uint32Array): number {
  let v = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/**
 * 以截面積積分估算一段網格的體積（cm³）。
 * 只計算 [rowStart, rowEnd] 這幾列，用來排除和其他部位重疊的部分（例如藏在軀幹裡的大腿根部）。
 */
export function sliceVolume(l: Loft, rowStart: number, rowEnd: number, includeCaps = false): number {
  const { cols, positions: P, centers: C } = l;
  const areas: Vector3[] = [];
  const cs: Vector3[] = [];
  for (let r = rowStart; r <= rowEnd; r++) {
    const c = new Vector3(C[r * 3], C[r * 3 + 1], C[r * 3 + 2]);
    const A = new Vector3();
    for (let j = 0; j < cols; j++) {
      const i0 = (r * cols + j) * 3;
      const i1 = (r * cols + ((j + 1) % cols)) * 3;
      const ax = P[i0] - c.x, ay = P[i0 + 1] - c.y, az = P[i0 + 2] - c.z;
      const bx = P[i1] - c.x, by = P[i1 + 1] - c.y, bz = P[i1 + 2] - c.z;
      A.x += ay * bz - az * by;
      A.y += az * bx - ax * bz;
      A.z += ax * by - ay * bx;
    }
    areas.push(A.multiplyScalar(0.5));
    cs.push(c);
  }
  let vol = 0;
  for (let i = 0; i < areas.length - 1; i++) {
    const n = areas[i].clone().add(areas[i + 1]);
    if (n.lengthSq() === 0) continue;
    n.normalize();
    const h = Math.abs(cs[i + 1].clone().sub(cs[i]).dot(n));
    vol += ((areas[i].length() + areas[i + 1].length()) / 2) * h;
  }
  if (includeCaps) {
    if (l.capStart && rowStart === 0) vol += (areas[0].length() * Math.abs(l.capStart.clone().sub(cs[0]).dot(areas[0].clone().normalize()))) / 3;
    const last = areas.length - 1;
    if (l.capEnd && rowEnd === l.rows - 1) vol += (areas[last].length() * Math.abs(l.capEnd.clone().sub(cs[last]).dot(areas[last].clone().normalize()))) / 3;
  }
  return vol;
}

export function mirrorLoft(l: Loft): Loft {
  const flip = (a: Float32Array) => {
    const out = new Float32Array(a);
    for (let i = 0; i < out.length; i += 3) out[i] = -out[i];
    return out;
  };
  const flipV = (v: Vector3 | null) => (v ? new Vector3(-v.x, v.y, v.z) : null);
  return { ...l, positions: flip(l.positions), centers: flip(l.centers), capStart: flipV(l.capStart), capEnd: flipV(l.capEnd) };
}

/** 網格線：每隔 rowStep 列畫一圈，每隔 colStep 欄畫一條縱線 */
export function gridLineIndex(l: Loft, rowStep: number, colStep: number, startIdx: number, endIdx: number): Uint32Array {
  const { rows, cols } = l;
  const seg: number[] = [];
  const rowSet = new Set<number>();
  for (let r = 0; r < rows; r += rowStep) rowSet.add(r);
  for (const r of rowSet) {
    for (let j = 0; j < cols; j++) seg.push(r * cols + j, r * cols + ((j + 1) % cols));
  }
  for (let j = 0; j < cols; j += colStep) {
    for (let r = 0; r < rows - 1; r++) seg.push(r * cols + j, (r + 1) * cols + j);
    if (startIdx >= 0) seg.push(startIdx, j);
    if (endIdx >= 0) seg.push((rows - 1) * cols + j, endIdx);
  }
  return new Uint32Array(seg);
}
