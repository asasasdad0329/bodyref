import manifest from './manifest.json';
import { adjacency } from './geometry';

// 讀取由 tools/prepare_body.py 產生的人體資產（MakeHuman CC0 網格與形變目標）

export type RegionName = (typeof manifest.regions)[number];

export interface Target {
  name: string;
  indices: Uint16Array;
  /** 量化後的位移，乘上 deltaStep 得到公分 */
  deltas: Int16Array;
}

export interface BodyAsset {
  /** 頂點總數（身體 + 關節輔助點） */
  n: number;
  /** 身體頂點數；之後的頂點是關節輔助點 */
  nBody: number;
  /** 基本網格（公分） */
  base: Float32Array;
  quads: Uint16Array;
  /** 每個頂點所屬部位，值是 regions 的索引 */
  region: Uint8Array;
  regions: readonly string[];
  /** 手臂的蒙皮權重（0–1），用來擺手臂角度 */
  armWeight: { L: Float32Array; R: Float32Array };
  deltaStep: number;
  targets: Map<string, Target>;
  /** 關節輔助點：[起始頂點, 頂點數] */
  joints: Record<string, [number, number]>;
  landmarks: Record<string, number>;
}

/** 原生杯型中向前展開或向下懸垂的自由表面；不把整份胸壁支撐目標排除。 */
const freeBreastCache = new WeakMap<BodyAsset, Set<number>>();
export function freeBreastVertices(a: BodyAsset): Set<number> {
  const cached = freeBreastCache.get(a);
  if (cached) return cached;
  const out = new Set<number>();
  const regions = new Set(['breastL', 'breastR'].map(r => a.regions.indexOf(r)));
  for (let i = 0; i < a.nBody; i++) if (regions.has(a.region[i])) out.add(i);
  const adjacent = adjacency(a.quads, a.nBody), distance = new Int16Array(a.nBody).fill(-1), queue = [...out];
  for (const i of queue) distance[i] = 0;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (distance[i] >= 4) continue;
    for (const j of adjacent[i]) if (distance[j] < 0) { distance[j] = distance[i] + 1; queue.push(j); }
  }
  const cup = a.targets.get('female-young-averagemuscle-averageweight-maxcup-averagefirmness');
  const minimum = new Float32Array(a.nBody * 3);
  const minCup = a.targets.get('female-young-averagemuscle-averageweight-mincup-averagefirmness');
  if (minCup) for (let k = 0; k < minCup.indices.length; k++) {
    const i = minCup.indices[k];
    if (i < a.nBody) for (let d = 0; d < 3; d++) minimum[i * 3 + d] = minCup.deltas[k * 3 + d] * a.deltaStep;
  }
  if (cup) for (let k = 0; k < cup.indices.length; k++) {
    const i = cup.indices[k];
    if (i >= a.nBody) continue;
    const down = cup.deltas[k * 3 + 1] * a.deltaStep - minimum[i * 3 + 1];
    const forward = cup.deltas[k * 3 + 2] * a.deltaStep - minimum[i * 3 + 2];
    if (distance[i] >= 0 && (forward > 0.3 || down < -0.6)) out.add(i);
  }
  freeBreastCache.set(a, out);
  return out;
}

export function parseBodyAsset(buf: ArrayBuffer): BodyAsset {
  const m = manifest;
  const n = m.vertexCount;
  const u8 = (off: number, len: number) => new Uint8Array(buf, off, len);
  const weight = (off: number) => Float32Array.from(u8(off, n), (v) => v / 255);
  const targets = new Map<string, Target>();
  for (const t of m.targets) {
    targets.set(t.name, {
      name: t.name,
      indices: new Uint16Array(buf, t.indices, t.count),
      deltas: new Int16Array(buf, t.deltas, t.count * 3),
    });
  }
  return {
    n,
    nBody: m.bodyVertexCount,
    base: new Float32Array(buf, m.positions, n * 3),
    quads: new Uint16Array(buf, m.quads, m.faceCount * 4),
    region: u8(m.region, n),
    regions: m.regions,
    armWeight: { L: weight(m.armWeightL), R: weight(m.armWeightR) },
    deltaStep: m.deltaStep,
    targets,
    joints: m.joints as unknown as Record<string, [number, number]>,
    landmarks: m.landmarks,
  };
}

export async function loadBodyAsset(url: string): Promise<BodyAsset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`無法載入人體模型（HTTP ${res.status}）`);
  return parseBodyAsset(await res.arrayBuffer());
}

/** 套用一組形變目標：out = base + Σ w·Δ */
export function applyTargets(a: BodyAsset, weights: Map<string, number>, out: Float32Array = new Float32Array(a.base)): Float32Array {
  out.set(a.base);
  for (const [name, w] of weights) addTarget(a, name, w, out);
  return out;
}

export function addTarget(a: BodyAsset, name: string, w: number, out: Float32Array): void {
  if (!w) return;
  const t = a.targets.get(name);
  if (!t) return;
  const k = w * a.deltaStep;
  const { indices, deltas } = t;
  for (let j = 0; j < indices.length; j++) {
    const i = indices[j] * 3;
    out[i] += deltas[j * 3] * k;
    out[i + 1] += deltas[j * 3 + 1] * k;
    out[i + 2] += deltas[j * 3 + 2] * k;
  }
}
