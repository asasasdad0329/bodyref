import type { Sex } from '../../core/measurements';
import { type BodyAsset, addTarget } from './asset';
import { adjacency, smoothField, vertexNormals } from './geometry';
import { type MeasureContext, type Measured, measure, measureContext } from './measure';

// 原型：環切面 + 曲線連接（軀幹、骨盆、大腿、胸部）。
//
// 身體看成一圈一圈的水平切面。下胸、腰、臀、大腿這些「關鍵圈」各有一個大小參數，
// 每一圈怎麼變大變小（往側面、往前、往後各多少）由該部位的模組決定；
// 圈與圈之間用不會過衝的平滑曲線（單調三次插值）連起來，所以改一圈只會平順地帶動相鄰的一段。
// 胸部是獨立的部件：以胸壁上的底座為中心往外放大，越大越自然下垂。

export interface RingTargets {
  height: number;
  bust: number;
  underbust: number;
  waist: number;
  hip: number;
  thigh: number;
}

export interface RingOptions {
  /** 先把素體骨盆一帶雕得很明顯的細節（胯骨、鼠蹊折線、大腿外側鼓起）抹順 */
  neutralize: boolean;
}

/** 三個方向的縮放：側面、正前、正後 */
interface Aniso {
  side: number;
  front: number;
  back: number;
}

/** 部位模組：圍度變化量 d（= 參數 − 1）怎麼分到三個方向 */
const MODULES: Record<'underbust' | 'waist' | 'hip' | 'thigh', (d: number) => Aniso> = {
  // 胸廓：均勻
  underbust: (d) => ({ side: 1 + d, front: 1 + d, back: 1 + d }),
  // 腰：變細時主要收側面、保留厚度；變粗時肚子往前、腰側往外
  // 腰：變細時幾乎只收側面（腰窩），前面的肚子與後腰只收一點；變粗時肚子往前、腰側往外
  waist: (d) => (d < 0 ? { side: 1 + 1.5 * d, front: 1 + 0.25 * d, back: 1 + 0.4 * d } : { side: 1 + 1.0 * d, front: 1 + 1.2 * d, back: 1 + 0.6 * d }),
  // 臀：往後（臀部）與側面長，前面少
  hip: (d) => ({ side: 1 + 1.2 * d, front: 1 + 0.5 * d, back: 1 + 1.05 * d }),
  // 大腿（局部座標：side = 外側，front/back 同上；內側另外處理）
  thigh: (d) => ({ side: 1 + 1.0 * d, front: 1 + 0.8 * d, back: 1 + 1.0 * d }),
};

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

interface Params {
  ub: number;
  waist: number;
  hip: number;
  thigh: number;
  breast: number;
}

interface Prepared {
  B: Float32Array;
  marks: Measured['marks'];
  acromionY: number;
  /** 軀幹每公分高度的前後中心 z */
  torsoZ: (y: number) => number;
  /** 左大腿每公分高度的中心 (x, z) */
  thighC: (y: number) => [number, number];
  wTorso: Float32Array;
  wThighL: Float32Array;
  wThighR: Float32Array;
  wBreast: Float32Array;
  breastSets: { L: Uint32Array; R: Uint32Array; rimL: Uint32Array; rimR: Uint32Array };
  armSet: Uint32Array;
}

export class RingBody {
  readonly ctx: MeasureContext;
  readonly adj: number[][];

  constructor(readonly asset: BodyAsset) {
    this.ctx = measureContext(asset);
    this.adj = adjacency(asset.quads, asset.nBody);
  }

  private region(name: string): number {
    return this.asset.regions.indexOf(name);
  }

  private prepare(sex: Sex, height: number, opts: RingOptions, cupDiff: number): Prepared {
    const a = this.asset;
    const n = a.nBody;
    const B = new Float32Array(a.base);
    addTarget(a, `asian-${sex}-young`, 1, B);
    addTarget(a, 'nipple-size-decr', 1, B);
    // 胸部底稿：先用 MakeHuman 的自然胸型（罩杯越大越飽滿、稍微下垂），超出範圍的部分再由圓頂放大
    if (sex === 'female') {
      const cup = Math.min(1, Math.max(0, (cupDiff - 7.5) / 17.5));
      const firm = Math.min(0.72, Math.max(0.5, 0.72 - 0.22 * cup));
      const tri = (v: number): number[] => (v <= 0.5 ? [(0.5 - v) * 2, v * 2, 0] : [0, (1 - v) * 2, (v - 0.5) * 2]);
      const lv = ['min', 'average', 'max'];
      const c = tri(cup), f = tri(firm);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        if ((i === 1 && j === 1) || !(c[i] * f[j])) continue;
        addTarget(a, `female-young-averagemuscle-averageweight-${lv[i]}cup-${lv[j]}firmness`, c[i] * f[j], B);
      }
    }
    // 整體縮放到指定身高、腳底貼地
    let m = measure(this.ctx, B);
    const s = height / m.values.height;
    for (let i = 0; i < B.length; i += 3) {
      B[i] *= s;
      B[i + 1] = (B[i + 1] - m.marks.soleY) * s;
      B[i + 2] *= s;
    }
    m = measure(this.ctx, B);
    const mk = m.marks;
    if (opts.neutralize) this.neutralizePelvis(B, mk);
    m = measure(this.ctx, B);

