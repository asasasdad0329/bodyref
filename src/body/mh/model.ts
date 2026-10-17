import type { Sex } from '../../core/measurements';
import { type BodyAsset, addTarget } from './asset';
import { DEFAULT_SHARE, DEPOTS, type CompositionMaps, type Depot, SEGMENTS, type Segment, VISCERAL_SHARE, buildMaps } from './composition';
import { type V3, adjacency, centroid, meshVolume, smooth, vertexAreas, vertexNormals } from './geometry';
import { MEASURE_KEYS, type Levels, type MeasureContext, type MeasureKey, type Measured, measure, measureContext } from './measure';

// 把 MakeHuman 網格依「身體組成」變形成指定的數據。分層順序：
//
// 1. 骨架：身高（整體縮放）、四肢長度、肩寬，以及頸、手腕、腳踝、下胸圍這些以骨架為主的圍度。
// 2. 組成：手臂／軀幹／腿三段的肌肉量，加上各堆積區的脂肪量（kg）。脂肪沿皮膚往外長一層，
//    體重 = 瘦體重 + 增加的脂肪，體脂率由此算出。
// 3. 局部：罩杯（MakeHuman 的胸部形變，挺度隨大小自然變化）。
// 4. 微調：胸、腰、臀、臂、大腿、小腿的量測形變，代價很高，只補組成解釋不了的部分。
//
// 求解時每個參數只能影響自己負責的量測（例如罩杯只管上下胸圍差），避免用胸部去湊腰圍。

/** 量測修正：正值用 incr、負值用 decr。frame 為骨架型（便宜），否則為軟組織（昂貴） */
const CORRECTIONS: { key: MeasureKey; target: string; frame: boolean }[] = [
  { key: 'neck', target: 'measure-neck-circ', frame: true },
  { key: 'wrist', target: 'measure-wrist-circ', frame: true },
  { key: 'ankle', target: 'measure-ankle-circ', frame: true },
  { key: 'underbust', target: 'measure-underbust-circ', frame: true },
  { key: 'shoulder', target: 'measure-shoulder-dist', frame: true },
  { key: 'upperArmLen', target: 'measure-upperarm-length', frame: true },
  { key: 'forearmLen', target: 'measure-lowerarm-length', frame: true },
  { key: 'thighLen', target: 'measure-upperleg-height', frame: true },
  { key: 'calfLen', target: 'measure-lowerleg-height', frame: true },
  { key: 'bust', target: 'measure-bust-circ', frame: false },
  { key: 'waist', target: 'measure-waist-circ', frame: false },
  { key: 'hip', target: 'measure-hips-circ', frame: false },
  { key: 'upperArm', target: 'measure-upperarm-circ', frame: false },
  { key: 'thigh', target: 'measure-thigh-circ', frame: false },
  { key: 'calf', target: 'measure-calf-circ', frame: false },
];

/** 參數向量的排列：修正、肌肉三段、罩杯、脂肪各區、額外瘦體重、縮放 */
const NC = CORRECTIONS.length;
const I_MUSCLE = NC;
const I_CUP = NC + SEGMENTS.length;
const I_FAT = I_CUP + 1;
const I_LEAN = I_FAT + DEPOTS.length;
const I_SCALE = I_LEAN + 1;
const NQ = I_SCALE + 1;

/** 瘦的基礎身體本身的體脂率 */
const BASE_FAT: Record<Sex, number> = { female: 0.15, male: 0.08 };
/** 脂肪與去脂組織的密度（g/cm³） */
const FAT_DENSITY = 0.9;
const LEAN_DENSITY = 1.1;
/** 每區最多能比基礎身體再薄多少（cm） */
const MIN_THICKNESS = -0.5;

/** 求解的目標：量測值、體重、體脂率、上下胸圍差；sd 越小越要精確符合 */
export type Goal =
  | { kind: 'measure'; key: MeasureKey; value: number; sd: number }
  | { kind: 'weight'; value: number; sd: number }
  | { kind: 'bodyFat'; value: number; sd: number }
  | { kind: 'diff'; value: number; sd: number };

export interface FitInput {
  sex: Sex;
  goals: Goal[];
  /** 先驗：體重與體脂率的預期值（決定脂肪總量的起點），以及上下胸圍差 */
  prior: { weight: number; bodyFat: number; diff: number };
}

