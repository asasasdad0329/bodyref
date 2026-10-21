import type { Sex } from '../../core/measurements';
import { REFERENCE } from '../../core/reference';
import { addTarget, type BodyAsset } from './asset';

/** 造型座標，非醫學分段組成估計；0 為本專案參考體型。 */
export interface ShapeCondition {
  adiposity: number;
  leanBuild: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** 把組成映射到 CC0 造型範圍；尺度是可校準的造型設定，不是研究提供的生長係數。 */
export function shapeCondition(sex: Sex, height: number, weight: number, bodyFat: number): ShapeCondition {
  const ref = REFERENCE[sex];
  const leanIndex = weight * (1 - bodyFat) / (height * height);
  const referenceIndex = ref.weight * (1 - ref.bodyFat) / (ref.height * ref.height);
  return {
    adiposity: clamp((bodyFat - ref.bodyFat) / 0.24, -0.8, 0.8),
    // 去脂量含骨骼與內臟；此座標只選擇造型，不把去脂公斤改稱肌肉公斤。
    leanBuild: clamp(Math.log(leanIndex / referenceIndex), -0.6, 0.6),
  };
}

/** 連續的三節點造型混合；中性位置的斜率連續，避免跨平均值時跳形。 */
export function shapeWeights(v: number): [number, number, number] {
  const x = clamp(v, -1, 1);
  const u = x * x * (3 - 2 * Math.abs(x));
  return [x < 0 ? u : 0, 1 - u, x > 0 ? u : 0];
}

/**
 * 使用現有 CC0 位移作形態描述，尺寸由另一層量測校正。
 * 權重非負、合計為 1，平均附近一階連續；輸入有界。
 */
export function applyCompositionShape(a: BodyAsset, sex: Sex, c: ShapeCondition, out: Float32Array): void {
  const frameHelpers = out.slice(a.nBody * 3);
  const levels = ['min', 'average', 'max'];
  const muscle = shapeWeights(c.leanBuild), fat = shapeWeights(c.adiposity);
  for (let m = 0; m < 3; m++) for (let f = 0; f < 3; f++) {
    if (m === 1 && f === 1) continue;
    addTarget(a, `universal-${sex}-young-${levels[m]}muscle-${levels[f]}weight`, muscle[m] * fat[f], out);
  }
  // 組成改表面，骨性參照由尺寸骨架負責；不讓資產中的輔助點跟著胖瘦漂移。
  out.set(frameHelpers, a.nBody * 3);
}
