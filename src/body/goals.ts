import type { Suggestion } from '../core/linkage';
import type { Sex } from '../core/measurements';
import type { FitInput, Goal } from './mh/model';
import type { MeasureKey } from './mh/measure';

// 把面板上的狀態換成網格求解的目標。
//
// - 手動填的數值一定要精確符合。
// - 骨架類的數值（身高、四肢長度）沒填時也用建議值，因為組成（胖瘦）改變不了骨架。
// - 肩寬、頸圍、手腕、腳踝、下胸圍沒填時只當作「大致在這附近」。
// - 胸、腰、臀、臂、大腿、小腿沒填時不設目標，由身體組成（脂肪分佈、肌肉量）自然決定。
// - 體重、體脂率沒填時只當作起點，會被手動填的圍度帶著走（例如把腰圍改粗，體重會跟著變重）。

const HARD = 0.02;

/** 沒填時的寬鬆程度（cm） */
const SOFT: Partial<Record<MeasureKey, number>> = {
  shoulder: 1.5,
  neck: 1,
  wrist: 0.5,
  ankle: 0.7,
  underbust: 2.5,
};

const LENGTHS: MeasureKey[] = ['upperArmLen', 'forearmLen', 'thighLen', 'calfLen'];
const SOFT_TISSUE: MeasureKey[] = ['bust', 'waist', 'hip', 'upperArm', 'thigh', 'calf'];

export interface GoalInput {
  sex: Sex;
  sug: Suggestion;
  /** 指定罩杯換算的上下胸圍差；沒指定為 null */
  bustDiff: number | null;
}

export function goalsFor({ sex, sug, bustDiff }: GoalInput): FitInput {
  const v = sug.values;
  const L = sug.locked;
  const goals: Goal[] = [{ kind: 'measure', key: 'height', value: v.height, sd: 0.02 }];
  for (const key of LENGTHS) goals.push({ kind: 'measure', key, value: v[key], sd: HARD });
  for (const [key, sd] of Object.entries(SOFT) as [MeasureKey, number][]) {
    goals.push({ kind: 'measure', key, value: v[key], sd: L[key] ? HARD : sd });
  }
  for (const key of SOFT_TISSUE) {
    if (L[key]) goals.push({ kind: 'measure', key, value: v[key], sd: HARD });
  }
  const diff = bustDiff ?? v.bust - v.underbust;
  if (sex === 'female' && !(L.bust && L.underbust)) goals.push({ kind: 'diff', value: diff, sd: bustDiff !== null ? 0.05 : 3 });
  goals.push({ kind: 'weight', value: v.weight, sd: L.weight ? 0.05 : 4 });
  goals.push({ kind: 'bodyFat', value: v.bodyFat, sd: L.bodyFat ? 0.001 : 0.035 });
  return { sex, goals, prior: { weight: v.weight, bodyFat: v.bodyFat, diff } };
}
