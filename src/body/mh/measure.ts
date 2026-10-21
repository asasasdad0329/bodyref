import type { BodyAsset } from './asset';
import {
  type Plane,
  type Tape,
  type V3,
  centroid,
  cross,
  dist,
  horizontal,
  lerp3,
  norm,
  pickLoop,
  project,
  hull2,
  slice,
  sub,
  tape,
  vert,
} from './geometry';

// 在人體網格上量尺寸。圍度是用平面切出截面後的凸包周長（拉緊的布尺），
// 位置由關節與標記點決定；「最細處」「最粗處」這類定義會在一段範圍內搜尋。
// 長度在網格上直接量關節與標記點之間的距離。

export type MeasureKey =
  | 'height' | 'neck' | 'bust' | 'underbust' | 'waist' | 'hip' | 'upperArm' | 'wrist'
  | 'thigh' | 'calf' | 'ankle' | 'shoulder' | 'upperArmLen' | 'forearmLen' | 'thighLen' | 'calfLen';

export const MEASURE_KEYS: readonly MeasureKey[] = [
  'height', 'neck', 'bust', 'underbust', 'waist', 'hip', 'upperArm', 'wrist',
  'thigh', 'calf', 'ankle', 'shoulder', 'upperArmLen', 'forearmLen', 'thighLen', 'calfLen',
];

type SearchKey = 'neck' | 'waist' | 'hip' | 'upperArm' | 'wrist' | 'thigh' | 'calf' | 'ankle';

/** 搜尋型量測的範圍（相對位置）與找最大或最小 */
const SEARCH: Record<SearchKey, { from: number; to: number; steps: number; mode: 'min' | 'max' }> = {
  neck: { from: 0.15, to: 0.45, steps: 5, mode: 'min' },
  waist: { from: 0.42, to: 0.85, steps: 10, mode: 'min' },
  hip: { from: 0.2, to: 0.46, steps: 7, mode: 'max' },
  upperArm: { from: 0.5, to: 0.5, steps: 1, mode: 'max' },
  wrist: { from: 0.93, to: 0.93, steps: 1, mode: 'min' },
  thigh: { from: 0.1, to: 0.1, steps: 1, mode: 'max' },
  calf: { from: 0.12, to: 0.55, steps: 8, mode: 'max' },
  ankle: { from: 0.06, to: 0.28, steps: 6, mode: 'min' },
};

/** 搜尋到的相對位置；固定下來後可以快速重量（求解時用） */
export type Levels = Record<SearchKey, number>;

export interface Measured {
  values: Record<MeasureKey, number>;
  tapes: Partial<Record<MeasureKey, V3[]>>;
  /** 長度量測的端點 */
  segments: Partial<Record<MeasureKey, [V3, V3]>>;
  levels: Levels;
  /** 來源量法與使用者最細腰／服裝肩寬分開，不能當成同一個量。 */
  sources: { navelWaist: { value: number; path: V3[] }; shoulderBone: number; relaxedArmMid: number; surfaceUnderbust: number };
  /** 給顯示與結構線用的高度 */
  marks: { soleY: number; topY: number; crotchY: number; waistY: number; hipY: number; underbustY: number; bustY: number; kneeY: number; ankleY: number };
}

const REGION_SETS = {
  trunk: ['torso', 'breastL', 'breastR', 'thighL', 'thighR'],
  trunkNoBreast: ['torso', 'thighL', 'thighR'],
  thighL: ['thighL', 'torso'],
  calfL: ['calfL', 'thighL', 'footL'],
  armL: ['shoulderL', 'upperarmL', 'forearmL'],
  wristL: ['forearmL', 'handL'],
  neck: ['neck', 'torso', 'head', 'face'],
  shoulders: ['torso', 'neck', 'shoulderL', 'shoulderR', 'upperarmL', 'upperarmR'],
} as const;

export type FaceSets = Record<keyof typeof REGION_SETS, Uint32Array>;

