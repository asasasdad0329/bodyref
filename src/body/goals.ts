import { suggest, type Suggestion } from '../core/linkage';
import type { Sex } from '../core/measurements';
import type { MeasureKey } from './mh/measure';
import type { CompositionInput, RingTargets, SoftGoal } from './mh/rings';

// 把面板上的狀態換成人體網格的輸入。
//
// - 骨架類（身高、四肢長度、肩寬、頸、手腕、腳踝、下胸圍）：手動的照填，沒填的用連動建議。
//   女性的上胸圍也在這裡（決定胸部大小），沒指定罩杯時用建議值。
// - 軟組織類（腰、臀、大腿、小腿、上臂；男性的上胸圍）：只有手動填的才固定，
//   沒填的用連動建議作軟偏好，在體重、體脂與手動條件允許下調整脂肪、肌肉分配。
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
  // 罩杯是胸部形狀控制，不拿它重新推動全身軟組織偏好。
  const preferenceSuggestion = bustDiff === null ? sug : suggest({ sex,
    locked: Object.fromEntries(Object.entries(v).filter(([k]) => L[k as keyof typeof L])),
  });
  if (sex === 'female' && bustDiff !== null) {
    // 單改罩杯不重新推測胸廓與四肢；已指定的上／下胸仍決定另一圈。
    for (const k of FRAME) {
      if (!L[k] && k !== 'underbust') frame[k as keyof RingTargets] = preferenceSuggestion.values[k];
    }
    if (!L.bust && !L.underbust) {
      frame.underbust = preferenceSuggestion.values.underbust;
      frame.bust = frame.underbust + bustDiff;
    }
  }
  const preferred: CompositionInput['preferred'] = {};
  for (const k of SOFT) {
    if (L[k] || (k === 'bust' && sex === 'female')) continue;
    const [lo, hi] = preferenceSuggestion.range[k];
    preferred[k] = {
      target: preferenceSuggestion.values[k],
      scale: Math.max(0.045, Math.log(hi / lo) / (2 * 1.2816)),
      // 來源的上臂與腰量法不同，先降低偏好強度，不捏造公分換算。
      confidence: k === 'upperArm' ? 0.55 : k === 'waist' ? 0.65 : 1,
    };
  }
  return {
    sex,
    frame,
    weight: preferenceSuggestion.values.weight,
    bodyFat: preferenceSuggestion.values.bodyFat,
    weightLocked: L.weight,
    locked,
    preferred,
    shapeWeight: preferenceSuggestion.values.weight,
    shapeBodyFat: preferenceSuggestion.values.bodyFat,
    userLocked: (Object.keys(L) as MeasureKey[]).filter((k) => L[k as keyof typeof L] && k in v && k !== ('weight' as MeasureKey) && k !== ('bodyFat' as MeasureKey)),
    bodyFatLocked: L.bodyFat,
    bustDiff,
  };
}
