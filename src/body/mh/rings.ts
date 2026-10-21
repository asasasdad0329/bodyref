import type { Sex } from '../../core/measurements';
import { REFERENCE } from '../../core/reference';
import { applyCompositionShape, shapeCondition, shapeWeights, type ShapeCondition } from './shape';
import { SurfaceRig, BreastRig } from './shapeRig';
import { type BodyAsset, addTarget } from './asset';
import { type V3, adjacency, centroid, meshVolume, smoothField, vertexNormals } from './geometry';
import { type MeasureContext, type MeasureKey, type Measured, measure, measureContext } from './measure';
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
  /** 組成選擇表面形態；尺寸仍在該表面上重新量測校正。 */
  shape?: ShapeCondition;
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
  'general', 'belly', 'flank', 'lowerBack', 'upperBack', 'chest', 'buttock', 'hipSide',
  'thighFat', 'calfFat', 'armFat', 'neckFat', 'trunkMuscle', 'thighMuscle', 'calfMuscle', 'armMuscle',
] as const;
export type SoftKey = (typeof SOFT_KEYS)[number];
export type Soft = Record<SoftKey, number>;
const RING_SOFT: SoftKey[] = ['thighFat', 'calfFat', 'armFat', 'neckFat', 'thighMuscle', 'calfMuscle', 'armMuscle'];
const isMuscle = (k: SoftKey) => k.endsWith('Muscle');
export const zeroSoft = (): Soft => Object.fromEntries(SOFT_KEYS.map((k) => [k, 0])) as Soft;

/** 增加的脂肪預設怎麼分到各區（依性別；只填身高體重時用） */
const FAT_SHARE: Record<Sex, Partial<Record<SoftKey, number>>> = {
  female: { general: 0.3, belly: 0.1, flank: 0.06, lowerBack: 0.04, upperBack: 0.03, buttock: 0.12, hipSide: 0.1, thighFat: 0.14, armFat: 0.06, calfFat: 0.03, neckFat: 0.02 },
  male: { general: 0.25, belly: 0.3, flank: 0.11, lowerBack: 0.05, upperBack: 0.06, chest: 0.05, buttock: 0.02, hipSide: 0.01, thighFat: 0.05, armFat: 0.07, calfFat: 0.01, neckFat: 0.02 },
};
/** 增加的去脂體重（肌肉、骨骼、內臟）怎麼分 */
const LEAN_SHARE: Partial<Record<SoftKey, number>> = { trunkMuscle: 0.4, thighMuscle: 0.3, calfMuscle: 0.12, armMuscle: 0.18 };
/** 瘦了的時候：大多從全身那一層減 */
const LOSS_SHARE: Partial<Record<SoftKey, number>> = { general: 0.6, belly: 0.1, flank: 0.05, buttock: 0.05, hipSide: 0.05, thighFat: 0.1, armFat: 0.05 };

/** 手動填的軟組織圍度由哪幾區負責（比例） */
export type SoftGoal = 'bust' | 'waist' | 'hip' | 'thigh' | 'calf' | 'upperArm';
const GROUPS: Record<SoftGoal, Partial<Record<SoftKey, number>>> = {
  bust: { chest: 1 },
  waist: { belly: 0.5, flank: 0.35, lowerBack: 0.15 },
  // 預設的自然過渡：臀後與臀側平均分攤
  hip: { buttock: 0.5, hipSide: 0.5 },
  thigh: { thighFat: 1 },
  calf: { calfFat: 1 },
  upperArm: { armFat: 1 },
};
/** 四肢的圍度：增加的部分照體脂拆成脂肪與肌肉 */
const MUSCLE_OF: Partial<Record<SoftGoal, SoftKey>> = { thigh: 'thighMuscle', calf: 'calfMuscle', upperArm: 'armMuscle' };

const FAT_DENSITY = 0.9;
// 和素體的 Siri 雙組成密度一致；這是去脂體重，不是單獨肌肉組織。
const LEAN_DENSITY = 1.1;
/** Siri：體脂率 → 人體平均密度 */
const bodyDensity = (bf: number) => 495 / (bf * 100 + 450);
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
  /** 去除罩杯連動後的形態起點；不能把乳房增量當成全身肌肉增加。 */
  shapeWeight?: number;
  shapeBodyFat?: number;
  /** 手動填的軟組織圍度 */
  locked: Partial<Record<SoftGoal, number>>;
  /** 未手動指定的圍度偏好；允許在硬條件限制下保留偏差。 */
  preferred?: GirthPreferences;
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
  tissueMass: { fat: number; lean: number };
}

/** 四肢長度用 MakeHuman 的長度形變（骨架） */
const LENGTHS: [MeasureKey, string][] = [
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

/** 每個關鍵圈的參數（1 = 素體原本的大小）；breast 是超出 MakeHuman 胸型的圓頂量 */
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
  breastSets: { rimL: Uint32Array; rimR: Uint32Array };
  surfaceRig: SurfaceRig;
  breastRig: BreastRig;
  /** 整隻手臂（上臂、前臂、手）：跟著肩膀平移 */
  armSets: { L: Uint32Array; R: Uint32Array };
}

export class RingBody {
  readonly ctx: MeasureContext;
  readonly adj: number[][];
  private readonly hipCalibrations = new Map<string, { kgPer: Soft; response: GirthResponse }>();
  private readonly setups = new Map<string, {
    sex: Sex;
    neutralize: boolean;
    /** 身高、四肢長度、上下胸圍差（女性） */
    frame: (number | undefined)[];
    p: Prepared & { lens: number[]; slopes: number[] };
    V0: number;
    M0: number;
    kgPer: Soft;
    response: GirthResponse;
  }>();

  constructor(readonly asset: BodyAsset) {
    this.ctx = measureContext(asset);
    this.adj = adjacency(asset.quads, asset.nBody);
  }

