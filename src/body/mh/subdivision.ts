/**
 * 四邊面 Catmull–Clark 曲面。形狀骨操作控制網格，這裡重建實際幾何，
 * 不以法線或材質掩蓋折線。拓撲只準備一次，後續重用。
 */
interface Refinement {
  count: number;
  quads: Uint32Array;
  edges: [number, number, number, number][];
  valence: Uint16Array;
  boundary: Map<number, number[]>;
  output: Uint32Array;
}

function prepare(quads: Uint32Array, count: number): Refinement {
  const lookup = new Map<number, number>(), edges: Refinement['edges'] = [];
  const faceEdges = new Uint32Array(quads.length), valence = new Uint16Array(count);
  const key = (a: number, b: number) => Math.min(a, b) * count + Math.max(a, b);
  for (let f = 0; f < quads.length / 4; f++) for (let k = 0; k < 4; k++) {
    const a = quads[f * 4 + k], b = quads[f * 4 + (k + 1) % 4], code = key(a, b);
    let index = lookup.get(code);
    if (index === undefined) {
      index = edges.length; lookup.set(code, index); edges.push([a, b, f, -1]);
      valence[a]++; valence[b]++;
    } else {
      if (edges[index][3] !== -1) throw new Error('細分曲面需要流形網格');
      edges[index][3] = f;
    }
    faceEdges[f * 4 + k] = index;
  }
  const boundary = new Map<number, number[]>();
  for (const [a, b, , second] of edges) if (second < 0) {
    boundary.set(a, [...(boundary.get(a) ?? []), b]);
    boundary.set(b, [...(boundary.get(b) ?? []), a]);
  }
  const output = new Uint32Array(quads.length * 4);
  for (let f = 0; f < quads.length / 4; f++) for (let k = 0; k < 4; k++) {
    output.set([quads[f * 4 + k], count + faceEdges[f * 4 + k],
      count + edges.length + f, count + faceEdges[f * 4 + (k + 3) % 4]], (f * 4 + k) * 4);
  }
  return { count, quads, edges, valence, boundary, output };
}

function refine(source: Float32Array, step: Refinement): Float32Array {
  const { count, quads, edges, valence, boundary } = step;
  const faceStart = count + edges.length;
  // 雙精度累加可避免多層細分的頂點順序造成可見偏差。
  const result = new Float64Array((faceStart + quads.length / 4) * 3);
  for (let f = 0; f < quads.length / 4; f++) for (let d = 0; d < 3; d++) {
    let value = 0;
    for (let k = 0; k < 4; k++) value += source[quads[f * 4 + k] * 3 + d] / 4;
    result[(faceStart + f) * 3 + d] = value;
    for (let k = 0; k < 4; k++) result[quads[f * 4 + k] * 3 + d] += value;
  }
  edges.forEach(([a, b, first, second], e) => {
    for (let d = 0; d < 3; d++) {
      const sum = source[a * 3 + d] + source[b * 3 + d];
      result[(count + e) * 3 + d] = second < 0 ? sum / 2
        : (sum + result[(faceStart + first) * 3 + d] + result[(faceStart + second) * 3 + d]) / 4;
      result[a * 3 + d] += source[b * 3 + d];
      result[b * 3 + d] += source[a * 3 + d];
    }
  });
  for (let i = 0; i < count; i++) for (let d = 0; d < 3; d++) {
    const edge = boundary.get(i), n = valence[i];
    result[i * 3 + d] = edge?.length === 2
      ? source[i * 3 + d] * .75 + (source[edge[0] * 3 + d] + source[edge[1] * 3 + d]) / 8
      : n > 0 ? source[i * 3 + d] * (n - 2) / n + result[i * 3 + d] / (n * n) : source[i * 3 + d];
  }
  return Float32Array.from(result);
}

export class SubdivisionSurface {
  readonly quads: Uint32Array;
  readonly indices: Uint32Array;
  private readonly steps: Refinement[] = [];
  private readonly boundary = new Map<number, number[]>();

