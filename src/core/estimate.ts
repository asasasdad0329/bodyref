import { COARSE, generateBody } from '../body/generate';
import { type BodyMeasurements, MEASURES, type MeasureId, type MeasureValues, type Sex } from './measurements';
import { GIRTH_IDS, REFERENCE, bodyDensity, bodyFatFromBmi, cupDiff } from './reference';

// 推算：由身高、體重、體脂率（與罩杯）推出全身量測，再讓手動指定的項目覆蓋推算值。
//
// 做法是把每個部位的截面積拆成「去脂」與「脂肪」兩部分，依去脂體重和脂肪重量相對於參考體型的倍數縮放；
// 最後再用 3D 模型的實際體積 × 人體密度去校正，讓模型體重等於輸入體重。
// 因此「體重」不是用公式套出來的，而是由模型體積驗算出來的。

export interface BasicInputs {
  sex: Sex;
  height: number;
  weight: number;
  /** 0–1；null 表示依 BMI 自動估算 */
  bodyFat: number | null;
  /** 罩杯字母；null 表示自動 */
  cup: string | null;
}

export interface EstimateInput extends BasicInputs {
  overrides: Partial<MeasureValues>;
}

export type Source = 'auto' | 'manual';

export interface Estimate {
  measurements: BodyMeasurements;
  source: Record<MeasureId, Source>;
  bodyFat: number;
  bodyFatAuto: boolean;
  /** 依模型體積與體脂率換算的體重 */
  modelWeight: number;
  /** 體重校正倍數，1 表示和參考體型的比例相同 */
  sigma: number;
}

const calibration = new Map<Sex, number>();
const VOLUME_ARM_ANGLE = 10;

function modelVolume(m: BodyMeasurements): number {
  return generateBody(m, { quality: COARSE, armAngle: VOLUME_ARM_ANGLE }).volume;
}

/**
 * 模型體積與真實人體體積的換算係數：讓參考體型的模型重量等於參考體重。
 * 係數接近 1 代表模型的形狀和真實人體相當接近。
 */
export function calibrationFactor(sex: Sex): number {
  let c = calibration.get(sex);
  if (c === undefined) {
    const ref = REFERENCE[sex];
    const m = referenceMeasurements(sex);
    const realVolume = (ref.weight * 1000) / bodyDensity(ref.bodyFat);
    c = realVolume / modelVolume(m);
    calibration.set(sex, c);
  }
  return c;
}

export function referenceMeasurements(sex: Sex): BodyMeasurements {
  const ref = REFERENCE[sex];
  const v = { sex, height: ref.height } as BodyMeasurements;
  for (const g of GIRTH_IDS) v[g] = ref.girths[g];
  v.bust = ref.girths.underbust + ref.bustDiff;
  v.shoulder = ref.shoulder;
  for (const [k, r] of Object.entries(ref.lengthRatio)) v[k as keyof typeof ref.lengthRatio] = r * ref.height;
  return v;
}

/** 依模型體積換算體重（kg） */
export function weightFromModel(m: BodyMeasurements, bodyFat: number): number {
  return (modelVolume(m) * calibrationFactor(m.sex) * bodyDensity(bodyFat)) / 1000;
}

export function resolveBodyFat(b: BasicInputs): number {
  if (b.bodyFat !== null) return b.bodyFat;
  return bodyFatFromBmi(b.weight / (b.height / 100) ** 2, b.sex);
}

export function estimate(inp: EstimateInput): Estimate {
  const ref = REFERENCE[inp.sex];
  const H = inp.height;
  const W = inp.weight;
  const bf = resolveBodyFat(inp);
  const hr = H / ref.height;
  const lean = (W * (1 - bf)) / (ref.weight * (1 - ref.bodyFat) * hr * hr);
  const fat = (W * bf) / (ref.weight * ref.bodyFat * hr * hr);
  const ov = inp.overrides;

  const build = (sigma: number): BodyMeasurements => {
    const v = { sex: inp.sex, height: H } as BodyMeasurements;
    for (const g of GIRTH_IDS) {
      const phi = ref.fatShare[g];
      v[g] = ov[g] ?? ref.girths[g] * Math.sqrt(hr * sigma * ((1 - phi) * lean + phi * fat));
    }
    const chosen = inp.cup && inp.sex === 'female' ? cupDiff(inp.cup) : undefined;
    const diff =
      chosen ??
      (inp.sex === 'female'
        ? Math.min(30, Math.max(6, ref.bustDiff * fat ** 0.45))
        : Math.min(16, Math.max(2, ref.bustDiff * lean ** 1.2 + 3 * (fat - 1))));
    v.bust = ov.bust ?? v.underbust + diff;
    v.shoulder =
      ov.shoulder ?? ref.shoulder * hr * (1 + 0.12 * (Math.sqrt(lean * sigma) - 1) + 0.05 * (Math.sqrt(fat * sigma) - 1));
    for (const [k, r] of Object.entries(ref.lengthRatio)) {
      const id = k as keyof typeof ref.lengthRatio;
      v[id] = ov[id] ?? r * H;
    }
    return v;
  };

  // 以割線法求 sigma，使模型體重等於輸入體重。體重大致和 sigma 成正比，第一步直接按比例猜。
  // 全部圍度都手動指定時，sigma 不影響體重，就停在 1。
  const weightAt = (sigma: number) => weightFromModel(build(sigma), bf);
  let s0 = 1, w0 = weightAt(s0);
  let s1 = Math.min(4, Math.max(0.2, W / w0)), w1 = weightAt(s1);
  for (let i = 0; i < 6 && Math.abs(w1 - W) > 0.03 && Math.abs(w1 - w0) > 1e-4; i++) {
    const s2 = Math.min(4, Math.max(0.2, s1 + ((W - w1) * (s1 - s0)) / (w1 - w0)));
    s0 = s1; w0 = w1;
    s1 = s2; w1 = weightAt(s1);
  }
  const responsive = Math.abs(w1 - w0) > 1e-4;
  const sigma = responsive ? s1 : 1;
  const source = {} as Record<MeasureId, Source>;
  for (const d of MEASURES) source[d.id] = ov[d.id] !== undefined ? 'manual' : 'auto';

  return {
    measurements: build(sigma),
    source,
    bodyFat: bf,
    bodyFatAuto: inp.bodyFat === null,
    modelWeight: responsive ? w1 : w0,
    sigma,
  };
}
