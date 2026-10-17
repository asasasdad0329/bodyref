import type { BodyShape } from '../body/generate';
import type { Estimate } from './estimate';
import type { Sex } from './measurements';
import { MUSCLE_OF_LEAN, cupFromDiff } from './reference';

// 由推算結果算出摘要數據，並檢查數據組合在現實中是否常見。
// 參考範圍是成年人的大致分佈，用來提醒「這組數字很少見」，不是醫學判斷。

export type CheckLevel = 'rare' | 'conflict';

export interface Check {
  level: CheckLevel;
  text: string;
}

export interface Summary {
  bmi: number;
  bmiLabel: string;
  modelWeight: number;
  bodyFat: number;
  bodyFatAuto: boolean;
  leanMass: number;
  muscleRate: number;
  /** 例如 "B70"；男性為 null */
  braSize: string | null;
  whr: number;
  inseam: number;
  modelHeight: number;
  shape: string;
  checks: Check[];
}

/** 台灣成人 BMI 分級 */
function bmiLabel(bmi: number): string {
  if (bmi < 18.5) return '過輕';
  if (bmi < 24) return '正常';
  if (bmi < 27) return '過重';
  return '肥胖';
}

export function braSize(bust: number, underbust: number): string {
  const cup = cupFromDiff(bust - underbust);
  if (cup === '—') return 'AA 以下';
  return `${cup}${Math.round(underbust / 5) * 5}`;
}

/** 依三圍判斷常見的體型分類 */
export function bodyShapeType(bust: number, waist: number, hip: number, sex: Sex): string {
  if (waist / hip >= (sex === 'female' ? 0.85 : 0.98) && waist >= bust * 0.92) return '蘋果形';
  if (hip - bust >= 9) return '梨形';
  if (bust - hip >= 9) return '倒三角形';
  if (bust - waist >= 23 || hip - waist >= 25) return '沙漏形';
  return 'H 形（直筒）';
}

const fmt = (v: number, d = 1) => v.toFixed(d);

export function summarize(est: Estimate, inputWeight: number, body: BodyShape): Summary {
  const m = est.measurements;
  const female = m.sex === 'female';
  const H = m.height;
  const bmi = inputWeight / (H / 100) ** 2;
  const leanMass = inputWeight * (1 - est.bodyFat);
  const checks: Check[] = [];
  const add = (level: CheckLevel, text: string) => checks.push({ level, text });

  // 數據彼此矛盾
  const gap = est.modelWeight - inputWeight;
  if (Math.abs(gap) / inputWeight > 0.04) {
    add(
      'conflict',
      `依目前的圍度，模型體重約 ${fmt(est.modelWeight)} kg，和輸入的 ${fmt(inputWeight)} kg 差了 ${fmt(Math.abs(gap))} kg。手動指定的圍度太多時，系統沒辦法同時符合體重。`,
    );
  }
  if (body.torsoClamped) {
    add('conflict', `大腿長加小腿長超出這個身高能容納的範圍，模型身高變成 ${fmt(body.modelHeight)} cm。`);
  }
  if (m.underbust > m.bust) add('conflict', '下胸圍比上胸圍大，請檢查兩個數值是否填反。');
  if (m.calf > m.thigh) add('conflict', '小腿圍比大腿圍大，請檢查數值。');
  if (m.ankle > m.calf) add('conflict', '腳踝圍比小腿圍大，請檢查數值。');
  if (m.wrist > m.upperArm) add('conflict', '手腕圍比臂圍大，請檢查數值。');

  // 現實中少見的組合
  if (bmi < 16.5) add('rare', `BMI ${fmt(bmi)} 屬於嚴重過輕，現實中少見。`);
  if (bmi > 40) add('rare', `BMI ${fmt(bmi)} 屬於重度肥胖。`);
  const whr = m.waist / m.hip;
  if (female && whr < 0.65) add('rare', `腰臀比 ${fmt(whr, 2)}，成年女性很少低於 0.65（常見約 0.68–0.85）。`);
  if (!female && whr < 0.78) add('rare', `腰臀比 ${fmt(whr, 2)}，成年男性很少低於 0.78（常見約 0.80–0.95）。`);
  const wht = m.waist / H;
  if (wht < 0.35) add('rare', `腰圍只有身高的 ${fmt(wht * 100, 0)}%，現實中很少低於 35%。`);
  const diff = m.bust - m.underbust;
  if (female && diff >= 20 && est.bodyFat < 0.2) {
    add('rare', `${cupFromDiff(diff)} 罩杯以上的胸部大多是脂肪，體脂 ${fmt(est.bodyFat * 100, 0)}% 時很少見。`);
  }
  if (female && diff >= 30) add('rare', '上下胸圍差 30 cm 以上（I 罩杯以上）屬於極少數。');
  if (!female && diff > 14) add('rare', `男性上下胸圍差 ${fmt(diff)} cm，通常只出現在胸肌非常發達或體脂很高時。`);
  const inseamRatio = body.landmarks.crotchY / H;
  if (inseamRatio > (female ? 0.49 : 0.5)) add('rare', `股下占身高 ${fmt(inseamRatio * 100, 0)}%，一般約 44–48%，屬於少見的長腿比例。`);
  if (inseamRatio < 0.41) add('rare', `股下只占身高 ${fmt(inseamRatio * 100, 0)}%，一般約 44–48%。`);
  if (m.thigh / m.hip > 0.68) add('rare', `大腿圍是臀圍的 ${fmt((m.thigh / m.hip) * 100, 0)}%，一般在 52–64% 之間。`);
  if (female && est.bodyFat < 0.13) add('rare', `體脂 ${fmt(est.bodyFat * 100, 0)}% 已接近女性的必需脂肪下限（約 10–13%）。`);
  if (!female && est.bodyFat < 0.06) add('rare', `體脂 ${fmt(est.bodyFat * 100, 0)}% 已接近男性的必需脂肪下限（約 2–5%）。`);

  return {
    bmi,
    bmiLabel: bmiLabel(bmi),
    modelWeight: est.modelWeight,
    bodyFat: est.bodyFat,
    bodyFatAuto: est.bodyFatAuto,
    leanMass,
    muscleRate: MUSCLE_OF_LEAN * (1 - est.bodyFat),
    braSize: female ? braSize(m.bust, m.underbust) : null,
    whr,
    inseam: body.landmarks.crotchY,
    modelHeight: body.modelHeight,
    shape: bodyShapeType(m.bust, m.waist, m.hip, m.sex),
    checks,
  };
}
