import type { Sex } from '../../core/measurements';
import { bodyDensity } from '../../core/reference';
import type { BodyAsset } from './asset';
import { type HeadParts, cutNeck, eggHead, headParts } from './egghead';
import { type V3, centroid, vert } from './geometry';
import { GuideBuilder } from './guides';
import { MEASURE_KEYS, type MeasureKey } from './measure';
import { type ArmPose, BodyModel, type FitResult, type Macro, type Targets, rotateArmPoint } from './model';

// 把「一組完整數據」變成畫面需要的一切：顯示用網格、結構線、量測線、實際量到的數值與體積。
// 在 Web Worker 裡執行，避免拖動滑桿時卡住畫面。

export interface EngineInput {
  sex: Sex;
  targets: Targets;
  /** 由身高與（輸入或建議的）體重算出，決定整體胖瘦 */
  bmi: number;
  /** 體脂率（0–1），決定肌肉與脂肪的比例，也用來把體積換算成體重 */
  bodyFat: number;
  armAngle: number;
}

export interface TapePath {
  closed: boolean;
  /** x, y, z 連續排列 */
  points: Float32Array;
  anchor: V3;
}

export interface EngineOutput {
  positions: Float32Array;
  /** 可見的身體三角形 */
  bodyIndex: Uint32Array;
  /** 蛋形人台頭與頸部延伸 */
  head: { positions: Float32Array; index: Uint32Array };
  guides: Float32Array<ArrayBufferLike>[];
  tapes: Partial<Record<MeasureKey, TapePath>>;
  values: Targets;
  residual: Targets;
  /** 體積（cm³） */
  volume: number;
  /** 依體積與體脂率換算的體重（kg） */
  modelWeight: number;
  marks: { topY: number; crotchY: number; kneeY: number; ankleY: number };
  macro: Macro;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 從完整數據取出網格要符合的量測項目 */
export function targetsFrom(values: Record<string, number>): Targets {
  return Object.fromEntries(MEASURE_KEYS.map((k) => [k, values[k]])) as Targets;
}

/** Deurenberg 公式（25 歲）估算的體脂率，用來判斷肌肉量相對於 BMI 是多是少 */
function expectedBodyFat(bmi: number, sex: Sex): number {
  return (1.2 * bmi + 0.23 * 25 - 10.8 * (sex === 'male' ? 1 : 0) - 5.4) / 100;
}

/** 依數據選擇 MakeHuman 的整體體型滑桿（胖瘦、肌肉量）與罩杯的起始值 */
export function macroFor(sex: Sex, t: Targets, bmi: number, bodyFat: number): { macro: Macro; cupPrior: number } {
  const weight = bmi < 21.5 ? 0.5 - (21.5 - bmi) / 10 : 0.5 + (bmi - 21.5) / 21;
  const muscle = 0.5 + (expectedBodyFat(bmi, sex) - bodyFat) / 0.16;
  const diff = t.bust - t.underbust;
  const cupPrior = diff < 12.5 ? 0.5 - (12.5 - diff) / 13 : 0.5 + (diff - 12.5) / 29;
  return {
    macro: { sex, muscle: clamp(muscle, 0, 1), weight: clamp(weight, 0, 1), firmness: 0.5 },
    cupPrior: clamp(cupPrior, 0, 2),
  };
}

export class BodyEngine {
  readonly model: BodyModel;
  private readonly guides: GuideBuilder;
  private readonly calibration = new Map<Sex, number>();
  readonly head: HeadParts;

  constructor(readonly asset: BodyAsset) {
    this.model = new BodyModel(asset);
    this.guides = new GuideBuilder(asset);
    this.head = headParts(asset);
  }

  /** 讓參考體型的「體積 × 密度」等於參考體重的換算係數 */
  setCalibration(sex: Sex, factor: number): void {
    this.calibration.set(sex, factor);
  }

  fitOnly(input: Omit<EngineInput, 'armAngle'>): FitResult {
    const { macro, cupPrior } = macroFor(input.sex, input.targets, input.bmi, input.bodyFat);
    return this.model.fit(input.targets, macro, cupPrior);
  }