export function buildFaceSets(a: BodyAsset): FaceSets {
  const out = {} as FaceSets;
  // 自由乳房不能只依「最大骨權重」分區：原生杯型目標揭示下極也落在 torso。
  // 只加入明顯投影的自由表面，不把整份杯型目標的胸壁／上胸支撐全部刪除。
  const freeBreast = new Set<number>();
  const cup = a.targets.get('female-young-averagemuscle-averageweight-maxcup-averagefirmness');
  if (cup) for (let k = 0; k < cup.indices.length; k++) {
    if (cup.deltas[k * 3 + 2] * a.deltaStep > 0.3) freeBreast.add(cup.indices[k]);
  }
  for (const [key, names] of Object.entries(REGION_SETS)) {
    const allowed = new Set(names.map((r) => a.regions.indexOf(r)));
    const faces: number[] = [];
    for (let f = 0; f < a.quads.length / 4; f++) {
      let all = true, any = false;
      for (let k = 0; k < 4; k++) {
        const vertex = a.quads[f * 4 + k];
        const inside = allowed.has(a.region[vertex]) && !(key === 'trunkNoBreast' && freeBreast.has(vertex));
        all &&= inside;
        any ||= inside;
      }
      // 不含胸部的集合要求整個面都在允許的部位內，其他集合只要碰到就算
      if (key === 'trunkNoBreast' ? all : any) faces.push(f);
    }
    out[key as keyof FaceSets] = Uint32Array.from(faces);
  }
  return out;
}

/** 胯下候選頂點：身體正中附近、骨盆以下 */
export function crotchCandidates(a: BodyAsset): Uint32Array {
  const P = a.base;
  const [ps, pc] = a.joints['pelvis'];
  const pelvis = centroid(P, ps, pc);
  const ids: number[] = [];
  for (let i = 0; i < a.nBody; i++) {
    if (Math.abs(P[i * 3]) < 0.6 && P[i * 3 + 1] < pelvis[1]) ids.push(i);
  }
  return Uint32Array.from(ids);
}

/** 臀部候選頂點：骨盆後方、左右臀峰附近。最往後凸的那一點決定臀圍高度 */
export function buttockCandidates(a: BodyAsset): Uint32Array {
  const P = a.base;
  const [ps, pc] = a.joints['pelvis'];
  const pelvis = centroid(P, ps, pc);
  const ids: number[] = [];
  for (let i = 0; i < a.nBody; i++) {
    const x = Math.abs(P[i * 3]), y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (x > 2 && x < 13 && z < pelvis[2] - 4 && y < pelvis[1] + 6 && y > pelvis[1] - 16) ids.push(i);
  }
  return Uint32Array.from(ids);
}

export interface MeasureContext {
  asset: BodyAsset;
  faces: FaceSets;
  crotch: Uint32Array;
  buttock: Uint32Array;
}

export function measureContext(a: BodyAsset): MeasureContext {
  return { asset: a, faces: buildFaceSets(a), crotch: crotchCandidates(a), buttock: buttockCandidates(a) };
}

