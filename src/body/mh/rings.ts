import type { Sex } from '../../core/measurements';
import { REFERENCE, MUSCLE_OF_LEAN } from '../../core/reference';
import { nhanesPreference } from '../../core/nhanes';
import { SurfaceRig, defaultCondition, type ShapeCondition } from './controls';
import { BreastRig } from './breast';
import { SurfaceQuality, type ShapeQuality } from './quality';
import { BodyModel } from './model';
import { type BodyAsset, addTarget } from './asset';
import { type V3, adjacency, centroid, meshVolume, smoothField, vertexNormals } from './geometry';
import { type MeasureContext, type MeasureKey, type Measured, measure, measureContext, measureSkeleton } from './measure';
import { type GirthPreferences, type GirthResponse, distributionPenalty, redistributionStep } from './distribution';

// 原型：環切面 + 曲線連接 + 軟組織量體（全身）。
//
// 身體看成一圈一圈的切面：軀幹與腿是水平切面，手臂沿「肩 → 肘 → 腕」的軸線切。
// 每個量測位置是一個「關鍵圈」，各有一個大小參數；這一圈怎麼變大變小（往外、往內、往前、往後各多少）
// 由該部位的模組決定，圈與圈之間用不會過衝的平滑曲線連起來。
// 臀部、臀側、下腹這些「一團肉」另外做成有形狀的量體；胸部是獨立部件。
// 四肢長度屬於骨架，先用 MakeHuman 的長度形變調好，再做圍度。

export type RingTargets = { height: number } & Partial<Record<Exclude<MeasureKey, 'height'>, number>>;

export interface RingOptions {
  /** 先把素體骨盆一帶雕得很明顯的細節（胯骨、鼠蹊折線、大腿外側鼓起）抹順 */
  neutralize: boolean;
  /** 臀部支撐範圍（由目標臀圍／身高決定），校準與求解必須使用同一份。 */
  hipExpansion?: number;
  condition?: ShapeCondition;
}

/** 四個方向的縮放：往外、往內（只用在四肢）、往前、往後 */
interface Aniso {
  side: number;
  inner: number;
  front: number;
  back: number;
}

const uni = (k: number): Aniso => ({ side: k, inner: k, front: k, back: k });
const aniso = (d: number, side: number, inner: number, front: number, back: number): Aniso => ({
  side: 1 + side * d,
  inner: 1 + inner * d,
  front: 1 + front * d,
  back: 1 + back * d,
});

/** 部位模組：圍度變化量 d（= 參數 − 1）怎麼分到各方向 */
const MODULES = {
  underbust: (d: number) => uni(1 + d),
  // 腰：變細時幾乎只收側面（腰窩），前面的肚子與後腰只收一點；變粗時肚子往前、腰側往外
  // 變粗的部分大多由肚子、腰側的量體負責，骨架只往外撐一點
  waist: (d: number) => (d < 0 ? aniso(d, 1.5, 1.5, 0.25, 0.4) : aniso(d, 0.55, 0.55, 0.7, 0.45)),
  // 大腿：內側中段長得多一點
  thigh: (d: number) => aniso(d, 1.0, 1.15, 0.8, 1.0),
  // 小腿：主要長在後內側的小腿肚，前面是脛骨幾乎不長
  calf: (d: number) => aniso(d, 0.85, 1.1, 0.35, 1.35),
  // 腳踝：以骨頭為主，前面少
  ankle: (d: number) => aniso(d, 1.0, 1.0, 0.7, 1.1),
  // 上臂：後側（三頭肌、蝴蝶袖的位置）長得最多
  upperArm: (d: number) => aniso(d, 1.0, 0.8, 0.8, 1.35),
  wrist: (d: number) => uni(1 + d),
  // 脖子：後頸多一點
  neck: (d: number) => aniso(d, 1.0, 1.0, 0.8, 1.15),
};

/** 脂肪、肌肉加在四肢圈上時，各方向長多少（和骨架的部位模組分開） */
const FAT = {
  thigh: (d: number) => aniso(d, 1.0, 1.3, 0.6, 0.9),
  calf: (d: number) => aniso(d, 0.9, 1.2, 0.3, 1.2),
  // 上臂的脂肪偏後下方（蝴蝶袖）
  upperArm: (d: number) => aniso(d, 0.9, 1.0, 0.6, 1.5),
  neck: (d: number) => aniso(d, 1.0, 1.0, 0.9, 1.2),
};
const MUSCLE = {
  // 大腿前側（股四頭肌）、小腿肚、三角肌與上臂前後
  thigh: (d: number) => aniso(d, 0.9, 0.8, 1.3, 0.9),
  calf: (d: number) => aniso(d, 0.8, 1.1, 0.2, 1.5),
  upperArm: (d: number) => aniso(d, 1.2, 0.6, 1.1, 1.0),
};
/** 兩組縮放疊加（各自相對於 1 的增減相加） */
const plus = (...xs: Aniso[]): Aniso => ({
  side: 1 + xs.reduce((s, x) => s + x.side - 1, 0),
  inner: 1 + xs.reduce((s, x) => s + x.inner - 1, 0),
  front: 1 + xs.reduce((s, x) => s + x.front - 1, 0),
  back: 1 + xs.reduce((s, x) => s + x.back - 1, 0),
});

/**
 * 有重量的體雕部位：每一區是固定的造型，量（公斤）決定鼓多大。
 * 量體類（cm）沿表面長出一團；四肢與脖子類是加在那一圈上的比例。
 */
export const SOFT_KEYS = [
  'general', 'belly', 'lowerAbdomen', 'thighCover', 'flank', 'lowerBack', 'upperBack', 'chest', 'buttock', 'gluteUpper', 'gluteLower', 'hipSide', 'hipRoot',
  'thighFat', 'calfFat', 'armFat', 'neckFat', 'trunkMuscle', 'chestMuscle', 'gluteMuscle', 'thighMuscle', 'calfMuscle', 'armMuscle', 'otherLean',
] as const;
export type SoftKey = (typeof SOFT_KEYS)[number];
export type Soft = Record<SoftKey, number>;
const RING_SOFT: SoftKey[] = ['thighCover', 'thighFat', 'calfFat', 'armFat', 'neckFat', 'thighMuscle', 'calfMuscle', 'armMuscle'];
const isMuscle = (k: SoftKey) => k.endsWith('Muscle');
const isLean = (k: SoftKey) => isMuscle(k) || k === 'otherLean';
export const zeroSoft = (): Soft => Object.fromEntries(SOFT_KEYS.map((k) => [k, 0])) as Soft;

/** 增加的脂肪預設怎麼分到各區（依性別；只填身高體重時用） */
const FAT_SHARE: Record<Sex, Partial<Record<SoftKey, number>>> = {
  female: { general: 0.55, lowerAbdomen: 0.04, thighCover: 0.04, belly: 0.1, flank: 0.06, lowerBack: 0.04, upperBack: 0.03, buttock: 0.07, gluteUpper: 0.03, gluteLower: 0.02, hipSide: 0.075, hipRoot: 0.025, thighFat: 0.14, armFat: 0.06, calfFat: 0.03, neckFat: 0.02 },
  male: { general: 0.55, lowerAbdomen: 0.06, thighCover: 0.03, belly: 0.24, flank: 0.11, lowerBack: 0.05, upperBack: 0.06, chest: 0.05, buttock: 0.01, gluteUpper: 0.006, gluteLower: 0.004, hipSide: 0.007, hipRoot: 0.003, thighFat: 0.05, armFat: 0.07, calfFat: 0.01, neckFat: 0.02 },
};
/** 增加的去脂體重（肌肉、骨骼、內臟）怎麼分 */

/** 瘦了的時候：大多從全身那一層減 */
const LOSS_SHARE: Partial<Record<SoftKey, number>> = { general: 0.6, belly: 0.1, flank: 0.05, buttock: 0.05, hipSide: 0.05, thighFat: 0.1, armFat: 0.05 };

/** 手動填的軟組織圍度由哪幾區負責（比例） */
export type SoftGoal = 'bust' | 'waist' | 'hip' | 'thigh' | 'calf' | 'upperArm';
const GROUPS: Record<SoftGoal, Partial<Record<SoftKey, number>>> = {
  bust: { chest: 1 },
  waist: { belly: 0.5, flank: 0.35, lowerBack: 0.15 },
  // 預設的自然過渡：臀後與臀側平均分攤
  hip: { buttock: 0.3, gluteUpper: 0.12, gluteLower: 0.12, hipSide: 0.32, hipRoot: 0.14 },
  thigh: { thighFat: 1 },
  calf: { calfFat: 1 },
  upperArm: { armFat: 1 },
};
/** 四肢的圍度：增加的部分照體脂拆成脂肪與肌肉 */
const MUSCLE_OF: Partial<Record<SoftGoal, SoftKey>> = { thigh: 'thighMuscle', calf: 'calfMuscle', upperArm: 'armMuscle' };

const FAT_DENSITY = 0.9;
const LEAN_DENSITY = 1.06;
/** 與後續體積帳使用同一組固定密度；不混用另一組成分假設的平均密度公式。 */
const bodyDensity = (bf: number) => 1 / (bf / FAT_DENSITY + (1 - bf) / LEAN_DENSITY);
/** 素體本身的體脂率（換算素體的體重用） */
const BASE_FAT: Record<Sex, number> = { female: 0.25, male: 0.15 };

export interface CompositionInput {
  sex: Sex;
  /** 骨架與連動建議：身高、四肢長度、肩寬、頸、手腕、腳踝、下胸圍；女性另含上胸圍（決定罩杯） */
  frame: RingTargets;
  weight: number;
  bodyFat: number;
  weightLocked: boolean;
  bodyFatLocked: boolean;
  /** 手動填的軟組織圍度 */
  locked: Partial<Record<SoftGoal, number>>;
  /** 未手動指定的圍度偏好；允許在硬條件限制下保留偏差。 */
  preferred?: GirthPreferences;
  muscleMass?: number;
  estimateReference?: boolean;
  frameLocked?: MeasureKey[];
  breastLocked?: boolean;
  condition?: ShapeCondition;
}

export interface CompositionResult {
  P: Float32Array;
  measured: Measured;
  values: Measured['values'];
  weight: number;
  bodyFat: number;
  /** 各區的公斤數 */
  kg: Record<SoftKey, number>;
  iterations: number;
  tissues: { fat: number; muscle: number; otherLean: number };
  quality: ShapeQuality;
  accounting: { otherLeanBase: number; otherLeanControl: number; breastOtherLean: number };
}

/** 四肢長度用 MakeHuman 的長度形變（骨架） */
const LENGTHS: ['upperArmLen' | 'forearmLen' | 'thighLen' | 'calfLen', string][] = [
  ['upperArmLen', 'measure-upperarm-length'],
  ['forearmLen', 'measure-lowerarm-length'],
  ['thighLen', 'measure-upperleg-height'],
  ['calfLen', 'measure-lowerleg-height'],
];

