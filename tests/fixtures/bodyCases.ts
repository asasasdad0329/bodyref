import type { Sex } from '../../src/core/measurements';
import type { VarId } from '../../src/core/linkage';

/** 網格回歸與瀏覽器驗收共用的代表體型；不是任何真人的資料。 */
export interface BodyCase {
  id: string;
  sex: Sex;
  locked: Partial<Record<VarId, number>>;
  cup?: string;
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
  { ...female('CUP-S', { height: 160, underbust: 70 }), cup: 'S' },
  ...[60, 70, 80].map((weight) => female(`LOCK-W${weight}`, { height: 165, weight, bust: 92, underbust: 74, waist: 68, hip: 98 })),
  female('F-M43-AUTO-W', { height: 165, bodyFat: 0.25, muscleRate: 0.43, waist: 68, hip: 98 }),
  ...[0.3, 0.43].map((muscleRate) => female(`F-M${muscleRate * 100}`, { height: 165, weight: 62, bodyFat: 0.25, muscleRate, waist: 68, hip: 98 })),
  ...[0.18, 0.35].map((bodyFat) => female(`F-SHAPE-BF${bodyFat * 100}`, { height: 165, weight: 62, bodyFat, muscleRate: 0.36, bust: 100, underbust: 72, waist: 68, hip: 98 })),
  ...[0.3, 0.45].map((muscleRate) => ({ id: `M-CHEST-M${muscleRate * 100}`, sex: 'male' as const, locked: { height: 175, weight: 80, bodyFat: 0.2, muscleRate, bust: 108, underbust: 88, waist: 82, hip: 100 } })),
  ...[0.15, 0.32].map((bodyFat) => ({ id: `M-CHEST-BF${bodyFat * 100}`, sex: 'male' as const, locked: { height: 175, weight: 80, bodyFat, muscleRate: 0.37, bust: 108, underbust: 88, waist: 82, hip: 100 } })),
  ...[100, 115].map((hip) => ({ id: `M-H${hip}`, sex: 'male' as const, locked: { height: 175, waist: 82, hip } })),
];