export interface FitResult {
  /** 靜止姿勢（A 字站姿）的網格，已縮放並放在地面上（公分） */
  rest: Float32Array;
  measured: Measured;
  values: Record<MeasureKey, number>;
  weight: number;
  bodyFat: number;
  /** 每個目標的誤差（模型值 − 目標值） */
  residual: { goal: Goal; error: number }[];
  /** 身體體積（cm³） */
  volume: number;
  scale: number;
  offsetY: number;
  composition: {
    muscle: Record<Segment, number>;
    /** 各區脂肪比瘦的基礎身體多出的量（kg） */
    fat: Record<Depot, number>;
    /** 比基礎身體多出的去脂體重（kg）：體重大的人骨架、肌肉、內臟也比較重 */
    lean: number;
    cup: number;
  };
}

/** 三段（min / average / max）滑桿在 v 時各段的權重 */
function tri(v: number): [number, number, number] {
  const c = Math.min(1, Math.max(0, v));
  if (c <= 0.5) return [(0.5 - c) * 2, c * 2, 0];
  return [0, (1 - c) * 2, (c - 0.5) * 2];
}
const LEVEL = ['min', 'average', 'max'] as const;

/** 自然胸型：小罩杯偏挺，越大越往下垂一點（最大罩杯時為 MakeHuman 的中等挺度，避免過度下垂） */
export function naturalFirmness(cup: number): number {
  return Math.min(0.72, Math.max(0.5, 0.72 - 0.22 * cup));
}

/** Siri 公式：體脂率 → 人體平均密度 */
const density = (bf: number) => 495 / (bf * 100 + 450);

interface SexData {
  asian: Float32Array;
  maps: CompositionMaps;
}

interface Evaluation {
  P: Float32Array;
  meas: Measured;
  weight: number;
  bodyFat: number;
  leanVolume: number;
}

export class BodyModel {
  readonly ctx: MeasureContext;
  readonly adj: number[][];
  readonly nippleVerts: Uint32Array;
  private readonly sexData = new Map<Sex, SexData>();
  private jac: { key: string; cols: number[][] } | null = null;
  private last: { sex: Sex; q: Float64Array } | null = null;

  constructor(readonly asset: BodyAsset) {
    this.ctx = measureContext(asset);
    this.adj = adjacency(asset.quads, asset.nBody);
    const B = asset.base;
    const near: number[] = [];
    for (const name of ['bustApexL', 'bustApexR']) {
      const c = [B[asset.landmarks[name] * 3], B[asset.landmarks[name] * 3 + 1], B[asset.landmarks[name] * 3 + 2]];
      for (let i = 0; i < asset.nBody; i++) {
        if (Math.hypot(B[i * 3] - c[0], B[i * 3 + 1] - c[1], B[i * 3 + 2] - c[2]) < 2.2) near.push(i);
      }
    }
    this.nippleVerts = Uint32Array.from(near);
  }

  /** 每個性別：族群基礎形狀與脂肪分區圖（第一次用到時建立） */
  private data(sex: Sex): SexData {
    let d = this.sexData.get(sex);
    if (d) return d;
    const a = this.asset;
    const asian = new Float32Array(a.base);
    addTarget(a, `asian-${sex}-young`, 1, asian);
    addTarget(a, 'nipple-size-decr', 1, asian);
    const lean = new Float32Array(asian);
    addTarget(a, `universal-${sex}-young-averagemuscle-minweight`, 1, lean);
    const n = a.nBody;
    const maps = buildMaps(a, sex, lean, vertexNormals(lean, a.quads, n), vertexAreas(lean, a.quads, n), this.adj, measure(this.ctx, lean).marks);
    d = { asian, maps };
    this.sexData.set(sex, d);
    return d;
  }

  /** 加上依權重遮罩縮放的形變目標（肌肉分段用） */
  private addMasked(name: string, w: number, mask: Float32Array, P: Float32Array): void {
    if (!w) return;
    const t = this.asset.targets.get(name);
    if (!t) return;
    const k = w * this.asset.deltaStep;
    for (let j = 0; j < t.indices.length; j++) {
      const i = t.indices[j];
      const m = mask[i] ?? 1;
      if (!m) continue;
      P[i * 3] += t.deltas[j * 3] * k * m;
      P[i * 3 + 1] += t.deltas[j * 3 + 1] * k * m;
      P[i * 3 + 2] += t.deltas[j * 3 + 2] * k * m;
    }
  }

