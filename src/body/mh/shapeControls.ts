import type { BodyAsset } from './asset';
import { adjacency, centroid, dist, meshVolume, type V3, vert } from './geometry';
import { measure, measureContext, type Measured } from './measure';

// 第一階段造型原型：基準曲面上的局部控制，不改動 RingBody 或姿勢骨架。
// 支撐以網格邊的測地距離建立，固定支撐邊界，再解有約束的平滑權重。
// 所有範圍與模式係數都是待驗收的造型設定，不是解剖研究的公斤換算。
export interface ShapeControl {
  id: string;
  label: string;
  parent: 'rib' | 'pelvis' | 'sacrum';
  origin: V3;
  /** 局部座標：外側、上、前。右側外側軸反向。 */
  axes: [V3, V3, V3];
  direction: V3;
  range: [number, number];
  seed: number;
  weights: Float32Array;
}

export type ShapePose = Record<string, number>;
export type HipMode = 'muscle' | 'fat';
export interface ShapeResult {
  positions: Float32Array;
  measured: Measured;
  volume: number;
}

const step = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 沿既有表面走，不能穿過空間中靠得很近的臀溝或左右腿。 */
function geodesic(P: Float32Array, adj: number[][], allowed: Float32Array, seed: number, radius: number): Float64Array {
  const d = new Float64Array(adj.length).fill(Infinity);
  const queue = [seed];
  d[seed] = 0;
  // 有界的佇列鬆弛；距離改善才重訪，結果不依賴頂點先後順序。
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k];
    for (const j of adj[i]) {
      if (!allowed[j]) continue;
      const next = d[i] + dist(vert(P, i), vert(P, j));
      if (next < radius && next < d[j] - 1e-8) {
        d[j] = next;
        queue.push(j);
      }
    }
  }
  return d;
}

export class PelvicShapeControls {
  readonly controls: ShapeControl[] = [];
  readonly baseline: Float32Array;
  readonly baselineResult: ShapeResult;
  readonly references: Record<'rib' | 'pelvis' | 'sacrum', V3>;
  readonly support: Float32Array;
  readonly scale: number;
  private readonly ctx;

  constructor(readonly asset: BodyAsset, baseline: Float32Array) {
    if (baseline.length !== asset.n * 3 || !baseline.every(Number.isFinite)) throw new Error('控制基準必須包含完整身體與關節座標');
    this.baseline = baseline.slice();
    this.ctx = measureContext(asset);
    const measured = measure(this.ctx, this.baseline);
    const m = measured.marks;
    this.scale = measured.values.height / 160;
    const s = this.scale;
    const pelvis = centroid(baseline, ...asset.joints.pelvis);
    this.references = { pelvis, sacrum: [0, pelvis[1], pelvis[2] - 4 * s], rib: [0, m.underbustY, pelvis[2]] };
    this.baselineResult = { positions: this.baseline.slice(), measured, volume: meshVolume(baseline.subarray(0, asset.nBody * 3), asset.quads) };
    const adj = adjacency(asset.quads, asset.nBody);
    const regions = new Set(['torso', 'thighL', 'thighR'].map((r) => asset.regions.indexOf(r)));
    const support = this.support = new Float32Array(asset.nBody);
    const bottom = m.crotchY - 0.48 * (m.crotchY - m.kneeY);
    for (let i = 0; i < asset.nBody; i++) {
      if (!regions.has(asset.region[i])) continue;
      const [x, y, z] = vert(baseline, i);
      support[i] = step(bottom, bottom + 7 * s, y) * (1 - step(m.underbustY - 5 * s, m.underbustY, y));
      // 中線附著是漸變限制，不在脊柱兩旁另挖凹槽。
      const back = 1 - step(pelvis[2] - 2 * s, pelvis[2] + 2 * s, z);
      support[i] *= 1 - back * 0.8 * (1 - step(0, 4 * s, Math.abs(x)));
      // 恥骨與會陰的支撐逐漸減弱；不能把左右大腿內側接成一片。
      support[i] *= 1 - (1 - step(1 * s, 5 * s, Math.abs(x))) * (1 - step(m.crotchY, m.crotchY + 7 * s, y));
    }
    const add = (id: string, label: string, parent: ShapeControl['parent'], x: number, y: number, z: number,
      direction: V3, radius: number, side: number) => {
      const origin: V3 = [x, y, z];
      let seed = -1, best = Infinity;
      for (let i = 0; i < asset.nBody; i++) {
        if (support[i] < 0.15 || (side && baseline[i * 3] * side < 0)) continue;
        const d = dist(vert(baseline, i), origin);
        if (d < best) { best = d; seed = i; }
      }
      if (seed < 0) throw new Error(`找不到控制支撐：${id}`);
      const distances = geodesic(baseline, adj, support, seed, radius * s);
      const raw = Float32Array.from(distances, (d) => 1 - step(radius * s * 0.12, radius * s, d));
      let w = raw.slice(), next = w.slice();
      const active = Array.from(distances.keys()).filter((i) => distances[i] < radius * s);
      // 帶固定零邊界的 screened Laplacian；保留寬廣控制柄，避免單點尖峰。
      for (let it = 0; it < 80; it++) {
        for (const i of active) {
          if (distances[i] < radius * s * 0.12) { next[i] = 1; continue; }
          const avg = adj[i].reduce((sum, j) => sum + w[j], 0) / adj[i].length;
          next[i] = 0.15 * raw[i] + 0.85 * avg;
        }
        [w, next] = [next, w];
      }
      this.controls.push({ id, label, parent, origin: vert(baseline, seed),
        axes: [[side || 1, 0, 0], [0, 1, 0], [0, 0, 1]], direction,
        range: [-1 * s, 8 * s], seed, weights: w });
    };
    const h = m.hipY, waist = m.waistY, z = pelvis[2];
    add('abdomen', '腹前', 'rib', 0, waist, z + 12 * s, [0, 0, 1], 19, 0);
    add('lowerAbdomen', '下腹', 'pelvis', 0, h + 7 * s, z + 12 * s, [0, -0.12, 1], 18, 0);
    for (const side of [1, -1]) {
      const suffix = side > 0 ? 'L' : 'R', label = side > 0 ? '左' : '右';
      const pair = (id: string, name: string, parent: ShapeControl['parent'], x: number, y: number, depth: number, dir: V3, radius: number) =>
        add(`${id}${suffix}`, label + name, parent, x * s * side, y, z + depth * s, [dir[0] * side, dir[1], dir[2]], radius, side);
      pair('waist', '腰側', 'rib', 12, waist, 0, [1, 0, 0], 19);
      pair('lumbar', '後腰', 'sacrum', 7, waist - 2 * s, -9, [0.12, 0, -1], 20);
      pair('upperGlute', '臀上', 'pelvis', 8, h + 7 * s, -11, [0.2, 0.15, -1], 21);
      pair('rearGlute', '臀後', 'sacrum', 8, h, -15, [0.15, 0, -1], 23);
      pair('sideGlute', '臀側', 'pelvis', 15, h, -1, [1, 0, -0.12], 23);
      pair('lowerGlute', '下臀', 'pelvis', 9, h - 7 * s, -10, [0.2, -0.3, -0.8], 21);
      pair('outerRoot', '大腿根外側', 'pelvis', 14, m.crotchY - 3 * s, 0, [1, 0, 0], 20);
      pair('rearRoot', '大腿根後側', 'pelvis', 9, m.crotchY - 4 * s, -8, [0.1, 0, -1], 20);
    }
    // 同一條控制帶共享分割權重，交界不能重複計入兩份位移。
    for (let i = 0; i < asset.nBody; i++) {
      const total = Math.max(1, this.controls.reduce((sum, c) => sum + c.weights[i], 0));
      for (const c of this.controls) c.weights[i] *= support[i] / total;
    }
  }

