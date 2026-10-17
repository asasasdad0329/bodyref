import type { Sex } from '../../core/measurements';
import type { BodyAsset } from './asset';
import { centroid, smoothField, vert } from './geometry';

// 身體組成：脂肪與肌肉分區。
//
// 脂肪：把皮下脂肪分成幾個常見的堆積區（腹部、腰側、臀、大腿……），
// 每一區是一張平滑的權重圖。增加某區的脂肪，就是讓那一區的皮膚沿著法向量往外長一層，
// 厚度 = 脂肪體積 ÷ 該區面積，所以厚度是脂肪自己帶出來的（腹部的權重集中在正前方，肚子會往前凸）。
// 肌肉：分成手臂、軀幹、腿三段，各自混合 MakeHuman 的肌肉形變目標（與 InBody 的分段方式相同）。

export const DEPOTS = [
  'general', 'abdomen', 'flank', 'lowerBack', 'upperBack', 'buttock', 'hipSide',
  'thigh', 'upperArm', 'breast', 'calf', 'forearm', 'neck',
] as const;
export type Depot = (typeof DEPOTS)[number];

export const SEGMENTS = ['arms', 'trunk', 'legs'] as const;
export type Segment = (typeof SEGMENTS)[number];

/**
 * 體脂增加時，新增的皮下脂肪分到各區的比例（總和為 1）。
 * 依男女脂肪分佈差異的一般印象：女性偏臀、大腿、下腹、胸；男性偏腹部、腰側、胸、背。
 */
export const DEFAULT_SHARE: Record<Sex, Record<Depot, number>> = {
  female: {
    general: 0.36, abdomen: 0.14, flank: 0.08, lowerBack: 0.04, upperBack: 0.04, buttock: 0.07, hipSide: 0.05,
    thigh: 0.1, upperArm: 0.05, breast: 0.06, calf: 0.01, forearm: 0, neck: 0,
  },
  male: {
    general: 0.42, abdomen: 0.2, flank: 0.12, lowerBack: 0.06, upperBack: 0.05, buttock: 0.02, hipSide: 0,
    thigh: 0.04, upperArm: 0.02, breast: 0.07, calf: 0, forearm: 0, neck: 0,
  },
};

/** 內臟脂肪占總脂肪的比例：會把腹壁往前推，算在腹部那一區 */
export const VISCERAL_SHARE: Record<Sex, number> = { female: 0.05, male: 0.1 };

