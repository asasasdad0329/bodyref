import type { Sex } from '../../core/measurements';
import { type BodyAsset, addTarget } from './asset';
import { adjacency, centroid, meshVolume, smooth, type V3 } from './geometry';
import { MEASURE_KEYS, type Levels, type MeasureContext, type MeasureKey, type Measured, measure, measureContext } from './measure';

// 把 MakeHuman 網格變形成指定的量測數據。
//
// 1. 整體體型：依性別、胖瘦、肌肉量、罩杯混合 MakeHuman 的整體形變目標（由藝術家製作，決定脂肪與肌肉的分佈）。
// 2. 精確尺寸：用 MakeHuman 的量測形變目標（胸圍、腰圍、臂長……）微調，
//    以高斯-牛頓法求出每個目標的權重與整體縮放，讓網格上量到的數值等於輸入值。

export interface Macro {
  sex: Sex;
  /** 0–1，0.5 為平均 */
  muscle: number;
  /** 0–1，0.5 為平均 */
  weight: number;
  /** 胸部挺度 0–1 */
  firmness: number;
}

/** 求解的參數：量測目標（正值用 incr、負值用 decr），以及控制胸圍差的參數 */
const PARAMS: { key: string; target: string; prior?: number }[] = [
  { key: 'bust', target: 'measure-bust-circ' },
  { key: 'underbust', target: 'measure-underbust-circ' },
  { key: 'waist', target: 'measure-waist-circ' },
  { key: 'hip', target: 'measure-hips-circ' },
  { key: 'neck', target: 'measure-neck-circ' },
  { key: 'upperArm', target: 'measure-upperarm-circ' },
  { key: 'wrist', target: 'measure-wrist-circ' },
  { key: 'thigh', target: 'measure-thigh-circ' },
  { key: 'calf', target: 'measure-calf-circ' },
  { key: 'ankle', target: 'measure-ankle-circ' },
  { key: 'shoulder', target: 'measure-shoulder-dist' },
  { key: 'upperArmLen', target: 'measure-upperarm-length' },
  { key: 'forearmLen', target: 'measure-lowerarm-length' },
  { key: 'thighLen', target: 'measure-upperleg-height' },
  { key: 'calfLen', target: 'measure-lowerleg-height' },
];
const NP = PARAMS.length;
/** 第 NP 個參數：女性為罩杯（0–1.6，0.5 為平均），男性為胸廓前後厚度 */
const DIFF = NP;
const NQ = NP + 1;
const MAX_P = 4;
const MAX_CUP = 2;
const LAMBDA = 2e-5;

function macroClose(a: Macro, b: Macro): boolean {
  return Math.abs(a.muscle - b.muscle) < 0.15 && Math.abs(a.weight - b.weight) < 0.15 && Math.abs(a.firmness - b.firmness) < 0.2;
}

export type Targets = Record<MeasureKey, number>;

export interface FitResult {
  /** 靜止姿勢（A 字站姿）的網格，已縮放並放在地面上（公分） */
  rest: Float32Array;
  measured: Measured;
  /** 量測值（已縮放） */
  values: Targets;
  /** 和目標的差（cm） */
  residual: Targets;
  /** 身體體積（cm³） */
  volume: number;
  scale: number;
  offsetY: number;
  q: Float64Array;
}

/** 三段（min / average / max）滑桿在 v 時各段的權重 */
function tri(v: number): [number, number, number] {
  if (v <= 0.5) return [(0.5 - v) * 2, v * 2, 0];
  return [0, (1 - v) * 2, (v - 0.5) * 2];
}
const LEVEL = ['min', 'average', 'max'] as const;

export class BodyModel {
  readonly ctx: MeasureContext;
  readonly adj: number[][];
  readonly nippleVerts: Uint32Array;
  private macroKey = '';
  private macroBase: Float32Array | null = null;
  private jac: { cols: number[][]; sex: Sex; macro: Macro } | null = null;
  private lastQ: Float64Array | null = null;
  private lastSex: Sex | null = null;

  constructor(readonly asset: BodyAsset) {
    this.ctx = measureContext(asset);
    this.adj = adjacency(asset.quads, asset.nBody);
    const B = asset.base;
    // 乳頭附近：人台的胸部是平滑的
    const near: number[] = [];
    for (const name of ['bustApexL', 'bustApexR']) {
      const c = [B[asset.landmarks[name] * 3], B[asset.landmarks[name] * 3 + 1], B[asset.landmarks[name] * 3 + 2]];
      for (let i = 0; i < asset.nBody; i++) {
        if (Math.hypot(B[i * 3] - c[0], B[i * 3 + 1] - c[1], B[i * 3 + 2] - c[2]) < 2) near.push(i);
      }
    }
    this.nippleVerts = Uint32Array.from(near);
  }

