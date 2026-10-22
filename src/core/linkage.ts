import type { MeasureId, Sex } from './measurements';
import { REFERENCE } from './reference';
import stats from './statsModel.json';
import { nhanesPreference } from './nhanes';

// 數值連動：把全身數據視為一個多變量常態分佈（長度與重量取對數），
// 使用者鎖定的數值當作已知條件，其餘項目取條件期望值作為「建議值」，並附上常見範圍。
// 連動關係（共變異數）來自 ANSUR II；平均值來自 reference.ts 的台灣／東亞參考體型。

export type VarId = 'height' | 'weight' | 'bodyFat' | MeasureId;
export const VARS = stats.variables as VarId[];
const IDX = Object.fromEntries(VARS.map((v, i) => [v, i])) as Record<VarId, number>;
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
  return Float64Array.from(VARS, (id, i) => toZ(i, v[id]));
}

function covariance(sex: Sex): number[][] {
  const out = stats[sex].cov.map(r => [...r]);
  // ANSUR 骨點肩寬不轉稱服裝肩寬；後者先採身高縮放的工程參照。
  // 固定身高後，手動服裝肩寬不再以錯誤來源共變異改變其他圍度。
  const s = IDX.shoulder, h = IDX.height;
  for (let i = 0; i < out.length; i++) if (i !== s) out[s][i] = out[i][s] = out[h][i];
  out[s][s] = out[h][h] + 0.04 ** 2;
  return out;
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
  const h = new Array(VARS.length).fill(0);
  h[i] = 1;
  return h;
}

const Z90 = 1.2816;

/** ANSUR 原調查的肚臍腰偏好；不把東亞最細腰參照加固定差值冒充來源。 */
export function navelWaistPreference(sex: Sex, height: number, weight: number) {
  const row = stats[sex];
  const post = condition(Float64Array.from(row.ansurMean), covariance(sex), [
    { h: unit(IDX.height), y: toZ(IDX.height, height) },
    { h: unit(IDX.weight), y: toZ(IDX.weight, weight) },
  ]);
  return { target: Math.exp(post.mean[IDX.waist]), scale: Math.sqrt(post.variance[IDX.waist]) };
}

export function suggest(inp: LinkageInput): Suggestion {
  const mu = referenceMean(inp.sex);
  const S = covariance(inp.sex);
  const base: Observation[] = [];
  for (const id of VARS) {
    const v = inp.locked[id];
    // 放鬆上臂、最細腰不作屈臂上臂、肚臍腰的實測觀察；手動值仍完整保留。
    if (v !== undefined && id !== 'upperArm' && id !== 'waist' && !(inp.sex === 'female' && id === 'bust')) base.push({ h: unit(IDX[id]), y: toZ(IDX[id], v) });
  }
  const useDiff = inp.bustDiff != null && !(inp.locked.bust !== undefined && inp.locked.underbust !== undefined);
  const post = condition(mu, S, base);
  // 杯差只建立下方的胸圍關係，不作全身體重或骨架的觀測條件。

  const values = {} as Record<VarId, number>;
  const range = {} as Record<VarId, [number, number]>;
  const locked = {} as Record<VarId, boolean>;
  VARS.forEach((id, i) => {
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
  if (!locked.upperArm) {
    const arm = nhanesPreference(inp.sex, values.height, values.weight, values.bodyFat);
    values.upperArm = arm.arm;
    range.upperArm = [arm.arm * Math.exp(-Z90 * arm.scale), arm.arm * Math.exp(Z90 * arm.scale)];
  }
  return { values, range, locked };
}

export interface Rarity {
  id: VarId;
  /** 在其他已鎖定數值的條件下，這個數值的百分位（0–1） */
  percentile: number;
  /** 最細腰等參考模型分數不可冒充相同量法的實測百分位。 */
  basis: 'reference' | 'nhanes';
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
  const ids = VARS.filter((id) => inp.locked[id] !== undefined);
  return ids
    .filter((id) => !['height', 'shoulder', 'bodyFat'].includes(id))
    .map((id) => {
      if (id === 'upperArm') {
        const otherLocked = { ...inp.locked }; delete otherLocked.upperArm;
        const v = suggest({ ...inp, locked: otherLocked }).values;
        const arm = nhanesPreference(inp.sex, v.height, v.weight, v.bodyFat);
        return { id, percentile: phi(Math.log(inp.locked.upperArm! / arm.arm) / arm.scale), basis: 'nhanes' as const };
      }
      const others: Observation[] = ids.filter((o) => o !== id && o !== 'waist' && o !== 'upperArm' && !(inp.sex === 'female' && o === 'bust')).map((o) => ({ h: unit(IDX[o]), y: toZ(IDX[o], inp.locked[o]!) }));
      const post = condition(mu, S, others);
      const i = IDX[id];
      const z = (toZ(i, inp.locked[id]!) - post.mean[i]) / Math.sqrt(post.variance[i] || 1e-12);
      return { id, percentile: phi(z), basis: 'reference' as const };
    });
}
