import manifest from './manifest.json';

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