  run(input: EngineInput): EngineOutput {
    const { macro, cupPrior } = macroFor(input.sex, input.targets, input.bmi, input.bodyFat);
    const fit = this.model.fit(input.targets, macro, cupPrior);
    const { P, armRotation } = this.model.display(fit, input.armAngle);
    const a = this.asset;
    const s = fit.scale;
    const toDisplay = (p: V3): V3 => [p[0] * s, p[1] * s + fit.offsetY, p[2] * s];
    const m = fit.measured;

    const J = (n: string) => centroid(P, ...a.joints[n]);
    const knee = J('l-knee'), ankle = J('l-ankle');
    let topY = -Infinity;
    for (let i = 0; i < a.nBody; i++) topY = Math.max(topY, P[i * 3 + 1]);
    const crotchY = m.marks.crotchY * s + fit.offsetY;

    const guides: Float32Array[] = this.guides.build(P, {
      underbustY: m.marks.underbustY * s + fit.offsetY,
      waistY: m.marks.waistY * s + fit.offsetY,
      hipY: m.marks.hipY * s + fit.offsetY,
      topY,
      height: fit.values.height,
    }).map((line) => Float32Array.from(line.flat()));
    const egg = eggHead(P, this.head);
    const neckCut = cutNeck(P, a, this.head);
    guides.push(...egg.guides);
    const headPositions = new Float32Array(egg.positions.length + neckCut.plug.positions.length);
    headPositions.set(egg.positions);
    headPositions.set(neckCut.plug.positions, egg.positions.length);
    const eggCount = egg.positions.length / 3;
    const headIndex = Uint32Array.from([...egg.index, ...Array.from(neckCut.plug.index, (i) => i + eggCount)]);

    // 量測線：從量測時的截面換到顯示座標；手臂上的跟著手臂轉
    const tapes: EngineOutput['tapes'] = {};
    const armKeys: MeasureKey[] = ['upperArm', 'wrist'];
    for (const key of MEASURE_KEYS) {
      const path = m.tapes[key];
      if (!path) continue;
      let pts = path.map(toDisplay);
      if (armKeys.includes(key)) pts = pts.map((p) => rotateArmPoint(p, armRotation.L as ArmPose));
      tapes[key] = closedTape(pts, key !== 'shoulder', ['upperArm', 'wrist', 'thigh', 'calf', 'ankle'].includes(key));
    }
    const seg = (p: V3, q: V3): TapePath => ({
      closed: false,
      points: Float32Array.from([...p, ...q]),
      anchor: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2],
    });
    const acromion = vert(P, a.landmarks.acromionL), elbow = J('l-elbow'), wrist = J('l-hand');
    tapes.upperArmLen = seg(acromion, elbow);
    tapes.forearmLen = seg(elbow, wrist);
    // 腿長畫在左腿外側
    const thighR = a.regions.indexOf('thighL'), calfR = a.regions.indexOf('calfL');
    let outer = -Infinity;
    for (let i = 0; i < a.nBody; i++) {
      const r = a.region[i];
      if (r === thighR || r === calfR) outer = Math.max(outer, P[i * 3]);
    }
    const x = outer + 2.5;
    tapes.thighLen = seg([x, crotchY, knee[2]], [x, knee[1], knee[2]]);
    tapes.calfLen = seg([x, knee[1], knee[2]], [x, ankle[1], ankle[2]]);

    const calib = this.calibration.get(input.sex) ?? 1;
    const modelWeight = (fit.volume * calib * bodyDensity(input.bodyFat)) / 1000;
    return {
      positions: P.slice(0, a.nBody * 3),
      bodyIndex: neckCut.bodyIndex,
      head: { positions: headPositions, index: headIndex },
      guides,
      tapes,
      values: fit.values,
      residual: fit.residual,
      volume: fit.volume,
      modelWeight,
      marks: { topY, crotchY, kneeY: knee[1], ankleY: ankle[1] },
      macro,
    };
  }
}

/** 封閉的量測線：稍微往外推，標籤放在正前方或外側 */
function closedTape(pts: V3[], closed: boolean, lateral: boolean): TapePath {
  const c = pts.reduce<V3>((acc, p) => [acc[0] + p[0] / pts.length, acc[1] + p[1] / pts.length, acc[2] + p[2] / pts.length], [0, 0, 0]);
  const pushed = closed
    ? pts.map((p): V3 => {
        const d: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        return [p[0] + (d[0] / l) * 0.15, p[1] + (d[1] / l) * 0.15, p[2] + (d[2] / l) * 0.15];
      })
    : pts;
  let anchor = pushed[0];
  for (const p of pushed) {
    if (lateral ? p[0] > anchor[0] : p[2] > anchor[2]) anchor = p;
  }
  if (!closed) anchor = pushed[Math.floor(pushed.length / 2)];
  return { closed, points: Float32Array.from(pushed.flat()), anchor };
}
