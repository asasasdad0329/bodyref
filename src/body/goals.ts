import { nhanesPreference } from '../core/nhanes';
import { DEFAULT_MORPHOLOGY, type Morphology } from '../core/morphology';
import { navelWaistPreference, suggest, type Suggestion } from '../core/linkage';
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
  muscleMass?: number | null;
  morphology?: Morphology;
}

export interface BodyInput extends CompositionInput {
  /** 手動填的量測（用來列出做不到的項目） */
  userLocked: MeasureKey[];
  bodyFatLocked: boolean;
  bustDiff: number | null;
}

export function bodyInputFor({ sex, sug, bustDiff, muscleMass, morphology }: GoalInput): BodyInput {
  const v = sug.values;
  const L = sug.locked;
  const frame = Object.fromEntries(FRAME.map((k) => [k, v[k]])) as RingTargets;
  if (sex === 'female') Object.assign(frame, { bust: v.bust, underbust: v.underbust });
  const locked: CompositionInput['locked'] = {};
  for (const k of SOFT) if (L[k] && !(k === 'bust' && sex === 'female')) locked[k] = v[k];
  // 女性杯量及明確上胸都是局部控制，不反推全身脂肪、骨架或肌肉。
  const detachedBreast = sex === 'female' && (bustDiff !== null || L.bust);
  const preferenceSuggestion = !detachedBreast ? sug : suggest({ sex,
    locked: Object.fromEntries(Object.entries(v).filter(([k]) => L[k as keyof typeof L] && k !== 'bust')),
  });
  if (detachedBreast) {
    for (const key of FRAME) if (!L[key]) frame[key] = preferenceSuggestion.values[key];
    frame.underbust = L.underbust || (bustDiff !== null && L.bust) ? v.underbust : preferenceSuggestion.values.underbust;
    frame.bust = bustDiff === null ? v.bust : frame.underbust! + bustDiff;
  }
  const preferred: CompositionInput['preferred'] = {};
  for (const k of SOFT) {
    if (L[k] || (k === 'bust' && sex === 'female')) continue;
    const [lo, hi] = preferenceSuggestion.range[k];
    preferred[k] = {
      target: preferenceSuggestion.values[k],
      scale: Math.max(0.045, Math.log(hi / lo) / (2 * 1.2816)),
      // 最細腰仍是來源不完全相同的造型先驗；上臂稍後由 NHANES 覆寫。
      confidence: k === 'upperArm' ? 0.55 : k === 'waist' ? 0.65 : 1,
    };
  }
  if (!L.upperArm) {
    const pv = preferenceSuggestion.values;
    const obs = nhanesPreference(sex, pv.height, pv.weight, pv.bodyFat);
    // 實測中點的偏好優先於其餘人工／跨族群先驗；3 是分配成本權重，
    // 不更動來源留出誤差或介面顯示的預測範圍。
    preferred.upperArm = { target: obs.arm, scale: Math.max(0.045, obs.scale), confidence: 3 };
  }
  if (!L.waist) {
    const pv = preferenceSuggestion.values;
    const source = navelWaistPreference(sex, pv.height, pv.weight);
    preferred.waist = { ...source, scale: Math.max(0.045, source.scale), confidence: 0.65,
      source: 'navel', minimumTarget: pv.waist };
  }
  return {
    estimateReference: !Object.keys(L).some(k => k !== 'height' && L[k as keyof typeof L]) && bustDiff === null && muscleMass == null,
    muscleMass: muscleMass ?? undefined,
    condition: { morphology: morphology ?? { ...DEFAULT_MORPHOLOGY }, bodyFat: v.bodyFat, muscle: 0 },
    sex,
    frame,
    frameLocked: FRAME.filter(k => L[k]),
    breastLocked: sex === 'female' && (bustDiff !== null || L.bust || L.underbust),
    weight: L.weight ? v.weight : preferenceSuggestion.values.weight,
    bodyFat: L.bodyFat ? v.bodyFat : preferenceSuggestion.values.bodyFat,
    weightLocked: L.weight,
    locked,
    preferred,
    userLocked: (Object.keys(L) as MeasureKey[]).filter((k) => L[k as keyof typeof L] && k in v && k !== ('weight' as MeasureKey) && k !== ('bodyFat' as MeasureKey)),
    bodyFatLocked: L.bodyFat,
    bustDiff,
  };
}