  constructor(quads: Uint16Array | Uint32Array, count: number, levels = 2) {
    let current: Uint32Array = Uint32Array.from(quads);
    for (let level = 0; level < levels; level++) {
      const step = prepare(current, count); this.steps.push(step);
      count += step.edges.length + current.length / 4;
      current = step.output;
    }
    this.quads = current;
    const last = this.steps[this.steps.length - 1];
    if (last) last.edges.forEach(([a, b, , second], i) => {
      if (second >= 0) return;
      const mid = last.count + i;
      this.boundary.set(a, [...(this.boundary.get(a) ?? []), mid]);
      this.boundary.set(b, [...(this.boundary.get(b) ?? []), mid]);
      this.boundary.set(mid, [a, b]);
    });
    this.indices = new Uint32Array(current.length / 4 * 6);
    for (let f = 0; f < current.length / 4; f++) {
      const [a, b, c, d] = current.subarray(f * 4, f * 4 + 4);
      this.indices.set([a, b, c, a, c, d], f * 6);
    }
  }

  /** 同拓撲的線性插值，用於分區、蒙皮與不參與雕形的表面。 */
  interpolate(source: Float32Array, dimensions = 1, diagonalFaces = false): Float32Array {
    let result = source;
    for (const step of this.steps) {
      const faceStart = step.count + step.edges.length;
      const next = new Float32Array((faceStart + step.quads.length / 4) * dimensions);
      next.set(result.subarray(0, step.count * dimensions));
      step.edges.forEach(([a, b], i) => {
        for (let k = 0; k < dimensions; k++) next[(step.count + i) * dimensions + k] = (result[a * dimensions + k] + result[b * dimensions + k]) / 2;
      });
      for (let f = 0; f < step.quads.length / 4; f++) for (let k = 0; k < dimensions; k++) {
        for (let j = 0; j < 4; j += diagonalFaces ? 2 : 1) {
          next[(faceStart + f) * dimensions + k] += result[step.quads[f * 4 + j] * dimensions + k] / (diagonalFaces ? 2 : 4);
        }
      }
      result = next;
    }
    return result;
  }

