import type { BodyAsset } from './asset';
import { type V3, centroid, cross, dot, norm, pickLoop, slice, sub } from './geometry';

// 人台頭：拿掉 MakeHuman 的頭（臉與頭皮），換成依頭部實際大小生成的蛋形頭（有下巴、沒有五官）。
// 脖子在上段切開，從切口接一段平滑的頸部延伸伸進蛋形頭裡；耳朵保留原本的網格。

/** 每一列：[由下巴到頭頂的高度比例, 半寬, 最後方, 最前方]（相對值，頭寬 = 2 × 7.3） */
const PROFILE: [number, number, number, number][] = [
  [0.0, 1.2, 4.6, 7.2],
  [0.03, 2.4, 3.6, 7.8],
  [0.09, 4.1, 0.8, 8.4],
  [0.19, 5.6, -4.6, 8.7],
  [0.33, 6.6, -8.3, 8.9],
  [0.48, 7.1, -9.5, 9.0],
  [0.62, 7.3, -9.9, 8.6],
  [0.76, 6.9, -9.6, 7.4],
  [0.88, 5.8, -8.2, 5.4],
  [0.96, 3.6, -5.4, 2.4],
  [1.0, 0.0, -1.6, -1.4],
];
const COLS = 48;
const ROWS = 44;

export interface HeadParts {
  /** 頭部（含臉、脖子）的頂點，非耳朵 */
  removable: Uint8Array;
  /** 用來量頭部大小的頂點 */
  skull: Uint32Array;
  chin: Uint32Array;
  /** 切脖子用的面 */
  neckFaces: Uint32Array;
}

export function headParts(a: BodyAsset): HeadParts {
  const B = a.base;
  const head = centroid(B, ...a.joints['head']);
  const headR = new Set([a.regions.indexOf('head'), a.regions.indexOf('face')]);
  const neckR = a.regions.indexOf('neck');
  const removable = new Uint8Array(a.nBody);
  const skull: number[] = [];
  const chin: number[] = [];
  for (let i = 0; i < a.nBody; i++) {
    const r = a.region[i];
    if (r === neckR) removable[i] = 1;
    if (!headR.has(r)) continue;
    const x = Math.abs(B[i * 3]), y = B[i * 3 + 1], z = B[i * 3 + 2];
    const isEar = x > 6.3 && Math.abs(z - head[2]) < 4.5 && Math.abs(y - head[1]) < 6;
    if (!isEar) {
      removable[i] = 1;
      skull.push(i);
    }
    if (x < 1.5 && z > head[2]) chin.push(i);
  }
  const neckFaces: number[] = [];
  for (let f = 0; f < a.quads.length / 4; f++) {
    for (let k = 0; k < 4; k++) {
      const r = a.region[a.quads[f * 4 + k]];
      if (r === neckR || headR.has(r)) {
        neckFaces.push(f);
        break;
      }
    }
  }
  return { removable, skull: Uint32Array.from(skull), chin: Uint32Array.from(chin), neckFaces: Uint32Array.from(neckFaces) };
}

function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function sample(col: number, t: number): number {
  let i = 0;
  while (i < PROFILE.length - 2 && PROFILE[i + 1][0] < t) i++;
  const a = PROFILE[Math.max(0, i - 1)], b = PROFILE[i], c = PROFILE[i + 1], d = PROFILE[Math.min(PROFILE.length - 1, i + 2)];
  const u = (t - b[0]) / (c[0] - b[0] || 1);
  return cr(a[col], b[col], c[col], d[col], Math.min(1, Math.max(0, u)));
}

export interface HeadMesh {
  positions: Float32Array;
  index: Uint32Array;
  /** 正中線與眼睛高度的結構線 */
  guides: Float32Array[];
}