  /** 整體體型（不含罩杯與量測目標） */
  private macroShape(m: Macro): Float32Array {
    const key = `${m.sex}|${m.muscle.toFixed(3)}|${m.weight.toFixed(3)}|${m.firmness.toFixed(3)}`;
    if (key === this.macroKey && this.macroBase) return this.macroBase;
    const a = this.asset;
    const P = new Float32Array(a.base);
    addTarget(a, `asian-${m.sex}-young`, 1, P);
    const mu = tri(m.muscle), wt = tri(m.weight);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === 1 && j === 1) continue;
        addTarget(a, `universal-${m.sex}-young-${LEVEL[i]}muscle-${LEVEL[j]}weight`, mu[i] * wt[j], P);
      }
    }
    // 人台不需要乳頭細節
    addTarget(a, 'nipple-point-decr', 1, P);
    addTarget(a, 'nipple-size-decr', 1, P);
    this.macroKey = key;
    this.macroBase = P;
    return P;
  }

  /** 罩杯形變：依胖瘦、罩杯、挺度三個滑桿混合 */
  private addBreast(m: Macro, cup: number, P: Float32Array): void {
    if (m.sex !== 'female') return;
    const wt = tri(m.weight);
    const c = cup <= 1 ? tri(cup) : ([0, 0, 2 * cup - 1] as [number, number, number]);
    const f = tri(m.firmness);
    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (i === 1 && j === 1) continue;
          const k = wt[w] * c[i] * f[j];
          if (k) addTarget(this.asset, `female-young-averagemuscle-${LEVEL[w]}weight-${LEVEL[i]}cup-${LEVEL[j]}firmness`, k, P);
        }
      }
    }
  }

  /** 由參數組出未縮放的網格 */
  shape(m: Macro, q: Float64Array, out?: Float32Array): Float32Array {
    const base = this.macroShape(m);
    const P = out ?? new Float32Array(base.length);
    P.set(base);
    for (let k = 0; k < NP; k++) {
      const p = q[k];
      if (p) addTarget(this.asset, `${PARAMS[k].target}-${p > 0 ? 'incr' : 'decr'}`, Math.abs(p), P);
    }
    if (m.sex === 'female') this.addBreast(m, q[DIFF], P);
    else if (q[DIFF]) addTarget(this.asset, `measure-frontchest-dist-${q[DIFF] > 0 ? 'incr' : 'decr'}`, Math.abs(q[DIFF]), P);
    return P;
  }

  private vec(meas: Measured): number[] {
    return MEASURE_KEYS.map((k) => meas.values[k]);
  }

  /** 在目前參數 q 附近，用中央差分算每個參數對各量測值的影響 */
  private jacobian(m: Macro, q0: Float64Array, levels: Levels): number[][] {
    const h = 0.3;
    const cols: number[][] = [];
    const P = new Float32Array(this.asset.base.length);
    for (let k = 0; k < NQ; k++) {
      const qa = Float64Array.from(q0), qb = Float64Array.from(q0);
      qa[k] += h;
      qb[k] -= h;
      if (k === DIFF && m.sex === 'female') qb[k] = Math.max(0, qb[k]);
      const va = this.vec(measure(this.ctx, this.shape(m, qa, P), levels));
      const vb = this.vec(measure(this.ctx, this.shape(m, qb, P), levels));
      const dq = qa[k] - qb[k];
      cols.push(va.map((x, i) => (x - vb[i]) / dq));
    }
    return cols;
  }

  fit(targets: Targets, m: Macro, cupPrior: number): FitResult {
    const prior = new Float64Array(NQ);
    prior[DIFF] = m.sex === 'female' ? cupPrior : 0;
    let q = this.lastQ && this.lastSex === m.sex ? Float64Array.from(this.lastQ) : Float64Array.from(prior);
    const T = MEASURE_KEYS.map((k) => targets[k]);
    const nE = T.length;
    let P = this.shape(m, q);
    let meas = measure(this.ctx, P);
    let levels = meas.levels;
    let s = targets.height / meas.values.height;
    // 體型差不多時沿用上一次的偏導數，不必每次重算
    let J = this.jac && this.jac.sex === m.sex && macroClose(this.jac.macro, m) ? this.jac.cols : null;
    let recomputed = 0;
    let researched = 0;

    for (let it = 0; it < 30; it++) {
      const mv = this.vec(meas);
      const r = mv.map((x, i) => (s * x - T[i]) / T[i]);
      const maxErr = Math.max(...mv.map((x, i) => Math.abs(s * x - T[i])));
      if (maxErr < 0.05) {
        // 收斂後重新搜尋「最細／最粗」的位置；位置變了就再修正
        const full = measure(this.ctx, P);
        const moved = Object.keys(levels).some((k) => Math.abs(full.levels[k as keyof Levels] - levels[k as keyof Levels]) > 0.01);
        meas = full;
        if (!moved || researched >= 2) break;
        levels = full.levels;
        researched++;
        continue;
      }
      if (!J || (it > 0 && it % 6 === 0 && maxErr > 0.3 && recomputed < 2)) {
        J = this.jacobian(m, q, levels);
        this.jac = { cols: J, sex: m.sex, macro: { ...m } };
        recomputed++;
      }
      // 正規方程式：未知數為 q（NQ 個）與縮放 s
      const n = NQ + 1;
      const cols = Array.from({ length: n }, (_, k) => (k === NQ ? mv.map((x, i) => x / T[i]) : J![k].map((x, i) => (s * x) / T[i])));
      const A = Array.from({ length: n }, () => new Array(n).fill(0));
      const b = new Array(n).fill(0);
      for (let a = 0; a < n; a++) {
        for (let c = a; c < n; c++) {
          let sum = 0;
          for (let i = 0; i < nE; i++) sum += cols[a][i] * cols[c][i];
          A[a][c] = A[c][a] = sum;
        }
        let sum = 0;
        for (let i = 0; i < nE; i++) sum += cols[a][i] * r[i];
        b[a] = -sum;
        if (a < NQ) {
          A[a][a] += LAMBDA;
          b[a] -= LAMBDA * (q[a] - prior[a]);
        }
      }
      const d = solveSym(A, b);
      const next = Float64Array.from(q, (v, k) => v + d[k]);
      for (let k = 0; k < NQ; k++) next[k] = Math.max(-MAX_P, Math.min(MAX_P, next[k]));
      if (m.sex === 'female') next[DIFF] = Math.max(0, Math.min(MAX_CUP, next[DIFF]));
      q = next;
      s += d[NQ];
      P = this.shape(m, q, P);
      meas = measure(this.ctx, P, levels);
    }
    this.lastQ = q;
    this.lastSex = m.sex;

    // 縮放並放到地面
    const offsetY = -meas.marks.soleY * s;
    const rest = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      rest[i] = P[i] * s;
      rest[i + 1] = P[i + 1] * s + offsetY;
      rest[i + 2] = P[i + 2] * s;
    }
    const values = {} as Targets;
    const residual = {} as Targets;
    for (const k of MEASURE_KEYS) {
      values[k] = meas.values[k] * s;
      residual[k] = values[k] - targets[k];
    }
    const volume = meshVolume(rest.subarray(0, this.asset.nBody * 3), this.asset.quads);
    return { rest, measured: meas, values, residual, volume, scale: s, offsetY, q };
  }

  /** 顯示用網格：臉部平滑成人台頭，手臂轉到指定的外展角度 */
  display(fit: FitResult, armAngle: number): { P: Float32Array; armRotation: { L: ArmPose; R: ArmPose } } {
    const P = new Float32Array(fit.rest);
    smooth(P, this.adj, this.nippleVerts, 12, 0.6);
    const rot = { L: this.poseArm(P, 'L', armAngle), R: this.poseArm(P, 'R', armAngle) };
    return { P, armRotation: rot };
  }

  /** 以肩關節為中心，把手臂轉到與垂直線夾 angle 度（線性混合蒙皮） */
  private poseArm(P: Float32Array, side: 'L' | 'R', angle: number): ArmPose {
    const a = this.asset;
    const j = side === 'L' ? 'l' : 'r';
    const sh = centroid(P, ...a.joints[`${j}-shoulder`]);
    const wr = centroid(P, ...a.joints[`${j}-hand`]);
    const sign = side === 'L' ? 1 : -1;
    const current = Math.atan2(sign * (wr[0] - sh[0]), sh[1] - wr[1]);
    const theta = sign * ((angle * Math.PI) / 180 - current);
    const c = Math.cos(theta), sn = Math.sin(theta);
    const W = a.armWeight[side];
    const rotate = (i: number, w: number) => {
      const x = P[i * 3] - sh[0], y = P[i * 3 + 1] - sh[1];
      const rx = c * x - sn * y, ry = sn * x + c * y;
      P[i * 3] = sh[0] + x + (rx - x) * w;
      P[i * 3 + 1] = sh[1] + y + (ry - y) * w;
    };
    for (let i = 0; i < a.nBody; i++) if (W[i] > 0) rotate(i, W[i]);
    // 手臂上的關節輔助點跟著整隻手臂轉
    for (const name of [`${j}-elbow`, `${j}-hand`]) {
      const [st, cnt] = a.joints[name];
      for (let i = st; i < st + cnt; i++) rotate(i, 1);
    }
    return { pivot: sh, theta };
  }
}

export interface ArmPose {
  pivot: V3;
  /** 繞 z 軸的旋轉角（弧度） */
  theta: number;
}

/** 把點繞肩關節（z 軸）旋轉，用來移動手臂上的量測線 */
export function rotateArmPoint(p: V3, pose: ArmPose): V3 {
  const c = Math.cos(pose.theta), s = Math.sin(pose.theta);
  const x = p[0] - pose.pivot[0], y = p[1] - pose.pivot[1];
  return [pose.pivot[0] + c * x - s * y, pose.pivot[1] + s * x + c * y, p[2]];
}

function solveSym(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}
