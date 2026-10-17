// 量測項目的定義。介面上的滑桿、量測線、分享連結都依這份清單產生，
// 新增量測項目時從這裡開始：加一筆定義，再到 body/generate.ts 指定它影響模型的哪個部位。

export type Sex = 'female' | 'male';

export type MeasureId =
  | 'neck'
  | 'bust'
  | 'underbust'
  | 'waist'
  | 'hip'
  | 'upperArm'
  | 'wrist'
  | 'thigh'
  | 'calf'
  | 'ankle'
  | 'shoulder'
  | 'upperArmLen'
  | 'forearmLen'
  | 'thighLen'
  | 'calfLen';

export type MeasureKind = 'girth' | 'length';
export type MeasureGroup = 'girth' | 'length';

export interface MeasureDef {
  id: MeasureId;
  label: string;
  /** 怎麼量：顯示在欄位下方的說明 */
  hint: string;
  kind: MeasureKind;
  group: MeasureGroup;
  min: number;
  max: number;
  step: number;
}

export const MEASURES: readonly MeasureDef[] = [
  { id: 'neck', label: '頸圍', hint: '喉結下方繞頸一圈', kind: 'girth', group: 'girth', min: 26, max: 50, step: 0.5 },
  { id: 'bust', label: '上胸圍', hint: '經過胸部最高點水平一圈', kind: 'girth', group: 'girth', min: 65, max: 140, step: 0.5 },
  { id: 'underbust', label: '下胸圍', hint: '胸部下緣貼著肋骨水平一圈', kind: 'girth', group: 'girth', min: 58, max: 125, step: 0.5 },
  { id: 'waist', label: '腰圍', hint: '肋骨與骨盆之間最細處', kind: 'girth', group: 'girth', min: 48, max: 140, step: 0.5 },
  { id: 'hip', label: '臀圍', hint: '臀部最寬處水平一圈', kind: 'girth', group: 'girth', min: 70, max: 150, step: 0.5 },
  { id: 'upperArm', label: '臂圍', hint: '上臂最粗處，手臂放鬆', kind: 'girth', group: 'girth', min: 18, max: 50, step: 0.5 },
  { id: 'wrist', label: '手腕圍', hint: '腕骨上方最細處', kind: 'girth', group: 'girth', min: 12, max: 22, step: 0.5 },
  { id: 'thigh', label: '大腿圍', hint: '臀下大腿最粗處', kind: 'girth', group: 'girth', min: 36, max: 85, step: 0.5 },
  { id: 'calf', label: '小腿圍', hint: '小腿肚最粗處', kind: 'girth', group: 'girth', min: 24, max: 52, step: 0.5 },
  { id: 'ankle', label: '腳踝圍', hint: '踝骨上方最細處', kind: 'girth', group: 'girth', min: 16, max: 32, step: 0.5 },
  { id: 'shoulder', label: '肩寬', hint: '左右肩點之間，沿背部量（服裝量法）', kind: 'length', group: 'length', min: 30, max: 56, step: 0.5 },
  { id: 'upperArmLen', label: '上臂長', hint: '肩點到手肘', kind: 'length', group: 'length', min: 22, max: 42, step: 0.5 },
  { id: 'forearmLen', label: '前臂長', hint: '手肘到手腕', kind: 'length', group: 'length', min: 17, max: 34, step: 0.5 },
  { id: 'thighLen', label: '大腿長', hint: '胯下到膝蓋中心', kind: 'length', group: 'length', min: 20, max: 45, step: 0.5 },
  { id: 'calfLen', label: '小腿長', hint: '膝蓋中心到腳踝骨', kind: 'length', group: 'length', min: 28, max: 52, step: 0.5 },
];

export const MEASURE_BY_ID: Record<MeasureId, MeasureDef> = Object.fromEntries(
  MEASURES.map((m) => [m.id, m]),
) as Record<MeasureId, MeasureDef>;

export type MeasureValues = Record<MeasureId, number>;

/** 生成 3D 模型所需的完整數據 */
export interface BodyMeasurements extends MeasureValues {
  sex: Sex;
  height: number;
}

export const HEIGHT_RANGE = { min: 135, max: 210, step: 0.5 };
export const WEIGHT_RANGE = { min: 30, max: 160, step: 0.5 };
export const BODY_FAT_RANGE = { min: 5, max: 55, step: 0.5 };