/** 依顯示網格上頭部的實際範圍生成蛋形頭 */
export function eggHead(P: Float32Array, parts: HeadParts): HeadMesh {
  let top = -Infinity, back = Infinity, halfW = 0, chinY = Infinity, front = -Infinity;
  for (const i of parts.skull) {
    top = Math.max(top, P[i * 3 + 1]);
    back = Math.min(back, P[i * 3 + 2]);
  }
  for (const i of parts.chin) chinY = Math.min(chinY, P[i * 3 + 1]);
  const H = top - chinY;
  // 寬度量顴骨與太陽穴高度、前額的最前方量眉毛上方
  for (const i of parts.skull) {
    const y = P[i * 3 + 1];
    const t = (y - chinY) / H;
    if (t > 0.45 && t < 0.75) halfW = Math.max(halfW, Math.abs(P[i * 3]));
    if (t > 0.6 && t < 0.75 && Math.abs(P[i * 3]) < 2) front = Math.max(front, P[i * 3 + 2]);
  }
  const kx = halfW / 7.3;
  const kz = (front - back) / (8.6 + 9.9);
  const z0 = back + 9.9 * kz;

  const positions = new Float32Array((ROWS * COLS + 2) * 3);
  const rings: number[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const t = 0.005 + (0.99 * r) / (ROWS - 1);
    const hw = sample(1, t) * kx, zb = sample(2, t) * kz + z0, zf = sample(3, t) * kz + z0;
    const zc = (zb + zf) / 2, hd = (zf - zb) / 2;
    const y = chinY + t * H;
    const ring: number[] = [];
    for (let c = 0; c < COLS; c++) {
      const a = (2 * Math.PI * c) / COLS;
      const ca = Math.cos(a), sa = Math.sin(a);
      const e = 2 / 2.3;
      const x = hw * Math.sign(sa) * Math.abs(sa) ** e;
      const z = zc + hd * Math.sign(ca) * Math.abs(ca) ** e;
      positions.set([x, y, z], (r * COLS + c) * 3);
      ring.push(x, y, z);
    }
    rings.push(ring);
  }
  const bottom = ROWS * COLS, apex = bottom + 1;
  positions.set([0, chinY, z0 + sample(3, 0) * kz - 1.5 * kz], bottom * 3);
  positions.set([0, top, z0 + sample(2, 1) * kz * 0.5], apex * 3);
  const idx: number[] = [];
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS; c++) {
      const a = r * COLS + c, b = r * COLS + ((c + 1) % COLS);
      const d = (r + 1) * COLS + c, e = (r + 1) * COLS + ((c + 1) % COLS);
      idx.push(a, b, d, b, e, d);
    }
  }
  for (let c = 0; c < COLS; c++) {
    idx.push(bottom, (c + 1) % COLS, c);
    idx.push(apex, (ROWS - 1) * COLS + c, (ROWS - 1) * COLS + ((c + 1) % COLS));
  }
  // 結構線：正中線（前後）與眼睛高度
  const col = (c: number) => Float32Array.from(rings.flatMap((ring) => ring.slice(c * 3, c * 3 + 3)));
  const eyeRow = Math.round(0.5 * (ROWS - 1));
  const guides = [col(0), col(COLS / 2), Float32Array.from([...rings[eyeRow], ...rings[eyeRow].slice(0, 3)])];
  return { positions, index: Uint32Array.from(idx), guides };
}

export interface NeckCut {
  /** 可見的身體三角形（頭與上段脖子已移除） */
  bodyIndex: Uint32Array;
  /** 從切口往上伸進頭部的頸部延伸 */
  plug: { positions: Float32Array; index: Uint32Array };
}

const PLUG_COLS = 40;
const PLUG_ROWS = 6;

