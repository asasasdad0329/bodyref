import type { MeasureId, Sex } from './measurements';

// 推算用的參考體型。數值取自成年人人體計測的常見平均值（台灣／東亞年輕成人為主），
// 推算時會依身高、體重、體脂率從這組數據縮放出完整的身體。

export type GirthId = 'neck' | 'underbust' | 'waist' | 'hip' | 'upperArm' | 'wrist' | 'thigh' | 'calf' | 'ankle';

export const GIRTH_IDS: readonly GirthId[] = [
  'neck', 'underbust', 'waist', 'hip', 'upperArm', 'wrist', 'thigh', 'calf', 'ankle',
];

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
  /**
   * 各部位截面積中「隨脂肪量變化」的比例。數值越高，體脂變化時該部位的圍度變化越大，
   * 例如腰和臀遠比手腕敏感。男女的脂肪分佈不同。
   */
  fatShare: Record<GirthId, number>;
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
    fatShare: {
      neck: 0.18,
      underbust: 0.22,
      waist: 0.45,
      hip: 0.52,
      upperArm: 0.45,
      wrist: 0.1,
      thigh: 0.52,
      calf: 0.38,
      ankle: 0.12,
    },
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
    fatShare: {
      neck: 0.2,
      underbust: 0.25,
      waist: 0.58,
      hip: 0.45,
      upperArm: 0.28,
      wrist: 0.1,
      thigh: 0.35,
      calf: 0.25,
      ankle: 0.1,
    },
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

/** Deurenberg 公式：由 BMI 估算體脂率（假設 25 歲） */
export function bodyFatFromBmi(bmi: number, sex: Sex): number {
  const pct = 1.2 * bmi + 0.23 * 25 - 10.8 * (sex === 'male' ? 1 : 0) - 5.4;
  return Math.min(0.5, Math.max(0.06, pct / 100));
}

/** Siri 公式：體脂率 → 人體平均密度（g/cm³） */
export function bodyDensity(bodyFat: number): number {
  return 495 / (bodyFat * 100 + 450);
}

export type LengthId = Extract<MeasureId, 'upperArmLen' | 'forearmLen' | 'thighLen' | 'calfLen'>;
