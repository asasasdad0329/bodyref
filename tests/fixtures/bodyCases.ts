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

/** 原版 main 5c8a6f9 的 H104 大腿圍，固定後不隨候選重算。 */
export const H104_THIGH = 61.210495016745476;

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
  ...[94, 104, 114, 124, 130].map(hip => female(`HT${hip}`, { ...pear, hip, thigh: H104_THIGH })),
  ...[85, 90, 95, 100].flatMap(bust => [56, 64].flatMap(waist => [104, 114].map(hip => female(`E${bust}-W${waist}-H${hip}`, { height: 160, bust, underbust: bust - 20, waist, hip })))),
  ...[18, 35].map(bf => female(`FC${bf}`, { height: 165, weight: 60, bust: 94, underbust: 74, waist: 68, hip: 104, thigh: 56, bodyFat: bf / 100 })),
  ...[18, 35].map(bf => ({ id: `MC${bf}`, sex: 'male' as const, locked: { height: 175, weight: 80, bust: 105, waist: 85, hip: 100, bodyFat: bf / 100 } })),
  ...[60, 75, 90].flatMap(weight => [false, true].map(fixedThigh => female(`MULTI${weight}${fixedThigh ? '-T' : ''}`, { height: 165, weight, bust: 94, underbust: 74, waist: 68, hip: 104, ...(fixedThigh ? { thigh: 56 } : {}) }))),
];