export function measure(ctx: MeasureContext, P: Float32Array, fixed?: Levels, search: readonly SearchKey[] = [], chestWall?: Float32Array): Measured {
  const a = ctx.asset;
  const J = (name: string): V3 => centroid(P, a.joints[name][0], a.joints[name][1]);
  const L = (name: string): V3 => vert(P, a.landmarks[name]);

  let soleY = Infinity, topY = -Infinity;
  for (let i = 0; i < a.nBody; i++) {
    const y = P[i * 3 + 1];
    if (y < soleY) soleY = y;
    if (y > topY) topY = y;
  }
  let crotchY = Infinity;
  for (const i of ctx.crotch) crotchY = Math.min(crotchY, P[i * 3 + 1]);

  const knee = J('l-knee'), ankle = J('l-ankle'), hipJ = J('l-upper-leg');
  const shoulderJ = J('l-shoulder'), elbow = J('l-elbow'), wristJ = J('l-hand');
  const neckJ = J('neck'), headJ = J('head');
  const bustY = (L('bustApexL')[1] + L('bustApexR')[1]) / 2;
  const underbustY = chestWall ? (chestWall[a.landmarks.underbustL * 3 + 1] + chestWall[a.landmarks.underbustR * 3 + 1]) / 2
    : (L('underbustL')[1] + L('underbustR')[1]) / 2;

  const values = {} as Record<MeasureKey, number>;
  const tapes: Measured['tapes'] = {};
  const levels = {} as Levels;

  const girth = (faces: Uint32Array, plane: Plane, ref: V3): Tape | null => {
    const loop = pickLoop(slice(P, a.quads, faces, plane), plane, ref);
    return loop && loop.length > 2 ? tape(loop, plane) : null;
  };
  // 軀幹：面集合已排除手臂，把所有截面段合在一起取凸包（排除胸部時，布尺會從胸下直接跨過）
  const trunkGirth = (faces: Uint32Array, y: number, surface = P): Tape | null => {
    const plane = horizontal(y);
    const pts = slice(surface, a.quads, faces, plane).flat();
    return pts.length > 2 ? tape(pts, plane) : null;
  };

  // 每個搜尋型量測：依相對位置 t 產生平面與參考點
  const planes: Record<SearchKey, (t: number) => { faces: Uint32Array; plane: Plane; ref: V3; union?: boolean }> = {
    hip: (t) => {
      const y = crotchY + (underbustY - crotchY) * t;
      return { faces: ctx.faces.trunk, plane: horizontal(y), ref: [0, y, 0], union: true };
    },
    neck: (t) => {
      const p = lerp3(neckJ, headJ, t);
      return { faces: ctx.faces.neck, plane: { p, n: norm(sub(headJ, neckJ)) }, ref: p };
    },
    waist: (t) => {
      const y = crotchY + (underbustY - crotchY) * t;
      return { faces: ctx.faces.trunkNoBreast, plane: horizontal(y), ref: [0, y, 0], union: true };
    },
    upperArm: (t) => {
      const p = lerp3(shoulderJ, elbow, t);
      return { faces: ctx.faces.armL, plane: { p, n: norm(sub(elbow, shoulderJ)) }, ref: p };
    },
    wrist: (t) => {
      const p = lerp3(elbow, wristJ, t);
      return { faces: ctx.faces.wristL, plane: { p, n: norm(sub(wristJ, elbow)) }, ref: p };
    },
    thigh: (t) => {
      const y = crotchY - (crotchY - knee[1]) * t;
      const c = lerp3(hipJ, knee, (hipJ[1] - y) / (hipJ[1] - knee[1]));
      return { faces: ctx.faces.thighL, plane: horizontal(y), ref: c };
    },
    calf: (t) => {
      const y = knee[1] - (knee[1] - ankle[1]) * t;
      return { faces: ctx.faces.calfL, plane: horizontal(y), ref: lerp3(knee, ankle, t) };
    },
    ankle: (t) => {
      const y = ankle[1] + (knee[1] - ankle[1]) * t;
      return { faces: ctx.faces.calfL, plane: horizontal(y), ref: lerp3(ankle, knee, t) };
    },
  };

  for (const key of Object.keys(SEARCH) as SearchKey[]) {
    const s = SEARCH[key];
    const searchKey = !fixed || search.includes(key);
    const ts = !searchKey ? [fixed![key]] : Array.from({ length: s.steps }, (_, i) => s.from + ((s.to - s.from) * i) / Math.max(1, s.steps - 1));
    let best: Tape | null = null;
    let bestT = ts[0];
    for (const t of ts) {
      const { faces, plane, ref, union } = planes[key](t);
      const g = union ? trunkGirth(faces, plane.p[1]) : girth(faces, plane, ref);
      if (!g) continue;
      if (!best || (s.mode === 'min' ? g.length < best.length : g.length > best.length)) {
        best = g;
        bestT = t;
      }
    }
    // 搜尋時在最佳位置附近再細找一次
    if (searchKey && best && s.steps > 1) {
      const step = (s.to - s.from) / (s.steps - 1);
      for (const t of [bestT - step / 2, bestT + step / 2]) {
        if (t < s.from - step / 2 || t > s.to + step / 2) continue;
        const { faces, plane, ref, union } = planes[key](t);
        const g = union ? trunkGirth(faces, plane.p[1]) : girth(faces, plane, ref);
        if (g && (s.mode === 'min' ? g.length < best.length : g.length > best.length)) {
          best = g;
          bestT = t;
        }
      }
    }
    levels[key] = bestT;
    values[key] = best?.length ?? NaN;
    if (best) tapes[key] = best.path;
  }

  // 臀圍量臀區最大的水平皮尺；不以單一最凸頂點的高度代表整圈，
  // 否則兩個相近臀峰交換前後順序時，量測會突然跳幾公分。
  const hipY = crotchY + (underbustY - crotchY) * levels.hip;

  const bust = trunkGirth(ctx.faces.trunk, bustY);
  values.bust = bust?.length ?? NaN;
  if (bust) tapes.bust = bust.path;
  // 垂墜乳房遮住胸壁時，皮尺走同一框架的胸壁參照；不拿自由下極湊下胸。
  // 參照也經相同中性平滑，讀值獨立計算，並非回傳目標。
  const ub = trunkGirth(ctx.faces.trunkNoBreast, underbustY, chestWall);
  values.underbust = ub?.length ?? NaN;
  if (ub) tapes.underbust = ub.path;

  // 肩寬：經過兩側肩點與後頸點的平面，沿背部的布尺長度
  const aL = L('acromionL'), aR = L('acromionR'), nape = L('nape');
  const sPlane: Plane = { p: nape, n: norm(cross(sub(aL, nape), sub(aR, nape))) };
  const arc = shoulderArc(pickLoop(slice(P, a.quads, ctx.faces.shoulders, sPlane), sPlane, nape), sPlane, aL, aR, nape);
  values.shoulder = arc.length;
  tapes.shoulder = arc.path;

  values.height = topY - soleY;
  values.upperArmLen = dist(L('acromionL'), elbow);
  values.forearmLen = dist(elbow, wristJ);
  values.thighLen = crotchY - knee[1];
  values.calfLen = knee[1] - ankle[1];

  const segments: Measured['segments'] = {
    upperArmLen: [L('acromionL'), elbow],
    forearmLen: [elbow, wristJ],
  };
  const waistY = crotchY + (underbustY - crotchY) * levels.waist;
  // 自有拓撲標記：4121 位於原 CC0 網格的肚臍凹點，不依身高乘固定比例猜高度。
  const navel = trunkGirth(ctx.faces.trunkNoBreast, P[4121 * 3 + 1]);
  return {
    values,
    tapes,
    segments,
    levels,
    sources: { navelWaist: { value: navel?.length ?? NaN, path: navel?.path ?? [] }, shoulderBone: dist(aL, aR), relaxedArmMid: values.upperArm,
      surfaceUnderbust: trunkGirth(ctx.faces.trunk, underbustY)?.length ?? NaN },
    marks: { soleY, topY, crotchY, waistY, hipY, underbustY, bustY, kneeY: knee[1], ankleY: ankle[1] },
  };
}

