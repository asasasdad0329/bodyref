import type { Sex } from './measurements';

// 參考體型：台灣／東亞年輕成人的常見平均值。連動模型以這組數值為平均，
// 再依 ANSUR II 的共變異數推算其他項目（見 linkage.ts）。

export type GirthId = 'neck' | 'underbust' | 'waist' | 'hip' | 'upperArm' | 'wrist' | 'thigh' | 'calf' | 'ankle';

export interface ReferenceBody {
  height: number;
  weight: number;
  /** 體脂率，0–1 */
  bodyFat: number;
  girths: Record<GirthId, number>;
  /** 上胸圍與下胸圍的差 */
  bustDiff: number;
  shoulder: number;
  /** 長度與身高的比例 */
  lengthRatio: Record<'upperArmLen' | 'forearmLen' | 'thighLen' | 'calfLen', number>;
}

export const REFERENCE: Record<Sex, ReferenceBody> = {
  female: {
    height: 160,
    weight: 52,
    bodyFat: 0.26,
    girths: {
      neck: 31.5,
      underbust: 70,
      waist: 64,
      hip: 89,
      upperArm: 25,
      wrist: 14.5,
      thigh: 51,
      calf: 33.5,
      ankle: 20.5,
    },
    bustDiff: 12.5,
    shoulder: 38,
    lengthRatio: { upperArmLen: 0.186, forearmLen: 0.145, thighLen: 0.175, calfLen: 0.241 },
  },
  male: {
    height: 172,
    weight: 68,
    bodyFat: 0.18,
    girths: {
      neck: 37.5,
      underbust: 84,
      waist: 79,
      hip: 93,
      upperArm: 29,
      wrist: 16.5,
      thigh: 54,
      calf: 36,
      ankle: 22.5,
    },
    bustDiff: 7,
    shoulder: 45,
    lengthRatio: { upperArmLen: 0.188, forearmLen: 0.148, thighLen: 0.177, calfLen: 0.244 },
  },
};

/** 骨骼肌重約占去脂體重的比例（InBody 等體組成儀的常見關係） */
export const MUSCLE_OF_LEAN = 0.55;

/** 台灣／日本內衣尺寸：上下胸圍差（cm）對應罩杯 */
export const CUP_TABLE: readonly { cup: string; diff: number }[] = [
  { cup: 'AA', diff: 7.5 },
  { cup: 'A', diff: 10 },
  { cup: 'B', diff: 12.5 },
  { cup: 'C', diff: 15 },
  { cup: 'D', diff: 17.5 },
  { cup: 'E', diff: 20 },
  { cup: 'F', diff: 22.5 },
  { cup: 'G', diff: 25 },
  { cup: 'H', diff: 27.5 },
  { cup: 'I', diff: 30 },
  { cup: 'J', diff: 32.5 },
  { cup: 'K', diff: 35 },
];

export function cupDiff(cup: string): number | undefined {
  return CUP_TABLE.find((c) => c.cup === cup)?.diff;
}

export function cupFromDiff(diff: number): string {
  if (diff < 6.25) return '—';
  let best = CUP_TABLE[0];
  for (const c of CUP_TABLE) if (Math.abs(c.diff - diff) < Math.abs(best.diff - diff)) best = c;
  return best.cup;
}

/** Siri 公式：體脂率 → 人體平均密度（g/cm³） */
export function bodyDensity(bodyFat: number): number {
  return 495 / (bodyFat * 100 + 450);
}