/** 在脖子上段切開：切口以上的頭與脖子不顯示，改接一段平滑的延伸伸進蛋形頭 */
export function cutNeck(P: Float32Array, a: BodyAsset, parts: HeadParts): NeckCut {
  const neck = centroid(P, ...a.joints['neck']);
  const head = centroid(P, ...a.joints['head']);
  const n = norm(sub(head, neck));
  const p0: V3 = [neck[0] + (head[0] - neck[0]) * 0.55, neck[1] + (head[1] - neck[1]) * 0.55, neck[2] + (head[2] - neck[2]) * 0.55];
  const plane = { p: p0, n };
  const sd = (i: number) => (P[i * 3] - p0[0]) * n[0] + (P[i * 3 + 1] - p0[1]) * n[1] + (P[i * 3 + 2] - p0[2]) * n[2];

  const tris: number[] = [];
  for (let f = 0; f < a.quads.length / 4; f++) {
    let hide = true;
    for (let k = 0; k < 4; k++) {
      const v = a.quads[f * 4 + k];
      if (!parts.removable[v] || sd(v) <= 0) {
        hide = false;
        break;
      }
    }
    if (hide) continue;
    const q = f * 4;
    tris.push(a.quads[q], a.quads[q + 1], a.quads[q + 2], a.quads[q], a.quads[q + 2], a.quads[q + 3]);
  }

  const loop = pickLoop(slice(P, a.quads, parts.neckFaces, plane), plane, p0) ?? [];
  const ring = resampleLoop(loop, PLUG_COLS);
  const c = ring.reduce<V3>((s, q) => [s[0] + q[0] / ring.length, s[1] + q[1] / ring.length, s[2] + q[2] / ring.length], [0, 0, 0]);
  const positions = new Float32Array((PLUG_ROWS * PLUG_COLS + 1) * 3);
  for (let r = 0; r < PLUG_ROWS; r++) {
    const d = r * 1.8;
    const k = 1 - 0.035 * r;
    for (let j = 0; j < PLUG_COLS; j++) {
      const q = ring[j];
      positions.set(
        [c[0] + (q[0] - c[0]) * k + n[0] * d, c[1] + (q[1] - c[1]) * k + n[1] * d, c[2] + (q[2] - c[2]) * k + n[2] * d],
        (r * PLUG_COLS + j) * 3,
      );
    }
  }
  const top = PLUG_ROWS * PLUG_COLS;
  const dTop = (PLUG_ROWS - 1) * 1.8 + 1;
  positions.set([c[0] + n[0] * dTop, c[1] + n[1] * dTop, c[2] + n[2] * dTop], top * 3);
  // 讓三角形朝外：依截面繞向決定順序
  const [u0, u1] = [sub(ring[0], c), sub(ring[1], c)];
  const outward = dot(cross(u0, u1), n) > 0;
  const idx: number[] = [];
  const face = (a1: number, b1: number, c1: number) => (outward ? idx.push(a1, b1, c1) : idx.push(a1, c1, b1));
  for (let r = 0; r < PLUG_ROWS - 1; r++) {
    for (let j = 0; j < PLUG_COLS; j++) {
      const a0 = r * PLUG_COLS + j, b0 = r * PLUG_COLS + ((j + 1) % PLUG_COLS);
      const a1 = a0 + PLUG_COLS, b1 = b0 + PLUG_COLS;
      face(a0, b0, b1);
      face(a0, b1, a1);
    }
  }
  for (let j = 0; j < PLUG_COLS; j++) face((PLUG_ROWS - 1) * PLUG_COLS + j, (PLUG_ROWS - 1) * PLUG_COLS + ((j + 1) % PLUG_COLS), top);
  return { bodyIndex: Uint32Array.from(tris), plug: { positions, index: Uint32Array.from(idx) } };
}

/** 依弧長平均重新取樣一圈截面 */
function resampleLoop(loop: V3[], count: number): V3[] {
  if (loop.length < 3) return Array.from({ length: count }, () => [0, 0, 0] as V3);
  const pts = [...loop, loop[0]];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const total = cum[cum.length - 1];
  const out: V3[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (total * k) / count;
    while (seg < pts.length - 2 && cum[seg + 1] < d) seg++;
    const t = (d - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
    out.push([
      pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t,
      pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t,
      pts[seg][2] + (pts[seg + 1][2] - pts[seg][2]) * t,
    ]);
  }
  return out;
}