/** 單調三次插值（PCHIP）：經過每個控制點，兩點之間不會超過端點值，不會出現波浪 */
export function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const s = h.map((hi, i) => (ys[i + 1] - ys[i]) / hi);
  const m = new Array(n).fill(0);
  m[0] = s[0];
  m[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (s[i - 1] * s[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / s[i - 1] + w2 / s[i]);
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 每個關鍵圈的參數（1 = 素體原本的大小）；女性 breast 在原生小／中／大杯間插值，之後才擴展控制籠 */
const PARAM_KEYS = ['underbust', 'waist', 'hip', 'thigh', 'calf', 'ankle', 'upperArm', 'wrist', 'neck', 'shoulder', 'breast'] as const;
type ParamKey = (typeof PARAM_KEYS)[number];
type Params = Record<ParamKey, number>;

interface ArmAxis {
  S: V3;
  E: V3;
  H: V3;
  side: 1 | -1;
}

interface Prepared {
  sex: Sex;
  hipExpansion: number;
  B: Float32Array;
  marks: Measured['marks'];
  levels: Measured['levels'];
  acromionY: number;
  /** 軀幹與脖子每公分高度的前後中心 z */
  torsoZ: (y: number) => number;
  neckZ: (y: number) => number;
  /** 左腿每公分高度的中心 (x, z) */
  legC: (y: number) => [number, number];
  arms: ArmAxis[];
  w: { torso: Float32Array; legL: Float32Array; legR: Float32Array; armL: Float32Array; armR: Float32Array; neck: Float32Array; breast: Float32Array };
  /** 小腿、腳、前臂、手、脖子：位移不再抹平（這些部位的圈本來就沿軸線平順相接） */
  raw: Float32Array;
  /** 全身那一層脂肪的厚度分布（小腿、前臂較薄，頭、手、腳沒有） */
  wGen: Float32Array;
  /** 素體抹平過的法向量（軟組織量體沿這個方向長出來） */
  normals: Float32Array;
  quality: SurfaceQuality;
  surfaceRig: SurfaceRig;
  breastRig: BreastRig;
  condition: ShapeCondition;
  chestWall?: Float32Array;
  /** 相同框架與四肢參數的共同底面；軀幹材料響應探測不需重算拓撲平滑。 */
  frameCache?: Map<string, Float32Array>;
  /** 同一次求解會回到已評估候選；同參數的最終曲面和胸壁不必重建。 */
  surfaceCache?: Map<string, { surface: Float32Array; wall?: Float32Array }>;
  /** 整隻手臂（上臂、前臂、手）：跟著肩膀平移 */
  armSets: { L: Uint32Array; R: Uint32Array };
}

export class RingBody {
  readonly ctx: MeasureContext;
  readonly adj: number[][];
  private readonly surface: BodyModel;
  private regionFields?: Pick<Prepared, 'w' | 'raw' | 'wGen' | 'armSets'>;
  private inspectionState: { p: Prepared; q: Params; soft: Soft } | null = null;
  private readonly setups = new Map<string, {
    sex: Sex;
    neutralize: boolean;
    /** 身高、四肢長度、上下胸圍差（女性） */
    frame: (number | undefined)[];
    p: Prepared & { lens: number[]; slopes: number[] };
    V0: number;
    breastV0: number;
    M0: number;
    kgPer: Soft;
    response: GirthResponse;
  }>();

  constructor(readonly asset: BodyAsset) {
    this.ctx = measureContext(asset);
    this.adj = adjacency(asset.quads, asset.nBody);
    this.surface = new BodyModel(asset);
  }

  private region(name: string): number {
    return this.asset.regions.indexOf(name);
  }

  /** 維護入口：檢查骨性參照上的權重與單控制；正式尺寸仍走 fitComposition。 */
  inspectControls(inp: CompositionInput) {
    if (this.inspectionState) {
      const p = this.inspectionState.p;
      return { surface: p.surfaceRig.controls, breast: p.breastRig.bindings };
    }
    const ref = REFERENCE[inp.sex];
    const hip = inp.locked.hip ?? inp.preferred?.hip?.target ?? ref.girths.hip;
    const condition = { ...(inp.condition ?? defaultCondition()), bodyFat: inp.bodyFat };
    const p = this.prepare(inp.sex, inp.frame, { neutralize: true, condition,
      hipExpansion: smoothstep(1.02, 1.43, (hip / inp.frame.height) / (ref.girths.hip / ref.height)) });
    return { surface: p.surfaceRig.controls, breast: p.breastRig.bindings };
  }

  /** 隔離最近一次的實際解，停用指定組織控制以定位故障；不改動求解快取。 */
  inspectSolved(disabled: SoftKey[] = []): Float32Array {
    if (!this.inspectionState) throw new Error('請先進行實際數值求解');
    const { p, q, soft } = this.inspectionState;
    const out = new Float32Array(p.B.length), reduced = { ...soft };
    for (const key of disabled) reduced[key] = 0;
    this.build(p, q, out, reduced);
    return out;
  }

  /** 多起點候選之間保留被選中的診斷狀態，避免截面讀到被捨棄的候選。 */
  preserveInspection(): () => void {
    const state = this.inspectionState;
    return () => { this.inspectionState = state; };
  }

  /** 單控制也走相同的交界約束、胸型與最終平滑，再獨立量測響應。 */
  inspectControl(id: string, amount: number, disabled: SoftKey[] = []) {
    if (!this.inspectionState) throw new Error('請先進行實際數值求解');
    const { p, q, soft } = this.inspectionState, reduced = { ...soft };
    for (const key of disabled) reduced[key] = 0;
    const P = new Float32Array(p.B.length);
    this.build(p, q, P, reduced, { id, amount });
    const measured = measure(this.ctx, P, undefined, [], p.chestWall);
    return { P, values: measured.values, sources: measured.sources,
      volume: meshVolume(P.subarray(0, this.asset.nBody * 3), this.asset.quads) };
  }

  /** 素體 + 四肢長度，縮放到指定身高、腳底貼地 */
  private skeleton(B0: Float32Array, t: RingTargets, lens: number[]): { B: Float32Array; m: ReturnType<typeof measureSkeleton> } {
    const a = this.asset;
    const B = new Float32Array(B0);
    LENGTHS.forEach(([, name], k) => {
      if (lens[k]) addTarget(a, `${name}-${lens[k] > 0 ? 'incr' : 'decr'}`, Math.abs(lens[k]), B);
    });
    let m = measureSkeleton(this.ctx, B);
    const s = t.height / m.values.height;
    for (let i = 0; i < B.length; i += 3) {
      B[i] *= s;
      B[i + 1] = (B[i + 1] - m.marks.soleY) * s;
      B[i + 2] *= s;
    }
    m = measureSkeleton(this.ctx, B);
    return { B, m };
  }

  private prepare(sex: Sex, t: RingTargets, opts: RingOptions, lensIn?: number[], slopesIn?: number[]): Prepared & { lens: number[]; slopes: number[] } {
    this.ctx.sex = sex;
    const a = this.asset;
    const n = a.nBody;
    const B0 = new Float32Array(a.base);
    addTarget(a, `asian-${sex}-young`, 1, B0);
    addTarget(a, 'nipple-size-decr', 1, B0);
    // 女性以原生小杯曲面作確定基底；大小由同一組原生杯型控制與局部控制籠求解。
    // 不先選一個偏大的底稿，再用負參數削平。
    if (sex === 'female') addTarget(a, 'female-young-averagemuscle-averageweight-mincup-averagefirmness', 1, B0);
    addTarget(a, 'nipple-point-decr', 1, B0);

    // 四肢長度：每一段各自用割線法調到目標（調完再縮放回身高，所以要反覆幾次）
    const lens = lensIn ? [...lensIn] : LENGTHS.map(() => 0);
    let { B, m: frameMeasure } = this.skeleton(B0, t, lens);
    const slopes = slopesIn ?? LENGTHS.map(([key], k) => {
      const trial = [...lens];
      trial[k] = 0.5;
      return (this.skeleton(B0, t, trial).m.values[key] - frameMeasure.values[key]) / 0.5;
    });
    for (let it = 0; it < (lensIn ? 0 : 8); it++) {
      let worst = 0;
      LENGTHS.forEach(([key], k) => {
        const want = t[key as keyof RingTargets];
        if (want === undefined || !slopes[k]) return;
        const err = want - frameMeasure.values[key];
        worst = Math.max(worst, Math.abs(err));
        lens[k] = Math.max(-3, Math.min(3, lens[k] + err / slopes[k]));
      });
      if (worst < 0.1) break;
      ({ B, m: frameMeasure } = this.skeleton(B0, t, lens));
    }
    let m = measure(this.ctx, B);
    if (opts.neutralize) {
      this.neutralizePelvis(B, m.marks);
      m = measure(this.ctx, B);
    }

    const R = (r: string) => this.region(r);
    const regionSet = (...names: string[]) => new Set(names.map(R));
    const indicator = (set: Set<number>, iterations: number) => {
      const w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = set.has(a.region[i]) ? 1 : 0;
      smoothField(w, this.adj, iterations);
      return w;
    };
    // 這些權重只依賴固定拓撲；身高、肌脂與代表型不需重新建立。
    if (!this.regionFields) {
    // 各部位的權重，交界處平滑過渡
    const w = {
      torso: indicator(regionSet('torso', 'breastL', 'breastR', 'shoulderL', 'shoulderR'), 12),
      // 腳、手跟著腳踝、手腕一起變粗（只變寬不變長），否則腳踝、手腕會被不動的腳掌、手掌拉回去
      legL: indicator(regionSet('thighL', 'calfL', 'footL'), 12),
      legR: indicator(regionSet('thighR', 'calfR', 'footR'), 12),
      armL: indicator(regionSet('upperarmL', 'forearmL', 'handL'), 8),
      armR: indicator(regionSet('upperarmR', 'forearmR', 'handR'), 8),
      neck: indicator(regionSet('neck'), 6),
      breast: indicator(regionSet('breastL', 'breastR'), 4),
    };
    const raw = indicator(regionSet('calfL', 'calfR', 'footL', 'footR', 'forearmL', 'forearmR', 'handL', 'handR', 'neck'), 6);
    const wGen = new Float32Array(n);
    const thin = regionSet('calfL', 'calfR', 'forearmL', 'forearmR');
    const full = regionSet('torso', 'breastL', 'breastR', 'shoulderL', 'shoulderR', 'thighL', 'thighR', 'upperarmL', 'upperarmR');
    for (let i = 0; i < n; i++) wGen[i] = full.has(a.region[i]) ? 1 : thin.has(a.region[i]) ? 0.55 : a.region[i] === R('neck') ? 0.7 : 0;
    smoothField(wGen, this.adj, 10);
    const noCover = regionSet('head', 'face', 'handL', 'handR', 'footL', 'footR');
    for (let i = 0; i < n; i++) if (noCover.has(a.region[i])) wGen[i] = 0;

      const pickSet = (set: Set<number>) => Uint32Array.from({ length: n }, (_, i) => i).filter(i => set.has(a.region[i]));
      this.regionFields = { w, raw, wGen, armSets: {
        L: pickSet(regionSet('upperarmL', 'forearmL', 'handL')),
        R: pickSet(regionSet('upperarmR', 'forearmR', 'handR')),
      } };
    }
    const { w, raw, wGen, armSets } = this.regionFields;

    // 中心線：每公分高度一個點
    const centerLine = (set: Set<number>, axis: 0 | 2, mode: 'mid' | 'mean') => {
      const acc = new Map<number, [number, number, number, number]>();
      for (let i = 0; i < n; i++) {
        if (!set.has(a.region[i])) continue;
        const y = Math.round(B[i * 3 + 1]);
        const e = acc.get(y) ?? [Infinity, -Infinity, 0, 0];
        const v = B[i * 3 + axis];
        e[0] = Math.min(e[0], v);
        e[1] = Math.max(e[1], v);
        e[2] += v;
        e[3]++;
        acc.set(y, e);
      }
      const ys = [...acc.keys()].sort((p, q) => p - q);
      const vs = ys.map((y) => {
        const e = acc.get(y)!;
        return mode === 'mid' ? (e[0] + e[1]) / 2 : e[2] / e[3];
      });
      // 稍微抹平
      const sm = vs.map((_, i) => {
        let sum = 0, c = 0;
        for (let k = Math.max(0, i - 3); k <= Math.min(vs.length - 1, i + 3); k++) {
          sum += vs[k];
          c++;
        }
        return sum / c;
      });
      return linear(ys, sm);
    };
    const legSet = regionSet('thighL', 'calfL');
    const legX = centerLine(legSet, 0, 'mean');
    const legZ = centerLine(legSet, 2, 'mean');

    const J = (name: string) => centroid(B, ...a.joints[name]);
    const arms: ArmAxis[] = [
      { S: J('l-shoulder'), E: J('l-elbow'), H: J('l-hand'), side: 1 },
      { S: J('r-shoulder'), E: J('r-elbow'), H: J('r-hand'), side: -1 },
    ];

    const normals = vertexNormals(B, a.quads, n);
    smoothVectors(normals, this.adj, 10);
    const torsoZ = centerLine(regionSet('torso'), 2, 'mid');
    const bodyWeight = Float32Array.from(w.torso, (v, i) => Math.min(1, v + w.legL[i] + w.legR[i]));
    const condition = opts.condition ?? defaultCondition();
    const surfaceRig = new SurfaceRig(a, B, this.adj, sex, m.marks, normals, bodyWeight, wGen, w.torso, torsoZ, opts.hipExpansion ?? 0, condition);
    return {
      quality: new SurfaceQuality(a, B), surfaceRig, breastRig: new BreastRig(a, B, this.adj), condition,
      sex,
      hipExpansion: opts.hipExpansion ?? 0,
      B,
      marks: m.marks,
      levels: m.levels,
      acromionY: (B[a.landmarks.acromionL * 3 + 1] + B[a.landmarks.acromionR * 3 + 1]) / 2,
      torsoZ,
      neckZ: centerLine(regionSet('neck'), 2, 'mid'),
      legC: (y) => [legX(y), legZ(y)],
      arms,
      w,
      raw,
      wGen,
      normals,
      armSets,
      lens,
      slopes,
    };
  }

  /** 骨盆一帶：以高度為權重做 Taubin 平滑，把雕得太深的胯骨與鼠蹊折線抹順 */
  private neutralizePelvis(B: Float32Array, mk: Measured['marks']): void {
    const a = this.asset;
    const L = mk.underbustY - mk.crotchY;
    const R = (r: string) => this.region(r);
    const ok = new Set([R('torso'), R('thighL'), R('thighR')]);
    const w = new Float32Array(a.nBody);
    for (let i = 0; i < a.nBody; i++) {
      if (!ok.has(a.region[i])) continue;
      const y = B[i * 3 + 1];
      w[i] = smoothstep(mk.crotchY - 0.45 * L, mk.crotchY - 0.1 * L, y) * (1 - smoothstep(mk.crotchY + 0.45 * L, mk.crotchY + 0.75 * L, y));
      // 正中線附近（下腹、恥骨、臀溝）保留原本的弧度，只抹掉兩側斜下來的 V 字折線
      w[i] *= 0.5 + 0.5 * smoothstep(3, 9, Math.abs(B[i * 3]));
    }
    const tmp = new Float32Array(B.length);
    for (let it = 0; it < 30; it++) {
      for (const f of [0.5, -0.53]) {
        for (let i = 0; i < a.nBody; i++) {
          const nb = this.adj[i];
          if (!w[i]) {
            tmp[i * 3] = B[i * 3];
            tmp[i * 3 + 1] = B[i * 3 + 1];
            tmp[i * 3 + 2] = B[i * 3 + 2];
            continue;
          }
          let x = 0, y = 0, z = 0;
          for (const j of nb) {
            x += B[j * 3];
            y += B[j * 3 + 1];
            z += B[j * 3 + 2];
          }
          const k = (f * w[i]) / nb.length;
          tmp[i * 3] = B[i * 3] + (x - nb.length * B[i * 3]) * k;
          tmp[i * 3 + 1] = B[i * 3 + 1] + (y - nb.length * B[i * 3 + 1]) * k;
          tmp[i * 3 + 2] = B[i * 3 + 2] + (z - nb.length * B[i * 3 + 2]) * k;
        }
        B.set(tmp.subarray(0, a.nBody * 3), 0);
      }
    }
  }

  private build(p: Prepared, q: Params, out: Float32Array, soft?: Soft, single?: { id: string; amount: number }): void {
    const surfaceKey = single ? null : [...PARAM_KEYS.map(k => q[k]), ...(soft ? SOFT_KEYS.map(k => soft[k]) : []), p.levels.calf, p.levels.ankle].join(',');
    p.surfaceCache ??= new Map();
    const cached = surfaceKey === null ? undefined : p.surfaceCache.get(surfaceKey);
    if (cached) {
      out.set(cached.surface);
      if (cached.wall) { p.chestWall ??= new Float32Array(out.length); p.chestWall.set(cached.wall); }
      return;
    }
    const a = this.asset;
    const n = a.nBody;
    const mk = p.marks;
    const B = p.B;
    out.set(B);
    const L = mk.underbustY - mk.crotchY;
    const d = Object.fromEntries(PARAM_KEYS.map((k) => [k, q[k] - 1])) as Params;
    // 男性胸部體量共同擴展胸廓的側面與前後弧，局部覆蓋僅負責表層分布。
    // 不能把整個胸圍差集中成胸前一塊；單位響應包含這項共同變換。
    if (p.sex === 'male') d.breast += (soft?.chest ?? 0) * 0.08;
    const dH = d.hip;
    const W = MODULES.waist(d.waist), U = MODULES.underbust(d.underbust);

    // ── 軀幹：三條輪廓曲線（側面、前面、後面），各有自己的控制點（由下往上）
    // 骨架曲線只負責大輪廓（骨盆寬、腰窩、胸廓、肩寬）；臀部、下腹、臀側的「肉」由後面的量體負責
    const yA = mk.underbustY + 0.55 * (p.acromionY - mk.underbustY);
    const armK = 1 + 0.5 * d.underbust + (p.sex === 'male' ? 0.3 * d.breast : 0);
    const male = p.sex === 'male';
    // 男性：上胸圍是胸大肌那一圈（另一個關鍵圈）；女性：上胸圍由胸部部件決定
    const chest = male ? plus(U, aniso(d.breast, 0.8, 0.8, 0.8, 0.35)) : U;
    const chestY = male ? mk.bustY : (mk.underbustY + yA) / 2;
    const chestSide = male ? chest.side : (U.side + armK) / 2;
    // 骨盆：男性的臀圍主要在骨架（骨盆寬與後側），量體較小
    const hipFrame = male ? { side: 1 + 0.8 * dH, back: 1 + 0.45 * dH } : { side: 1 + 0.55 * dH, back: 1 + 0.2 * dH };
    const tSide = pchip(
      [mk.crotchY - 0.12 * L, mk.hipY, mk.waistY, mk.underbustY, chestY, yA, p.acromionY],
      [1 + (male ? 0.7 : 0.45) * dH, hipFrame.side, W.side, U.side, chestSide, (armK + q.shoulder) / 2, q.shoulder],
    );
    const tFront = pchip(
      [mk.crotchY, mk.waistY, mk.underbustY, chestY, yA, p.acromionY],
      [1 + 0.2 * dH, W.front, U.front, male ? chest.front : (U.front + armK) / 2, armK, 1],
    );
    const tBack = pchip(
      [mk.crotchY - 0.12 * L, mk.hipY, mk.waistY, mk.underbustY, chestY, yA, p.acromionY],
      [1 + 0.1 * dH, hipFrame.back, W.back, U.back, male ? chest.back : (U.back + armK) / 2, armK, 1],
    );
    const torsoDisp = (x: number, y: number, z: number): V3 => {
      const dz = z - p.torsoZ(y);
      const sz = tBack(y) + (tFront(y) - tBack(y)) * smoothstep(-4, 4, dz);
      return [x * (tSide(y) - 1), 0, dz * (sz - 1)];
    };

    // ── 腿：腳底 → 腳踝 → 小腿肚 → 膝 → 大腿中段 → 量大腿圍處 → 大腿根
    const kneeY = mk.kneeY, ankleY = mk.ankleY;
    const calfY = kneeY - (kneeY - ankleY) * p.levels.calf;
    const ankleRingY = ankleY + (kneeY - ankleY) * p.levels.ankle;
    const thighY = mk.crotchY - 0.1 * (mk.crotchY - kneeY);
    const midY = kneeY + 0.45 * (mk.crotchY - kneeY);
    const sf = soft ?? zeroSoft();
    const T = plus(MODULES.thigh(d.thigh), FAT.thigh(sf.thighFat), MUSCLE.thigh(sf.thighMuscle));
    const C = plus(MODULES.calf(d.calf), FAT.calf(sf.calfFat), MUSCLE.calf(sf.calfMuscle));
    const K = MODULES.ankle(d.ankle);
    // 膝蓋、大腿中段跟著大腿與小腿的總變化
    const dT = d.thigh + sf.thighFat + sf.thighMuscle, dC = d.calf + sf.calfFat + sf.calfMuscle;
    const knee = aniso(1, 0.3 * dT + 0.3 * dC, 0.35 * dT + 0.3 * dC, 0.2 * dT + 0.15 * dC, 0.3 * dT + 0.35 * dC);
    const legRings: [number, Aniso][] = [
      [mk.soleY + 0.01 * L, aniso(d.ankle, 0.45, 0.45, 0, 0)],
      [ankleRingY, K],
      [calfY, C],
      [kneeY, knee],
      [midY, plus(aniso(d.thigh, 0.55, 0.6, 0.5, 0.55), FAT.thigh(0.6 * sf.thighFat + sf.thighCover), MUSCLE.thigh(0.8 * sf.thighMuscle))],
      [thighY, T],
      // 大腿根部內側收回來，避免把恥骨三角區夾成凹陷
      [mk.crotchY + 0.05 * L, { ...T, inner: 1 + 0.75 * (T.inner - 1) }],
    ];
    const legCurve = curves(legRings);
    const legDisp = (x: number, y: number, z: number, side: number): V3 => {
      const [cx, cz] = p.legC(y);
      const ox = x - side * cx, oz = z - cz;
      const c = legCurve(y);
      const sx = c.inner + (c.side - c.inner) * smoothstep(-2, 2, ox * side);
      const sz = c.back + (c.front - c.back) * smoothstep(-3, 3, oz);
      // 腳踝以下只變寬，不往前後拉長腳掌
      const zk = smoothstep(ankleY - 0.03 * L, ankleRingY, y);
      // 腿根和正中恥骨共用邊界：內腿增厚不把附著於正中的皮膚拉過另一側。
      const root = smoothstep(mk.crotchY - 0.22 * (mk.crotchY - kneeY), mk.crotchY - 1, y);
      const anchor = root * (1 - smoothstep(0.35 * cx, 0.8 * cx, Math.abs(x)));
      // 根部內側以正比例壓縮保留頂點次序，不能先越過正中再逐點夾回。
      const rootDx = x * (1 / (1 + Math.max(0, sx - 1)) - 1);
      const dx = ox * (sx - 1) * (1 - anchor) + rootDx * anchor;
      const attachment = 1 - (1 - smoothstep(0, 0.35 * cx, Math.abs(x))) * root;
      return [dx, 0, oz * (sz - 1) * zk * attachment];
    };

    // ── 手臂：沿「肩 → 肘 → 腕」的軸線，u = 0 肩、1 肘、2 腕
    const A = plus(MODULES.upperArm(d.upperArm), FAT.upperArm(sf.armFat), MUSCLE.upperArm(sf.armMuscle)), Wr = MODULES.wrist(d.wrist);
    const dA = d.upperArm + sf.armFat + sf.armMuscle;
    const armRings: [number, Aniso][] = [
      [-0.1, uni(1 + 0.35 * dA)],
      // 三角肌：肌肉多的時候肩頭比較圓
      [0.15, plus(aniso(d.upperArm + sf.armFat, 0.7, 0.4, 0.6, 0.7), aniso(sf.armMuscle, 1.2, 0.5, 1.0, 1.0))],
      [0.5, A],
      [1, uni(1 + 0.35 * dA + 0.15 * d.wrist)],
      [1.45, uni(1 + 0.25 * dA + 0.55 * d.wrist)],
      [1.93, Wr],
      [2.15, uni(1 + 0.45 * d.wrist)],
    ];
    const armCurve = curves(armRings);
    const armDisp = (P: V3, ax: ArmAxis): V3 => {
      const seg = (A0: V3, A1: V3) => {
        const dv = sub(A1, A0);
        const len = Math.hypot(...dv);
        const dir: V3 = [dv[0] / len, dv[1] / len, dv[2] / len];
        const t = dot(sub(P, A0), dir) / len;
        return { A0, dir, len, t };
      };
      const up = seg(ax.S, ax.E), lo = seg(ax.E, ax.H);
      const s = up.t <= 1 ? up : lo;
      const u = up.t <= 1 ? up.t : 1 + lo.t;
      const C0: V3 = [s.A0[0] + s.dir[0] * s.t * s.len, s.A0[1] + s.dir[1] * s.t * s.len, s.A0[2] + s.dir[2] * s.t * s.len];
      const r = sub(P, C0);
      // 局部座標：front = 正前方去掉軸向分量；out = 往身體外側
      const fz: V3 = [-s.dir[2] * s.dir[0], -s.dir[2] * s.dir[1], 1 - s.dir[2] * s.dir[2]];
      const f = normalize(fz);
      let o = normalize(cross(s.dir, f));
      if (o[0] * ax.side < 0) o = [-o[0], -o[1], -o[2]];
      const ro = dot(r, o), rf = dot(r, f);
      const c = armCurve(u);
      const so = c.inner + (c.side - c.inner) * smoothstep(-1.5, 1.5, ro);
      const sf = c.back + (c.front - c.back) * smoothstep(-1.5, 1.5, rf);
      // 肩關節位移和臂圍變換一起混合，不能按最大權重分區把整臂硬接到肩上。
      const shoulder = torsoDisp(ax.S[0], ax.S[1], ax.S[2]);
      return [o[0] * ro * (so - 1) + f[0] * rf * (sf - 1) + shoulder[0],
        o[1] * ro * (so - 1) + f[1] * rf * (sf - 1),
        o[2] * ro * (so - 1) + f[2] * rf * (sf - 1) + shoulder[2] * 0.5];
    };

    // ── 脖子
    const Nk = plus(MODULES.neck(d.neck), FAT.neck(sf.neckFat));
    const neckDisp = (x: number, y: number, z: number): V3 => {
      const dz = z - p.neckZ(y);
      const sz = Nk.back + (Nk.front - Nk.back) * smoothstep(-2, 2, dz);
      return [x * (Nk.side - 1), 0, dz * (sz - 1)];
    };

    const frameKey = [...PARAM_KEYS.filter(k => male || k !== 'breast').map(k => q[k]), ...RING_SOFT.map(k => sf[k]), male ? sf.chest : 0, p.levels.calf, p.levels.ankle].join(',');
    p.frameCache ??= new Map();
    const cachedFrame = p.frameCache.get(frameKey);
    if (cachedFrame) out.set(cachedFrame);
    else {
    for (let i = 0; i < n; i++) {
      const w = p.w;
      let sum = 0;
      const dsum: V3 = [0, 0, 0];
      if (w.torso[i] >= 1e-4) {
        const wk = w.torso[i], dv = torsoDisp(B[i * 3], B[i * 3 + 1], B[i * 3 + 2]);
        dsum[0] += dv[0] * wk; dsum[1] += dv[1] * wk; dsum[2] += dv[2] * wk;
        sum += wk;
      }
      if (w.legL[i] >= 1e-4) {
        const wk = w.legL[i], dv = legDisp(B[i * 3], B[i * 3 + 1], B[i * 3 + 2], 1);
        dsum[0] += dv[0] * wk; dsum[1] += dv[1] * wk; dsum[2] += dv[2] * wk;
        sum += wk;
      }
      if (w.legR[i] >= 1e-4) {
        const wk = w.legR[i], dv = legDisp(B[i * 3], B[i * 3 + 1], B[i * 3 + 2], -1);
        dsum[0] += dv[0] * wk; dsum[1] += dv[1] * wk; dsum[2] += dv[2] * wk;
        sum += wk;
      }
      if (w.armL[i] >= 1e-4) {
        const wk = w.armL[i], dv = armDisp([B[i * 3], B[i * 3 + 1], B[i * 3 + 2]], p.arms[0]);
        dsum[0] += dv[0] * wk; dsum[1] += dv[1] * wk; dsum[2] += dv[2] * wk;
        sum += wk;
      }
      if (w.armR[i] >= 1e-4) {
        const wk = w.armR[i], dv = armDisp([B[i * 3], B[i * 3 + 1], B[i * 3 + 2]], p.arms[1]);
        dsum[0] += dv[0] * wk; dsum[1] += dv[1] * wk; dsum[2] += dv[2] * wk;
        sum += wk;
      }
      if (w.neck[i] >= 1e-4) {
        const wk = w.neck[i], dv = neckDisp(B[i * 3], B[i * 3 + 1], B[i * 3 + 2]);
        dsum[0] += dv[0] * wk; dsum[1] += dv[1] * wk; dsum[2] += dv[2] * wk;
        sum += wk;
      }
      if (!sum) continue;
      // 權重總和不足 1 的地方（往手、腳、頭過渡）只取加權量，自然淡出
      const norm = Math.max(1, sum);
      out[i * 3] += dsum[0] / norm;
      out[i * 3 + 1] += dsum[1] / norm;
      out[i * 3 + 2] += dsum[2] / norm;
    }
    // 增加的量是「一層」：把位移場抹平再加回去，素體原本的細節（膝蓋、肌肉起伏）不會跟著被放大
    const D = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) D[i] = out[i] - B[i];
    const D0 = new Float32Array(D);
    smoothVectors(D, this.adj, 12);
    for (let i = 0; i < n * 3; i++) {
      const r = p.raw[(i / 3) | 0];
      out[i] = B[i] + D[i] * (1 - r) + D0[i] * r;
    }
    if (p.frameCache.size >= 8) p.frameCache.delete(p.frameCache.keys().next().value!);
    p.frameCache.set(frameKey, out.slice(0, n * 3));
    }

    // 軟組織由共同控制帶合成；每份場已在骨架準備時完成拓撲綁定與邊界平滑。
    const surfaceSoft = soft ?? { ...zeroSoft(), buttock: (male ? 14 : 26) * Math.max(-0.25, dH), hipSide: (male ? 4 : 9) * Math.max(-0.25, dH) };
    p.surfaceRig.apply(out, male ? { ...surfaceSoft, chest: surfaceSoft.chest * 0.2 } : surfaceSoft, single);

    // 內側軟組織可接近正中面，但左右表面不能交換位置。
    // 指數壓縮保留連續斜率；體積與皮尺仍在此約束後重新量測。
    for (let i = 0; i < n; i++) {
      const x = B[i * 3];
      if (Math.abs(x) > 1e-5 && out[i * 3] / x < 0.2) out[i * 3] = 0.2 * x * Math.exp(out[i * 3] / (0.2 * x) - 1);
    }

    // 肩寬帶動手臂後，量測軸與擺姿勢樞紐也要跟隨同一骨性位移。
    // 只移動皮膚會讓中段皮尺沿舊軸切割，亦會繞錯誤的肩點轉動。
    for (const [row, side] of ['l', 'r'].entries()) {
      const ax = p.arms[row], delta = torsoDisp(...ax.S);
      for (const name of ['shoulder', 'elbow', 'hand']) {
        const [start, count] = a.joints[`${side}-${name}`];
        for (let i = start; i < start + count; i++) {
          out[i * 3] = B[i * 3] + delta[0];
          out[i * 3 + 2] = B[i * 3 + 2] + delta[2] * 0.5;
        }
      }
    }

    if (!male) {
      p.chestWall ??= new Float32Array(out.length);
      if (q.breast <= 0) {
        this.surface.finish(out); p.chestWall.set(out);
      } else {
        p.chestWall.set(out);
        p.breastRig.apply(out, q.breast, p.condition.morphology.breast, (i, delta) => {
          const x = B[i * 3], y = B[i * 3 + 1], z = B[i * 3 + 2];
          const before = torsoDisp(x, y, z), after = torsoDisp(x + delta[0], y + delta[1], z + delta[2]);
          const w = p.w.torso[i] / Math.max(1, p.w.torso[i] + p.w.legL[i] + p.w.legR[i] + p.w.armL[i] + p.w.armR[i] + p.w.neck[i]);
          return delta.map((v, k) => v + (after[k] - before[k]) * w) as V3;
        });
        this.surface.finishPair(p.chestWall, out, p.breastRig.support);
      }
    } else {
      this.surface.finish(out);
    }
    if (surfaceKey !== null) {
      if (p.surfaceCache.size >= 8) p.surfaceCache.delete(p.surfaceCache.keys().next().value!);
      p.surfaceCache.set(surfaceKey, { surface: new Float32Array(out), wall: p.chestWall?.slice() });
    }
    // 任何改變輪廓的平滑都在求解與量測前完成；姿勢階段不再修改曲面。
  }

  /** 每一圈各自調整（割線法），直到網格上量到的數值等於目標；四肢長度在圍度調好後再校正一次 */
  fit(sex: Sex, t: RingTargets, opts: RingOptions): { P: Float32Array; values: Measured['values']; params: Params; iterations: number } {
    this.ctx.sex = sex;
    let p = this.prepare(sex, t, opts);
    const P = new Float32Array(p.B.length);
    const male = sex === 'male';
    // 胸部：女性從原生小杯開始（0），男性胸廓的局部尺度從 1 開始
    const q = Object.fromEntries(PARAM_KEYS.map((k) => [k, k === 'breast' && !male ? 0 : 1])) as Params;
    const read = (v: Measured['values'], k: ParamKey) => (k === 'breast' ? (male ? v.bust : v.bust - v.underbust) : v[k]);
    const want = (k: ParamKey) =>
      k === 'breast' ? (male ? t.bust : t.bust !== undefined && t.underbust !== undefined ? t.bust - t.underbust : undefined) : t[k];
    let m = measure(this.ctx, p.B);
    let total = 0;
    for (let pass = 0; pass < 2; pass++) {
      const prev = new Map<ParamKey, [number, number]>();
      for (let it = 0; it < 30; it++, total++) {
        this.build(p, q, P);
        // 量測高度固定在素體上找到的位置（腰在最細處、小腿在最粗處…），和關鍵圈的位置一致；
        // 否則胖的時候「最細處」會跑掉，調大那一圈反而量不到
        m = measure(this.ctx, P, p.levels, [], p.chestWall);
        let worst = 0;
        for (const k of PARAM_KEYS) {
          const target = want(k);
          if (target === undefined) continue;
          const cur = read(m.values, k);
          const err = target - cur;
          worst = Math.max(worst, Math.abs(err));
          // 斜率：第一次假設圍度和參數成正比（女性胸部另外估），之後用前後兩次的差
          const guess = k === 'breast' && !male ? 20 : cur / q[k];
          let slope = guess;
          const pr = prev.get(k);
          if (pr && Math.abs(q[k] - pr[0]) > 1e-6) {
            const sl = (cur - pr[1]) / (q[k] - pr[0]);
            if (Number.isFinite(sl) && sl > 0.2 * guess) slope = sl;
          }
          prev.set(k, [q[k], cur]);
          const lo = k === 'breast' && !male ? 0 : 0.4;
          q[k] = Math.max(lo, Math.min(k === 'breast' && !male ? 6 : 3, q[k] + (0.9 * err) / slope));
        }
        if (worst < 0.15) break;
      }
      // 四肢長度：圍度調整會稍微移動胯下與肩點，差太多就修正骨架長度再調一次
      const lens = [...p.lens];
      let worstLen = 0;
      LENGTHS.forEach(([key], k) => {
        const target = t[key as keyof RingTargets];
        if (target === undefined || !p.slopes[k]) return;
        const err = target - m.values[key];
        worstLen = Math.max(worstLen, Math.abs(err));
        lens[k] = Math.max(-3, Math.min(3, lens[k] + err / p.slopes[k]));
      });
      if (worstLen < 0.2 || pass === 1) break;
      p = this.prepare(sex, t, opts, lens, p.slopes);
    }
    this.build(p, q, P);
    m = measure(this.ctx, P, p.levels, [], p.chestWall);
    return { P, values: m.values, params: q, iterations: total };
  }

  /**
   * 依身體組成長出身體：骨架照連動建議（或手動值），脂肪與肌肉以公斤分到各區。
   * 手動填的軟組織圍度只調整負責它的那幾區（要變小到負的時改收那一圈），
   * 其餘的量照性別的預設比例分到沒填的部位；鎖定體重時，總脂肪量固定，多退少補都從沒填的部位來。
   */
  fitComposition(inp: CompositionInput, opts: RingOptions): CompositionResult {
    const { sex } = inp;
    this.ctx.sex = sex;
    const male = sex === 'male';
    const ref = REFERENCE[sex];
    const hip = inp.locked.hip ?? inp.preferred?.hip?.target ?? ref.girths.hip * inp.frame.height / ref.height;
    opts = { ...opts, condition: { ...(inp.condition ?? defaultCondition()), bodyFat: inp.bodyFat, muscle: inp.muscleMass === undefined ? 0 : (inp.muscleMass / (inp.weight * (1 - inp.bodyFat)) - MUSCLE_OF_LEAN) * 4 }, hipExpansion: smoothstep(1.02, 1.43, (hip / inp.frame.height) / (ref.girths.hip / ref.height)) };
    const a = this.asset;
    const n = a.nBody;
    const P = new Float32Array(a.base.length);
    const vol = (X: Float32Array) => meshVolume(X.subarray(0, n * 3), a.quads);
    const q = Object.fromEntries(PARAM_KEYS.map((k) => [k, k === 'breast' && !male ? 0 : 1])) as Params;

    // 骨架與校準只和身高、四肢長度、胸部底稿有關：算過就留著，拖動圍度滑桿時不用重算
    const f = inp.frame;
    // 以固定半公分格點建立骨架快取，格點只決定起點；最後仍對準實際長度。
    // 不借用「最先遇到的相近體型」，否則分配校準會因操作路徑而得到不同的基底。
    const setupFrame: RingTargets = { ...f };
    for (const [name] of LENGTHS) {
      const k = name as keyof RingTargets;
      const value = f[k];
      if (value !== undefined) setupFrame[k] = Math.round(value * 2) / 2;
    }
    const frameVec = [setupFrame.height, setupFrame.upperArmLen, setupFrame.forearmLen,
      setupFrame.thighLen, setupFrame.calfLen];
    const key = JSON.stringify([sex, opts.neutralize, opts.condition, opts.hipExpansion, ...frameVec]);
    let setup = this.setups.get(key);
    if (setup) {
      this.setups.delete(key); this.setups.set(key, setup);
    } else {
      const pp = this.prepare(sex, setupFrame, opts);
      // 素體的體重與每一區「一單位」有多重（體積 × 密度）
      this.build(pp, q, P, zeroSoft());
      const V0 = vol(P);
      const breastV0 = pp.chestWall ? V0 - vol(pp.chestWall) : 0;
      const M0 = (V0 * bodyDensity(BASE_FAT[sex])) / 1000;
      const kgPer = zeroSoft();
      const response: GirthResponse = {};
      {
        for (const k of SOFT_KEYS) {
          if (k === 'chest' && !male) continue;
          // 原生肌肉材料同時收束脂肪，淨體積可以下降，不能把負斜率當負肌肉公斤。
          // 軀幹肌肉以素體骨骼肌估計量的 35% 為一單位全區形態幅度；區域細分為
          // 工程組成先驗。形變造成的真正體積仍進總帳，與脂肪／其他去脂分開。
          if (k === 'chestMuscle' || k === 'trunkMuscle' || k === 'gluteMuscle') {
            kgPer[k] = M0 * (1 - BASE_FAT[sex]) * MUSCLE_OF_LEAN * 0.35
              * ({ chestMuscle: 0.22, trunkMuscle: 0.5, gluteMuscle: 0.28 }[k]);
          } else {
            const unit = RING_SOFT.includes(k) ? 0.05 : 1;
            const s1 = zeroSoft(); s1[k] = unit;
            this.build(pp, q, P, s1);
            kgPer[k] = ((vol(P) - V0) * (isLean(k) ? LEAN_DENSITY : FAT_DENSITY)) / 1000 / unit;
          }
          // 分配的有限差分會在當前體型重新量測；不建立隨即被覆寫的素體圍度響應。
        }
      }
      setup = { sex, neutralize: opts.neutralize, frame: frameVec, p: pp, V0, breastV0, M0, kgPer, response };
      if (this.setups.size > 6) this.setups.delete(this.setups.keys().next().value!);
      this.setups.set(key, setup);
    }
    let p = { ...setup.p, hipExpansion: opts.hipExpansion! };
    const { M0 } = setup;
    const { kgPer, response: calibratedResponse } = setup;
    const baseFat = M0 * BASE_FAT[sex];

    // 預設分配：體重與體脂率換算出的脂肪、去脂體重，扣掉素體已有的，照比例分到各區
    // 未鎖體重時，統計推估重量不是新的肌肉／器官量實測。
    // 去脂先驗由框架與性別參照建立；局部加量直接反映在輸出重量。
    const referenceWeight = ref.weight * (inp.frame.height / ref.height) ** 3;
    const leanTarget = inp.weightLocked ? inp.weight * (1 - inp.bodyFat) : referenceWeight * (1 - ref.bodyFat);
    const fatTarget = inp.weightLocked ? inp.weight * inp.bodyFat : leanTarget * inp.bodyFat / (1 - inp.bodyFat);
    const dFat = fatTarget - baseFat;
    const baseMuscle = (M0 - baseFat) * MUSCLE_OF_LEAN;
    const dLean = leanTarget - (M0 - baseFat);
    const muscleTarget = inp.muscleMass ?? leanTarget * MUSCLE_OF_LEAN;
    const dMuscle = muscleTarget - baseMuscle;
    const observed = nhanesPreference(sex, inp.frame.height, inp.weight, inp.bodyFat);
    // DXA 的粗分區僅約束分布先驗；分到大腿／小腿及局部肌腹的比例是工程模型。
    const leanShare: Partial<Record<SoftKey, number>> = {
      trunkMuscle: observed.lean.trunk * 0.4, chestMuscle: observed.lean.trunk * 0.35, gluteMuscle: observed.lean.trunk * 0.25, armMuscle: observed.lean.arm,
      thighMuscle: observed.lean.leg * 0.72, calfMuscle: observed.lean.leg * 0.28,
    };
    const norm = (sh: Partial<Record<SoftKey, number>>, keys?: SoftKey[]) => {
      const ks = (Object.keys(sh) as SoftKey[]).filter((k) => (!keys || keys.includes(k)) && kgPer[k]);
      const tot = ks.reduce((t, k) => t + sh[k]!, 0) || 1;
      return Object.fromEntries(ks.map((k) => [k, sh[k]! / tot])) as Partial<Record<SoftKey, number>>;
    };
    const regionalFat = { ...FAT_SHARE[sex] };
    if (inp.locked.waist === undefined) {
      regionalFat.belly = (regionalFat.belly ?? 0) + (regionalFat.lowerAbdomen ?? 0);
      regionalFat.lowerAbdomen = 0;
    }
    const regionalKeys = { arm: ['armFat'], leg: ['thighFat', 'calfFat', 'thighCover'],
      trunk: ['belly', 'lowerAbdomen', 'flank', 'lowerBack', 'upperBack', 'chest', 'buttock', 'gluteUpper', 'gluteLower', 'hipSide', 'hipRoot', 'neckFat'] } as const;
    const initial = norm(regionalFat);
    // DXA 為整臂／整腿／軀幹先驗；全身覆蓋及局部細分仍是明示的表面模型映射。
    const general = initial.general ?? 0;
    for (const region of ['arm', 'leg', 'trunk'] as const) {
      const keys = regionalKeys[region];
      const total = keys.reduce((sum, k) => sum + (initial[k] ?? 0), 0);
      const target = Math.max(0.01, observed.fat[region] - general * ({ arm: 0.1, leg: 0.35, trunk: 0.55 }[region]));
      for (const k of keys) if (initial[k] !== undefined) regionalFat[k] = initial[k]! * target / Math.max(0.01, total);
    }
    regionalFat.general = general;
    const fatShare = norm(dFat >= 0 ? regionalFat : LOSS_SHARE);
    const kgDefault = zeroSoft();
    for (const [k, v] of Object.entries(fatShare) as [SoftKey, number][]) kgDefault[k] = dFat * v;
    for (const [k, v] of Object.entries(norm(leanShare)) as [SoftKey, number][]) kgDefault[k] = dMuscle * v;
    kgDefault.otherLean = dLean - dMuscle;

    // 手動填的軟組織圍度：女性的上胸圍由胸部部件負責（在骨架那邊），其餘各有負責的區
    const goals = (Object.keys(inp.locked) as SoftGoal[]).filter((g) => inp.locked[g] !== undefined && !(g === 'bust' && !male));
    const owned = new Set<SoftKey>();
    for (const g of goals) {
      for (const k of Object.keys(GROUPS[g]) as SoftKey[]) owned.add(k);
      const mk = MUSCLE_OF[g];
      if (mk) owned.add(mk);
    }
    const groups = { ...GROUPS };
    const projected = opts.condition!.morphology.hip === 'projected';
    const fatCondition = smoothstep(0.12, 0.42, inp.bodyFat);
    const directions: Partial<Record<SoftGoal, Partial<Record<SoftKey, number>>>> = {
      hip: { buttock: projected ? 0.44 : 0.3, gluteUpper: 0.13, gluteLower: 0.12 + 0.08 * fatCondition,
        hipSide: projected ? 0.18 : 0.32, hipRoot: 0.16 },
      waist: { belly: male ? 0.65 : opts.condition!.morphology.abdomen === 'soft' ? 0.5 : 0.35,
        flank: 0.35 + 0.15 * fatCondition, lowerBack: male ? 0.25 : 0.18 },
    };
    for (const g of ['hip', 'waist'] as const) {
      const units = directions[g]!;
      groups[g] = norm(Object.fromEntries(Object.entries(units).map(([k, v]) => [k, v * Math.max(0, kgPer[k as SoftKey])])));
    }
    const fatFrac = Math.min(0.85, Math.max(0.25, 2.2 * inp.bodyFat));
    /** 鎖定體重時的修正量：骨架調整、胸部等也會改變體重，用實際算出的體重回頭調整沒填部位的脂肪 */
    let restAdj = 0;
    /** 同時鎖定體重與體脂率時，去脂體重（肌肉）也要調整 */
    let leanAdj = 0;
    let muscleAdj = 0;
    const extra = Object.fromEntries(goals.map((g) => [g, 0])) as Record<SoftGoal, number>;
    let bias = zeroSoft();
    // 骨架類：照連動建議（或手動值）對準
    const FRAME: ParamKey[] = ['underbust', 'shoulder', 'neck', 'wrist', 'ankle', ...(male ? [] : (['breast'] as ParamKey[]))];
    const hardFrame = (k: ParamKey) => k === 'breast' ? inp.breastLocked !== false
      : inp.frameLocked === undefined || inp.frameLocked.includes(k as MeasureKey);
    // 分配從同一個起點求解，避免接受步數受上一個體型影響；骨架與公斤校準仍使用快取。
    const shrinkKey: Record<SoftGoal, ParamKey> = { bust: 'breast', waist: 'waist', hip: 'hip', thigh: 'thigh', calf: 'calf', upperArm: 'upperArm' };
    const upper: Partial<Record<SoftKey, number>> = { general: 2.2, upperBack: 2.5, lowerBack: 5,
      chest: 12, gluteUpper: 8, gluteLower: 8, buttock: 12, hipSide: 10, hipRoot: 8, neckFat: 0.25, trunkMuscle: 1.8, chestMuscle: 1.8, gluteMuscle: 1.8, otherLean: 2.5, thighCover: 0.6, lowerAbdomen: 6,
      armFat: inp.locked.upperArm === undefined ? 0.45 : 1.2,
      calfFat: inp.locked.calf === undefined ? 0.12 : 1,
      calfMuscle: inp.locked.calf === undefined ? 0.16 : 0.8 };

    const allocate = (): { soft: Soft; kg: Soft } => {
      const kg = { ...kgDefault };
      for (const g of goals) {
        const grp = groups[g];
        const mk = MUSCLE_OF[g];
        const fatBase = (Object.keys(grp) as SoftKey[]).reduce((t, k) => t + kgDefault[k], 0);
        const fatTotal = fatBase + extra[g] * (mk ? fatFrac : 1);
        if (mk) kg[mk] = kgDefault[mk] + extra[g] * (1 - fatFrac);
        // 要比素體還小：脂肪歸零，改收那一圈
        q[shrinkKey[g]] = fatTotal < 0 ? Math.max(0.5, 1 + fatTotal * 0.02) : 1;
        for (const [k, r] of Object.entries(grp) as [SoftKey, number][]) kg[k] = Math.max(0, fatTotal) * r;
      }
      if (inp.weightLocked || inp.estimateReference) {
        // 總脂肪量固定：剩下的量分到沒填的部位
        let used = 0;
        for (const k of owned) if (!isLean(k)) used += kg[k];
        const free = (Object.keys(fatShare) as SoftKey[]).filter((k) => !owned.has(k));
        const rest = dFat - used + restAdj;
        const sh = norm(rest >= 0 ? regionalFat : LOSS_SHARE, free.length ? free : ['general']);
        for (const k of SOFT_KEYS) if (!owned.has(k) && !isLean(k)) kg[k] = 0;
        // 局部減量與總重修正優先由相鄰軀幹覆蓋吸收；未指定的臀腿不自動
        // 成為縮上臂後的補償出口。軀幹同樣受上限約束，不能無限堆入。
        const adjacent = free.filter(k => ['belly', 'lowerAbdomen', 'flank', 'lowerBack', 'chest'].includes(k));
        const initialFree = free.reduce((sum, k) => sum + kgDefault[k], 0);
        const replacement = goals.length && adjacent.length ? Math.max(0, rest - Math.max(0, initialFree)) : 0;
        for (const [k, v] of Object.entries(sh) as [SoftKey, number][]) kg[k] = (rest - replacement) * v;
        const addWithinCapacity = (amount: number, keys: SoftKey[]) => {
          let remaining = amount;
          const room = (k: SoftKey) => Math.max(0, (upper[k] ?? Infinity) * kgPer[k] - kg[k] - bias[k]);
          let active = keys.filter(k => room(k) > 0.0001);
          for (let pass = 0; pass < keys.length && remaining > 0.0001 && active.length; pass++) {
            let used = 0;
            for (const [k, v] of Object.entries(norm(regionalFat, active)) as [SoftKey, number][]) {
              const delta = Math.min(remaining * v, room(k)); kg[k] += delta; used += delta;
            }
            if (used < 0.0001) break;
            remaining -= used; active = active.filter(k => room(k) > 0.0001);
          }
          return remaining;
        };
        if (replacement) addWithinCapacity(addWithinCapacity(replacement, adjacent), free);
      } else if (restAdj) {
        // 只鎖定體脂率：沒填的部位多退少補，讓脂肪比例對上
        const free = (Object.keys(fatShare) as SoftKey[]).filter((k) => !owned.has(k));
        const sh = norm(restAdj >= 0 ? regionalFat : LOSS_SHARE, free.length ? free : ['general']);
        for (const [k, v] of Object.entries(sh) as [SoftKey, number][]) kg[k] += restAdj * v;
      }
      kg.otherLean += leanAdj;
      if (muscleAdj) for (const [k, v] of Object.entries(norm(leanShare)) as [SoftKey, number][]) kg[k] += muscleAdj * v;
      for (const k of SOFT_KEYS) kg[k] += bias[k];
      const soft = zeroSoft();
      for (const k of SOFT_KEYS) {
        if (!kgPer[k]) continue;
        const u = kg[k] / kgPer[k];
        // 變薄有下限（量體不會凹進去、圈不會縮太多）
        const lower = RING_SOFT.includes(k) ? -0.25 : k === 'general' ? -1.2 : isMuscle(k) && !RING_SOFT.includes(k) ? -0.6 : isLean(k) ? -2 : 0;
        soft[k] = Math.min(upper[k] ?? Infinity, Math.max(lower, u));
      }
      return { soft, kg };
    };

    const t = inp.frame;
    const want = (k: ParamKey) => (k === 'breast' ? (t.bust !== undefined && t.underbust !== undefined ? t.bust - t.underbust : undefined) : t[k]);
    const read = (v: Measured['values'], k: ParamKey) => (k === 'breast' ? v.bust - v.underbust : v[k]);
    // 每公斤大約讓那一圈變粗幾公分（第一步用，之後用割線法）
    const GUESS: Record<SoftGoal, number> = { bust: 3, waist: 2.5, hip: 2, thigh: 4, calf: 6, upperArm: 8 };

    const weightOf = (sft: Soft) => {
      // 肌肉與其餘去脂各有確定基準及受限增量，不能拿幾何殘差補成器官／水分。
      const muscleKg = baseMuscle + SOFT_KEYS.reduce((sum, k) => sum + (isMuscle(k) ? sft[k] * kgPer[k] : 0), 0);
      const otherLeanBase = (M0 - baseFat) * (1 - MUSCLE_OF_LEAN);
      const otherLeanControl = sft.otherLean * kgPer.otherLean;
      const volume = vol(P);
      const breastOtherLean = p.chestWall ? (volume - vol(p.chestWall) - setup!.breastV0)
        * bodyDensity(inp.bodyFat) * (1 - inp.bodyFat) / 1000 : 0;
      const otherKg = otherLeanBase + otherLeanControl + breastOtherLean;
      // 剩餘皮下量體在固定密度下計為脂肪；局部脂肪公斤斜率只用於提出候選，
      // 不把非線性膨脹差當成額外去脂。負剩餘量會保留並觸發未收斂診斷。
      const fat = (volume / 1000 - (muscleKg + otherKg) / LEAN_DENSITY) * FAT_DENSITY;
      return { weight: fat + muscleKg + otherKg, fatKg: fat - baseFat, muscleKg,
        accounting: { otherLeanBase, otherLeanControl, breastOtherLean } };
    };
    let m = measure(this.ctx, p.B);
    let total = 0;
    let soft = zeroSoft();
    let prevW: [number, number] | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const preferred = { ...inp.preferred };
      const preferenceValues = (measured: Measured) => preferred.waist?.source === 'navel'
        ? { ...measured.values, minWaist: measured.values.waist, waist: measured.sources.navelWaist.value } : measured.values;
      // 男性胸圍是軟偏好，不能讓未量測的上背代替胸前吸收補償；上背保留預設分配。
      const free = SOFT_KEYS.filter((k) => (inp.weightLocked || inp.muscleMass !== undefined || !isMuscle(k)) && k !== 'otherLean' && !(k === 'lowerAbdomen' && inp.locked.waist === undefined) && !(male && k === 'upperBack') && kgPer[k]);
      const regionalCost = Object.fromEntries(SOFT_KEYS.map(k => [k, (isMuscle(k) ? 10 : 1) / Math.max(0.1, Math.abs(kgPer[k])) ** 2])) as Soft;
      type State = { q: Params; extra: Record<SoftGoal, number>; restAdj: number; leanAdj: number; muscleAdj: number; bias: Soft; levels: Prepared['levels'] };
      const save = (): State => ({ q: { ...q }, extra: { ...extra }, restAdj, leanAdj, muscleAdj, bias: { ...bias }, levels: { ...p.levels } });
      const restore = (s: State) => { Object.assign(q, s.q); Object.assign(extra, s.extra); restAdj = s.restAdj; leanAdj = s.leanAdj; muscleAdj = s.muscleAdj; bias = { ...s.bias }; p = { ...p, levels: { ...s.levels } }; };
      let best: State | null = null, bestPenalty = Infinity, attempts = 0, stepScale = 0.8;
      let response: GirthResponse | null = null;
      let responseState: { soft: Soft; q: Params } | null = null;
      const prevQ = new Map<ParamKey, [number, number]>();
      const prevX = new Map<SoftGoal, [number, number]>();
      for (let it = 0; it < 80; it++, total++) {
        soft = allocate().soft;
        this.build(p, q, P, soft);
        m = measure(this.ctx, P, p.levels, inp.locked.waist === undefined ? [] : ['waist'], p.chestWall);
        // 候選必須保存真正產生本次量測的參數，不能保存下方尚未驗證的修正量。
        const evaluatedState = save();
        let worst = 0;
        for (const k of FRAME) {
          const target = want(k);
          if (target === undefined) continue;
          // 服裝肩寬的未填參照不是骨點寬的實測：肩背增厚後不能反向縮骨架來硬守估值。
          if ((k === 'shoulder' || (male && k === 'underbust')) && !hardFrame(k)) continue;
          const cur = read(m.values, k);
          const err = target - cur;
          if (hardFrame(k)) worst = Math.max(worst, Math.abs(err));
          const guess = k === 'breast' ? 20 : cur / q[k];
          let slope = guess;
          const pr = prevQ.get(k);
          if (pr && Math.abs(q[k] - pr[0]) > 1e-6) {
            const sl = (cur - pr[1]) / (q[k] - pr[0]);
            if (Number.isFinite(sl) && sl > 0.2 * guess) slope = sl;
          }
          prevQ.set(k, [q[k], cur]);
          q[k] = Math.max(k === 'breast' ? 0 : 0.4, Math.min(k === 'breast' ? 6 : 3, q[k] + (0.9 * err) / slope));
        }
        for (const g of goals) {
          const cur = m.values[g];
          const err = inp.locked[g]! - cur;
          worst = Math.max(worst, Math.abs(err));
          let slope = GUESS[g];
          const pr = prevX.get(g);
          if (pr && Math.abs(extra[g] - pr[0]) > 1e-6) {
            const sl = (cur - pr[1]) / (extra[g] - pr[0]);
            if (Number.isFinite(sl) && sl > 0.2 * GUESS[g]) slope = sl;
          }
          prevX.set(g, [extra[g], cur]);
          extra[g] += (0.9 * err) / slope;
        }
        if (inp.muscleMass !== undefined) {
          const muscle = weightOf(soft).muscleKg;
          const err = inp.muscleMass - muscle;
          if (Math.abs(err) > 0.12) worst = Math.max(worst, 1);
          muscleAdj += 0.9 * err;
        }
        if (inp.bodyFatLocked || inp.estimateReference) {
          // 體脂率固定：直接算出脂肪與去脂體重各差多少，分別補到沒填的部位
          const { weight: w, fatKg } = weightOf(soft);
          const fat = baseFat + fatKg;
          if (inp.weightLocked || inp.estimateReference) {
            const eFat = inp.weight * inp.bodyFat - fat;
            const eLean = inp.weight * (1 - inp.bodyFat) - (w - fat);
            if (Math.abs(eFat) > 0.2 || Math.abs(eLean) > 0.2) worst = Math.max(worst, 1);
            restAdj += 0.9 * eFat;
            leanAdj += 0.9 * eLean;
          } else {
            // 加 x 公斤脂肪後 (fat + x) / (w + x) = 體脂率
            const x = (inp.bodyFat * w - fat) / (1 - inp.bodyFat);
            if (Math.abs(x) > 0.2) worst = Math.max(worst, 1);
            restAdj += 0.9 * x;
          }
        } else if (inp.weightLocked || inp.estimateReference) {
          const w = weightOf(soft).weight;
          const err = inp.weight - w;
          if (Math.abs(err) > 0.2) worst = Math.max(worst, 1);
          let slope = 1;
          if (prevW && Math.abs(restAdj - prevW[0]) > 1e-6) {
            const sl = (w - prevW[1]) / (restAdj - prevW[0]);
            if (Number.isFinite(sl) && sl > 0.3) slope = sl;
          }
          prevW = [restAdj, w];
          restAdj += (0.9 * err) / slope;
        }
        // 若局部圈已收到下限，先釋放跨區基底的壓力；不能靠繼續累加無效的局部修正。
        const blockedGoals = goals.filter((g) => q[shrinkKey[g]] <= 0.5001 && m.values[g] > inp.locked[g]! + 0.15);
        const seekFeasible = blockedGoals.length > 0 && it >= 12 && it % 8 === 4;
        if (worst < 0.15) {
          // 固定切面只用於迭代加速；收斂前重新搜尋真正的最細／最粗位置。
          const searched = measure(this.ctx, P, undefined, [], p.chestWall);
          const displaced = goals.some(g => Math.abs(searched.values[g] - inp.locked[g]!) > 0.15)
            || (!male && want('breast') !== undefined && Math.abs(read(searched.values, 'breast') - want('breast')!) > 0.15);
          if (displaced) {
            p = { ...p, levels: searched.levels };
            prevQ.clear(); prevX.clear();
            continue;
          }
          // 先校正已知會改動骨架的長度，再進行昂貴的區域偏好分配。
          // 有固定軟組織圈時，須先完成共同分配，因其交界仍會移動長度端點。
          // 沒有這類條件時，避免在即將捨棄的骨架上建立全部響應。
          if (pass === 0 && !goals.length && LENGTHS.some(([key]) => t[key] !== undefined && Math.abs(t[key]! - m.values[key]) >= 0.3)) break;
        }
        if (worst < 0.15 || seekFeasible) {
          if (!inp.weightLocked && preferred.upperArm) {
            // 上臂偏好使用扣除局部增胸量後的模型估計。手動胸圍不應凍結
            // 上臂的分配，也不能把更大罩杯的重量回饋成全身增肌／增脂。
            const breastWeight = p.chestWall ? (vol(P) - vol(p.chestWall) - setup!.breastV0) * bodyDensity(inp.bodyFat) / 1000 : 0;
            const estimate = Math.min(inp.weight, Math.max(1, weightOf(soft).weight - breastWeight));
            preferred.upperArm = { ...preferred.upperArm, target: nhanesPreference(sex, inp.frame.height, estimate, inp.bodyFat).arm };
          }
          const candidatePreferred = { ...preferred };
          for (const g of blockedGoals) candidatePreferred[g] = { target: inp.locked[g]!, scale: 0.015, confidence: 4 };
          const penalty = distributionPenalty(preferenceValues(m), preferred) + 0.035 * SOFT_KEYS.reduce((s, k) => s + bias[k] ** 2 * regionalCost[k], 0);
          if (worst < 0.15 && p.quality.evaluate(P).valid && penalty < bestPenalty - 1e-4) { best = evaluatedState; bestPenalty = penalty; }
          else if (best && !seekFeasible) { restore(best); stepScale *= 0.4; }
          if (!Object.keys(candidatePreferred).length || attempts++ >= 10 || it >= 56 || stepScale < 0.08 || bestPenalty < 0.03) break;
          if (best) {
            // 使用與保存狀態一致的量測提出候選，不能沿用剛被退回的身體。
            restore(best);
            soft = allocate().soft; this.build(p, q, P, soft); m = measure(this.ctx, P, p.levels, inp.locked.waist === undefined ? [] : ['waist'], p.chestWall);
          }
          // 跨區轉移超過一公斤或框架明顯改變後，舊斜率不再代表目前的形態。
          // 更新相鄰響應，不能一直沿初次候選的斜率累加後再縮小步長。
          if (responseState && (free.some(k => Math.abs((soft[k] - responseState!.soft[k]) * kgPer[k]) > 1)
            || PARAM_KEYS.some(k => k !== 'breast' && Math.abs(q[k] - responseState!.q[k]) > 0.06))) response = null;
          if (!response) {
            // 在目前體型量小步響應；瘦素體上的斜率無法代表大腹部與大臀的交互影響。
            response = { ...calibratedResponse };
            responseState = { soft: { ...soft }, q: { ...q } };
            const probeP = new Float32Array(P.length);
            // 共用控制帶會跨量測切面；在當前體型重新量測相鄰響應。
            const coupled: SoftKey[] = SOFT_KEYS.filter(k => k !== 'otherLean');
            for (const k of free.filter((k) => coupled.includes(k))) {
              const probe = { ...soft, [k]: soft[k] + 0.15 / kgPer[k] };
              this.build(p, q, probeP, probe);
              const probeMeasured = measure(this.ctx, probeP, p.levels, inp.locked.waist === undefined ? [] : ['waist'], p.chestWall);
              const v = preferenceValues(probeMeasured);
              response[k] = Object.fromEntries((Object.keys(v) as MeasureKey[]).map((g) => [g, (v[g] - preferenceValues(m)[g]) / 0.15]));
            }
          }
          const capacity = zeroSoft();
          const room = zeroSoft();
          for (const k of free) {
            const floor = (RING_SOFT.includes(k) ? -0.25 : k === 'general' ? -1.2 : isLean(k) ? -2 : 0) * kgPer[k];
            capacity[k] = Math.max(0, soft[k] * kgPer[k] - floor);
            room[k] = Math.max(0, ((upper[k] ?? Infinity) - soft[k]) * kgPer[k]);
          }
          let active = [...free];
          let step = zeroSoft();
          for (let activePass = 0; activePass < free.length; activePass++) {
            step = redistributionStep(active, response, preferenceValues(m), candidatePreferred,
              [...goals, ...FRAME.filter((k) => k !== 'breast' && hardFrame(k)) as MeasureKey[]], bias, capacity,
              regionalCost);
            const blocked = active.filter((k) => (step[k] < 0 && capacity[k] < 0.01) || (step[k] > 0 && room[k] < 0.01));
            if (!blocked.length) break;
            active = active.filter((k) => !blocked.includes(k));
          }
          const largest = Math.max(...SOFT_KEYS.map((k) => Math.abs(step[k])), 1e-9);
          let scale = Math.min(stepScale, Math.max(0.5, inp.weight * 0.02) / largest);
          for (const k of free) {
            if (step[k] < 0) scale = Math.min(scale, capacity[k] / -step[k]);
            if (step[k] > 0) scale = Math.min(scale, room[k] / step[k]);
          }
          if (largest * scale < 0.015) break;
          for (const k of free) bias[k] += step[k] * scale;
          prevQ.clear(); prevX.clear(); prevW = null;
        }
      }
      if (best) {
        restore(best);
        soft = allocate().soft;
        this.build(p, q, P, soft);
        m = measure(this.ctx, P, p.levels, inp.locked.waist === undefined ? [] : ['waist'], p.chestWall);
      }
      const lens = [...p.lens];
      let worstLen = 0;
      LENGTHS.forEach(([key], k) => {
        const target = t[key as keyof RingTargets];
        if (target === undefined || !p.slopes[k]) return;
        const err = target - m.values[key];
        worstLen = Math.max(worstLen, Math.abs(err));
        lens[k] = Math.max(-3, Math.min(3, lens[k] + err / p.slopes[k]));
      });
      if (worstLen < 0.3 || pass === 1) break;
      p = this.prepare(sex, t, opts, lens, p.slopes);
      // 本次圍度造成的長度修正只屬於這次解，不可寫回共用骨架而沿用舊公斤校準。
    }
    // 最後只對尚未達標的局部責任區作小型聯立校正；不讓分配候選的最後一步
    // 或量測位置更新留下未收斂的硬條件。每個參數仍只屬於自己的尺寸區。
    const evaluate = () => {
      soft = allocate().soft; this.build(p, q, P, soft); m = measure(this.ctx, P, undefined, [], p.chestWall);
    };
    type Variable = { target: number; read: () => number; get: () => number; set: (v: number) => void; probe: number; maxStep: number };
    const frameVariable = (k: ParamKey): Variable => ({ target: want(k)!, read: () => read(m.values, k),
      get: () => q[k], set: v => { q[k] = Math.max(k === 'breast' ? 0 : 0.4, Math.min(k === 'breast' ? 6 : 3, v)); }, probe: 0.01, maxStep: 0.2 });
    const softVariable = (g: SoftGoal): Variable => ({ target: inp.locked[g]!, read: () => m.values[g],
      get: () => extra[g], set: v => { extra[g] = v; }, probe: 0.15, maxStep: 4 });
    const frameVars = FRAME.filter(k => want(k) !== undefined && hardFrame(k));
    const blocks: Variable[][] = [
      frameVars.filter(k => k === 'underbust' || k === 'breast').map(frameVariable),
      goals.filter(g => ['waist', 'hip', 'thigh'].includes(g)).map(softVariable),
      ...goals.filter(g => !['waist', 'hip', 'thigh'].includes(g)).map(g => [softVariable(g)]),
      ...frameVars.filter(k => k !== 'underbust' && k !== 'breast').map(k => [frameVariable(k)]),
    ].filter(b => b.length);
    evaluate();
    for (let pass = 0; pass < 10; pass++) {
      const tissue = weightOf(soft);
      const dimensionError = Math.max(...blocks.flat().map(v => Math.abs(v.read() - v.target)));
      const massError = Math.max(inp.weightLocked ? Math.abs(tissue.weight - inp.weight) : 0,
        inp.bodyFatLocked ? Math.abs((baseFat + tissue.fatKg) / tissue.weight - inp.bodyFat) * 50 : 0,
        inp.muscleMass === undefined ? 0 : Math.abs(tissue.muscleKg - inp.muscleMass));
      if (dimensionError < 0.15 && massError < 0.12) break;
      for (const block of blocks) {
        const base = block.map(v => v.get()), error = block.map(v => v.target - v.read());
        if (Math.max(...error.map(Math.abs)) < 0.12) continue;
        const cost = error.reduce((s, e) => s + e * e, 0);
        const current = block.map(v => v.read());
        const columns = block.map((variable, column) => {
          block.forEach((v, k) => v.set(base[k])); variable.set(base[column] + variable.probe); evaluate();
          return block.map((v, row) => (v.read() - current[row]) / variable.probe);
        });
        const matrix = block.map((_, row) => columns.map(c => c[row]));
        const delta = solveLocal(matrix, error);
        let accepted = false;
        if (delta) for (const damping of [0.9, 0.45, 0.2, 0.08]) {
          block.forEach((v, k) => v.set(base[k] + damping * Math.max(-v.maxStep, Math.min(v.maxStep, delta[k])))); evaluate();
          if (p.quality.evaluate(P).valid && block.reduce((s, v) => s + (v.read() - v.target) ** 2, 0) < cost) { accepted = true; break; }
        }
        if (!accepted) { block.forEach((v, k) => v.set(base[k])); evaluate(); }
      }
      const current = weightOf(soft);
      if (inp.muscleMass !== undefined) muscleAdj += inp.muscleMass - current.muscleKg;
      if (inp.bodyFatLocked && inp.weightLocked) {
        restAdj += inp.weight * inp.bodyFat - baseFat - current.fatKg;
        leanAdj += inp.weight * (1 - inp.bodyFat) - (current.weight - baseFat - current.fatKg);
      } else if (inp.bodyFatLocked) restAdj += (inp.bodyFat * current.weight - baseFat - current.fatKg) / (1 - inp.bodyFat);
      else if (inp.weightLocked) {
        const before = restAdj; restAdj += 0.15; evaluate();
        const slope = (weightOf(soft).weight - current.weight) / 0.15;
        restAdj = before + (inp.weight - current.weight) / Math.max(0.2, slope);
      }
      evaluate();
    }
    // 多圈固定時，分配器的積分量可能已超過局部上限，繼續修改它不會
    // 改到曲面。最後直接在實際有界控制上聯立殘差，不再推動飽和的積分量。
    const constraints = blocks.flat().map(v => ({ target: v.target, read: v.read }));
    const dimensionCount = constraints.length;
    if (inp.weightLocked) constraints.push({ target: inp.weight, read: () => weightOf(soft).weight });
    if (inp.bodyFatLocked) constraints.push({ target: inp.bodyFat * 100,
      read: () => { const tissue = weightOf(soft); return (baseFat + tissue.fatKg) / tissue.weight * 100; } });
    if (inp.muscleMass !== undefined) constraints.push({ target: inp.muscleMass, read: () => weightOf(soft).muscleKg });
    if (constraints.some(v => Math.abs(v.read() - v.target) > 0.45)) {
      const dimensionsValid = () => constraints.slice(0, dimensionCount).every(v => Math.abs(v.read() - v.target) < 0.5);
      const costOf = () => constraints.reduce((sum, v) => sum + (v.read() - v.target) ** 2, 0);
      let feasible = dimensionsValid() && p.quality.evaluate(P).valid ? { q: { ...q }, soft: { ...soft }, cost: costOf() } : null;
      type Control = { get: () => number; set: (v: number) => void; probe: number; step: number; high: number };
      const variables: Control[] = [];
      const frameKeys = new Set([...frameVars, ...goals.map(g => shrinkKey[g])]);
      for (const k of frameKeys) {
        const lo = k === 'breast' && !male ? 0 : 0.5;
        const high = k === 'breast' && !male ? 6 : frameVars.includes(k) ? 3 : 1;
        variables.push({ get: () => q[k], set: v => { q[k] = Math.max(lo, Math.min(high, v)); }, probe: 0.01, step: 0.05, high });
      }
      for (const k of SOFT_KEYS) {
        if (!kgPer[k] || (male && k === 'upperBack')) continue;
        // 未指定肌肉時不藉此重新雕全身肌肉；其他去脂只用於明確組成條件。
        if (isMuscle(k) && inp.muscleMass === undefined) continue;
        if (k === 'otherLean' && !inp.bodyFatLocked && inp.muscleMass === undefined) continue;
        const lo = RING_SOFT.includes(k) ? -0.25 : k === 'general' ? -1.2 : isMuscle(k) ? -0.6 : isLean(k) ? -2 : 0;
        const high = (upper[k] ?? Infinity) * kgPer[k];
        variables.push({ get: () => soft[k] * kgPer[k],
          set: v => { soft[k] = Math.max(lo, Math.min(upper[k] ?? Infinity, v / kgPer[k])); },
          probe: 0.1, step: 1, high });
      }
      const update = () => { this.build(p, q, P, soft); m = measure(this.ctx, P, undefined, [], p.chestWall); };
      for (let pass = 0; pass < 6; pass++) {
        const current = constraints.map(v => v.read()), error = constraints.map((v, i) => v.target - current[i]);
        if (Math.max(...error.map(Math.abs)) < 0.15) break;
        const base = variables.map(v => v.get()), cost = error.reduce((s, e) => s + e * e, 0);
        const columns = variables.map((v, column) => {
          variables.forEach((item, k) => item.set(base[k]));
          v.set(base[column] + (base[column] + v.probe <= v.high ? v.probe : -v.probe));
          const change = v.get() - base[column]; update();
          return constraints.map((item, row) => Math.abs(change) < 1e-8 ? 0 : (item.read() - current[row]) / change * v.step);
        });
        // 少數硬條件、較多區域自由度：在相同控制尺度下取最小變動解。
        // 阻尼只防止秩不足放大步長，不放寬任何目標或控制邊界。
        const normal = constraints.map((_, row) => constraints.map((_, other) =>
          columns.reduce((sum, c) => sum + c[row] * c[other], 0) + (row === other ? 0.001 : 0)));
        const multiplier = solveLocal(normal, error);
        const delta = multiplier && columns.map(c => c.reduce((sum, v, row) => sum + v * multiplier[row], 0));
        let accepted = false;
        if (delta) for (const damping of [0.9, 0.45, 0.2, 0.08]) {
          variables.forEach((v, k) => v.set(base[k] + damping * Math.max(-1, Math.min(1, delta[k])) * v.step)); update();
          const tissue = weightOf(soft);
          const positive = tissue.muscleKg >= 0 && baseFat + tissue.fatKg >= 0
            && tissue.accounting.otherLeanBase + tissue.accounting.otherLeanControl + tissue.accounting.breastOtherLean >= 0;
          if (costOf() < cost && positive && p.quality.evaluate(P).valid) {
            accepted = true;
            if (dimensionsValid() && (!feasible || costOf() < feasible.cost)) feasible = { q: { ...q }, soft: { ...soft }, cost: costOf() };
            break;
          }
        }
        if (!accepted) { variables.forEach((v, k) => v.set(base[k])); update(); break; }
      }
      // 若容量仍不足，保留最近的有效尺寸解；不能為減少重量殘差而
      // 丟掉已達標的圈，再讓外層退回更遠的近似體型。
      if (!dimensionsValid() && feasible) { Object.assign(q, feasible.q); soft = feasible.soft; update(); }
    }
    this.build(p, q, P, soft);
    m = measure(this.ctx, P, undefined, [], p.chestWall);

    // 體重：素體 + 各區脂肪（實際用到的量）+ 其餘增加的體積當作去脂組織
    const { weight, fatKg, muscleKg, accounting } = weightOf(soft);
    const tissues = { fat: baseFat + fatKg, muscle: muscleKg, otherLean: weight - baseFat - fatKg - muscleKg };
    this.inspectionState = { p, q: { ...q }, soft: { ...soft } };
    const kg = zeroSoft();
    for (const k of SOFT_KEYS) kg[k] = soft[k] * kgPer[k];
    return { P, measured: m, values: m.values, weight, bodyFat: tissues.fat / weight, kg, iterations: total, tissues, accounting, quality: p.quality.evaluate(P) };
  }
}