  apply(pose: ShapePose = {}): ShapeResult {
    for (const [id, amount] of Object.entries(pose)) {
      const control = this.controls.find((c) => c.id === id);
      if (!control) throw new Error(`未知控制：${id}`);
      if (!Number.isFinite(amount) || amount < control.range[0] || amount > control.range[1]) throw new Error(`控制超出範圍：${id}`);
    }
    const positions = this.baseline.slice();
    for (const c of this.controls) {
      const amount = pose[c.id] ?? 0;
      if (!amount) continue;
      for (let i = 0; i < this.asset.nBody; i++) {
        const k = c.weights[i] * amount;
        for (let axis = 0; axis < 3; axis++) positions[i * 3 + axis] += k * c.direction[axis];
      }
    }
    return { positions, measured: measure(this.ctx, positions), volume: meshVolume(positions.subarray(0, this.asset.nBody * 3), this.asset.quads) };
  }

  /** 模式是多控制的校準起點；振幅單位為公分，絕不當作公斤。 */
  hipPose(mode: HipMode, amount: number): ShapePose {
    if (!Number.isFinite(amount) || amount < 0 || amount > 8 * this.scale) throw new Error('臀部模式超出原型範圍');
    const pattern = mode === 'muscle'
      ? { upperGlute: 0.85, rearGlute: 1, sideGlute: 0.45, lowerGlute: 0.35, outerRoot: 0.15, rearRoot: 0.3 }
      : { upperGlute: 0.35, rearGlute: 0.65, sideGlute: 1, lowerGlute: 0.95, outerRoot: 0.65, rearRoot: 0.5 };
    return Object.fromEntries(Object.entries(pattern).flatMap(([id, gain]) => ['L', 'R'].map((side) => [id + side, gain * amount])));
  }

  /** 只在已定義的正向模式間求解；固定大腿失敗時回報，不能用負向挖洞補償。 */
  fitHip(mode: HipMode, target: number, fixedThigh = false): { result: ShapeResult; pose: ShapePose; reached: boolean; error: number } {
    if (!Number.isFinite(target) || target <= 0) throw new Error('臀圍必須是有限正數');
    let best = { result: this.apply(), pose: {} as ShapePose, reached: false, error: Infinity };
    const baselineThigh = this.baselineResult.measured.values.thigh;
    const evaluate = (amount: number) => {
      const pose = this.hipPose(mode, amount);
      if (fixedThigh) {
        // 讓增量改由臀上／臀後承擔，仍保留腿根自由度；不抵消已加入的表面厚度。
        for (const side of ['L', 'R']) {
          pose['outerRoot' + side] *= 0.15;
          pose['rearRoot' + side] *= 0.15;
          pose['lowerGlute' + side] *= 0.5;
        }
      }
      const result = this.apply(pose);
      const error = result.measured.values.hip - target;
      const feasible = !fixedThigh || Math.abs(result.measured.values.thigh - baselineThigh) < 0.5;
      if (feasible && Math.abs(error) < Math.abs(best.error)) best = { result, pose, reached: Math.abs(error) < 0.5, error };
      return { error, feasible };
    };
    let lo = 0, hi = 8 * this.scale;
    evaluate(0);
    for (let it = 0; it < 16; it++) {
      const mid = (lo + hi) / 2;
      const { error, feasible } = evaluate(mid);
      if (error > 0 || !feasible) hi = mid;
      else lo = mid;
    }
    return best;
  }
}
