import type { EngineOutput } from '../body/mh/engine';
import { type Rarity, type Suggestion, type VarId, rarity } from './linkage';
import { MEASURE_BY_ID, type MeasureId, type Sex, VAR_LABEL } from './measurements';
import { cupFromDiff } from './reference';
import type { AppState } from './state';

// 摘要數據與現實檢核。
// 少見程度用連動模型計算：例如身高 160、體重 52 的女性，腰圍 56 大約落在第幾百分位。
// 這是和成年人實測資料比較的統計結果，不是醫學判斷。

export type CheckLevel = 'rare' | 'conflict' | 'info';

export interface Check {
  level: CheckLevel;
  text: string;
}

export interface Summary {
  bmi: number;
  bmiLabel: string;
  weight: number;
  weightLocked: boolean;
  bodyFat: number;
  bodyFatLocked: boolean;
  leanMass: number;
  muscleRate: number;
  muscleMass: number;
  otherLeanMass: number;
  /** 例如 "B70"；男性為 null */
  braSize: string | null;
  whr: number;
  inseam: number;
  modelHeight: number;
  shape: string;
  checks: Check[];
  /** 每個鎖定數值的百分位（給欄位標示「少見」） */
  rarity: Rarity[];
  /** 顯示用的完整數值（見 resolveValues） */
  values: Record<VarId, number>;
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

const f1 = (v: number) => v.toFixed(1);

function unitOf(id: string): string {
  if (id === 'weight') return 'kg';
  if (id === 'bodyFat') return '%';
  return 'cm';
}

function shown(id: string, v: number): string {
  return id === 'bodyFat' ? f1(v * 100) : f1(v);
}

function direction(id: string, high: boolean): string {
  if (id === 'weight') return high ? '重' : '輕';
  if (id === 'bodyFat') return high ? '高' : '低';
  const kind = MEASURE_BY_ID[id as MeasureId]?.kind;
  if (kind === 'length') return high ? '長' : '短';
  return high ? '粗' : '細';
}

/** 「比這更細的只有約 3%」「比這更細的不到 0.1%」 */
function share(p: number): string {
  const v = p * 100;
  if (v < 0.1) return '不到 0.1%';
  return `只有約 ${v < 1 ? v.toFixed(1) : Math.round(v)}%`;
}

/** 顯示用的完整數值：手動的用輸入值，其他的用網格上實際量到的數值與模型的體重、體脂率 */
export function resolveValues(sug: Suggestion, out: EngineOutput): Record<VarId, number> {
  const v = { ...sug.values };
  for (const id of Object.keys(v) as VarId[]) {
    if (sug.locked[id]) continue;
    if (id === 'weight') v.weight = out.weight;
    else if (id === 'bodyFat') v.bodyFat = out.bodyFat;
    else if (id === 'muscleRate') v.muscleRate = out.muscleRate;
    else if (id in out.values) v[id] = out.values[id as keyof typeof out.values];
  }
  return v;
}

const SOFT_TISSUE: VarId[] = ['bust', 'underbust', 'waist', 'hip', 'upperArm', 'thigh', 'calf'];

export function summarize(state: AppState, sug: Suggestion, out: EngineOutput, bustDiff: number | null): Summary {
  const v = resolveValues(sug, out);
  const female = state.sex === 'female';
  const H = v.height;
  const bmi = v.weight / (H / 100) ** 2;
  const checks: Check[] = [];
  const add = (level: CheckLevel, text: string) => checks.push({ level, text });

  // 模型做不到的數值（只檢查手動填的）
  for (const { goal, error } of out.residual) {
    if (goal.kind === 'measure' && sug.locked[goal.key] && Math.abs(error) > 0.5) {
      add('conflict', `${VAR_LABEL[goal.key]}尚未對準：模型 ${f1(goal.value + error)} cm，目標 ${f1(goal.value)} cm。`);
    }
    if (goal.kind === 'weight' && sug.locked.weight && Math.abs(error) > 0.5) {
      add(
        'conflict',
        `體重尚未對準：模型 ${f1(goal.value + error)} kg，目標 ${f1(goal.value)} kg，相差 ${f1(Math.abs(error))} kg。`,
      );
    }
    if (goal.kind === 'diff' && bustDiff !== null && Math.abs(error) > 0.5) {
      add('conflict', `罩杯尚未對準：上下胸圍差為 ${f1(goal.value + error)} cm，目標 ${f1(goal.value)} cm。`);
    }
    if (goal.kind === 'bodyFat' && sug.locked.bodyFat && Math.abs(error) > 0.01) {
      add('conflict', `體脂率：模型最接近只能做到 ${f1((goal.value + error) * 100)}%（目標 ${f1(goal.value * 100)}%）。`);
    }
  }
  if (out.tissueMass.otherLean < out.weight * 0.12) add('conflict', '脂肪與骨骼肌已占用過多重量，其餘去脂組織不足；請調整體重或組成。');
  if (state.locked.muscleRate !== undefined && Math.abs(out.muscleRate - state.locked.muscleRate) > 0.01) add('conflict', `骨骼肌率：模型目前為 ${f1(out.muscleRate * 100)}%，請調整組成或圍度。`);
  if (v.underbust > v.bust) add('conflict', '下胸圍比上胸圍大，請檢查兩個數值是否填反。');
  const lockedSoft = SOFT_TISSUE.filter((id) => sug.locked[id]);
  if (sug.locked.weight && lockedSoft.length) {
    add(
      'info',
      `體重已手動指定，總重量固定：${lockedSoft.map((id) => VAR_LABEL[id]).join('、')}比預設多用（或省下）的組織重量，會從其他沒填的部位扣掉（或補到那裡）。想讓體重跟著變，請把體重改回建議。`,
    );
  }

  // 和實測資料比較的少見程度
  const rar = rarity({ sex: state.sex, locked: state.locked, bustDiff });
  for (const r of rar) {
    const p = Math.min(r.percentile, 1 - r.percentile);
    if (p >= 0.05) continue;
    const high = r.percentile > 0.5;
    add(
      'rare',
      `${VAR_LABEL[r.id]} ${shown(r.id, v[r.id])} ${unitOf(r.id)}：在同性別、同身高、其他已填數值也相同的人當中，比這更${direction(r.id, high)}的${share(p)}。`,
    );
  }
  if (bmi < 16.5) add('rare', `BMI ${f1(bmi)} 屬於嚴重過輕。`);
  if (bmi > 40) add('rare', `BMI ${f1(bmi)} 屬於重度肥胖。`);
  if (female && v.bodyFat < 0.13) add('rare', `體脂 ${f1(v.bodyFat * 100)}% 已接近女性的必需脂肪下限（約 10–13%）。`);
  if (!female && v.bodyFat < 0.06) add('rare', `體脂 ${f1(v.bodyFat * 100)}% 已接近男性的必需脂肪下限（約 2–5%）。`);

  const leanMass = v.weight * (1 - v.bodyFat);
  return {
    bmi,
    bmiLabel: bmiLabel(bmi),
    weight: v.weight,
    weightLocked: sug.locked.weight,
    bodyFat: v.bodyFat,
    bodyFatLocked: sug.locked.bodyFat,
    leanMass,
    muscleRate: out.muscleRate,
    muscleMass: out.tissueMass.muscle,
    otherLeanMass: out.tissueMass.otherLean,
    braSize: female ? braSize(v.bust, v.underbust) : null,
    whr: v.waist / v.hip,
    inseam: out.marks.crotchY,
    modelHeight: out.marks.topY,
    shape: bodyShapeType(v.bust, v.waist, v.hip, state.sex),
    checks,
    rarity: rar,
    values: v,
  };
}