  /** 將固定的一級曲面及分區混合編成稀疏權重，求解迭代不反覆建整份細分暫存。 */
  compile(vertices: Uint32Array, ownership: Float32Array): (source: Float32Array, output: Float32Array) => void {
    if (this.steps.length !== 1) throw new Error('稀疏曲面目前僅支援一級細分');
    type Stencil = Map<number, number>;
    const step = this.steps[0];
    const add = (out: Stencil, input: Stencil, gain: number) => {
      for (const [i, value] of input) out.set(i, (out.get(i) ?? 0) + value * gain);
    };
    const unit = (i: number): Stencil => new Map([[i, 1]]);
    const faces: Stencil[] = [];
    const touching: number[][] = Array.from({ length: step.count }, () => []);
    const neighbors: number[][] = Array.from({ length: step.count }, () => []);
    for (let f = 0; f < step.quads.length / 4; f++) {
      const stencil: Stencil = new Map();
      for (let k = 0; k < 4; k++) {
        const i = step.quads[f * 4 + k]; add(stencil, unit(i), .25); touching[i].push(f);
      }
      faces.push(stencil);
    }
    for (const [a, b] of step.edges) { neighbors[a].push(b); neighbors[b].push(a); }
    const refined: Stencil[] = [];
    const linear: Stencil[] = [];
    for (let i = 0; i < step.count; i++) {
      const n = step.valence[i], edge = step.boundary.get(i), stencil: Stencil = new Map();
      if (edge?.length === 2) { add(stencil, unit(i), .75); for (const j of edge) add(stencil, unit(j), .125); }
      else if (n) {
        add(stencil, unit(i), (n - 2) / n);
        for (const j of neighbors[i]) add(stencil, unit(j), 1 / (n * n));
        for (const f of touching[i]) add(stencil, faces[f], 1 / (n * n));
      } else add(stencil, unit(i), 1);
      refined.push(stencil); linear.push(unit(i));
    }
    for (const [a, b, first, second] of step.edges) {
      const stencil: Stencil = new Map(), midpoint: Stencil = new Map();
      add(midpoint, unit(a), .5); add(midpoint, unit(b), .5);
      add(stencil, midpoint, second < 0 ? 1 : .5);
      if (second >= 0) { add(stencil, faces[first], .25); add(stencil, faces[second], .25); }
      refined.push(stencil); linear.push(midpoint);
    }
    for (let f = 0; f < faces.length; f++) {
      refined.push(faces[f]);
      linear.push(new Map([[step.quads[f * 4], .5], [step.quads[f * 4 + 2], .5]]));
    }
    const around: number[][] = Array.from({ length: refined.length }, () => []);
    for (let f = 0; f < this.quads.length; f += 4) for (let k = 0; k < 4; k++) around[this.quads[f + k]].push(f + k);
    const offsets = new Uint32Array(vertices.length + 1), ids: number[] = [], coefficients: number[] = [];
    vertices.forEach((i, row) => {
      const weight = ownership[row], result: Stencil = new Map();
      add(result, linear[i], 1 - weight);
      if (weight) {
        const edge = this.boundary.get(i), n = around[i].length;
        if (edge?.length === 2) {
          add(result, refined[i], weight * 4 / 6);
          for (const j of edge) add(result, refined[j], weight / 6);
        } else if (n) {
          const factor = weight / (n * (n + 5));
          add(result, refined[i], n * n * factor);
          for (const position of around[i]) {
            const f = position - position % 4, k = position % 4;
            add(result, refined[this.quads[f + (k + 1) % 4]], 2 * factor);
            add(result, refined[this.quads[f + (k + 3) % 4]], 2 * factor);
            add(result, refined[this.quads[f + (k + 2) % 4]], factor);
          }
        } else add(result, refined[i], weight);
      }
      offsets[row] = ids.length;
      for (const [j, value] of result) if (Math.abs(value) > 1e-14) { ids.push(j); coefficients.push(value); }
    });
    offsets[vertices.length] = ids.length;
    const indices = Uint32Array.from(ids), values = Float64Array.from(coefficients);
    // 編譯後只保留數字陣列，Map 及中間面可回收。
    return (source, output) => {
      for (let row = 0; row < vertices.length; row++) {
        let x = 0, y = 0, z = 0;
        for (let j = offsets[row]; j < offsets[row + 1]; j++) {
          const i = indices[j] * 3, w = values[j];
          x += source[i] * w; y += source[i + 1] * w; z += source[i + 2] * w;
        }
        output[row * 3] = x; output[row * 3 + 1] = y; output[row * 3 + 2] = z;
      }
    };
  }

  evaluate(controlPoints: Float32Array): Float32Array {
    let result = controlPoints;
    for (const step of this.steps) result = refine(result, step);
    // Blender 雕形稿啟用 limit surface：將細分頂點投到極限曲面，
    // 不能只增加面數，留下原本控制多邊形的稜角。
    const limit = new Float64Array(result.length), count = new Uint16Array(result.length / 3);
    for (let f = 0; f < this.quads.length; f += 4) for (let k = 0; k < 4; k++) {
      const i = this.quads[f + k], before = this.quads[f + (k + 3) % 4];
      const after = this.quads[f + (k + 1) % 4], opposite = this.quads[f + (k + 2) % 4];
      count[i]++;
      for (let d = 0; d < 3; d++) limit[i * 3 + d] += 2 * (result[before * 3 + d] + result[after * 3 + d]) + result[opposite * 3 + d];
    }
    for (let i = 0; i < count.length; i++) for (let d = 0; d < 3; d++) {
      const n = count[i], edge = this.boundary.get(i);
      limit[i * 3 + d] = edge?.length === 2
        ? (4 * result[i * 3 + d] + result[edge[0] * 3 + d] + result[edge[1] * 3 + d]) / 6
        : n ? (n * n * result[i * 3 + d] + limit[i * 3 + d]) / (n * (n + 5)) : result[i * 3 + d];
    }
    return Float32Array.from(limit);
  }
}
