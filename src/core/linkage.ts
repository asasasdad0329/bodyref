import type { MeasureId, Sex } from './measurements';
import { MUSCLE_OF_LEAN, REFERENCE } from './reference';
import stats from './statsModel.json';

// 數值連動：把全身數據視為一個多變量常態分佈（長度與重量取對數），
// 使用者鎖定的數值當作已知條件，其餘項目取條件期望值作為「建議值」，並附上常見範圍。
// 連動關係（共變異數）來自 ANSUR II；平均值來自 reference.ts 的台灣／東亞參考體型。

export type VarId = 'height' | 'weight' | 'bodyFat' | 'muscleRate' | MeasureId;
const STAT_VARS = stats.variables as Exclude<VarId, 'muscleRate'>[];
export const VARS: VarId[] = [...STAT_VARS, 'muscleRate'];
const IDX = Object.fromEntries(STAT_VARS.map((v, i) => [v, i])) as Record<VarId, number>;
const IS_LOG = stats.transform.map((t) => t === 'log');

export interface LinkageInput {
  sex: Sex;
  locked: Partial<Record<VarId, number>>;
  /** 鎖定的上下胸圍差（cm），由罩杯換算；上胸圍和下胸圍都鎖定時不使用 */
  bustDiff?: number | null;
}

export interface Suggestion {
  /** 每個項目的數值（鎖定的就是輸入值） */
  values: Record<VarId, number>;
  /** 每個項目常見範圍的下限與上限（約 10%–90%） */
  range: Record<VarId, [number, number]>;
  locked: Record<VarId, boolean>;
}

const toZ = (i: number, v: number) => (IS_LOG[i] ? Math.log(v) : v);
const fromZ = (i: number, z: number) => (IS_LOG[i] ? Math.exp(z) : z);

/** 參考體型在轉換後空間的平均值 */
function referenceMean(sex: Sex): Float64Array {
  const ref = REFERENCE[sex];
  const v: Record<VarId, number> = {
    height: ref.height,
    weight: ref.weight,
    bodyFat: ref.bodyFat,
    bust: ref.girths.underbust + ref.bustDiff,
    shoulder: ref.shoulder,
    ...ref.girths,
    upperArmLen: ref.lengthRatio.upperArmLen * ref.height,
    forearmLen: ref.lengthRatio.forearmLen * ref.height,
    thighLen: ref.lengthRatio.thighLen * ref.height,
    calfLen: ref.lengthRatio.calfLen * ref.height,
  } as Record<VarId, number>;
  return Float64Array.from(STAT_VARS, (id, i) => toZ(i, v[id]));
}

function covariance(sex: Sex): number[][] {
  return stats[sex].cov;
}

