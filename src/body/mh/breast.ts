import { freeBreastVertices, type BodyAsset } from './asset';
import type { Morphology } from '../../core/morphology';
import { ease } from './controls';
import type { V3 } from './geometry';
import { LocalControlRig, type BoundControl, type ControlFrame, type LocalTransform } from './localControls';

interface BreastBinding {
  indices: Uint32Array;
  weights: Float32Array;
  rim: Uint32Array;
  cageRim: Uint32Array;
  root: V3;
  apexY: number;
  depth: Float32Array;
}

/** 在 CC0 原曲面上綁定的根部、上極、下極與展開控制，不另生成半球或乳頭圓頂。 */
export class BreastRig {
  readonly bindings: BreastBinding[] = [];
  readonly support: Uint32Array;
  private readonly average: Float32Array;
  private readonly maximum: Float32Array;
  private readonly firmAverage: Float32Array;
  private readonly firmMaximum: Float32Array;
  private readonly reference: Float32Array;
  private readonly nativeIndices: Uint32Array;

  constructor(a: BodyAsset, B: Float32Array, adj: number[][]) {
    this.reference = B;
    const minimum = new Float32Array(a.nBody * 3);
    this.average = new Float32Array(a.nBody * 3);
    this.maximum = new Float32Array(a.nBody * 3);
    this.firmAverage = new Float32Array(a.nBody * 3);
    this.firmMaximum = new Float32Array(a.nBody * 3);
    const minTarget = a.targets.get('female-young-averagemuscle-averageweight-mincup-averagefirmness')!;
    const maxTarget = a.targets.get('female-young-averagemuscle-averageweight-maxcup-averagefirmness')!;
    const firmAverage = a.targets.get('female-young-averagemuscle-averageweight-averagecup-maxfirmness')!;
    const firmMaximum = a.targets.get('female-young-averagemuscle-averageweight-maxcup-maxfirmness')!;
    for (const [target, out] of [[minTarget, minimum], [maxTarget, this.maximum]] as const) {
      for (let k = 0; k < target.indices.length; k++) {
        const i = target.indices[k];
        if (i >= a.nBody) continue;
        for (let d = 0; d < 3; d++) out[i * 3 + d] = target.deltas[k * 3 + d] * a.deltaStep;
      }
    }
    for (const [target, out] of [[firmAverage, this.firmAverage], [firmMaximum, this.firmMaximum]] as const) {
      for (let k = 0; k < target.indices.length; k++) {
        const i = target.indices[k];
        if (i < a.nBody) for (let d = 0; d < 3; d++) out[i * 3 + d] = target.deltas[k * 3 + d] * a.deltaStep;
      }
    }
    for (let i = 0; i < minimum.length; i++) this.firmMaximum[i] -= this.maximum[i];
    for (let i = 0; i < minimum.length; i++) { this.average[i] = -minimum[i]; this.maximum[i] -= minimum[i]; }
    let rawLo = Infinity, rawHi = -Infinity, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < a.nBody; i++) {
      rawLo = Math.min(rawLo, a.base[i * 3 + 1]); rawHi = Math.max(rawHi, a.base[i * 3 + 1]);
      lo = Math.min(lo, B[i * 3 + 1]); hi = Math.max(hi, B[i * 3 + 1]);
    }
    const scale = (hi - lo) / (rawHi - rawLo);
    for (let i = 0; i < minimum.length; i++) { this.average[i] *= scale; this.maximum[i] *= scale; this.firmAverage[i] *= scale; this.firmMaximum[i] *= scale; }
    this.nativeIndices = Uint32Array.from(new Set([...minTarget.indices, ...maxTarget.indices, ...firmAverage.indices, ...firmMaximum.indices])).filter(i => i < a.nBody);
    const freeVertices = freeBreastVertices(a);
    for (const side of ['L', 'R'] as const) {
      const region = a.regions.indexOf(`breast${side}`);
      const original = Uint32Array.from({ length: a.nBody }, (_, i) => i).filter(i => a.region[i] === region);
      const originalRim = original.filter(i => adj[i].some(j => a.region[j] !== region));
      const support = new Set(original);
      const freeSurface = new Set(original);
      const cup = a.targets.get('female-young-averagemuscle-averageweight-maxcup-averagefirmness');
      if (cup) for (let k = 0; k < cup.indices.length; k++) {
        const i = cup.indices[k];
        if (i >= a.nBody || B[i * 3] * (side === 'L' ? 1 : -1) <= 0 || a.region[i] !== a.regions.indexOf('torso')) continue;
        const projection = cup.deltas[k * 3 + 2] * a.deltaStep;
        if (projection > 0.08 || freeVertices.has(i)) support.add(i);
        if (freeVertices.has(i)) freeSurface.add(i);
      }
      const ids = Uint32Array.from(support);
      const rim = ids.filter(i => adj[i].some(j => !support.has(j)));
      if (!ids.length || !rim.length) throw new Error('缺少胸部拓撲標記');
      const root: V3 = [0, 0, 0];
      for (const i of rim) for (let k = 0; k < 3; k++) root[k] += B[i * 3 + k] / rim.length;
      const weights = new Float32Array(a.nBody);
      // 以原始表面投影區界定內部，邊界沿拓撲擴到根部過渡，固定外圈為零。
      const distance = new Int16Array(a.nBody).fill(-1);
      const queue = [...ids];
      for (const i of ids) { distance[i] = 0; weights[i] = freeSurface.has(i) ? 1 : 0; }
      const torso = a.regions.indexOf('torso');
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head];
        if (distance[i] >= 4) continue;
        for (const j of adj[i]) if (distance[j] < 0 && a.region[j] === torso && B[j * 3] * (side === 'L' ? 1 : -1) > 0) {
          distance[j] = distance[i] + 1; queue.push(j);
        }
      }
      const tmp = new Float32Array(a.nBody);
      for (let pass = 0; pass < 14; pass++) {
        for (const i of queue) {
          if (distance[i] === 4) { tmp[i] = 0; continue; }
          let sum = 2 * weights[i];
          for (const j of adj[i]) sum += weights[j];
          tmp[i] = sum / (adj[i].length + 2);
        }
        weights.set(tmp);
      }
      const depth = new Float32Array(a.nBody);
      for (const i of queue) depth[i] = Math.max(0, B[i * 3 + 2] - root[2]);
      const apexY = B[a.landmarks[`bustApex${side}`] * 3 + 1];
      // 附著邊界取完整形變支撐；內部籠的尺度中心仍取原生乳房區。
      // 籠中心只用來描述上下極，不是胸壁附著或下胸排除標記。
      this.bindings.push({ indices: Uint32Array.from(queue), weights, rim, cageRim: originalRim, root, depth, apexY });
    }
    this.support = Uint32Array.from(new Set([...this.nativeIndices, ...this.bindings.flatMap(b => [...b.indices])]));
    // 對材料本身的下極離散折面作拓撲正則化，載入時只算一次。
    // 後續尺寸與體積均量這個材料產生的表面，不在顯示階段補平。
    const weight = new Float32Array(a.nBody);
    for (const b of this.bindings) for (const i of b.indices) weight[i] = Math.max(weight[i], ease(0, 0.5, b.weights[i]));
    const regularize = (field: Float32Array, includeBase: boolean) => {
      const points = Float32Array.from(field, (v, i) => v + (includeBase ? B[i] : 0)), tmp = new Float32Array(points);
      for (let pass = 0; pass < 10; pass++) for (const step of [0.45, -0.47]) {
        for (const i of this.support) for (let k = 0; k < 3; k++) {
          let mean = 0; for (const j of adj[i]) mean += points[j * 3 + k] / adj[i].length;
          tmp[i * 3 + k] = points[i * 3 + k] + (mean - points[i * 3 + k]) * step * weight[i];
        }
        points.set(tmp);
      }
      for (let i = 0; i < field.length; i++) field[i] = points[i] - (includeBase ? B[i] : 0);
    };
    regularize(this.average, true); regularize(this.maximum, true);
    regularize(this.firmAverage, false); regularize(this.firmMaximum, false);
    this.nativeIndices = this.support;
  }

  /**
   * 原生小／中／大杯提供連續的有號材料曲面；超出大杯後採根部局部仿射擴展。
   * 寬、高、深、上極、下極、胸距及朝向各自有控制，不使用深度平方鼓包或
   * 隨下極高度改變斜率的下垂公式。所有型態在同一套自由度上設定偏好。
   */
  apply(out: Float32Array, amount: number, shape: Morphology['breast']): void {
    if (amount <= 0) return;
    const shapeWeight = ease(0, 1, amount);
    const native = Math.max(0, Math.min(2, amount));
    const firm = shape === 'long' ? 0 : shape === 'round' ? 0.55 : 0.2;
    const roots = this.bindings.map(b => {
      const root: V3 = [0, 0, 0];
      for (const i of b.rim) for (let k = 0; k < 3; k++) root[k] += out[i * 3 + k] / b.rim.length;
      return root;
    });
    const scales = this.bindings.map((b, index) => {
      const scale: V3 = [0, 0, 0], variance: V3 = [0, 0, 0];
      for (const i of b.rim) for (let k = 0; k < 3; k++) {
        const d = this.reference[i * 3 + k] - b.root[k];
        scale[k] += d * (out[i * 3 + k] - roots[index][k]); variance[k] += d * d;
      }
      return scale.map((v, k) => Math.max(0.4, Math.min(2.5, v / Math.max(0.01, variance[k])))) as V3;
    });
    const chestWall = new Float32Array(out);
    for (const i of this.nativeIndices) for (let k = 0; k < 3; k++) {
      const d = i * 3 + k, scale = scales[this.reference[i * 3] > 0 ? 0 : 1][k];
      const shapeDelta = native <= 1 ? this.average[d] * native : this.average[d] * (2 - native) + this.maximum[d] * (native - 1);
      const firmDelta = native <= 1 ? this.firmAverage[d] * native : this.firmAverage[d] * (2 - native) + this.firmMaximum[d] * (native - 1);
      out[d] += (shapeDelta + firm * firmDelta) * scale;
    }
    const extra = Math.max(0, amount - 2);
    const breadth = 1 + 0.19 * extra + (shape === 'round' ? 0.1 : shape === 'long' ? -0.025 : 0) * shapeWeight;
    const height = (1 + 0.12 * extra) * (1 + (shape === 'long' ? 0.17 : shape === 'round' ? -0.15 : 0) * shapeWeight);
    const depth = 1 + 0.5 * extra;
    const controls: BoundControl[] = [], frames: Record<string, ControlFrame> = {}, state: Record<string, LocalTransform> = {};
    this.bindings.forEach((b, sideIndex) => {
      const parent = `breast${sideIndex}`, root = roots[sideIndex], side = Math.sign(root[0]);
      frames[parent] = { origin: root, axes: [[side, 0, 0], [0, 1, 0], [0, 0, side]], scale: [1, 1, 1] };
      const weights = Float32Array.from(b.indices, i => ease(0, 0.4, b.weights[i]));
      const base = { parent, origin: [0, 0, 0] as V3, vertices: b.indices };
      const add = (name: string, w: Float32Array, t: LocalTransform, material?: Float32Array) => {
        const id = `${parent}-${name}`; controls.push({ ...base, id, weights: w, material }); state[id] = t;
      };
      add('width', weights, { scale: [breadth, 1, 1] });
      add('height', weights, { scale: [1, height, 1] });
      // 胸廓本身的前凸不是乳房厚度：深度只擴展相對同一胸壁的自由表面。
      // 根部不是一片平面，不能用 z-root.z 把胸腹與乳房一起拉成多層凸緣。
      const projection = new Float32Array(b.indices.length * 3);
      b.indices.forEach((i, row) => { projection[row * 3 + 2] = (out[i * 3 + 2] - chestWall[i * 3 + 2]) * side; });
      add('depth', new Float32Array(weights.length).fill(1), { material: depth - 1 }, projection);
      // 內側擴展由外移共同平衡，胸骨附著權重仍為零。
      add('separation', weights, { translation: [Math.max(0, breadth - 1) * Math.abs(root[0]) * 0.5, 0, 0] });
      const upper = Float32Array.from(b.indices, (i, row) => weights[row] * ease(-2, 4, out[i * 3 + 1] - root[1]));
      const lower = Float32Array.from(weights, (w, row) => w - upper[row]);
      add('upper-pole', upper, { material: (shape === 'round' ? 0.35 : shape === 'long' ? -0.13 : 0) * shapeWeight }, projection);
      add('lower-pole', lower, { material: (shape === 'long' ? 0.05 : 0) * shapeWeight }, projection);
      const gravity = new Float32Array(b.indices.length * 3);
      b.indices.forEach((i, row) => { gravity[row * 3 + 1] = -Math.max(0, out[i * 3 + 2] - chestWall[i * 3 + 2]); });
      add('sag', weights, { material: (shape === 'long' ? 0.13 : shape === 'round' ? 0 : 0.035) * shapeWeight }, gravity);
      add('orientation', weights, { yaw: (shape === 'round' ? 0 : -0.025) * side * shapeWeight });
    });
    new LocalControlRig(controls).apply(out, frames, state, out);
  }
}
