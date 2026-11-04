import manifest from './glute.json';
import type { BodyAsset } from './asset';
import { type Tape, type V3, adjacency, cavity, horizontal, horizontalPoints, hull2, pickLoop, slice, tape } from './geometry';

// 新臀（預覽，DECISIONS #80～#84）：網站只記「數值 → 控制」，形是事先算好的（tools/blender/glute_mh_*）。
//
//   1. 網站的全身數值換成臀的模上的脂肪 F、去脂 L（toModel，研究 R31；和 glute_mh_input.to_model 相同）。
//   2. (F, L) → 60 個共用變形方向各動多少：去脂方向 PCHIP（和 scipy 相同的端點規則），脂肪方向三次 B 樣條（#84）。
//   3. 素體整個細分一次（#82）。臀那一圈 2873 點 ＝ 網站骨架的平滑曲面 ＋ 每一點的局部縮放 × 位移（glute_mh_bind）。
//   4. 切口外 12 公分內（不含手臂）平順接回網站其他部位現在的形（拉普拉斯，共軛梯度）。
// 只做女性；骨架、其餘部位、體重帳目都還是原本的求解。

type Entry = { offset: number; count: number; dtype: string; shape: number[] };
const M = manifest as unknown as Record<string, Entry> & { modes: Entry; points: number; level1Vertices: number; degree: number };

export interface GluteData {
  Ls: Float32Array;
  knots: Float32Array;
  /** (欄, 曲線係數, 方向) */
  coef: Float32Array;
  /** (方向, 點, 3)，乘 scale 得到公分 */
  modes: Int16Array;
  scale: Float32Array;
  /** 臀那一圈在細分一次的素體上的編號 */
  region: Int32Array;
  limPtr: Int32Array;
  limCol: Int32Array;
  limVal: Float32Array;
  nbrPtr: Int32Array;
  nbr: Int32Array;
  nbrA: Float32Array;
  /** 臀那一圈每一點在 MakeHuman 160 公分（細分一次）的法向 */
  normal0: Float32Array;
  fade: Int32Array;
  hipF: Float32Array;
  /** (欄, F) 臀的模（160 公分）最翹處的臀圍 */
  hip: Float32Array;
}

export function parseGlute(buf: ArrayBuffer): GluteData {
  const get = <T>(name: string, C: new (b: ArrayBuffer, o: number, n: number) => T): T => new C(buf, M[name].offset, M[name].count);
  return {
    Ls: get('Ls', Float32Array), knots: get('knots', Float32Array), coef: get('coef', Float32Array),
    modes: get('modes', Int16Array), scale: get('scale', Float32Array), region: get('region', Int32Array),
    limPtr: get('limPtr', Int32Array), limCol: get('limCol', Int32Array), limVal: get('limVal', Float32Array),
    nbrPtr: get('nbrPtr', Int32Array), nbr: get('nbr', Int32Array), nbrA: get('nbrA', Float32Array), normal0: get('normal0', Float32Array),
    fade: get('fade', Int32Array), hipF: get('hipF', Float32Array), hip: get('hip', Float32Array),
  };
}

// ---------- 1. 輸入換算（R31：NHANES 2011–2018 DXA，女性 20–59 歲） ----------
const OTHER_FIT = [-2.601, 0.576, 0.646];
const BMC_FIT = [-8.988, 1.703, 0.245];
const GYN_SMM = 0.208, GYN_OTHER = 0.147, GYN_LST = 0.179;
export const MODEL_HEIGHT = 160;

/** 網站的全身數值 → 臀的模（160 公分）上的脂肪 F、去脂 L。bodyFat 是比例；muscle 有填時用填的骨骼肌。 */
export function toModel(height: number, weight: number, bodyFat: number, muscle?: number) {
  const s = height / MODEL_HEIGHT;
  const fat = weight * bodyFat;
  const fit = (c: number[]) => Math.exp(c[0] + c[1] * Math.log(height) + c[2] * Math.log(weight));
  const bmc = fit(BMC_FIT), other = fit(OTHER_FIT);
  const lst = weight - fat - bmc;
  const smm = muscle ?? lst - other;
  const lean = (GYN_SMM * smm + GYN_OTHER * other) / GYN_LST;
  return { F: fat / s ** 3, L: lean / s ** 3, scale: s, muscle: smm, other };
}

