import { freeBreastVertices, type BodyAsset } from './asset';
import type { Morphology } from '../../core/morphology';
import { ease } from './controls';
import type { V3 } from './geometry';

interface BreastBinding {
  indices: Uint32Array;
  weights: Float32Array;
  rim: Uint32Array;
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
  private readonly nativeIndices: Uint32Array;
  private readonly adjacency: number[][];

  constructor(a: BodyAsset, B: Float32Array, adj: number[][]) {
    this.adjacency = adj;
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
      for (const i of originalRim) for (let k = 0; k < 3; k++) root[k] += B[i * 3 + k] / originalRim.length;
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
      this.bindings.push({ indices: Uint32Array.from(queue), weights, rim: originalRim, root, depth, apexY });
    }
    this.support = Uint32Array.from(new Set([...this.nativeIndices, ...this.bindings.flatMap(b => [...b.indices])]));
  }

  apply(out: Float32Array, amount: number, shape: Morphology['breast']): void {
    const native = Math.max(0, Math.min(2, amount));
    const firmness = shape === 'long' ? 0.25 : shape === 'round' ? 0.8 : 0.55;
    // 原生小／中／大杯曲面沿共同控制插值。底座和上胸過渡來自完整原始目標。
    for (const i of this.nativeIndices) for (let k = 0; k < 3; k++) {
      const d = i * 3 + k;
      out[d] += native <= 1 ? this.average[d] * native : this.average[d] * (2 - native) + this.maximum[d] * (native - 1);
      out[d] += firmness * (native <= 1 ? this.firmAverage[d] * native : this.firmAverage[d] * (2 - native) + this.firmMaximum[d] * (native - 1));
    }
    const extra = Math.max(0, amount - 2);
    const scale = Math.exp(extra * 0.42);
    const growth = scale - 1;
    const breadth = Math.exp(extra * 0.27);
    const height = Math.exp(extra * 0.14) * (shape === 'long' ? 1.16 : shape === 'round' ? 0.96 : 1);
    for (const b of this.bindings) {
      const root: V3 = [0, 0, 0];
      for (const i of b.rim) for (let k = 0; k < 3; k++) root[k] += out[i * 3 + k] / b.rim.length;
      const radius = Math.max(3, Math.abs(root[0]) * 0.72);
      let maxDepth = 0;
      for (const i of b.indices) maxDepth = Math.max(maxDepth, out[i * 3 + 2] - root[2]);
      for (const i of b.indices) {
        // 內部保留同一曲面的寬／高／深關係；附著限制集中在根部，不能越加越像尖錐。
        const w = ease(0, 0.65, b.weights[i]);
        if (!w) continue;
        const dy = out[i * 3 + 1] - root[1];
        const lower = 1 - ease(-radius * 0.7, radius * 0.4, dy);
        const upper = 1 - lower;
        // 三型共用自由度；下極移動與上部飽滿各自受根部漸變限制。
        const width = shape === 'round' ? 0.12 : shape === 'long' ? -0.06 : 0;
        const fullness = shape === 'round' ? 0.28 * upper - 0.06 * lower : shape === 'long' ? -0.22 * upper + 0.08 * lower : 0;
        const drop = shape === 'long' ? 0.24 : shape === 'round' ? -0.045 : 0.07;
        const depth = Math.max(0, out[i * 3 + 2] - root[2]);
        const u = depth / Math.max(0.1, maxDepth);
        const profile = depth * (2 - u);
        const projection = profile * growth + depth * fullness * scale;
        const side = Math.sign(root[0]);
        const dx = out[i * 3] - root[0];
        const widening = dx * (breadth - 1 + width);
        // 內側靠胸骨的空間有限，主要展開在外側及下極；左右不互相穿越。
        const medial = widening * side < 0 ? 0.08 : 1;
        out[i * 3] += w * widening * medial;
        // 大小擴展主要放在自由下極，上方附著不能隨倍率升到鎖骨。
        const lowerExtension = 1 - ease(-radius * 0.5, radius * 0.35, dy);
        out[i * 3 + 1] += w * ((dy - radius * 0.4) * (height - 1) * lowerExtension - depth * (drop + 0.055 * Math.max(0, growth)) * (0.35 + 0.65 * lower));
        out[i * 3 + 2] += w * projection;
      }
      // 原始杯型在下極的少數拓撲面會在放大後形成曲率尖峰。
      // 在同一控制支撐內做保體積傾向的曲率校正；根部權重逐漸歸零。
      // 這是求解曲面的一部分，後續尺寸、體積與組成一律重新量測。
      const correction = ease(0.8, 2, amount);
      if (correction) {
        const tmp = new Float32Array(b.indices.length * 3);
        for (let pass = 0; pass < 8; pass++) for (const step of [0.45, -0.47]) {
          for (let row = 0; row < b.indices.length; row++) {
            const i = b.indices[row], neighbors = this.adjacency[i];
            const weight = ease(0, 0.65, b.weights[i]) * correction;
            for (let k = 0; k < 3; k++) {
              let mean = 0;
              for (const j of neighbors) mean += out[j * 3 + k] / neighbors.length;
              tmp[row * 3 + k] = out[i * 3 + k] + (mean - out[i * 3 + k]) * step * weight;
            }
          }
          for (let row = 0; row < b.indices.length; row++) for (let k = 0; k < 3; k++) out[b.indices[row] * 3 + k] = tmp[row * 3 + k];
        }
      }
    }
  }
}
