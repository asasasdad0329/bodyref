import type { BodyAsset } from './asset';
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

  constructor(a: BodyAsset, B: Float32Array, adj: number[][]) {
    for (const side of ['L', 'R'] as const) {
      const region = a.regions.indexOf(`breast${side}`);
      const ids = Uint32Array.from({ length: a.nBody }, (_, i) => i).filter(i => a.region[i] === region);
      const rim = ids.filter(i => adj[i].some(j => a.region[j] !== region));
      if (!ids.length || !rim.length) throw new Error('缺少胸部拓撲標記');
      const root: V3 = [0, 0, 0];
      for (const i of rim) for (let k = 0; k < 3; k++) root[k] += B[i * 3 + k] / rim.length;
      const weights = new Float32Array(a.nBody);
      // 以原始表面投影區界定內部，邊界沿拓撲擴到根部過渡，固定外圈為零。
      const distance = new Int16Array(a.nBody).fill(-1);
      const queue = [...ids];
      for (const i of ids) { distance[i] = 0; weights[i] = 1; }
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
      this.bindings.push({ indices: Uint32Array.from(queue), weights, rim, root, depth, apexY });
    }
  }

  apply(out: Float32Array, amount: number, shape: Morphology['breast']): void {
    const scale = Math.exp(amount * 0.42);
    const growth = scale - 1;
    const breadth = Math.exp(Math.max(0, amount) * 0.19);
    const height = Math.exp(Math.max(0, amount) * 0.16);
    for (const b of this.bindings) {
      const root: V3 = [0, 0, 0];
      for (const i of b.rim) for (let k = 0; k < 3; k++) root[k] += out[i * 3 + k] / b.rim.length;
      const radius = Math.max(3, Math.abs(root[0]) * 0.72);
      const maxDepth = Math.max(...b.indices.map(i => b.depth[i]));
      for (const i of b.indices) {
        // 內部保留同一曲面的寬／高／深關係；附著限制集中在根部，不能越加越像尖錐。
        const w = ease(0, 0.22 * maxDepth, b.depth[i]) * Math.min(1, b.weights[i] * 2.5);
        if (!w) continue;
        const dy = out[i * 3 + 1] - root[1];
        const lower = 1 - ease(-radius * 0.7, radius * 0.4, dy);
        const upper = 1 - lower;
        // 三型共用自由度；下極移動與上部飽滿各自受根部漸變限制。
        const width = shape === 'round' ? 0.12 : shape === 'long' ? -0.06 : 0;
        const fullness = shape === 'round' ? 0.28 * upper - 0.06 * lower : shape === 'long' ? -0.22 * upper + 0.08 * lower : 0;
        const drop = shape === 'long' ? 0.45 : shape === 'round' ? -0.045 : 0.12;
        const depth = b.depth[i];
        const projection = depth * (growth + fullness * scale);
        const side = Math.sign(root[0]);
        const dx = out[i * 3] - root[0];
        const widening = dx * (breadth - 1 + width);
        // 內側靠胸骨的空間有限，主要展開在外側及下極；左右不互相穿越。
        const medial = widening * side < 0 ? ease(0.8, 4, Math.abs(out[i * 3])) : 1;
        out[i * 3] += w * widening * medial;
        out[i * 3 + 1] += w * ((dy - radius * 0.45) * (height - 1) - depth * (drop + 0.32 * Math.max(0, growth)) * (0.35 + 0.65 * lower));
        out[i * 3 + 2] += w * projection;
      }
    }
  }
}