  private region(name: string): number {
    return this.asset.regions.indexOf(name);
  }

  /** 素體 + 四肢長度，縮放到指定身高、腳底貼地 */
  private skeleton(B0: Float32Array, t: RingTargets, lens: number[]): { B: Float32Array; m: Measured } {
    const a = this.asset;
    const B = new Float32Array(B0);
    LENGTHS.forEach(([, name], k) => {
      if (lens[k]) addTarget(a, `${name}-${lens[k] > 0 ? 'incr' : 'decr'}`, Math.abs(lens[k]), B);
    });
    let m = measure(this.ctx, B);
    const s = t.height / m.values.height;
    for (let i = 0; i < B.length; i += 3) {
      B[i] *= s;
      B[i + 1] = (B[i + 1] - m.marks.soleY) * s;
      B[i + 2] *= s;
    }
    m = measure(this.ctx, B);
    return { B, m };
  }

  private prepare(sex: Sex, t: RingTargets, opts: RingOptions, lensIn?: number[], slopesIn?: number[]): Prepared & { lens: number[]; slopes: number[] } {
    const a = this.asset;
    const n = a.nBody;
    const B0 = new Float32Array(a.base);
    addTarget(a, `asian-${sex}-young`, 1, B0);
    addTarget(a, 'nipple-size-decr', 1, B0);
    addTarget(a, 'nipple-point-decr', 1, B0);
    if (opts.shape) applyCompositionShape(a, sex, opts.shape, B0);
    // 胸部底稿：先用 MakeHuman 的自然胸型（罩杯越大越飽滿、稍微下垂），超出範圍的部分再由圓頂放大
    if (sex === 'female' && t.bust !== undefined && t.underbust !== undefined) {
      // 差值取整數公分：底稿只是起點，這樣拖動時可以沿用同一份骨架
      const cup = Math.min(1, Math.max(0, (Math.round(t.bust - t.underbust) - 7.5) / 17.5));
      const firm = Math.min(0.72, Math.max(0.5, 0.72 - 0.22 * cup));
      const tri = (v: number): number[] => (v <= 0.5 ? [(0.5 - v) * 2, v * 2, 0] : [0, (1 - v) * 2, (v - 0.5) * 2]);
      const lv = ['min', 'average', 'max'];
      const c = tri(cup), f = tri(firm);
      const weight = shapeWeights(opts.shape?.adiposity ?? 0);
      for (let w = 0; w < 3; w++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        if ((i === 1 && j === 1) || !(weight[w] * c[i] * f[j])) continue;
        addTarget(a, `female-young-averagemuscle-${lv[w]}weight-${lv[i]}cup-${lv[j]}firmness`, weight[w] * c[i] * f[j], B0);
      }
    }

    // 四肢長度：每一段各自用割線法調到目標（調完再縮放回身高，所以要反覆幾次）
    const lens = lensIn ? [...lensIn] : LENGTHS.map(() => 0);
    let { B, m } = this.skeleton(B0, t, lens);
    const slopes = slopesIn ?? LENGTHS.map(([key], k) => {
      const trial = [...lens];
      trial[k] = 0.5;
      return (this.skeleton(B0, t, trial).m.values[key] - m.values[key]) / 0.5;
    });
    for (let it = 0; it < (lensIn ? 0 : 8); it++) {
      let worst = 0;
      LENGTHS.forEach(([key], k) => {
        const want = t[key as keyof RingTargets];
        if (want === undefined || !slopes[k]) return;
        const err = want - m.values[key];
        worst = Math.max(worst, Math.abs(err));
        lens[k] = Math.max(-3, Math.min(3, lens[k] + err / slopes[k]));
      });
      if (worst < 0.1) break;
      ({ B, m } = this.skeleton(B0, t, lens));
    }
    if (opts.neutralize) {
      this.neutralizePelvis(B, m.marks);
      if (sex === 'male') this.neutralizeMaleChest(B);
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
    for (let i = 0; i < n; i++) if (regionSet('head', 'face', 'handL', 'handR', 'footL', 'footR').has(a.region[i])) wGen[i] = 0;

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

    const breastSet = regionSet('breastL', 'breastR');
    const pick = (r: number) => Uint32Array.from({ length: n }, (_, i) => i).filter((i) => a.region[i] === r);
    const rim = (set: Uint32Array) => set.filter((i) => this.adj[i].some((j) => !breastSet.has(a.region[j])));
    const pickSet = (set: Set<number>) => Uint32Array.from({ length: n }, (_, i) => i).filter((i) => set.has(a.region[i]));
    const normals = vertexNormals(B, a.quads, n);
    smoothVectors(normals, this.adj, 10);
    return {
      surfaceRig: new SurfaceRig(a, B, m.marks, this.adj, centerLine(regionSet('torso'), 2, 'mid'), B[a.landmarks.acromionL * 3 + 1], sex === 'male'),
      breastRig: new BreastRig(a, B, this.adj),
      sex,
      hipExpansion: opts.hipExpansion ?? 0,
      B,
      marks: m.marks,
      levels: m.levels,
      acromionY: (B[a.landmarks.acromionL * 3 + 1] + B[a.landmarks.acromionR * 3 + 1]) / 2,
      torsoZ: centerLine(regionSet('torso'), 2, 'mid'),
      neckZ: centerLine(regionSet('neck'), 2, 'mid'),
      legC: (y) => [legX(y), legZ(y)],
      arms,
      w,
      raw,
      wGen,
      normals,
      breastSets: { rimL: rim(pick(R('breastL'))), rimR: rim(pick(R('breastR'))) },
      armSets: { L: pickSet(regionSet('upperarmL', 'forearmL', 'handL')), R: pickSet(regionSet('upperarmR', 'forearmR', 'handR')) },
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

  /** 男性基準修型：在完整胸前分區去除尖峰，邊界以拓撲權重回接胸廓。 */
  private neutralizeMaleChest(B: Float32Array): void {
    const a = this.asset;
    const regions = new Set(['breastL', 'breastR'].map((r) => this.region(r)));
    const w = Float32Array.from({ length: a.nBody }, (_, i) => regions.has(a.region[i]) ? 1 : 0);
    smoothField(w, this.adj, 12);
    const tmp = new Float32Array(B);
    for (let it = 0; it < 40; it++) {
      for (let i = 0; i < a.nBody; i++) {
        if (w[i] < 1e-4) continue;
        const nb = this.adj[i], gain = 0.45 * w[i] / nb.length;
        for (let k = 0; k < 3; k++) tmp[i * 3 + k] = B[i * 3 + k]
          + gain * nb.reduce((sum, j) => sum + B[j * 3 + k] - B[i * 3 + k], 0);
      }
      B.set(tmp);
    }
  }

  private build(p: Prepared, q: Params, out: Float32Array, soft?: Soft): void {
    const a = this.asset;
    const n = a.nBody;
    const mk = p.marks;
    const B = p.B;
    out.set(B);
    const L = mk.underbustY - mk.crotchY;
    const d = Object.fromEntries(PARAM_KEYS.map((k) => [k, q[k] - 1])) as Params;
    const dH = d.hip;
    const W = MODULES.waist(d.waist), U = MODULES.underbust(d.underbust);

    // ── 軀幹：三條輪廓曲線（側面、前面、後面），各有自己的控制點（由下往上）
    // 骨架曲線只負責大輪廓（骨盆寬、腰窩、胸廓、肩寬）；臀部、下腹、臀側的「肉」由後面的量體負責
    const yA = mk.underbustY + 0.55 * (p.acromionY - mk.underbustY);
    const armK = 1 + 0.5 * d.underbust + (p.sex === 'male' ? 0.3 * d.breast : 0);
    const male = p.sex === 'male';
    // 男性：上胸圍是胸大肌那一圈（另一個關鍵圈）；女性：上胸圍由胸部部件決定
    const chest = male ? uni(q.breast) : U;
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
      [midY, plus(aniso(d.thigh, 0.55, 0.6, 0.5, 0.55), FAT.thigh(0.6 * sf.thighFat), MUSCLE.thigh(0.8 * sf.thighMuscle))],
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
      return [ox * (sx - 1), 0, oz * (sz - 1) * zk];
    };

    // ── 手臂：沿「肩 → 肘 → 腕」的軸線，u = 0 肩、1 肘、2 腕
    const A = plus(MODULES.upperArm(d.upperArm), FAT.upperArm(sf.armFat), MUSCLE.upperArm(sf.armMuscle)), Wr = MODULES.wrist(d.wrist);
    const dA = d.upperArm + sf.armFat + sf.armMuscle;
    const armRings: [number, Aniso][] = [
      [-0.1, uni(1 + 0.35 * dA)],
      // 三角肌：肌肉多的時候肩頭比較圓
      [0.15, plus(aniso(d.upperArm + sf.armFat, 0.7, 0.4, 0.6, 0.7), aniso(sf.armMuscle, 1.2, 0.5, 1.0, 1.0))],
      [0.55, A],
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
      return [o[0] * ro * (so - 1) + f[0] * rf * (sf - 1), o[1] * ro * (so - 1) + f[1] * rf * (sf - 1), o[2] * ro * (so - 1) + f[2] * rf * (sf - 1)];
    };

    // ── 脖子
    const Nk = plus(MODULES.neck(d.neck), FAT.neck(sf.neckFat));
    const neckDisp = (x: number, y: number, z: number): V3 => {
      const dz = z - p.neckZ(y);
      const sz = Nk.back + (Nk.front - Nk.back) * smoothstep(-2, 2, dz);
      return [x * (Nk.side - 1), 0, dz * (sz - 1)];
    };

    for (let i = 0; i < n; i++) {
      const w = p.w;
      const parts: [number, () => V3][] = [
        [w.torso[i], () => torsoDisp(B[i * 3], B[i * 3 + 1], B[i * 3 + 2])],
        [w.legL[i], () => legDisp(B[i * 3], B[i * 3 + 1], B[i * 3 + 2], 1)],
        [w.legR[i], () => legDisp(B[i * 3], B[i * 3 + 1], B[i * 3 + 2], -1)],
        [w.armL[i], () => armDisp([B[i * 3], B[i * 3 + 1], B[i * 3 + 2]], p.arms[0])],
        [w.armR[i], () => armDisp([B[i * 3], B[i * 3 + 1], B[i * 3 + 2]], p.arms[1])],
        [w.neck[i], () => neckDisp(B[i * 3], B[i * 3 + 1], B[i * 3 + 2])],
      ];
      let sum = 0;
      const dsum: V3 = [0, 0, 0];
      for (const [wk, f] of parts) {
        if (wk < 1e-4) continue;
        const dv = f();
        dsum[0] += dv[0] * wk;
        dsum[1] += dv[1] * wk;
        dsum[2] += dv[2] * wk;
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

    // ── 軟組織量體：每一團都是有形狀的圓頂，沿表面法向量長出來，大的時候帶一點下墜
    // 量體可以變大也可以變小（變小有下限，避免凹進去）
    const g = Math.max(-0.25, dH);
    const legacy = !soft;
    const butt = male ? 14 : 26, side = male ? 4 : 9;
    // 臀圍增加時擴展承托區，讓臀上、臀側與臀下共同承擔體積，避免只抬高固定的小圓頂。
    const spread = legacy ? 0 : p.hipExpansion;
    const rearUp = (0.55 + 0.25 * spread) * L;
    const rearDown = (0.38 + 0.32 * spread) * L;
    const rearWidth = 0.72 + 0.48 * spread;
    const H = p.acromionY - mk.underbustY;
    const belly: Mass = male
      ? // 男性的肚子：從胸下一路到恥骨是一整個圓頂，最突出在肚臍上方
        { key: 'belly', y: mk.crotchY + 0.6 * L, up: legacy ? 0.48 * L : 0.62 * L, down: 0.65 * L, angle: 0, width: legacy ? 1.5 : 1.65, amp: legacy ? 3 * Math.max(0, dH) + 30 * Math.max(0, d.waist) : sf.belly, sag: 0.2, taper: 0.3 }
      : // 女性的下腹：肚臍到恥骨之間的一團，越往下越窄（下緣是 U 形，不是一條橫線或 V）
        { key: 'belly', y: mk.crotchY + 0.3 * L, up: 0.32 * L, down: 0.38 * L, angle: 0, width: 1.25, amp: legacy ? 5 * Math.max(0, dH) + 18 * Math.max(0, d.waist) : sf.belly, sag: 0.12, taper: 0.55 };
    // 腰側（游泳圈）：腰變粗時往兩側後方長，圓圓地接到背與臀
    const flank = (sign: number): Mass => ({
      key: 'flank', y: mk.waistY - 0.05 * L, up: legacy ? 0.32 * L : 0.45 * L, down: legacy ? 0.38 * L : 0.45 * L, angle: sign * (Math.PI / 2 + 0.35), width: legacy ? 0.95 : 1.05,
      amp: legacy ? (male ? 16 : 9) * Math.max(0, d.waist) : sf.flank, sag: 0.1, taper: 0.2,
    });
    const masses: Mass[] = [
      // 臀部（左右各一團）：上緣沿後腰緩緩接上來，最飽滿處偏下，下緣圓圓地收進臀下折線
      { key: 'buttock', y: mk.hipY - 0.04 * L, up: rearUp, down: rearDown, angle: Math.PI - 0.6, width: rearWidth, amp: legacy ? butt * g : sf.buttock, sag: 0.12, taper: 0 },
      { key: 'buttock', y: mk.hipY - 0.04 * L, up: rearUp, down: rearDown, angle: -(Math.PI - 0.6), width: rearWidth, amp: legacy ? butt * g : sf.buttock, sag: 0.12, taper: 0 },
      // 臀側到大腿外側：讓骨盆到大腿是一條連續往外的弧線
      { key: 'hipSide', y: legacy ? mk.crotchY - 0.03 * L : mk.crotchY + 0.05 * L, up: (legacy ? 0.45 : 0.6 + 0.13 * spread) * L, down: (legacy ? 0.5 : 0.48 + 0.18 * spread) * L, angle: Math.PI / 2 + 0.2, width: legacy ? 0.85 : 0.95 + 0.12 * spread, amp: legacy ? side * g : sf.hipSide, sag: 0.05, taper: 0 },
      { key: 'hipSide', y: legacy ? mk.crotchY - 0.03 * L : mk.crotchY + 0.05 * L, up: (legacy ? 0.45 : 0.6 + 0.13 * spread) * L, down: (legacy ? 0.5 : 0.48 + 0.18 * spread) * L, angle: -(Math.PI / 2 + 0.2), width: legacy ? 0.85 : 0.95 + 0.12 * spread, amp: legacy ? side * g : sf.hipSide, sag: 0.05, taper: 0 },
      belly,
      flank(1),
      flank(-1),
      // 後腰與上背
      // 後腰與上背：兩團上下重疊，中間不會出現一道橫溝
      { key: 'lowerBack', y: mk.waistY, up: 0.7 * L, down: 0.4 * L, angle: Math.PI, width: 1.15, amp: sf.lowerBack, sag: 0.05, taper: 0 },
      { key: 'upperBack', y: mk.underbustY + 0.2 * H, up: 0.6 * H, down: 0.9 * H, angle: Math.PI, width: 1.3, amp: sf.upperBack, sag: 0.05, taper: 0 },
    ];
    const M = new Float32Array(n * 3);
    if (soft) p.surfaceRig.apply(out, sf, spread, male);
    for (let i = 0; i < n; i++) {
      const wBody = Math.min(1, p.w.torso[i] + p.w.legL[i] + p.w.legR[i]);
      const w = Math.max(wBody, p.wGen[i]);
      if (w < 0.01) continue;
      const x = B[i * 3], y = B[i * 3 + 1], z = B[i * 3 + 2];
      const theta = Math.atan2(x, z - p.torsoZ(y));
      // 全身那一層脂肪、軀幹的肌肉：均勻地沿表面往外
      let push = sf.general * p.wGen[i] * (male ? 1 : 1 - p.w.breast[i]) / Math.max(w, 1e-3) + (legacy ? sf.trunkMuscle * p.w.torso[i] / Math.max(w, 1e-3) : 0), drop = 0;
      for (const m of legacy ? masses : []) {
        if (!m.amp) continue;
        const uy = (y - m.y) / (y > m.y ? m.up : m.down);
        let dt = Math.abs(theta - m.angle);
        if (dt > Math.PI) dt = 2 * Math.PI - dt;
        const width = m.width * (1 - m.taper * smoothstep(0, 1, -uy));
        const u2 = uy * uy + (dt / width) ** 2;
        const ut = dt / width;
        if (Math.abs(uy) >= 1 || ut >= 1) continue;
        // 邊緣衰減：大的量體用更緩的邊，不會在交界處出現台階
        const radial = Math.pow(Math.max(0, 1 - u2), legacy ? 1.5 : 2);
        // 臀部把上下與環向的衰減逐漸分開，交接處也有支撐；其餘部位保持原形狀。
        const blend = m.key === 'buttock' || m.key === 'hipSide' ? spread : 0;
        const envelope = (1 - uy * uy) ** 2 * (1 - ut * ut) ** 2;
        const dome = (radial * (1 - blend) + envelope * blend) * (wBody / w);
        push += m.amp * dome;
        drop += m.amp * m.sag * dome * dome;
      }
      if (!push) continue;
      if (push < 0) drop = 0;
      M[i * 3] = w * push * p.normals[i * 3];
      M[i * 3 + 1] = w * (push * p.normals[i * 3 + 1] - drop);
      M[i * 3 + 2] = w * push * p.normals[i * 3 + 2];
    }
    smoothVectors(M, this.adj, 8);
    for (let i = 0; i < n * 3; i++) out[i] += M[i];

    // ── 整隻手臂跟著肩關節處的軀幹平移（肩寬、胸廓變寬時手臂往外移）
    for (const [ax, set] of [[p.arms[0], p.armSets.L], [p.arms[1], p.armSets.R]] as const) {
      const t = torsoDisp(ax.S[0], ax.S[1], ax.S[2]);
      for (const i of set) {
        out[i * 3] += t[0];
        out[i * 3 + 2] += t[2] * 0.5;
      }
    }

    // ── 胸部：以乳頭為中心、底座為邊界，沿表面法向量長出一個圓頂；越大越往下墜
    if (!male && soft) p.breastRig.apply(out, q.breast);
    if (legacy && ((!male && q.breast !== 0) || (male && sf.chest !== 0))) {
      const N = vertexNormals(out, a.quads, n);
      smoothVectors(N, this.adj, 8);
      // 男性的胸前脂肪用同一套：以乳頭為中心，範圍更寬、更扁
      const chestCm = male ? sf.chest : 0;
      for (const side of male && !chestCm ? [] : (['L', 'R'] as const)) {
        const rim = side === 'L' ? p.breastSets.rimL : p.breastSets.rimR;
        const apex = a.landmarks[side === 'L' ? 'bustApexL' : 'bustApexR'];
        const Ap = [out[apex * 3], out[apex * 3 + 1], out[apex * 3 + 2]];
        let Rb = 0;
        for (const i of rim) Rb += Math.hypot(out[i * 3] - Ap[0], out[i * 3 + 1] - Ap[1], out[i * 3 + 2] - Ap[2]) / rim.length;
        // 底座隨大小稍微擴大
        const Rr = male ? Rb * 2.3 : Rb * (1.1 + 0.15 * Math.min(2, q.breast));
        const amp = male ? chestCm : q.breast * Rb;
        if (!amp) continue;
        const shrink = amp < 0;
        for (let i = 0; i < n; i++) {
          const dx = out[i * 3] - Ap[0], dy = out[i * 3 + 1] - Ap[1], dz = out[i * 3 + 2] - Ap[2];
          if (dz < -Rr) continue;
          const dd = Math.hypot(dx, dy, dz);
          if (dd >= Rr) continue;
          const u = dd / Rr;
          let dome = Math.pow(1 - u * u, 1.6);
          if (male) {
            // 範圍大：越過正中線、靠近手臂、身體背面都平順淡出，不硬切
            const nl0 = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
            dome *= smoothstep(-1, 4, out[i * 3] * Math.sign(Ap[0])) * (1 - Math.min(1, p.w.armL[i] + p.w.armR[i])) * smoothstep(-0.1, 0.4, N[i * 3 + 2] / nl0);
          } else {
            // 只長在身體正面這一側（避免影響手臂內側）
            if (Math.sign(out[i * 3]) !== Math.sign(Ap[0]) && Math.abs(out[i * 3]) > 2) continue;
            if (p.w.armL[i] + p.w.armR[i] > 0.5) continue;
          }
          const nl = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
          out[i * 3] += (amp * dome * N[i * 3]) / nl;
          out[i * 3 + 1] += (amp * dome * N[i * 3 + 1]) / nl - (shrink ? 0 : (male ? 0.35 : 0.3) * amp * dome * dome);
          out[i * 3 + 2] += (amp * dome * N[i * 3 + 2]) / nl;
        }
      }
    }
  }

  /** 每一圈各自調整（割線法），直到網格上量到的數值等於目標；四肢長度在圍度調好後再校正一次 */
  fit(sex: Sex, t: RingTargets, opts: RingOptions): { P: Float32Array; values: Measured['values']; params: Params; iterations: number } {
    let p = this.prepare(sex, t, opts);
    const P = new Float32Array(p.B.length);
    const male = sex === 'male';
    // 胸部：女性是超出 MakeHuman 胸型的圓頂量（從 0 開始），男性是胸圍那一圈（從 1 開始）
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
        m = measure(this.ctx, P, p.levels);
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
          q[k] = Math.max(lo, Math.min(k === 'breast' && !male ? 5 : 3, q[k] + (0.9 * err) / slope));
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
    m = measure(this.ctx, P, p.levels);
    return { P, values: m.values, params: q, iterations: total };
  }

  /**
   * 依身體組成長出身體：骨架照連動建議（或手動值），脂肪與肌肉以公斤分到各區。
   * 手動填的軟組織圍度只調整負責它的那幾區（要變小到負的時改收那一圈），
   * 其餘的量照性別的預設比例分到沒填的部位；鎖定體重時，總脂肪量固定，多退少補都從沒填的部位來。
   */
  fitComposition(inp: CompositionInput, opts: RingOptions): CompositionResult {
    const { sex } = inp;
    const male = sex === 'male';
    const ref = REFERENCE[sex];
    const hip = inp.locked.hip ?? inp.preferred?.hip?.target ?? ref.girths.hip * inp.frame.height / ref.height;
    opts = { ...opts, shape: shapeCondition(sex, inp.frame.height, inp.shapeWeight ?? inp.weight,
      inp.shapeBodyFat ?? inp.bodyFat), hipExpansion: smoothstep(1.02, 1.43, (hip / inp.frame.height) / (ref.girths.hip / ref.height)) };
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
      setupFrame.thighLen, setupFrame.calfLen, male ? 0 : Math.round((f.bust ?? 0) - (f.underbust ?? 0))];
    const key = JSON.stringify([sex, opts.neutralize, opts.shape, ...frameVec]);
    let setup = this.setups.get(key);
    if (setup) {
      this.setups.delete(key); this.setups.set(key, setup);
    } else {
      const pp = this.prepare(sex, setupFrame, { ...opts, hipExpansion: 0 });
      // 素體的體重與每一區「一單位」有多重（體積 × 密度）
      this.build(pp, q, P, zeroSoft());
      const V0 = vol(P);
      const M0 = (V0 * bodyDensity(BASE_FAT[sex])) / 1000;
      const kgPer = zeroSoft();
      const response: GirthResponse = {};
      {
        const baseValues = measure(this.ctx, P, pp.levels).values;
        for (const k of SOFT_KEYS) {
          if (k === 'chest' && !male) continue;
          const unit = RING_SOFT.includes(k) ? 0.05 : 1;
          const s1 = zeroSoft();
          s1[k] = unit;
          this.build(pp, q, P, s1);
          kgPer[k] = ((vol(P) - V0) * (isMuscle(k) ? LEAN_DENSITY : FAT_DENSITY)) / 1000 / unit;
          const values = measure(this.ctx, P, pp.levels).values;
          response[k] = Object.fromEntries((Object.keys(values) as MeasureKey[]).map((g) => [g, (values[g] - baseValues[g]) / (unit * kgPer[k])]));
        }
      }
      setup = { sex, neutralize: opts.neutralize, frame: frameVec, p: pp, V0, M0, kgPer, response };
      if (this.setups.size > 6) this.setups.delete(this.setups.keys().next().value!);
      this.setups.set(key, setup);
    }
    let p = { ...setup.p, hipExpansion: opts.hipExpansion! };
    const { V0, M0 } = setup;
    let { kgPer, response: calibratedResponse } = setup;
    if (p.hipExpansion) {
      const shapeKey = JSON.stringify([key, p.hipExpansion]);
      let calibration = this.hipCalibrations.get(shapeKey);
      if (!calibration) {
        // 零量體的骨架不受承托範圍影響；只重新校準真的改形狀的臀後、臀側兩區。
        const kg = { ...kgPer }, response = { ...calibratedResponse };
        this.build(p, q, P, zeroSoft());
        const baseline = measure(this.ctx, P, p.levels).values;
        for (const k of ['buttock', 'hipSide'] as const) {
          this.build(p, q, P, { ...zeroSoft(), [k]: 1 });
          kg[k] = (vol(P) - V0) * FAT_DENSITY / 1000;
          const values = measure(this.ctx, P, p.levels).values;
          response[k] = Object.fromEntries((Object.keys(values) as MeasureKey[]).map((g) => [g, (values[g] - baseline[g]) / kg[k]]));
        }
        calibration = { kgPer: kg, response };
        if (this.hipCalibrations.size >= 14) this.hipCalibrations.delete(this.hipCalibrations.keys().next().value!);
        this.hipCalibrations.set(shapeKey, calibration);
      }
      kgPer = calibration.kgPer;
      calibratedResponse = calibration.response;
    }
    const baseFat = M0 * BASE_FAT[sex];

    // 預設分配：體重與體脂率換算出的脂肪、去脂體重，扣掉素體已有的，照比例分到各區
    const fatTarget = inp.weight * inp.bodyFat;
    const dFat = fatTarget - baseFat;
    const dLean = inp.weight * (1 - inp.bodyFat) - (M0 - baseFat);
    const norm = (sh: Partial<Record<SoftKey, number>>, keys?: SoftKey[]) => {
      const ks = (Object.keys(sh) as SoftKey[]).filter((k) => (!keys || keys.includes(k)) && kgPer[k]);
      const tot = ks.reduce((t, k) => t + sh[k]!, 0) || 1;
      return Object.fromEntries(ks.map((k) => [k, sh[k]! / tot])) as Partial<Record<SoftKey, number>>;
    };
    const fatShare = norm(dFat >= 0 ? FAT_SHARE[sex] : LOSS_SHARE);
    const kgDefault = zeroSoft();
    for (const [k, v] of Object.entries(fatShare) as [SoftKey, number][]) kgDefault[k] = dFat * v;
    for (const [k, v] of Object.entries(norm(LEAN_SHARE)) as [SoftKey, number][]) kgDefault[k] = dLean * v;

    // 手動填的軟組織圍度：女性的上胸圍由胸部部件負責（在骨架那邊），其餘各有負責的區
    const goals = (Object.keys(inp.locked) as SoftGoal[]).filter((g) => inp.locked[g] !== undefined && !(g === 'bust' && !male));
    const owned = new Set<SoftKey>();
    for (const g of goals) {
      for (const k of Object.keys(GROUPS[g]) as SoftKey[]) owned.add(k);
      const mk = MUSCLE_OF[g];
      if (mk) owned.add(mk);
    }
    const fatFrac = Math.min(0.85, Math.max(0.25, 2.2 * inp.bodyFat));
    /** 鎖定體重時的修正量：骨架調整、胸部等也會改變體重，用實際算出的體重回頭調整沒填部位的脂肪 */
    let restAdj = 0;
    /** 同時鎖定體重與體脂率時，去脂體重（肌肉）也要調整 */
    let leanAdj = 0;
    const extra = Object.fromEntries(goals.map((g) => [g, 0])) as Record<SoftGoal, number>;
    let bias = zeroSoft();
    // 骨架類：照連動建議（或手動值）對準
    const FRAME: ParamKey[] = ['underbust', 'shoulder', 'neck', 'wrist', 'ankle', ...(male ? [] : (['breast'] as ParamKey[]))];
    // 分配從同一個起點求解，避免接受步數受上一個體型影響；骨架與公斤校準仍使用快取。
    const shrinkKey: Record<SoftGoal, ParamKey> = { bust: 'breast', waist: 'waist', hip: 'hip', thigh: 'thigh', calf: 'calf', upperArm: 'upperArm' };

    const allocate = (): { soft: Soft; kg: Soft } => {
      const kg = { ...kgDefault };
      for (const g of goals) {
        const grp = GROUPS[g];
        const mk = MUSCLE_OF[g];
        const fatBase = (Object.keys(grp) as SoftKey[]).reduce((t, k) => t + kgDefault[k], 0);
        const fatTotal = fatBase + extra[g] * (mk ? fatFrac : 1);
        if (mk) kg[mk] = kgDefault[mk] + extra[g] * (1 - fatFrac);
        // 要比素體還小：脂肪歸零，改收那一圈
        q[shrinkKey[g]] = fatTotal < 0 ? Math.max(0.5, 1 + fatTotal * 0.02) : 1;
        for (const [k, r] of Object.entries(grp) as [SoftKey, number][]) kg[k] = Math.max(0, fatTotal) * r;
      }
      if (inp.weightLocked) {
        // 總脂肪量固定：剩下的量分到沒填的部位
        let used = 0;
        for (const k of owned) if (!isMuscle(k)) used += kg[k];
        const free = (Object.keys(fatShare) as SoftKey[]).filter((k) => !owned.has(k));
        const rest = dFat - used + restAdj;
        const sh = norm(rest >= 0 ? FAT_SHARE[sex] : LOSS_SHARE, free.length ? free : ['general']);
        for (const k of SOFT_KEYS) if (!owned.has(k) && !isMuscle(k)) kg[k] = 0;
        for (const [k, v] of Object.entries(sh) as [SoftKey, number][]) kg[k] = rest * v;
      } else if (restAdj) {
        // 只鎖定體脂率：沒填的部位多退少補，讓脂肪比例對上
        const free = (Object.keys(fatShare) as SoftKey[]).filter((k) => !owned.has(k));
        const sh = norm(restAdj >= 0 ? FAT_SHARE[sex] : LOSS_SHARE, free.length ? free : ['general']);
        for (const [k, v] of Object.entries(sh) as [SoftKey, number][]) kg[k] += restAdj * v;
      }
      if (leanAdj) for (const [k, v] of Object.entries(norm(LEAN_SHARE)) as [SoftKey, number][]) if (!owned.has(k)) kg[k] += leanAdj * v;
      for (const k of SOFT_KEYS) if (!owned.has(k)) kg[k] += bias[k];
      const soft = zeroSoft();
      for (const k of SOFT_KEYS) {
        if (!kgPer[k]) continue;
        const u = kg[k] / kgPer[k];
        // 變薄有下限（量體不會凹進去、圈不會縮太多）
        soft[k] = RING_SOFT.includes(k) ? Math.max(-0.25, u) : Math.max(k === 'general' ? -1.2 : -2, u);
      }
      return { soft, kg };
    };

    const t = inp.frame;
    const want = (k: ParamKey) => (k === 'breast' ? (t.bust !== undefined && t.underbust !== undefined ? t.bust - t.underbust : undefined) : t[k]);
    const read = (v: Measured['values'], k: ParamKey) => (k === 'breast' ? v.bust - v.underbust : v[k]);
    // 每公斤大約讓那一圈變粗幾公分（第一步用，之後用割線法）
    const GUESS: Record<SoftGoal, number> = { bust: 3, waist: 2.5, hip: 2, thigh: 4, calf: 6, upperArm: 8 };

    let evaluatedQ = { ...q };
    const buildActual = (sft: Soft) => {
      evaluatedQ = { ...q };
      this.build(p, evaluatedQ, P, sft);
    };
    const weightOf = (sft: Soft) => {
      // 尺寸控制必須和已量測的 P 相同；迭代剛提出的新 q 不得混入組成記帳。
      const lean = new Float32Array(P.length), leanOnly = zeroSoft();
      for (const k of SOFT_KEYS) if (isMuscle(k)) leanOnly[k] = sft[k];
      this.build(p, evaluatedQ, lean, leanOnly);
      if (!male && evaluatedQ.breast) p.breastRig.remove(lean, evaluatedQ.breast);
      // 固定採「去脂支撐 → 脂肪覆蓋」的加入順序；兩次實際體積的差包含交互，
      // 不假設 PCHIP 與混合曲面的體積為線性，也不把交互體積重複記入兩類。
      const leanV = vol(lean), fullV = vol(P);
      const fatKg = (fullV - leanV) * FAT_DENSITY / 1000;
      const leanKg = (leanV - V0) * LEAN_DENSITY / 1000;
      return { weight: M0 + fatKg + leanKg, fatKg };
    };
    let m = measure(this.ctx, p.B);
    let total = 0;
    let soft = zeroSoft();
    let prevW: [number, number] | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const preferred = inp.preferred ?? {};
      // 男性胸圍是軟偏好，不能讓未量測的上背代替胸前吸收補償；上背保留預設分配。
      const free = SOFT_KEYS.filter((k) => !owned.has(k) && !(male && k === 'upperBack') && kgPer[k]);
      type State = { q: Params; extra: Record<SoftGoal, number>; restAdj: number; leanAdj: number; bias: Soft };
      const save = (): State => ({ q: { ...q }, extra: { ...extra }, restAdj, leanAdj, bias: { ...bias } });
      const restore = (s: State) => { Object.assign(q, s.q); Object.assign(extra, s.extra); restAdj = s.restAdj; leanAdj = s.leanAdj; bias = { ...s.bias }; };
      let best: State | null = null, bestPenalty = Infinity, attempts = 0, stepScale = 0.8;
      let response: GirthResponse | null = null;
      const prevQ = new Map<ParamKey, [number, number]>();
      const prevX = new Map<SoftGoal, [number, number]>();
      for (let it = 0; it < 80; it++, total++) {
        soft = allocate().soft;
        buildActual(soft);
        m = measure(this.ctx, P, p.levels);
        let worst = 0;
        for (const k of FRAME) {
          const target = want(k);
          if (target === undefined) continue;
          const cur = read(m.values, k);
          const err = target - cur;
          worst = Math.max(worst, Math.abs(err));
          const guess = k === 'breast' ? 20 : cur / q[k];
          let slope = guess;
          const pr = prevQ.get(k);
          if (pr && Math.abs(q[k] - pr[0]) > 1e-6) {
            const sl = (cur - pr[1]) / (q[k] - pr[0]);
            if (Number.isFinite(sl) && sl > 0.2 * guess) slope = sl;
          }
          prevQ.set(k, [q[k], cur]);
          q[k] = Math.max(k === 'breast' ? -0.6 : 0.4, Math.min(k === 'breast' ? 5 : 3, q[k] + (0.9 * err) / slope));
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
        if (inp.bodyFatLocked) {
          // 體脂率固定：直接算出脂肪與去脂體重各差多少，分別補到沒填的部位
          const { weight: w, fatKg } = weightOf(soft);
          const fat = baseFat + fatKg;
          if (inp.weightLocked) {
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
        } else if (inp.weightLocked) {
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
        if (worst < 0.15 || seekFeasible) {
          const candidatePreferred = { ...preferred };
          for (const g of blockedGoals) candidatePreferred[g] = { target: inp.locked[g]!, scale: 0.015, confidence: 4 };
          const penalty = distributionPenalty(m.values, preferred) + 0.01 * SOFT_KEYS.reduce((s, k) => s + bias[k] ** 2, 0);
          if (worst < 0.15 && penalty < bestPenalty - 1e-4) { best = save(); bestPenalty = penalty; }
          else if (best && !seekFeasible) { restore(best); stepScale *= 0.4; }
          if (!Object.keys(candidatePreferred).length || attempts++ >= 10 || it >= 56 || stepScale < 0.08 || bestPenalty < 0.03) break;
          if (best) {
            // 使用與保存狀態一致的量測提出候選，不能沿用剛被退回的身體。
            soft = allocate().soft; buildActual(soft); m = measure(this.ctx, P, p.levels);
          }
          if (!response) {
            // 在目前體型量小步響應；瘦素體上的斜率無法代表大腹部與大臀的交互影響。
            response = { ...calibratedResponse };
            const probeP = new Float32Array(P.length);
            // 軀幹圓頂會跨到臀圍切面，需在當前體型重新量測；肢體響應沿用骨架校準。
            const coupled: SoftKey[] = [...SOFT_KEYS];
            for (const k of free.filter((k) => coupled.includes(k))) {
              const probe = { ...soft, [k]: soft[k] + 0.15 / kgPer[k] };
              this.build(p, q, probeP, probe);
              const v = measure(this.ctx, probeP, p.levels).values;
              response[k] = Object.fromEntries((Object.keys(v) as MeasureKey[]).map((g) => [g, (v[g] - m.values[g]) / 0.15]));
            }
          }
          const capacity = zeroSoft();
          for (const k of free) {
            const floor = (RING_SOFT.includes(k) ? -0.25 : k === 'general' ? -1.2 : -2) * kgPer[k];
            capacity[k] = Math.max(0, soft[k] * kgPer[k] - floor);
          }
          let active = [...free];
          let step = zeroSoft();
          for (let activePass = 0; activePass < free.length; activePass++) {
            step = redistributionStep(active, response, m.values, candidatePreferred,
              [...goals, ...FRAME.filter((k) => k !== 'breast') as MeasureKey[]], bias, capacity);
            const blocked = active.filter((k) => step[k] < 0 && capacity[k] < 0.01);
            if (!blocked.length) break;
            active = active.filter((k) => !blocked.includes(k));
          }
          const largest = Math.max(...SOFT_KEYS.map((k) => Math.abs(step[k])), 1e-9);
          let scale = Math.min(stepScale, Math.max(0.5, inp.weight * 0.02) / largest);
          for (const k of free) {
            if (step[k] < 0) scale = Math.min(scale, capacity[k] / -step[k]);
          }
          if (largest * scale < 0.015) break;
          for (const k of free) bias[k] += step[k] * scale;
          prevQ.clear(); prevX.clear(); prevW = null;
        }
      }
      if (best) {
        restore(best);
        soft = allocate().soft;
        buildActual(soft);
        m = measure(this.ctx, P, p.levels);
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
    const { kg } = allocate();
    soft = allocate().soft;
    buildActual(soft);
    m = measure(this.ctx, P, p.levels);

    // 體重：素體 + 各區脂肪（實際用到的量）+ 其餘增加的體積當作去脂組織
    const { weight, fatKg } = weightOf(soft);
    return { P, measured: m, values: m.values, weight, bodyFat: (baseFat + fatKg) / weight, kg, iterations: total,
      tissueMass: { fat: baseFat + fatKg, lean: weight - baseFat - fatKg } };
  }
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

/** 一團軟組織：中心高度與角度（0 = 正前方，π = 正後方），上下與左右的範圍，厚度（cm）與下墜比例 */
interface Mass {
  key: SoftKey;
  y: number;
  up: number;
  down: number;
  angle: number;
  width: number;
  amp: number;
  sag: number;
  /** 往下緣變窄的比例 */
  taper: number;
}

function smoothVectors(F: Float32Array, adj: number[][], iterations: number): void {
  const tmp = new Float32Array(F.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < adj.length; i++) {
      let x = F[i * 3], y = F[i * 3 + 1], z = F[i * 3 + 2];
      for (const j of adj[i]) {
        x += F[j * 3];
        y += F[j * 3 + 1];
        z += F[j * 3 + 2];
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
