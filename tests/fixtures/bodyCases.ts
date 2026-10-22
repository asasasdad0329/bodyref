import type { Morphology } from '../../src/core/morphology';
import type { Sex } from '../../src/core/measurements';
import type { VarId } from '../../src/core/linkage';

/** 網格回歸與瀏覽器驗收共用的代表體型；不是任何真人的資料。 */
export interface BodyCase {
  id: string;
  sex: Sex;
  locked: Partial<Record<VarId, number>>;
  cup?: string;
  morphology?: Morphology;
  muscleMass?: number;
}

const female = (id: string, locked: BodyCase['locked']): BodyCase => ({ id, sex: 'female', locked });
const pear = { height: 165, bust: 97, underbust: 76, waist: 68 };

export const BODY_CASES: BodyCase[] = [
  female('T1', { height: 160, weight: 52 }),
  female('T2', { height: 160, weight: 50, bust: 94, underbust: 66, waist: 56, hip: 94 }),
  female('T3', { ...pear, hip: 114 }),
  female('T4', { height: 158, weight: 80 }),
  female('T5-105', { height: 160, bust: 105, underbust: 70 }),
  female('T5-125', { height: 160, bust: 125, underbust: 70 }),
  { id: 'T6', sex: 'male', locked: { height: 170, weight: 97 } },
  female('T7-waist50', { height: 160, waist: 50 }),
  female('T7-hip130', { height: 160, hip: 130 }),
  female('T7-height190', { height: 190 }),
  female('T7-weight120', { height: 160, weight: 120 }),
  ...[94, 104, 114, 124, 130].map((hip) => female(`H${hip}`, { ...pear, hip })),
  female('UA-T1-22', { height: 160, weight: 52, upperArm: 22 }),
  female('UA-T3-26', { ...pear, hip: 114, upperArm: 26 }),
  female('UA-T4-30', { height: 158, weight: 80, upperArm: 30 }),
  ...[15, 25, 35].map((bf) => female(`BF${bf}`, { height: 160, weight: 52, bodyFat: bf / 100 })),
  ...[45, 60, 75, 90].map((weight) => female(`W${weight}`, { height: 160, weight })),
  { ...female('CUP-A', { height: 160, bodyFat: 0.27 }), cup: 'A' },
  { ...female('CUP-G', { height: 160, bodyFat: 0.27 }), cup: 'G' },
  // 審查報告的可重現輸入；未提供的欄位維持推算，不冒稱還原所有原圖設定。
  { ...female('AUDIT-G168', { height: 168 }), cup: 'G' },
  { ...female('AUDIT-G170-H114', { height: 170, hip: 114 }), cup: 'G' },
  { ...female('AUDIT-G170-H114-T68', { height: 170, hip: 114, thigh: 68 }), cup: 'G' },
  { ...female('AUDIT-G170-H114-T72', { height: 170, hip: 114, thigh: 72 }), cup: 'G' },
  { ...female('AUDIT-G170-H114-W68', { height: 170, hip: 114, waist: 68 }), cup: 'G' },
  ...[168, 170].map(height => ({ ...female(`AUDIT-E${height}-H114-W64`, { height, bust: 97, waist: 64, hip: 114 }), cup: 'E' })),
  // 男性圖片缺少完整輸入；以下明示身高 175 作受控壓力案例，並非原圖的精確重現。
  { id: 'AUDIT-M130', sex: 'male', locked: { height: 175, weight: 130 } },
  { id: 'AUDIT-M-CHEST20', sex: 'male', locked: { height: 175, bust: 110, underbust: 90 } },
  { id: 'AUDIT-M-H114-W68', sex: 'male', locked: { height: 175, hip: 114, waist: 68 } },
];

/** f4e2aff 同應用程式的 5c8a6f9，H104 中性解只取一次，禁止由候選重算。 */
export const BASELINE_H104_THIGH = 61.210495016745476;
export const PLAN_CASES: BodyCase[] = [
  ...[94, 104, 114, 124, 130].map(hip => female(`HF${hip}`, { ...pear, hip, thigh: BASELINE_H104_THIGH })),
  ...[85, 90, 95, 100].flatMap(bust => [56, 64].flatMap(waist => [104, 114].map(hip =>
    female(`E${bust}-W${waist}-H${hip}`, { height: 160, bust, underbust: bust - 20, waist, hip })))),
  ...[18, 35].map(bf => female(`COMP-F${bf}`, { height: 165, weight: 60, bust: 94, underbust: 74, waist: 68, hip: 104, thigh: 56, bodyFat: bf / 100 })),
  ...[18, 35].map(bf => ({ id: `COMP-M${bf}`, sex: 'male' as const, locked: { height: 175, weight: 80, bust: 105, waist: 85, hip: 100, bodyFat: bf / 100 } })),
  ...[60, 67.5, 75, 82.5, 90].flatMap(weight => [false, true].map(thigh => female(`FIXED-${weight}${thigh ? '-T56' : ''}`,
    { height: 165, weight, bust: 94, underbust: 74, waist: 68, hip: 104, ...(thigh ? { thigh: 56 } : {}) }))),
  ...(['teardrop', 'long', 'round'] as const).flatMap(breast => ['A', 'B', 'D', 'F', 'G', 'S'].map(cup => ({
    ...female(`SHAPE-${breast}-${cup}`, { height: 160, underbust: 70 }), cup, morphology: { breast, hip: 'balanced' as const, abdomen: 'soft' as const } }))),
  ...(['teardrop', 'long', 'round'] as const).map(breast => ({
    ...female(`SMALL-E-${breast}`, { height: 160, bust: 85, underbust: 65, waist: 64, hip: 104 }),
    morphology: { breast, hip: 'balanced' as const, abdomen: 'soft' as const } })),
  ...(['female', 'male'] as const).flatMap(sex => [false, true].flatMap(fixed => (sex === 'female' ? [20, 26] : [30, 36]).map(muscleMass => ({
    id: `MUSCLE-${sex}-${fixed ? 'fixed' : 'free'}-${muscleMass}`, sex, muscleMass,
    locked: sex === 'female' ? { height: 165, bodyFat: 0.18, ...(fixed ? { weight: 60, bust: 94, underbust: 74, waist: 68, hip: 104, thigh: 56 } : {}) }
      : { height: 175, bodyFat: 0.18, ...(fixed ? { weight: 80, bust: 105, waist: 85, hip: 100 } : {}) },
  })))),
  ...(['female', 'male'] as const).flatMap(sex => [false, true].flatMap(thigh => (['balanced', 'projected'] as const).flatMap(hip => (['soft', 'smooth'] as const).map(abdomen => ({
    id: `MORPH-${sex}-${hip}-${abdomen}${thigh ? '-thigh' : ''}`, sex,
    morphology: { breast: 'teardrop' as const, hip, abdomen },
    locked: sex === 'female' ? { height: 165, weight: 60, bodyFat: 0.25, bust: 94, underbust: 74, waist: 68, hip: 104, ...(thigh ? { thigh: 56 } : {}) }
      : { height: 175, weight: 80, bodyFat: 0.25, bust: 105, waist: 85, hip: 100, ...(thigh ? { thigh: 60 } : {}) },
  }))))),
];
BODY_CASES.push(...PLAN_CASES);
