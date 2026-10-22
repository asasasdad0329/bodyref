import type { MeasureKey } from './measure';
import type { Soft, SoftGoal, SoftKey } from './rings';

/** 未填部位的偏好；尺度在對數空間，量法可信度與統計變異分開處理。 */
export interface GirthPreference {
  target: number;
  scale: number;
  confidence: number;
  source?: 'navel';
  minimumTarget?: number;
}
export type GirthPreferences = Partial<Record<SoftGoal, GirthPreference>>;
export type GirthResponse = Partial<Record<SoftKey, Partial<Record<MeasureKey | 'minWaist', number>>>>;
type DistributionValues = Record<MeasureKey, number> & { minWaist?: number };
// 最細腰是造型先驗，肚臍腰是來源偏好；自由腰仍須承擔肥胖時的腹部量體。
const MIN_WAIST_PRIORITY = 8;

export function distributionPenalty(values: DistributionValues, preferences: GirthPreferences): number {
  let sum = 0;
  for (const [key, p] of Object.entries(preferences) as [SoftGoal, GirthPreference][]) {
    const z = Math.log(values[key] / p.target) / p.scale;
    sum += p.confidence * z * z;
    // 這是避免自由腰腹過細的下限偏好，不是第二條精確腰圍。
    // 超過下限後仍由來源肚臍腰評價，不能為守住推估最細腰把重量推去臀腿。
    if (p.minimumTarget && values.minWaist && values.minWaist < p.minimumTarget) sum += MIN_WAIST_PRIORITY * (Math.log(values.minWaist / p.minimumTarget) / p.scale) ** 2;
  }
  return sum;
}

/**
 * 只求自由分配區之間的小量轉移。每一欄都是同類組織的一加一減，
 * 不新增公斤、不把脂肪換成肌肉，也不直接碰手動圍度的控制參數。
 * 線性響應只用來提出候選；呼叫端必須重做硬條件並量測後才接受。
 */
export function redistributionStep(
  free: SoftKey[], response: GirthResponse, values: DistributionValues,
  preferences: GirthPreferences, protectedKeys: MeasureKey[], bias: Soft, capacity: Soft, regularization: Partial<Record<SoftKey, number>> = {},
): Soft {
  free = free.filter(k => k !== 'otherLean');
  const result = Object.fromEntries(Object.keys(bias).map((k) => [k, 0])) as Soft;
  const anchorFor = (muscle: boolean) => free.filter((k) => k.endsWith('Muscle') === muscle)
    .sort((a, b) => capacity[b] - capacity[a])[0];
  const fatAnchor = anchorFor(false), leanAnchor = anchorFor(true);
  const columns = free.filter((k) => k !== fatAnchor && k !== leanAnchor).map((key) => ({
    key, anchor: (key.endsWith('Muscle') ? leanAnchor : fatAnchor),
  })).filter((c): c is { key: SoftKey; anchor: SoftKey } => c.anchor !== undefined);
  const n = columns.length;
  if (!n) return result;
  const A: number[][] = [], b: number[] = [];
  const slope = (k: SoftKey, g: MeasureKey | 'minWaist') => response[k]?.[g] ?? 0;
  for (const [g, p] of Object.entries(preferences) as [SoftGoal, GirthPreference][]) {
    const w = Math.sqrt(p.confidence) / p.scale;
    A.push(columns.map(({ key, anchor }) => (slope(key, g) - slope(anchor, g)) * w / values[g]));
    b.push(Math.log(p.target / values[g]) * w);
    if (p.minimumTarget && values.minWaist && values.minWaist < p.minimumTarget) {
      const weight = Math.sqrt(MIN_WAIST_PRIORITY) / p.scale;
      A.push(columns.map(({ key, anchor }) => (slope(key, 'minWaist') - slope(anchor, 'minWaist')) * weight / values.minWaist!));
      b.push(Math.log(p.minimumTarget / values.minWaist) * weight);
    }
  }
  // 抑制跨區影響，精確達成仍由原有硬條件求解器負責。
  for (const g of protectedKeys) {
    const scale = Math.max(1, values[g] * 0.015);
    A.push(columns.map(({ key, anchor }) => (slope(key, g) - slope(anchor, g)) / scale));
    b.push(0);
  }
  const damping = 0.035;
  const regularizer = (key: SoftKey) => regularization[key] ?? 1;
  const M = Array.from({ length: n }, (_, i) => Array.from({ length: n + 1 }, (_, j) => {
    if (j === n) return A.reduce((s, r, k) => s + r[i] * b[k], 0) - damping * (regularizer(columns[i].key) * bias[columns[i].key] - regularizer(columns[i].anchor) * bias[columns[i].anchor]);
    return A.reduce((s, r) => s + r[i] * r[j], 0) + damping * ((i === j ? regularizer(columns[i].key) : 0) + (columns[i].anchor === columns[j].anchor ? regularizer(columns[i].anchor) : 0));
  }));
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[pivot][i])) pivot = j;
    [M[i], M[pivot]] = [M[pivot], M[i]];
    if (Math.abs(M[i][i]) < 1e-10) return result;
    for (let j = i + 1; j < n; j++) {
      const f = M[j][i] / M[i][i];
      for (let k = i; k <= n; k++) M[j][k] -= f * M[i][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = (M[i][n] - M[i].slice(i + 1, n).reduce((s, v, j) => s + v * x[i + 1 + j], 0)) / M[i][i];
    if (!Number.isFinite(x[i])) return Object.fromEntries(Object.keys(bias).map((k) => [k, 0])) as Soft;
    result[columns[i].key] += x[i];
    result[columns[i].anchor] -= x[i];
  }
  return result;
}