// ---------- 2. (F, L) → 方向的量 ----------

/** scipy.interpolate.PchipInterpolator 的斜率（含端點規則），y 是 (點, 維) 攤平 */
function pchipSlopes(x: Float32Array, y: Float32Array, dim: number): Float64Array {
  const n = x.length, d = new Float64Array(n * dim);
  const h = Array.from({ length: n - 1 }, (_, k) => x[k + 1] - x[k]);
  for (let j = 0; j < dim; j++) {
    const m = h.map((hk, k) => (y[(k + 1) * dim + j] - y[k * dim + j]) / hk);
    for (let k = 1; k < n - 1; k++) {
      if (m[k - 1] * m[k] <= 0) continue;
      const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
      d[k * dim + j] = (w1 + w2) / (w1 / m[k - 1] + w2 / m[k]);
    }
    const edge = (h0: number, h1: number, m0: number, m1: number) => {
      const e = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
      if (Math.sign(e) !== Math.sign(m0)) return 0;
      if (Math.sign(m0) !== Math.sign(m1) && Math.abs(e) > 3 * Math.abs(m0)) return 3 * m0;
      return e;
    };
    d[j] = edge(h[0], h[1], m[0], m[1]);
    d[(n - 1) * dim + j] = edge(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
  }
  return d;
}

/** 三次 B 樣條的基底函數在 x 的值（節點兩端重複 degree 次，和 glute_mh_control.knot_vector 相同） */
function bsplineBasis(t: number[], k: number, x: number): { span: number; N: number[] } {
  const nCoef = t.length - k - 1;
  let span = k;
  while (span < nCoef - 1 && x >= t[span + 1]) span++;
  const N = [1];
  const left: number[] = [], right: number[] = [];
  for (let j = 1; j <= k; j++) {
    left[j] = x - t[span + 1 - j];
    right[j] = t[span + j] - x;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const tmp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
  return { span, N };
}

// ---------- 細分一次（Catmull-Clark，和 tools/blender/glute_mh.subdivide 同一套規則與編號） ----------

interface Sparse { ptr: Int32Array; col: Int32Array; val: Float32Array; rows: number }

function subdivisionMatrix(quads: ArrayLike<number>, nv: number): { S: Sparse; quads: Uint32Array } {
  const nf = quads.length / 4;
  const ekey = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const edgeFaces = new Map<number, number[]>();
  for (let f = 0; f < nf; f++) for (let k = 0; k < 4; k++) {
    const key = ekey(quads[f * 4 + k], quads[f * 4 + ((k + 1) & 3)]);
    const list = edgeFaces.get(key);
    if (list) list.push(f); else edgeFaces.set(key, [f]);
  }
  const keys = [...edgeFaces.keys()].sort((a, b) => a - b);
  const edgeKey = new Map<number, number>();
  keys.forEach((key, i) => edgeKey.set(key, i));
  const ne = keys.length;
  const add = (r: Map<number, number>, c: number, v: number) => r.set(c, (r.get(c) ?? 0) + v);
  const fp = Array.from({ length: nf }, (_, f) => {
    const r = new Map<number, number>();
    for (let k = 0; k < 4; k++) add(r, quads[f * 4 + k], 0.25);
    return r;
  });
  const vf: number[][] = Array.from({ length: nv }, () => []);
  const ve: number[][] = Array.from({ length: nv }, () => []);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 4; k++) vf[quads[f * 4 + k]].push(f);
  const boundary = new Uint8Array(ne);
  const ep = keys.map((key, i) => {
    const a = Math.floor(key / nv), b = key % nv;
    ve[a].push(i); ve[b].push(i);
    const fs = edgeFaces.get(key)!, r = new Map<number, number>();
    if (fs.length === 2) {
      add(r, a, 0.25); add(r, b, 0.25);
      for (const f of fs) for (const [c, v] of fp[f]) add(r, c, v * 0.25);
    } else {
      add(r, a, 0.5); add(r, b, 0.5); boundary[i] = 1;
    }
    return r;
  });
  const other = (i: number, v: number) => { const a = Math.floor(keys[i] / nv); return a === v ? keys[i] % nv : a; };
  const rows: Map<number, number>[] = [];
  for (let v = 0; v < nv; v++) {
    const r = new Map<number, number>(), es = ve[v];
    const be = es.filter((i) => boundary[i]);
    if (be.length >= 2) {
      add(r, v, 0.75); add(r, other(be[0], v), 0.125); add(r, other(be[be.length - 1], v), 0.125);
    } else if (be.length === 1) {
      add(r, v, 1);
    } else {
      const n = es.length;
      for (const f of vf[v]) for (const [c, w] of fp[f]) add(r, c, w / vf[v].length / n);
      for (const i of es) { add(r, Math.floor(keys[i] / nv), 1 / n / n); add(r, keys[i] % nv, 1 / n / n); }
      add(r, v, (n - 3) / n);
    }
    rows.push(r);
  }
  rows.push(...ep, ...fp);
  let nnz = 0;
  for (const r of rows) nnz += r.size;
  const ptr = new Int32Array(rows.length + 1), col = new Int32Array(nnz), val = new Float32Array(nnz);
  let p = 0;
  rows.forEach((r, i) => { for (const [c, v] of r) { col[p] = c; val[p] = v; p++; } ptr[i + 1] = p; });
  const out = new Uint32Array(nf * 16);
  for (let f = 0; f < nf; f++) {
    const e = [0, 1, 2, 3].map((k) => nv + edgeKey.get(ekey(quads[f * 4 + k], quads[f * 4 + ((k + 1) & 3)]))!);
    const c = nv + ne + f;
    for (let k = 0; k < 4; k++) out.set([quads[f * 4 + k], e[k], c, e[(k + 3) & 3]], f * 16 + k * 4);
  }
  return { S: { ptr, col, val, rows: rows.length }, quads: out };
}

function applySparse(S: Sparse, P: ArrayLike<number>, out: Float64Array | Float32Array): void {
  for (let i = 0; i < S.rows; i++) {
    let x = 0, y = 0, z = 0;
    for (let p = S.ptr[i]; p < S.ptr[i + 1]; p++) {
      const c = S.col[p] * 3, w = S.val[p];
      x += w * P[c]; y += w * P[c + 1]; z += w * P[c + 2];
    }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
  }
}

export interface GluteHip {
  /** 臀部最翹處水平一圈的長度（凸包周長） */
  girth: number;
  y: number;
  path: V3[];
}

export class GluteBody {
  readonly nBody: number;
  readonly n1: number;
  readonly quads1: Uint32Array;
  private readonly S: Sparse;
  private readonly adj1: number[][];
  private readonly t: number[];
  private readonly slopes: Float64Array;
  private readonly nCoef: number;
  private readonly nModes: number;
  private readonly nPts: number;
  /** 切口外漸弱的列：自由點和它們的鄰點，每一列一個拉普拉斯（鄰點是自由點編號，或 -1-整體編號） */
  private readonly fadeRows: { rowVert: Int32Array; rowFree: Int32Array; rowPtr: Int32Array; rowNbr: Int32Array; diag: Float64Array };
  /** 細分一次的四邊形（點數小於 65536，存成 16 位元，給共用的切面工具用） */
  private readonly quads16: Uint16Array;
  private readonly children = new WeakMap<Uint32Array, Uint32Array>();
  /** 臀那一圈裡、四個角都在圈內的細分一次四邊形（量臀圍用） */
  private readonly regionQuads: Uint32Array;

  constructor(readonly asset: BodyAsset, readonly data: GluteData) {
    this.nBody = asset.nBody;
    const sub = subdivisionMatrix(asset.quads, asset.nBody);
    this.S = sub.S;
    this.quads1 = sub.quads;
    this.n1 = sub.S.rows;
    if (this.n1 !== M.level1Vertices) throw new Error(`新臀資料和人體網格不符（細分一次 ${this.n1} 點，資料 ${M.level1Vertices} 點）`);
    this.adj1 = adjacency(this.quads1, this.n1);
    if (this.n1 > 65536) throw new Error('細分一次的點數超過 16 位元');
    this.quads16 = Uint16Array.from(this.quads1);
    const k = M.degree;
    const K = Array.from(data.knots);
    this.t = [...Array(k).fill(K[0]), ...K, ...Array(k).fill(K[K.length - 1])];
    this.nCoef = M.coef.shape[1];
    this.nModes = M.modes.shape[0];
    this.nPts = M.modes.shape[1];
    this.slopes = pchipSlopes(data.Ls, data.coef, this.nCoef * this.nModes);
    // 漸弱：自由點與它們的鄰點各一列拉普拉斯，圈內與 12 公分外固定
    const freeIdx = new Int32Array(this.n1).fill(-1);
    data.fade.forEach((v, i) => { freeIdx[v] = i; });
    const rows = new Set<number>();
    for (const v of data.fade) { rows.add(v); for (const u of this.adj1[v]) rows.add(u); }
    const rowVert = Int32Array.from([...rows].sort((a, b) => a - b));
    const rowPtr = [0], rowNbr: number[] = [];
    const diag = new Float64Array(data.fade.length);
    for (const v of rowVert) {
      const deg = this.adj1[v].length;
      if (freeIdx[v] >= 0) diag[freeIdx[v]] += deg * deg;
      for (const u of this.adj1[v]) {
        rowNbr.push(freeIdx[u] >= 0 ? freeIdx[u] : -1 - u);
        if (freeIdx[u] >= 0) diag[freeIdx[u]] += 1;
      }
      rowPtr.push(rowNbr.length);
    }
    this.fadeRows = { rowVert, rowFree: Int32Array.from(rowVert, (v) => freeIdx[v]), rowPtr: Int32Array.from(rowPtr), rowNbr: Int32Array.from(rowNbr), diag };
    const inRegion = new Uint8Array(this.n1);
    for (const v of data.region) inRegion[v] = 1;
    const rq: number[] = [];
    for (let f = 0; f < this.quads1.length / 4; f++) {
      const q = this.quads1.subarray(f * 4, f * 4 + 4);
      if (inRegion[q[0]] && inRegion[q[1]] && inRegion[q[2]] && inRegion[q[3]]) rq.push(f);
    }
    this.regionQuads = Uint32Array.from(rq);
  }

  /** 範圍：脂肪、去脂超出格子時夾在邊上（不外插） */
  get range() {
    return { F: [this.data.knots[0], this.data.knots[this.data.knots.length - 1]], L: [this.data.Ls[0], this.data.Ls[this.data.Ls.length - 1]] };
  }

  /** (F, L) 時每個方向動多少 */
  weights(F: number, L: number): Float64Array {
    const { Ls, coef } = this.data;
    const dim = this.nCoef * this.nModes;
    const r = this.range;
    const f = Math.min(r.F[1], Math.max(r.F[0], F));
    const l = Math.min(r.L[1], Math.max(r.L[0], L));
    let i = 0;
    while (i < Ls.length - 2 && l > Ls[i + 1]) i++;
    const h = Ls[i + 1] - Ls[i], u = (l - Ls[i]) / h;
    const h00 = (1 + 2 * u) * (1 - u) ** 2, h10 = u * (1 - u) ** 2, h01 = u * u * (3 - 2 * u), h11 = u * u * (u - 1);
    const c = new Float64Array(dim);
    for (let j = 0; j < dim; j++) {
      c[j] = h00 * coef[i * dim + j] + h10 * h * this.slopes[i * dim + j] + h01 * coef[(i + 1) * dim + j] + h11 * h * this.slopes[(i + 1) * dim + j];
    }
    const { span, N } = bsplineBasis(this.t, M.degree, f);
    const w = new Float64Array(this.nModes);
    for (let a = 0; a <= M.degree; a++) {
      const row = (span - M.degree + a) * this.nModes;
      for (let m = 0; m < this.nModes; m++) w[m] += N[a] * c[row + m];
    }
    return w;
  }

  /** 臀那一圈每一點的位移（MakeHuman 原本的空間、接近極限曲面），公分 */
  displacement(F: number, L: number): Float64Array {
    const w = this.weights(F, L);
    const { modes, scale } = this.data;
    const len = this.nPts * 3, d = new Float64Array(len);
    for (let m = 0; m < this.nModes; m++) {
      const k = w[m] * scale[m];
      if (!k) continue;
      const off = m * len;
      for (let j = 0; j < len; j++) d[j] += k * modes[off + j];
    }
    return d;
  }

  /** 細分一次（任何身體頂點的量，x, y, z 連續） */
  subdivide(P: Float32Array): Float32Array {
    const out = new Float32Array(this.n1 * 3);
    applySparse(this.S, P, out);
    return out;
  }

  /** 網站骨架細分一次 */
  skeleton1(skel: Float32Array): Float64Array {
    const B1 = new Float64Array(this.n1 * 3);
    applySparse(this.S, skel, B1);
    return B1;
  }

  /** 臀那一圈 2873 點在網站上的位置：骨架的平滑曲面 ＋ 局部縮放 × 位移（glute_mh_bind.Binding.region）。
   * 局部縮放 J ＝ Jt ＋ s·n1 n0ᵀ：切平面內照鄰邊（Jt ＝ Σ 鄰邊 ⊗ A，A·n0 ＝ 0），法向照身高比例 s（glute_mh_bind.local_maps）。 */
  region(B1: Float64Array, F: number, L: number, s: number): Float64Array {
    const { region, limPtr, limCol, limVal, nbrPtr, nbr, nbrA, normal0 } = this.data;
    const d = this.displacement(F, L);
    const R = new Float64Array(this.nPts * 3);
    const J = new Float64Array(9);
    for (let k = 0; k < this.nPts; k++) {
      let x = 0, y = 0, z = 0;
      for (let p = limPtr[k]; p < limPtr[k + 1]; p++) {
        const c = limCol[p] * 3, w = limVal[p];
        x += w * B1[c]; y += w * B1[c + 1]; z += w * B1[c + 2];
      }
      const i = region[k] * 3;
      J.fill(0);
      for (let p = nbrPtr[k]; p < nbrPtr[k + 1]; p++) {
        const j = nbr[p] * 3;
        for (let r = 0; r < 3; r++) {
          const e = B1[j + r] - B1[i + r];
          for (let c = 0; c < 3; c++) J[r * 3 + c] += e * nbrA[p * 3 + c];
        }
      }
      // n1 ＝ cofactor(Jt)·n0（切平面的像的法向）
      const nx = normal0[k * 3], ny = normal0[k * 3 + 1], nz = normal0[k * 3 + 2];
      const col = (c: number): V3 => [J[c], J[3 + c], J[6 + c]];
      const [a0, a1, a2] = [col(0), col(1), col(2)];
      const cr = (u: V3, v: V3): V3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const c12 = cr(a1, a2), c20 = cr(a2, a0), c01 = cr(a0, a1);
      let mx = nx * c12[0] + ny * c20[0] + nz * c01[0], my = nx * c12[1] + ny * c20[1] + nz * c01[1], mz = nx * c12[2] + ny * c20[2] + nz * c01[2];
      const ml = Math.hypot(mx, my, mz) || 1;
      mx /= ml; my /= ml; mz /= ml;
      const dx = d[k * 3], dy = d[k * 3 + 1], dz = d[k * 3 + 2];
      const dn = s * (nx * dx + ny * dy + nz * dz);
      R[k * 3] = x + J[0] * dx + J[1] * dy + J[2] * dz + mx * dn;
      R[k * 3 + 1] = y + J[3] * dx + J[4] * dy + J[5] * dz + my * dn;
      R[k * 3 + 2] = z + J[6] * dx + J[7] * dy + J[8] * dz + mz * dn;
    }
    return R;
  }

  /** 細分一次的整個素體：臀那一圈放 R，切口外平順接回 final（網站其他部位現在的形，細分前） */
  compose(final: Float32Array, R: Float64Array): Float32Array {
    const { region, fade } = this.data;
    const out = this.subdivide(final);
    const D = new Float64Array(this.n1 * 3);
    for (let k = 0; k < this.nPts; k++) {
      const i = region[k] * 3;
      for (let c = 0; c < 3; c++) D[i + c] = R[k * 3 + c] - out[i + c];
    }
    const X = this.fadeSolve(D);
    for (let k = 0; k < this.nPts; k++) {
      const i = region[k] * 3;
      for (let c = 0; c < 3; c++) out[i + c] = R[k * 3 + c];
    }
    fade.forEach((v, f) => { for (let c = 0; c < 3; c++) out[v * 3 + c] += X[f * 3 + c]; });
    return out;
  }

  /** 只有臀那一圈的點（量臀圍用；其他點是 0，量的時候不會讀到） */
  regionOnly(R: Float64Array): Float32Array {
    const P = new Float32Array(this.n1 * 3);
    this.data.region.forEach((v, k) => { P[v * 3] = R[k * 3]; P[v * 3 + 1] = R[k * 3 + 1]; P[v * 3 + 2] = R[k * 3 + 2]; });
    return P;
  }

  /** 臀圍有鎖時：去脂 L 固定，找脂肪讓網站上量到的臀圍 ＝ target。先查模上的表，再照網站實際量到的比例修正。 */
  fatForHip(target: number, L: number, B1: Float64Array, crotchY: number, s: number): { F: number; girth: number } {
    let ratio = 1, F = this.fatForModelHip(target / s, L), girth = NaN;
    for (let it = 0; it < 4; it++) {
      girth = this.hip(this.regionOnly(this.region(B1, F, L, s)), crotchY, s).girth;
      if (Math.abs(girth - target) < 0.05) break;
      ratio = girth / (s * this.modelHip(F, L));
      const next = this.fatForModelHip(target / (s * ratio), L);
      if (Math.abs(next - F) < 1e-3) break;
      F = next;
    }
    return { F, girth };
  }

  /** 切口外的漸弱：在自由點上讓「位移的拉普拉斯」平方和最小（雙調和），固定點的值在 D（臀那一圈、12 公分外與手臂）。
   * 一階（拉普拉斯）只接得上位置、接不上斜率，臀那一圈的邊界會折出一條線；雙調和連斜率也接上。
   * 共軛梯度（Jacobi 預條件），從 0 起算，結果不依賴上一次。 */
  private fadeSolve(D: Float64Array): Float64Array {
    const nf = this.data.fade.length;
    const { rowVert, rowFree, rowPtr, rowNbr, diag } = this.fadeRows;
    const nr = rowVert.length;
    const X = new Float64Array(nf * 3);
    const y = new Float64Array(nr);
    const Lf = (v: Float64Array) => {
      for (let r = 0; r < nr; r++) {
        let s = rowFree[r] >= 0 ? (rowPtr[r + 1] - rowPtr[r]) * v[rowFree[r]] : 0;
        for (let p = rowPtr[r]; p < rowPtr[r + 1]; p++) if (rowNbr[p] >= 0) s -= v[rowNbr[p]];
        y[r] = s;
      }
    };
    const LfT = (o: Float64Array) => {
      o.fill(0);
      for (let r = 0; r < nr; r++) {
        if (rowFree[r] >= 0) o[rowFree[r]] += (rowPtr[r + 1] - rowPtr[r]) * y[r];
        for (let p = rowPtr[r]; p < rowPtr[r + 1]; p++) if (rowNbr[p] >= 0) o[rowNbr[p]] -= y[r];
      }
    };
    for (let c = 0; c < 3; c++) {
      // 已知部分：每一列固定點的貢獻
      for (let r = 0; r < nr; r++) {
        let s = rowFree[r] < 0 ? (rowPtr[r + 1] - rowPtr[r]) * D[rowVert[r] * 3 + c] : 0;
        for (let p = rowPtr[r]; p < rowPtr[r + 1]; p++) if (rowNbr[p] < 0) s -= D[(-1 - rowNbr[p]) * 3 + c];
        y[r] = -s;
      }
      const b = new Float64Array(nf);
      LfT(b);
      const x = new Float64Array(nf), r0 = Float64Array.from(b), z = new Float64Array(nf), q = new Float64Array(nf);
      for (let i = 0; i < nf; i++) z[i] = r0[i] / diag[i];
      const pv = Float64Array.from(z);
      let rz = 0, bb = 0;
      for (let i = 0; i < nf; i++) { rz += r0[i] * z[i]; bb += b[i] * b[i]; }
      for (let it = 0; it < 4000 && bb > 0; it++) {
        Lf(pv); LfT(q);
        let pq = 0;
        for (let i = 0; i < nf; i++) pq += pv[i] * q[i];
        const alpha = rz / pq;
        let rr = 0;
        for (let i = 0; i < nf; i++) { x[i] += alpha * pv[i]; r0[i] -= alpha * q[i]; rr += r0[i] * r0[i]; }
        if (rr < 1e-20 * bb) break;
        let rz2 = 0;
        for (let i = 0; i < nf; i++) { z[i] = r0[i] / diag[i]; rz2 += r0[i] * z[i]; }
        const beta = rz2 / rz;
        rz = rz2;
        for (let i = 0; i < nf; i++) pv[i] = z[i] + beta * pv[i];
      }
      for (let i = 0; i < nf; i++) X[i * 3 + c] = x[i];
    }
    return X;
  }

  /** 臀圍照網站的量法「臀部最翹處水平一圈」（和 glute_mh_fat.hip_prominent 同一個做法：最凸處 0.3 公分內那一段的中間）。
   * 只量臀那一圈（不含手）。s：身高 ／ 160；crotchY：網站的胯下高度。 */
  hip(P: Float32Array, crotchY: number, s: number, plateau = 0.3): GluteHip {
    const level = (y: number) => {
      const pts: V3[] = [];
      const seen = new Set<number>();
      const Q = this.quads1;
      for (const f of this.regionQuads) for (let k = 0; k < 4; k++) {
        const a = Q[f * 4 + k], b = Q[f * 4 + ((k + 1) & 3)];
        const da = P[a * 3 + 1] - y, db = P[b * 3 + 1] - y;
        if ((da >= 0) === (db >= 0)) continue;
        const key = Math.min(a, b) * this.n1 + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        const t = da / (da - db);
        pts.push([P[a * 3] + (P[b * 3] - P[a * 3]) * t, y, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t]);
      }
      return pts;
    };
    const ys: number[] = [], zb: number[] = [];
    for (let y = crotchY - 3 * s; y <= crotchY + 17 * s; y += 0.25 * s) {
      let z = Infinity;
      for (const p of level(y)) if (Math.abs(p[0]) < 12 * s) z = Math.min(z, p[2]);
      if (Number.isFinite(z)) { ys.push(y); zb.push(z); }
    }
    const zMin = Math.min(...zb);
    let sw = 0, sy = 0;
    ys.forEach((y, i) => { const w = Math.max(0, plateau * s - (zb[i] - zMin)); sw += w; sy += w * y; });
    const y = sy / sw;
    const girth = (yy: number) => {
      const pts = level(yy);
      const h = hull2(pts.map((p) => [p[0], p[2]]));
      let L = 0;
      for (let k = 0; k < h.length; k++) {
        const a = pts[h[k]], b = pts[h[(k + 1) % h.length]];
        L += Math.hypot(b[0] - a[0], b[2] - a[2]);
      }
      return { L, path: h.map((i) => pts[i]) };
    };
    const g = girth(y);
    return { girth: g.L, y, path: g.path };
  }

  /** 臀的模（160 公分）在去脂 L、脂肪 F 時的臀圍（格子量的表，脂肪方向已取累積最大值，單調） */
  modelHip(F: number, L: number): number {
    const { Ls, hipF, hip } = this.data;
    const nF = hipF.length;
    const col = (i: number) => {
      const f = Math.min(hipF[nF - 1], Math.max(hipF[0], F));
      let j = 0;
      while (j < nF - 2 && f > hipF[j + 1]) j++;
      const u = (f - hipF[j]) / (hipF[j + 1] - hipF[j]);
      return hip[i * nF + j] * (1 - u) + hip[i * nF + j + 1] * u;
    };
    const l = Math.min(Ls[Ls.length - 1], Math.max(Ls[0], L));
    let i = 0;
    while (i < Ls.length - 2 && l > Ls[i + 1]) i++;
    const u = (l - Ls[i]) / (Ls[i + 1] - Ls[i]);
    return col(i) * (1 - u) + col(i + 1) * u;
  }

  /** 去脂 L 時，模上臀圍 target 要多少脂肪（查表、二分；表在脂肪方向單調） */
  fatForModelHip(target: number, L: number): number {
    const r = this.range;
    let lo = r.F[0], hi = r.F[1];
    if (this.modelHip(lo, L) >= target) return lo;
    if (this.modelHip(hi, L) <= target) return hi;
    for (let it = 0; it < 50; it++) {
      const mid = (lo + hi) / 2;
      if (this.modelHip(mid, L) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** 細分一次的網格上量一圈水平皮尺。faces 是原本網格的面集合（量測用的那些）；
   * ref 有給時取離 ref 最近的那一圈（四肢），沒給時把所有截點合起來取凸包（軀幹）。 */
  tapeAt(P1: Float32Array, faces: Uint32Array, y: number, ref?: V3): Tape | null {
    let child = this.children.get(faces);
    if (!child) {
      child = new Uint32Array(faces.length * 4);
      faces.forEach((f, k) => { for (let c = 0; c < 4; c++) child![k * 4 + c] = f * 4 + c; });
      this.children.set(faces, child);
    }
    const plane = horizontal(y);
    if (!ref) {
      const pts = horizontalPoints(P1, this.quads16, child, y);
      return pts.length > 2 ? tape(pts, plane) : null;
    }
    const loop = pickLoop(slice(P1, this.quads16, child, plane), plane, ref);
    return loop && loop.length > 2 ? tape(loop, plane) : null;
  }

  /** 細分一次的凹陷程度（畫面壓暗用） */
  cavity(P: Float32Array): Float32Array {
    // 細分一次後點距約一半，平滑的次數 ×4 才是同樣的範圍
    return cavity(P, this.quads1, this.adj1, this.n1, 0.5, 48);
  }

  /** 原本可見的四邊形 → 細分一次的三角形（每個四邊形變四個） */
  triangles(keptFaces: ArrayLike<number>): Uint32Array {
    const out = new Uint32Array(keptFaces.length * 24);
    const Q = this.quads1;
    for (let k = 0; k < keptFaces.length; k++) {
      for (let c = 0; c < 4; c++) {
        const q = (keptFaces[k] * 4 + c) * 4, o = (k * 4 + c) * 6;
        out[o] = Q[q]; out[o + 1] = Q[q + 1]; out[o + 2] = Q[q + 2];
        out[o + 3] = Q[q]; out[o + 4] = Q[q + 2]; out[o + 5] = Q[q + 3];
      }
    }
    return out;
  }
}

/** 細分一次後的網格線：原本每條邊 u–v 變成 u–邊點–v（主畫面畫網格用，不需要整份資料） */
export function level1Grid(quads: ArrayLike<number>, nv: number, edges: Uint32Array): Uint32Array {
  const keys = new Set<number>();
  for (let f = 0; f < quads.length / 4; f++) for (let k = 0; k < 4; k++) {
    const a = quads[f * 4 + k], b = quads[f * 4 + ((k + 1) & 3)];
    keys.add(a < b ? a * nv + b : b * nv + a);
  }
  const sorted = [...keys].sort((a, b) => a - b);
  const index = new Map<number, number>();
  sorted.forEach((key, i) => index.set(key, nv + i));
  const out = new Uint32Array(edges.length * 2);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1], m = index.get(a < b ? a * nv + b : b * nv + a)!;
    out.set([a, m, m, b], e * 2);
  }
  return out;
}