export interface CompositionMaps {
  depot: Record<Depot, Float32Array>;
  /** 每一區「每 1 cm 厚度」的位移場（已抹平，x, y, z 連續），脂肪位移 = Σ 厚度 × 位移場 */
  field: Record<Depot, Float32Array>;
  /** 每一區的有效面積（cm²），用來把脂肪體積換算成厚度 */
  area: Record<Depot, number>;
  segment: Record<Segment, Float32Array>;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ramp = (v: number, lo: number, hi: number) => clamp01((v - lo) / (hi - lo));
/** 鐘形：在 center 為 1，離開 half 以外為 0 */
const bell = (v: number, center: number, half: number) => {
  const t = Math.abs(v - center) / half;
  return t >= 1 ? 0 : (1 - t * t) ** 2;
};

export interface Levels {
  crotchY: number;
  hipY: number;
  underbustY: number;
  kneeY: number;
  ankleY: number;
}

/**
 * 依瘦的基礎身體（P 與法向量 N）建立各區權重圖。
 * 只需要在載入時、每個性別算一次。
 */
export function buildMaps(a: BodyAsset, sex: Sex, P: Float32Array, N0: Float32Array, areas: Float32Array, adj: number[][], lv: Levels): CompositionMaps {
  // 推出的方向用抹平過的法向量，避免在乳頭、肚臍、鼠蹊這些細節處折出皺褶
  const N = smoothNormals(N0, adj, 25);
  const n = a.nBody;
  const R = (name: string) => a.regions.indexOf(name);
  const torso = R('torso'), breastL = R('breastL'), breastR = R('breastR'), neck = R('neck');
  const thigh = new Set([R('thighL'), R('thighR')]);
  const calf = new Set([R('calfL'), R('calfR')]);
  const upperarm = new Set([R('upperarmL'), R('upperarmR')]);
  const shoulder = new Set([R('shoulderL'), R('shoulderR')]);
  const forearm = new Set([R('forearmL'), R('forearmR')]);
  const hand = new Set([R('handL'), R('handR')]);
  const foot = new Set([R('footL'), R('footR')]);
  const head = new Set([R('head'), R('face')]);
  const acrY = (vert(P, a.landmarks.acromionL)[1] + vert(P, a.landmarks.acromionR)[1]) / 2;
  const L = lv.underbustY - lv.crotchY;
  const elbowY = centroid(P, ...a.joints['l-elbow'])[1];
  const shoulderJY = centroid(P, ...a.joints['l-shoulder'])[1];

  const depot = Object.fromEntries(DEPOTS.map((d) => [d, new Float32Array(n)])) as Record<Depot, Float32Array>;
  for (let i = 0; i < n; i++) {
    const r = a.region[i];
    if (head.has(r) || hand.has(r) || foot.has(r)) continue;
    const x = P[i * 3], y = P[i * 3 + 1];
    const nx = N[i * 3], nz = N[i * 3 + 2];
    const outward = nx * Math.sign(x || 1);
    const front = ramp(nz, 0.1, 0.7);
    const back = ramp(-nz, 0.1, 0.7);
    const side = ramp(Math.abs(nx), 0.35, 0.85);
    const isTorso = r === torso;
    const isBreast = r === breastL || r === breastR;

    // 全身均勻的一層：小腿、前臂較薄
    depot.general[i] = calf.has(r) || forearm.has(r) ? 0.5 : r === neck ? 0.6 : 1;
    if (isTorso) {
      // 女性的腹部脂肪偏下腹；男性集中在肚臍附近、往腰側擴散（內臟脂肪把整個腹壁往前推）
      const male = sex === 'male';
      const belly = male ? ramp(nz, -0.2, 0.6) : front;
      depot.abdomen[i] = belly * bell(y, lv.crotchY + (male ? 0.5 : 0.38) * L, (male ? 0.38 : 0.42) * L);
      depot.flank[i] = side * bell(y, lv.crotchY + 0.58 * L, 0.3 * L);
      depot.lowerBack[i] = back * bell(y, lv.crotchY + 0.58 * L, 0.32 * L);
    }
    if (isTorso || shoulder.has(r)) depot.upperBack[i] = back * bell(y, (lv.underbustY + acrY) / 2, 0.55 * (acrY - lv.underbustY));
    if (isTorso || thigh.has(r)) {
      depot.buttock[i] = back * bell(y, lv.hipY - 0.02 * L, 0.24 * L);
      depot.hipSide[i] = ramp(outward, 0.3, 0.8) * bell(y, lv.crotchY - 0.02 * L, 0.3 * L);
    }
    if (thigh.has(r)) {
      const t = (y - lv.kneeY) / (lv.crotchY - lv.kneeY);
      const inner = ramp(-outward, 0, 0.8);
      depot.thigh[i] = ramp(t, 0.12, 0.65) * (0.65 + 0.35 * inner);
    }
    if (upperarm.has(r) || shoulder.has(r)) {
      const t = (y - elbowY) / (shoulderJY - elbowY);
      depot.upperArm[i] = ramp(t, 0.05, 0.4) * (1 - ramp(t, 0.85, 1.1)) * (0.45 + 0.55 * back);
    }
    if (isBreast) depot.breast[i] = 1;
    else if (isTorso) depot.breast[i] = front * bell(y, (lv.underbustY + acrY) / 2 - 0.05 * L, 0.35 * (acrY - lv.underbustY)) * 0.6;
    if (calf.has(r)) {
      const t = (lv.kneeY - y) / (lv.kneeY - lv.ankleY);
      depot.calf[i] = bell(t, 0.32, 0.45) * (0.6 + 0.4 * back);
    }
    if (forearm.has(r)) depot.forearm[i] = 0.6;
    if (r === neck) depot.neck[i] = 0.4 + 0.6 * back;
  }
  const field = {} as Record<Depot, Float32Array>;
  const area = {} as Record<Depot, number>;
  for (const d of DEPOTS) {
    smoothField(depot[d], adj, 25);
    clearTips(depot[d], a, head, hand, foot);
    const w = depot[d];
    const F = new Float32Array(n * 3);
    let A = 0;
    for (let i = 0; i < n; i++) {
      F[i * 3] = N[i * 3] * w[i];
      F[i * 3 + 1] = N[i * 3 + 1] * w[i];
      F[i * 3 + 2] = N[i * 3 + 2] * w[i];
      A += w[i] * areas[i];
    }
    smoothVectors(F, adj, 12);
    field[d] = F;
    area[d] = A;
  }

  // 肌肉分段：依部位區分，再把交界抹平
  const segment = Object.fromEntries(SEGMENTS.map((s) => [s, new Float32Array(n)])) as Record<Segment, Float32Array>;
  for (let i = 0; i < n; i++) {
    const r = a.region[i];
    if (upperarm.has(r) || forearm.has(r) || hand.has(r)) segment.arms[i] = 1;
    else if (shoulder.has(r)) segment.arms[i] = 0.5;
    if (thigh.has(r) || calf.has(r) || foot.has(r)) segment.legs[i] = 1;
  }
  smoothField(segment.arms, adj, 8);
  smoothField(segment.legs, adj, 8);
  for (let i = 0; i < n; i++) segment.trunk[i] = Math.max(0, 1 - segment.arms[i] - segment.legs[i]);
  return { depot, field, area, segment };
}

function smoothNormals(N0: Float32Array, adj: number[][], iterations: number): Float32Array {
  const N = new Float32Array(N0);
  smoothVectors(N, adj, iterations);
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l;
    N[i + 1] /= l;
    N[i + 2] /= l;
  }
  return N;
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

/** 頭、手、腳不長脂肪（平滑後滲進去的權重歸零） */
function clearTips(F: Float32Array, a: BodyAsset, ...sets: Set<number>[]): void {
  for (let i = 0; i < F.length; i++) {
    if (sets.some((s) => s.has(a.region[i]))) F[i] = 0;
  }
}