    const R = (r: string) => this.region(r);
    const torsoSet = new Set([R('torso')]);
    const breastSet = new Set([R('breastL'), R('breastR')]);
    const indicator = (pred: (r: number) => boolean) => {
      const w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = pred(a.region[i]) ? 1 : 0;
      return w;
    };
    const wTorso = indicator((r) => torsoSet.has(r) || breastSet.has(r));
    const wThighL = indicator((r) => r === R('thighL'));
    const wThighR = indicator((r) => r === R('thighR'));
    // 交界處平滑過渡
    for (const w of [wTorso, wThighL, wThighR]) smoothField(w, this.adj, 12);

    // 軀幹中心線（前後方向）
    const zMin = new Map<number, number>(), zMax = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (a.region[i] !== R('torso')) continue;
      const y = Math.round(B[i * 3 + 1]);
      const z = B[i * 3 + 2];
      zMin.set(y, Math.min(zMin.get(y) ?? Infinity, z));
      zMax.set(y, Math.max(zMax.get(y) ?? -Infinity, z));
    }
    const ys = [...zMin.keys()].sort((p, q) => p - q);
    const zs = ys.map((y) => (zMin.get(y)! + zMax.get(y)!) / 2);
    const zsm = zs.map((_, i) => {
      let sum = 0, c = 0;
      for (let k = Math.max(0, i - 3); k <= Math.min(zs.length - 1, i + 3); k++) {
        sum += zs[k];
        c++;
      }
      return sum / c;
    });
    const torsoZ = linear(ys, zsm);

    // 左大腿中心
    const tx = new Map<number, [number, number, number]>();
    for (let i = 0; i < n; i++) {
      if (a.region[i] !== R('thighL')) continue;
      const y = Math.round(B[i * 3 + 1]);
      const e = tx.get(y) ?? [0, 0, 0];
      e[0] += B[i * 3];
      e[1] += B[i * 3 + 2];
      e[2]++;
      tx.set(y, e);
    }
    const tys = [...tx.keys()].sort((p, q) => p - q);
    const thighX = linear(tys, tys.map((y) => tx.get(y)![0] / tx.get(y)![2]));
    const thighZ = linear(tys, tys.map((y) => tx.get(y)![1] / tx.get(y)![2]));

    // 胸部：遮罩與底座邊緣
    const wBreast = indicator((r) => breastSet.has(r));
    smoothField(wBreast, this.adj, 4);
    const pick = (r: number) => Uint32Array.from({ length: n }, (_, i) => i).filter((i) => a.region[i] === r);
    const rim = (set: Uint32Array) =>
      set.filter((i) => this.adj[i].some((j) => !breastSet.has(a.region[j])));
    const L = pick(R('breastL')), Rb = pick(R('breastR'));
    const armRegions = new Set(['shoulderL', 'shoulderR', 'upperarmL', 'upperarmR', 'forearmL', 'forearmR', 'handL', 'handR'].map(R));
    const armSet = Uint32Array.from({ length: n }, (_, i) => i).filter((i) => armRegions.has(a.region[i]));
    const acromionY = (B[a.landmarks.acromionL * 3 + 1] + B[a.landmarks.acromionR * 3 + 1]) / 2;
    return {
      B,
      marks: m.marks,
      acromionY,
      torsoZ,
      thighC: (y) => [thighX(y), thighZ(y)],
      wTorso,
      wThighL,
      wThighR,
      wBreast,
      breastSets: { L, R: Rb, rimL: rim(L), rimR: rim(Rb) },
      armSet,
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

  private build(p: Prepared, q: Params, out: Float32Array): void {
    const a = this.asset;
    const n = a.nBody;
    const mk = p.marks;
    const B = p.B;
    out.set(B);
    const L = mk.underbustY - mk.crotchY;
    const dU = q.ub - 1, dH = q.hip - 1, dT = q.thigh - 1;
    const W = MODULES.waist(q.waist - 1), H = MODULES.hip(dH), U = MODULES.underbust(dU), T = MODULES.thigh(dT);

    // 軀幹的控制點（由下往上）：胯下、臀、腰、下胸、腋下、肩
    const yA = mk.underbustY + 0.55 * (p.acromionY - mk.underbustY);
    // 軀幹的輪廓分成三條曲線，各有自己的控制點（由下往上）：
    // 側面（正面看到的左右輪廓）：大腿根 → 臀側最寬 → 腰窩 → 下胸 → 腋下 → 肩
    // 前面（側面看到的肚子線）：恥骨 → 下腹 → 腰（臍） → 下胸 → 腋下 → 肩
    // 後面（側面看到的背線）：臀下 → 臀最翹 → 後腰 → 下胸 → 腋下 → 肩
    const one = 1;
    const armK = 1 + 0.5 * dU;
    const tSide = pchip(
      [mk.crotchY - 0.12 * L, mk.hipY, mk.waistY, mk.underbustY, yA, p.acromionY],
      [1 + 0.95 * dH, H.side, W.side, U.side, armK, one],
    );
    // 下腹與恥骨一帶跟著骨盆（臀圍）一起長一層，腰收細時不會被拉進去
    const lowerBelly = 1 + 0.6 * dH + (W.front - 1) * 0.6;
    const tFront = pchip(
      [mk.crotchY, mk.crotchY + 0.25 * L, mk.waistY, mk.underbustY, yA, p.acromionY],
      // 恥骨一帶延續下腹的弧度往下收，不在兩者之間形成一條橫向的台階
      [1 + 0.9 * (Math.max(lowerBelly, W.front) - 1), Math.max(lowerBelly, W.front), W.front, U.front, armK, one],
    );
    const tBack = pchip(
      [mk.crotchY - 0.12 * L, mk.hipY, mk.waistY, mk.underbustY, yA, p.acromionY],
      [1 + 0.95 * dH, H.back, W.back, U.back, armK, one],
    );

    // 大腿的控制點（由下往上）：膝、大腿中段、量大腿圍處、胯下
    const thighY = mk.crotchY - 0.1 * (mk.crotchY - mk.kneeY);
    const midY = mk.kneeY + 0.45 * (mk.crotchY - mk.kneeY);
    const tY = [mk.kneeY, midY, thighY, mk.crotchY + 0.05 * L];
    const mid: Aniso = { side: 1 + 0.55 * dT, front: 1 + 0.5 * dT, back: 1 + 0.55 * dT };
    // 大腿上段的後側接住臀部下緣，避免臀部像一顆球放在大腿上
    const top: Aniso = { side: T.side, front: T.front, back: Math.max(T.back, 1 + 0.75 * dH) };
    const legRing = [{ side: 1, front: 1, back: 1 }, mid, { ...T, back: (T.back + top.back) / 2 }, top];
    const lSide = pchip(tY, legRing.map((r) => r.side)), lFront = pchip(tY, legRing.map((r) => r.front)), lBack = pchip(tY, legRing.map((r) => r.back));
    // 大腿內側：中段長得比外側多一點，但到了大腿根部收回來，避免把恥骨三角區夾成凹陷
    const inner = (y: number) => 1 + (lSide(y) - 1) * (1.15 - 0.4 * smoothstep(thighY - 0.1 * L, mk.crotchY, y));

    const torsoDisp = (x: number, y: number, z: number): [number, number] => {
      const zc = p.torsoZ(y);
      const dz = z - zc;
      const sz = tBack(y) + (tFront(y) - tBack(y)) * smoothstep(-4, 4, dz);
      return [x * (tSide(y) - 1), dz * (sz - 1)];
    };
    const thighDisp = (x: number, y: number, z: number, sign: number): [number, number] => {
      const [cx, cz] = p.thighC(y);
      const ox = x - sign * cx, oz = z - cz;
      const outward = ox * sign;
      const sx = outward >= 0 ? lSide(y) : inner(y);
      const sz = lBack(y) + (lFront(y) - lBack(y)) * smoothstep(-3, 3, oz);
      return [ox * (sx - 1), oz * (sz - 1)];
    };

    for (let i = 0; i < n; i++) {
      const wt = p.wTorso[i], wl = p.wThighL[i], wr = p.wThighR[i];
      const sum = wt + wl + wr;
      if (sum < 1e-4) continue;
      const x = B[i * 3], y = B[i * 3 + 1], z = B[i * 3 + 2];
      let dx = 0, dz = 0;
      if (wt) {
        const [ax, az] = torsoDisp(x, y, z);
        dx += ax * wt;
        dz += az * wt;
      }
      if (wl) {
        const [ax, az] = thighDisp(x, y, z, 1);
        dx += ax * wl;
        dz += az * wl;
      }
      if (wr) {
        const [ax, az] = thighDisp(x, y, z, -1);
        dx += ax * wr;
        dz += az * wr;
      }
      // 權重總和不足 1 的地方（往小腿、手臂過渡）只取加權量，自然淡出
      const norm = Math.max(1, sum);
      out[i * 3] += dx / norm;
      out[i * 3 + 2] += dz / norm;
    }
    // 增加的量是「一層」：把位移場抹平再加回去，素體原本的細節（膝蓋、肌肉起伏）不會跟著被放大
    const D = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) D[i] = out[i] - B[i];
    smoothVectors(D, this.adj, 25);
    for (let i = 0; i < n * 3; i++) out[i] = B[i] + D[i];
    // 手臂跟著肩膀附近的軀幹側面平移（不變形）
    const shoulderY = (mk.underbustY + p.acromionY) / 2;
    for (const i of p.armSet) {
      const x = B[i * 3];
      const [ax] = torsoDisp(Math.sign(x) * 14, shoulderY, p.torsoZ(shoulderY));
      out[i * 3] += ax;
    }

    // 胸部：以乳頭為中心、底座為邊界，沿表面法向量長出一個圓頂；越大越往下墜
    const N = vertexNormals(out, a.quads, n);
    smoothVectors(N, this.adj, 8);
    for (const side of ['L', 'R'] as const) {
      const rim = side === 'L' ? p.breastSets.rimL : p.breastSets.rimR;
      const apex = a.landmarks[side === 'L' ? 'bustApexL' : 'bustApexR'];
      const A = [out[apex * 3], out[apex * 3 + 1], out[apex * 3 + 2]];
      let Rb = 0;
      for (const i of rim) Rb += Math.hypot(out[i * 3] - A[0], out[i * 3 + 1] - A[1], out[i * 3 + 2] - A[2]) / rim.length;
      // 底座隨大小稍微擴大
      const R = Rb * (1.1 + 0.15 * Math.min(2, q.breast));
      const amp = q.breast * Rb;
      for (let i = 0; i < n; i++) {
        const dx = out[i * 3] - A[0], dy = out[i * 3 + 1] - A[1], dz = out[i * 3 + 2] - A[2];
        if (dz < -R) continue;
        const d = Math.hypot(dx, dy, dz);
        if (d >= R) continue;
        // 只長在身體正面這一側（避免影響手臂內側）
        if (Math.sign(out[i * 3]) !== Math.sign(A[0]) && Math.abs(out[i * 3]) > 2) continue;
        const u = d / R;
        const dome = Math.pow(1 - u * u, 1.6);
        const nl = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
        out[i * 3] += (amp * dome * N[i * 3]) / nl;
        out[i * 3 + 1] += (amp * dome * N[i * 3 + 1]) / nl - 0.3 * amp * dome * dome;
        out[i * 3 + 2] += (amp * dome * N[i * 3 + 2]) / nl;
      }
    }
  }

  /** 每一圈各自調整，直到網格上量到的數值等於目標 */
  fit(sex: Sex, t: RingTargets, opts: RingOptions): { P: Float32Array; values: Measured['values']; params: Params; iterations: number } {
    const p = this.prepare(sex, t.height, opts, t.bust - t.underbust);
    const P = new Float32Array(p.B.length);
    const q: Params = { ub: 1, waist: 1, hip: 1, thigh: 1, breast: 0 };
    let m = measure(this.ctx, p.B);
    let prevDiff = m.values.bust - m.values.underbust, prevB = 0;
    let it = 0;
    for (; it < 25; it++) {
      this.build(p, q, P);
      m = measure(this.ctx, P);
      const v = m.values;
      const err = Math.max(Math.abs(v.underbust - t.underbust), Math.abs(v.waist - t.waist), Math.abs(v.hip - t.hip), Math.abs(v.thigh - t.thigh), Math.abs(v.bust - t.bust));
      if (err < 0.1) break;
      q.ub *= Math.pow(t.underbust / v.underbust, 0.9);
      q.waist *= Math.pow(t.waist / v.waist, 0.9);
      q.hip *= Math.pow(t.hip / v.hip, 0.9);
      q.thigh *= Math.pow(t.thigh / v.thigh, 0.9);
      // 胸部：割線法
      const diff = v.bust - v.underbust, want = t.bust - t.underbust;
      const slope = it === 0 ? 20 : Math.max(2, (diff - prevDiff) / (q.breast - prevB || 1e-6));
      prevDiff = diff;
      prevB = q.breast;
      q.breast = Math.max(0, q.breast + (want - diff) / slope);
    }
    return { P, values: m.values, params: q, iterations: it };
  }
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