/** 小型局部尺寸聯立；秩不足時保留原解，不放大無效步。 */
function solveLocal(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[pivot][i])) pivot = j;
    if (Math.abs(M[pivot][i]) < 1e-7) return null;
    [M[i], M[pivot]] = [M[pivot], M[i]];
    for (let j = i + 1; j < n; j++) {
      const scale = M[j][i] / M[i][i];
      for (let k = i; k <= n; k++) M[j][k] -= scale * M[i][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = (M[i][n] - M[i].slice(i + 1, n).reduce((s, v, k) => s + v * x[i + 1 + k], 0)) / M[i][i];
    if (!Number.isFinite(x[i])) return null;
  }
  return x;
}

/** 把一串 (位置, 四方向縮放) 的控制點接成四條平滑曲線 */
function curves(rings: [number, Aniso][]): (x: number) => Aniso {
  const xs = rings.map((r) => r[0]);
  const c = (k: keyof Aniso) => pchip(xs, rings.map((r) => r[1][k]));
  const side = c('side'), inner = c('inner'), front = c('front'), back = c('back');
  return (x) => ({ side: side(x), inner: inner(x), front: front(x), back: back(x) });
}

const sub = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const normalize = (p: V3): V3 => {
  const l = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
};

const vectorScratch = new WeakMap<number[][], Float32Array>();
function smoothVectors(F: Float32Array, adj: number[][], iterations: number): void {
  let tmp = vectorScratch.get(adj);
  if (!tmp || tmp.length !== F.length) { tmp = new Float32Array(F.length); vectorScratch.set(adj, tmp); }
  tmp.fill(0, adj.length * 3);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < adj.length; i++) {
      let x = F[i * 3], y = F[i * 3 + 1], z = F[i * 3 + 2];
      const nb = adj[i];
      if (nb.length === 4) {
        const a = nb[0] * 3, b = nb[1] * 3, c = nb[2] * 3, d = nb[3] * 3;
        x = x + F[a] + F[b] + F[c] + F[d];
        y = y + F[a + 1] + F[b + 1] + F[c + 1] + F[d + 1];
        z = z + F[a + 2] + F[b + 2] + F[c + 2] + F[d + 2];
      } else for (let row = 0; row < nb.length; row++) {
        const j = nb[row] * 3;
        x += F[j]; y += F[j + 1]; z += F[j + 2];
      }
      const k = 1 / (adj[i].length + 1);
      tmp[i * 3] = x * k;
      tmp[i * 3 + 1] = y * k;
      tmp[i * 3 + 2] = z * k;
    }
    F.set(tmp);
  }
}

function linear(xs: number[], ys: number[]): (x: number) => number {
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + (ys[hi] - ys[lo]) * t;
  };
}