  /** 由參數組出未縮放的網格，並回傳加脂肪前（瘦體）的體積 */
  private build(sex: Sex, q: Float64Array, P: Float32Array): number {
    const a = this.asset;
    const d = this.data(sex);
    P.set(d.asian);
    // 肌肉：三段各自混合 MakeHuman 的肌肉形變（以偏瘦的版本當基礎）
    SEGMENTS.forEach((seg, s) => {
      const w = tri(q[I_MUSCLE + s]);
      for (let l = 0; l < 3; l++) this.addMasked(`universal-${sex}-young-${LEVEL[l]}muscle-minweight`, w[l], d.maps.segment[seg], P);
    });
    // 骨架與量測修正
    for (let k = 0; k < NC; k++) {
      const p = q[k];
      if (p) addTarget(a, `${CORRECTIONS[k].target}-${p > 0 ? 'incr' : 'decr'}`, Math.abs(p), P);
    }
    // 罩杯：挺度隨大小自然變化
    if (sex === 'female') {
      const cup = q[I_CUP];
      const c = tri(cup), f = tri(naturalFirmness(cup));
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (i === 1 && j === 1) continue;
          const k = c[i] * f[j];
          if (k) addTarget(a, `female-young-averagemuscle-minweight-${LEVEL[i]}cup-${LEVEL[j]}firmness`, k, P);
        }
      }
    }
    const leanVolume = meshVolume(P.subarray(0, a.nBody * 3), a.quads);
    // 脂肪：各區厚度 = 脂肪體積 ÷ 面積（換算到縮放後的實際尺寸）
    const s3 = q[I_SCALE] ** 3;
    // 額外的去脂體重：和全身均勻的脂肪層同樣分佈，但密度較高
    const leanT = (q[I_LEAN] * 1000) / LEAN_DENSITY / (d.maps.area.general * s3);
    if (leanT) {
      const F = d.maps.field.general;
      for (let i = 0; i < F.length; i++) P[i] += F[i] * leanT;
    }
    DEPOTS.forEach((dp, k) => {
      const kg = q[I_FAT + k];
      if (!kg) return;
      const t = Math.max(MIN_THICKNESS / q[I_SCALE], (kg * 1000) / FAT_DENSITY / (d.maps.area[dp] * s3));
      const F = d.maps.field[dp];
      for (let i = 0; i < F.length; i++) P[i] += F[i] * t;
    });
    return leanVolume;
  }

  private evaluate(sex: Sex, q: Float64Array, P: Float32Array, levels?: Levels): Evaluation {
    const leanVolume = this.build(sex, q, P);
    const meas = measure(this.ctx, P, levels);
    const s = q[I_SCALE];
    const w0 = (leanVolume * s ** 3 * density(BASE_FAT[sex])) / 1000;
    let fat = 0;
    for (let k = 0; k < DEPOTS.length; k++) fat += q[I_FAT + k];
    const weight = w0 + fat + q[I_LEAN];
    return { P, meas, weight, bodyFat: (BASE_FAT[sex] * w0 + fat) / weight, leanVolume };
  }

  private goalValue(g: Goal, e: Evaluation, s: number): number {
    if (g.kind === 'measure') return e.meas.values[g.key] * s;
    if (g.kind === 'weight') return e.weight;
    if (g.kind === 'bodyFat') return e.bodyFat;
    return (e.meas.values.bust - e.meas.values.underbust) * s;
  }

  /**
   * 參數 k 是否可以影響目標 g（局部性：罩杯只管胸圍差，修正只管自己那一項）。
   * 體重與體脂率例外：任何形變都會改變體積，所以一定算進去。
   */
  private allowed(k: number, g: Goal): boolean {
    if (g.kind === 'weight' || g.kind === 'bodyFat') return true;
    if (k < NC) return g.kind === 'measure' && g.key === CORRECTIONS[k].key;
    if (k === I_CUP) return g.kind === 'diff' || (g.kind === 'measure' && (g.key === 'bust' || g.key === 'underbust'));
    return true;
  }

  fit(inp: FitInput): FitResult {
    const { sex, goals } = inp;
    const a = this.asset;
    const P = new Float32Array(a.base.length);
    const share = DEFAULT_SHARE[sex];

    // 起點與先驗
    const prior = new Float64Array(NQ);
    const sigma = new Float64Array(NQ);
    CORRECTIONS.forEach((c, k) => (sigma[k] = c.frame ? 2 : 0.3));
    const height = goals.find((g) => g.kind === 'measure' && g.key === 'height')!.value;
    const bmi = inp.prior.weight / (height / 100) ** 2;
    const expectedFat = (1.2 * bmi + 0.23 * 25 - 10.8 * (sex === 'male' ? 1 : 0) - 5.4) / 100;
    const muscle = Math.min(1, Math.max(0, 0.5 + (expectedFat - inp.prior.bodyFat) / 0.16));
    for (let s = 0; s < SEGMENTS.length; s++) {
      prior[I_MUSCLE + s] = muscle;
      sigma[I_MUSCLE + s] = 0.25;
    }
    const diff = inp.prior.diff;
    prior[I_CUP] = sex === 'female' ? Math.min(1, Math.max(0, diff < 12.5 ? 0.5 - (12.5 - diff) / 13 : 0.5 + (diff - 12.5) / 25)) : 0;
    sigma[I_CUP] = sex === 'female' ? 0.35 : 1e-6;

    // 以先驗的組成算出瘦體重，推得要增加多少脂肪，再依預設比例分到各區
    const probe = Float64Array.from(prior);
    probe[I_SCALE] = 1;
    const e0 = this.evaluate(sex, probe, P);
    probe[I_SCALE] = height / e0.meas.values.height;
    const lean = this.evaluate(sex, probe, P);
    const w0 = lean.weight;
    const extra = inp.prior.bodyFat * inp.prior.weight - BASE_FAT[sex] * w0;
    const extraLean = (1 - inp.prior.bodyFat) * inp.prior.weight - (1 - BASE_FAT[sex]) * w0;
    prior[I_LEAN] = extraLean;
    sigma[I_LEAN] = Math.max(1.5, 0.4 * Math.abs(extraLean));
    DEPOTS.forEach((d, k) => {
      let kg = extra * (1 - VISCERAL_SHARE[sex]) * share[d];
      if (d === 'abdomen') kg += extra * VISCERAL_SHARE[sex];
      prior[I_FAT + k] = kg;
      sigma[I_FAT + k] = Math.max(0.4, 0.6 * Math.abs(kg) + 0.08 * Math.abs(extra));
    });
    prior[I_SCALE] = probe[I_SCALE];
    sigma[I_SCALE] = 1;

    // 從上一次的解出發（拖動滑桿時只差一點點），但縮放先對準新的身高
    let q = this.last?.sex === sex ? Float64Array.from(this.last.q) : Float64Array.from(prior);
    let e = this.evaluate(sex, q, P);
    q[I_SCALE] = height / e.meas.values.height;
    e = this.evaluate(sex, q, P);
    let levels = e.meas.levels;
    // 目標的組成（哪些數值是手動的）改變時，影響矩陣要重算
    const jacKey = `${sex}|${goals.map((g) => (g.kind === 'measure' ? g.key : g.kind)).join(',')}`;
    let J = this.jac?.key === jacKey ? this.jac.cols : null;
    let recomputed = 0;
    let researched = 0;
    let prevCost = Infinity;

    const residuals = (ev: Evaluation, qq: Float64Array) => goals.map((g) => (this.goalValue(g, ev, qq[I_SCALE]) - g.value) / g.sd);

    for (let it = 0; it < 40; it++) {
      const r = residuals(e, q);
      const cost = r.reduce((s, x) => s + x * x, 0);
      const worst = Math.max(...r.map(Math.abs));
      if (worst < 0.5 || Math.abs(prevCost - cost) < 2e-3 * (1 + cost)) {
        const full = measure(this.ctx, P);
        const moved = Object.keys(levels).some((k) => Math.abs(full.levels[k as keyof Levels] - levels[k as keyof Levels]) > 0.01);
        if (!moved || researched >= 2) {
          e = { ...e, meas: full };
          break;
        }
        levels = full.levels;
        e = this.evaluate(sex, q, P, levels);
        researched++;
        prevCost = Infinity;
        continue;
      }
      if (!J || (it > 0 && it % 8 === 0 && worst > 2 && recomputed < 2)) {
        J = this.jacobian(sex, q, levels, goals);
        this.jac = { key: jacKey, cols: J };
        recomputed++;
      }
      prevCost = cost;
      // 加權最小平方：(JᵀJ + Σ⁻²) δ = −(Jᵀr + Σ⁻²(q − q₀))
      const A = Array.from({ length: NQ }, () => new Array(NQ).fill(0));
      const b = new Array(NQ).fill(0);
      const cols = J.map((col, k) => col.map((v, i) => (this.allowed(k, goals[i]) ? v / goals[i].sd : 0)));
      for (let x = 0; x < NQ; x++) {
        for (let y = x; y < NQ; y++) {
          let sum = 0;
          for (let i = 0; i < goals.length; i++) sum += cols[x][i] * cols[y][i];
          A[x][y] = A[y][x] = sum;
        }
        let sum = 0;
        for (let i = 0; i < goals.length; i++) sum += cols[x][i] * r[i];
        const reg = 1 / sigma[x] ** 2;
        A[x][x] += reg + 1e-6;
        b[x] = -sum - reg * (q[x] - prior[x]);
      }
      const d = solveSym(A, b);
      q = Float64Array.from(q, (v, k) => v + d[k]);
      this.clampParams(sex, q);
      e = this.evaluate(sex, q, P, levels);
    }
    this.last = { sex, q };

    const s = q[I_SCALE];
    const offsetY = -e.meas.marks.soleY * s;
    const rest = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      rest[i] = P[i] * s;
      rest[i + 1] = P[i + 1] * s + offsetY;
      rest[i + 2] = P[i + 2] * s;
    }
    const values = {} as Record<MeasureKey, number>;
    for (const k of MEASURE_KEYS) values[k] = e.meas.values[k] * s;
    const composition = {
      muscle: Object.fromEntries(SEGMENTS.map((seg, k) => [seg, q[I_MUSCLE + k]])) as Record<Segment, number>,
      fat: Object.fromEntries(DEPOTS.map((d, k) => [d, q[I_FAT + k]])) as Record<Depot, number>,
      lean: q[I_LEAN],
      cup: q[I_CUP],
    };
    return {
      rest,
      measured: e.meas,
      values,
      weight: e.weight,
      bodyFat: e.bodyFat,
      residual: goals.map((g) => ({ goal: g, error: this.goalValue(g, e, s) - g.value })),
      volume: meshVolume(rest.subarray(0, a.nBody * 3), a.quads),
      scale: s,
      offsetY,
      composition,
    };
  }

  private clampParams(sex: Sex, q: Float64Array): void {
    for (let k = 0; k < NC; k++) q[k] = Math.max(-3, Math.min(3, q[k]));
    for (let s = 0; s < SEGMENTS.length; s++) q[I_MUSCLE + s] = Math.max(0, Math.min(1, q[I_MUSCLE + s]));
    q[I_CUP] = sex === 'female' ? Math.max(0, Math.min(1, q[I_CUP])) : 0;
    for (let k = 0; k < DEPOTS.length; k++) q[I_FAT + k] = Math.max(-3, Math.min(60, q[I_FAT + k]));
    q[I_LEAN] = Math.max(-8, Math.min(40, q[I_LEAN]));
  }

  /** 每個參數對各目標的影響（前向差分） */
  private jacobian(sex: Sex, q0: Float64Array, levels: Levels, goals: Goal[]): number[][] {
    const P = new Float32Array(this.asset.base.length);
    const e0 = this.evaluate(sex, q0, P, levels);
    const base = goals.map((g) => this.goalValue(g, e0, q0[I_SCALE]));
    const cols: number[][] = [];
    for (let k = 0; k < NQ; k++) {
      let h = k < NC ? 0.25 : k === I_SCALE ? 0.01 : k >= I_FAT ? 0.8 : 0.1;
      const q = Float64Array.from(q0);
      if ((k >= I_MUSCLE && k <= I_CUP && q[k] + h > 1) || (k === I_CUP && sex === 'male')) h = -h;
      q[k] += h;
      if (k === I_CUP && sex === 'male') {
        cols.push(goals.map(() => 0));
        continue;
      }
      const e = this.evaluate(sex, q, P, levels);
      cols.push(goals.map((g, i) => (this.goalValue(g, e, q[I_SCALE]) - base[i]) / h));
    }
    return cols;
  }

  /** 顯示用網格：乳頭附近抹平，手臂轉到指定的外展角度 */
  display(fit: FitResult, armAngle: number): { P: Float32Array; armRotation: { L: ArmPose; R: ArmPose } } {
    const P = new Float32Array(fit.rest);
    smooth(P, this.adj, this.nippleVerts, 15, 0.6);
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
