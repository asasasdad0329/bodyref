import type { Suggestion } from '../core/linkage';
import type { Sex } from '../core/measurements';
import type { MeasureKey } from './mh/measure';
import type { CompositionInput, RingTargets, SoftGoal } from './mh/rings';

// 把面板上的狀態換成人體網格的輸入。
//
// - 骨架類（身高、四肢長度、肩寬、頸、手腕、腳踝、下胸圍）：手動的照填，沒填的用連動建議。
//   女性的上胸圍也在這裡（決定胸部大小），沒指定罩杯時用建議值。
// - 軟組織類（腰、臀、大腿、小腿、上臂；男性的上胸圍）：只有手動填的才固定，
//   沒填的由體重、體脂率與脂肪、肌肉的分配自然長出來。
// - 體重沒鎖定時只當作起點：手動把腰圍改粗，體重會跟著變重。

const FRAME: MeasureKey[] = ['height', 'shoulder', 'neck', 'wrist', 'ankle', 'underbust', 'upperArmLen', 'forearmLen', 'thighLen', 'calfLen'];
const SOFT: SoftGoal[] = ['bust', 'waist', 'hip', 'thigh', 'calf', 'upperArm'];

export interface GoalInput {
  sex: Sex;
  sug: Suggestion;
  /** 指定罩杯換算的上下胸圍差；沒指定為 null */
  bustDiff: number | null;
}

export interface BodyInput extends CompositionInput {
  /** 手動填的量測（用來列出做不到的項目） */
  userLocked: MeasureKey[];
  bodyFatLocked: boolean;
  bustDiff: number | null;
}

export function bodyInputFor({ sex, sug, bustDiff }: GoalInput): BodyInput {
  const v = sug.values;
  const L = sug.locked;
  const frame = Object.fromEntries(FRAME.map((k) => [k, v[k]])) as RingTargets;
  if (sex === 'female') Object.assign(frame, { bust: v.bust, underbust: v.underbust });
  const locked: CompositionInput['locked'] = {};
  for (const k of SOFT) if (L[k] && !(k === 'bust' && sex === 'female')) locked[k] = v[k];
  return {
    sex,
    frame,
    weight: v.weight,
    bodyFat: v.bodyFat,
    weightLocked: L.weight,
    locked,
    userLocked: (Object.keys(L) as MeasureKey[]).filter((k) => L[k as keyof typeof L] && k in v && k !== ('weight' as MeasureKey) && k !== ('bodyFat' as MeasureKey)),
    bodyFatLocked: L.bodyFat,
    bustDiff,
  };
}
