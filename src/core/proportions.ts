import { type LinkageInput, type VarId, suggest } from './linkage';
import type { MeasureId } from './measurements';

// 身體比例：腿長比、大腿：小腿、手臂長比、上臂：前臂。
// 比例和底下的長度是同一件事的兩種說法，所以彼此互斥：
// 改比例時，對應的長度變成「依比例推算」；改長度時，對應的比例變回由長度算出。
// 比例本身不進連動模型，而是先換算成長度，再當作鎖定的長度交給連動模型。

export type RatioId = 'legRatio' | 'thighCalf' | 'armRatio' | 'upperFore';
export type Ratios = Partial<Record<RatioId, number>>;

/** 腳踝骨中心離地高度約為身高的 4.2%（股下 = 大腿長 + 小腿長 + 這段；在人體網格上量得） */
export const ANKLE_HEIGHT = 0.042;

interface Group {
  /** 總長佔身高的比例 */
  total: RatioId;
  /** 上段：下段 */
  split: RatioId;
  upper: MeasureId;
  lower: MeasureId;
  offset: number;
}

export const RATIO_GROUPS: readonly Group[] = [
  { total: 'legRatio', split: 'thighCalf', upper: 'thighLen', lower: 'calfLen', offset: ANKLE_HEIGHT },
  { total: 'armRatio', split: 'upperFore', upper: 'upperArmLen', lower: 'forearmLen', offset: 0 },
];

export interface RatioDef {
  id: RatioId;
  label: string;
  hint: string;
  /** 顯示倍數：百分比為 100 */
  scale: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  digits: number;
}

export const RATIOS: readonly RatioDef[] = [
  { id: 'legRatio', label: '身高：股下', hint: '1 : 右側比值；增加表示腿更長', scale: 100, unit: '%', min: 40, max: 52, step: 0.1, digits: 1 },
  { id: 'thighCalf', label: '大腿：小腿', hint: '1 : 右側比值；增加表示小腿相對更長', scale: 1, unit: '', min: 0.5, max: 1, step: 0.01, digits: 2 },
  { id: 'armRatio', label: '身高：手臂長', hint: '1 : 右側比值；手臂長為肩點到手腕，增加表示手臂更長', scale: 100, unit: '%', min: 28, max: 38, step: 0.1, digits: 1 },
  { id: 'upperFore', label: '上臂：前臂', hint: '1 : 右側比值；增加表示前臂相對更長', scale: 1, unit: '', min: 1, max: 1.6, step: 0.01, digits: 2 },
];

/** 由長度算出比例 */
export function ratiosOf(v: Record<VarId, number>): Record<RatioId, number> {
  const out = {} as Record<RatioId, number>;
  for (const g of RATIO_GROUPS) {
    out[g.total] = (v[g.upper] + v[g.lower]) / v.height + g.offset;
    out[g.split] = v[g.upper] / v[g.lower];
  }
  return out;
}

/** 這個長度屬於哪一組比例 */
export function groupOfLength(id: VarId): Group | undefined {
  return RATIO_GROUPS.find((g) => g.upper === id || g.lower === id);
}

export function groupOfRatio(id: RatioId): Group {
  return RATIO_GROUPS.find((g) => g.total === id || g.split === id)!;
}

/**
 * 把比例換算成鎖定的長度，回傳新的鎖定值與「依比例推算」的長度清單。
 * 只指定其中一個比例時，另一個用連動模型的建議值。
 */
export function applyRatios(inp: LinkageInput, ratios: Ratios): { locked: LinkageInput['locked']; derived: MeasureId[] } {
  const groups = RATIO_GROUPS.filter((g) => ratios[g.total] !== undefined || ratios[g.split] !== undefined);
  if (!groups.length) return { locked: inp.locked, derived: [] };
  const base = suggest(inp).values;
  const locked = { ...inp.locked };
  const derived: MeasureId[] = [];
  for (const g of groups) {
    const total = ratios[g.total] !== undefined ? (ratios[g.total]! - g.offset) * base.height : base[g.upper] + base[g.lower];
    const split = ratios[g.split] ?? base[g.upper] / base[g.lower];
    locked[g.upper] = (total * split) / (1 + split);
    locked[g.lower] = total / (1 + split);
    derived.push(g.upper, g.lower);
  }
  return { locked, derived };
}

/** UI 統一為左側 1，內部及舊分享碼仍保留原來的上段÷下段。 */
export function ratioToDisplay(id: RatioId, value: number): number {
  return id === 'thighCalf' || id === 'upperFore' ? 1 / value : value;
}
export const ratioFromDisplay = ratioToDisplay;
export function ratioDisplayRange(d: RatioDef) {
  const ends = [ratioToDisplay(d.id, d.min / d.scale), ratioToDisplay(d.id, d.max / d.scale)];
  return { min: Math.min(...ends), max: Math.max(...ends), step: 0.001 };
}