/** 從肩部截面的凸包上，取兩個肩點之間經過後頸的那一段 */
function shoulderArc(loop: V3[] | null, plane: Plane, aL: V3, aR: V3, nape: V3): { length: number; path: V3[] } {
  if (!loop) return { length: dist(aL, aR), path: [aL, aR] };
  const uv = project(loop, plane);
  const h = hull2(uv);
  const [pa, pb, pn] = project([aL, aR, nape], plane);
  const nearest = (q: [number, number]) => {
    let best = 0, bd = Infinity;
    h.forEach((i, k) => {
      const d = Math.hypot(uv[i][0] - q[0], uv[i][1] - q[1]);
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    return best;
  };
  const ia = nearest(pa), ib = nearest(pb), inape = nearest(pn);
  const walk = (dir: 1 | -1) => {
    const ks: number[] = [];
    for (let k = ia; ; k = (k + dir + h.length) % h.length) {
      ks.push(k);
      if (k === ib || ks.length > h.length) break;
    }
    return ks;
  };
  const fwd = walk(1);
  const ks = fwd.includes(inape) ? fwd : walk(-1);
  const pts: [number, number][] = [pa, ...ks.map((k) => uv[h[k]]), pb];
  let length = 0;
  for (let k = 1; k < pts.length; k++) length += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return { length, path: [aL, ...ks.map((k) => loop[h[k]]), aR] };
}