/** 解線性方程組 A x = b（A 對稱正定、維度小），用部分選主元的高斯消去法 */
function solve(A: number[][], b: number[]): number[] {
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

interface Observation {
  /** 觀測的線性係數（在轉換後空間） */
  h: number[];
  y: number;
}

/**
 * 高斯條件分佈：給定觀測 H z = y（雜訊極小），回傳後驗平均與後驗變異數（對角）。
 * 上下胸圍差是非線性的觀測，在目前的估計值附近線性化後反覆更新。
 */
function condition(mu: Float64Array, S: number[][], obs: Observation[]): { mean: number[]; variance: number[] } {
  const n = mu.length;
  if (!obs.length) return { mean: [...mu], variance: S.map((r, i) => r[i]) };
  const m = obs.length;
  const SH = Array.from({ length: n }, (_, i) => obs.map((o) => o.h.reduce((s, h, k) => s + S[i][k] * h, 0)));
  const HSH = obs.map((oa, a) => obs.map((_, b) => oa.h.reduce((s, h, k) => s + h * SH[k][b], 0) + (a === b ? 1e-9 : 0)));
  const innov = obs.map((o) => o.y - o.h.reduce((s, h, k) => s + h * mu[k], 0));
  const alpha = solve(HSH, innov);
  const mean = Array.from({ length: n }, (_, i) => mu[i] + SH[i].reduce((s, v, a) => s + v * alpha[a], 0));
  const variance = Array.from({ length: n }, (_, i) => {
    const w = solve(HSH, SH[i]);
    return Math.max(0, S[i][i] - SH[i].reduce((s, v, a) => s + v * w[a], 0));
  });
  void m;
  return { mean, variance };
}

function unit(i: number): number[] {
  const h = new Array(STAT_VARS.length).fill(0);
  h[i] = 1;
  return h;
}

const Z90 = 1.2816;

export function suggest(inp: LinkageInput): Suggestion {
  const mu = referenceMean(inp.sex);
  const S = covariance(inp.sex);
  const base: Observation[] = [];
  for (const id of STAT_VARS) {
    const v = inp.locked[id];
    if (v !== undefined) base.push({ h: unit(IDX[id]), y: toZ(IDX[id], v) });
  }
  const useDiff = inp.bustDiff != null && !(inp.locked.bust !== undefined && inp.locked.underbust !== undefined);
  let post = condition(mu, S, base);
  if (useDiff) {
    // 上胸圍 − 下胸圍 = d：以 exp(zb) − exp(zu) 在「只考慮其他鎖定值」的估計附近線性化，只更新一次。
    // 不反覆迭代：在對數空間裡罩杯是比例，迭代到底會變成「大罩杯 = 整個胸廓變大、體重變重」，
    // 但罩杯應該主要是胸部本身的事。最後再把上胸圍對齊到下胸圍 + d。
    const ib = IDX.bust, iu = IDX.underbust;
    const eb = Math.exp(post.mean[ib]), eu = Math.exp(post.mean[iu]);
    const h = new Array(STAT_VARS.length).fill(0);
    h[ib] = eb;
    h[iu] = -eu;
    const y = inp.bustDiff! - (eb - eu) + eb * post.mean[ib] - eu * post.mean[iu];
    post = condition(mu, S, [...base, { h, y }]);
  }
  const values = {} as Record<VarId, number>;
  const range = {} as Record<VarId, [number, number]>;
  const locked = {} as Record<VarId, boolean>;
  STAT_VARS.forEach((id, i) => {
    const isLocked = inp.locked[id] !== undefined;
    locked[id] = isLocked;
    values[id] = isLocked ? inp.locked[id]! : fromZ(i, post.mean[i]);
    const sd = Math.sqrt(post.variance[i]);
    range[id] = [fromZ(i, post.mean[i] - Z90 * sd), fromZ(i, post.mean[i] + Z90 * sd)];
  });
  if (useDiff) {
    if (locked.bust) values.underbust = values.bust - inp.bustDiff!;
    else values.bust = values.underbust + inp.bustDiff!;
  }
  // 肌肉沒有 ANSUR 共變異數；單獨保留手動值，不虛構與圍度的統計關係。
  values.muscleRate = inp.locked.muscleRate ?? MUSCLE_OF_LEAN * (1 - values.bodyFat);
  locked.muscleRate = inp.locked.muscleRate !== undefined;
  range.muscleRate = [0.24, Math.min(0.55, 1 - values.bodyFat - 0.12)];
  return { values, range, locked };
}

export interface Rarity {
  id: VarId;
  /** 在其他已鎖定數值的條件下，這個數值的百分位（0–1） */
  percentile: number;
}

/** 標準常態累積分佈 */
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * 每個鎖定數值相對於「其他鎖定數值」的罕見程度。
 * 例如身高 160、體重 52 時，腰圍 56 大約落在第幾百分位。
 */
export function rarity(inp: LinkageInput): Rarity[] {
  const mu = referenceMean(inp.sex);
  const S = covariance(inp.sex);
  const ids = STAT_VARS.filter((id) => inp.locked[id] !== undefined);
  return ids
    .filter((id) => id !== 'height')
    .map((id) => {
      const others: Observation[] = ids.filter((o) => o !== id).map((o) => ({ h: unit(IDX[o]), y: toZ(IDX[o], inp.locked[o]!) }));
      const post = condition(mu, S, others);
      const i = IDX[id];
      const z = (toZ(i, inp.locked[id]!) - post.mean[i]) / Math.sqrt(post.variance[i] || 1e-12);
      return { id, percentile: phi(z) };
    });
}
