import type { Sex } from '../../core/measurements';

/** 美術用的表面形態座標；不是內部解剖模擬或人體統計迴歸係數。 */
export interface TissueShape {
  coverage: number;
  tone: number;
  load: number;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export function tissueShape(sex: Sex, bodyFat: number, muscleRate: number, bmi: number): TissueShape {
  return {
    coverage: clamp((bodyFat - 0.12) / 0.3, 0, 1),
    tone: clamp((muscleRate - (sex === 'female' ? 0.28 : 0.32)) / 0.22, 0, 1),
    load: clamp((bmi - 20) / 22, 0, 1),
  };
}

/** 胸型模組的基礎介面：尺寸校正只改量，不覆寫這些形態參數。 */
export interface BreastFoundation {
  footprint: number;
  fullness: number;
  separation: number;
  drop: number;
}
export function breastFoundation(shape: TissueShape, cupDiff: number): BreastFoundation {
  const large = clamp((cupDiff - 15) / 40, 0, 1);
  return {
    footprint: 1 + 0.24 * large + 0.08 * shape.coverage,
    fullness: 0.08 + 0.16 * shape.coverage + 0.12 * large,
    separation: 0.08,
    drop: 0.1 + 0.18 * shape.coverage + 0.14 * large,
  };
}
