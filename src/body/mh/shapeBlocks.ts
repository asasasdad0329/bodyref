import { addTarget, type BodyAsset } from './asset';
import { adjacency, centroid, type V3 } from './geometry';
import { measure, measureContext } from './measure';

/** 模型範圍標定，不是形變公式。標定一次後固定頂點ID，不隨UI數據重新分桶。 */
export interface ShapeBlock {
  id: string;
  vertices: Uint32Array;
  boundary: Uint32Array;
  neighbors: string[];
  center: V3;
  bounds: [V3, V3];
}

export interface ShapeBlockMap {
  reference: Float32Array;
  owner: readonly string[];
  blocks: ReadonlyMap<string, ShapeBlock>;
  groups: Readonly<Record<string, readonly string[]>>;
}

const cache = new WeakMap<BodyAsset, ShapeBlockMap>();

/**
 * 使用同一CC0拓撲的女性參照標定全身；男女共用頂點編號，不共用造型規律。
 * 分界由實際皮尺位置、肚臍及關節輔助點定位。範圍的外緣另列為共同交界，
 * C各輪再根據已建立的造型決定權重與連動，這裡不預先填形變係數。
 */
export function shapeBlocks(asset: BodyAsset): ShapeBlockMap {
  const saved = cache.get(asset);
  if (saved) return saved;
  const P = new Float32Array(asset.base);
  addTarget(asset, 'asian-female-young', 1, P);
  const m = measure(measureContext(asset, 'female'), P).marks;
  const navel = P[4121 * 3 + 1], pelvis = centroid(P, ...asset.joints.pelvis);
  const upperSpine = centroid(P, ...asset.joints['spine-1']);
  const J = (name: string) => centroid(P, ...asset.joints[name]);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));
  const owner: string[] = [], members = new Map<string, number[]>();
  for (let i = 0; i < asset.nBody; i++) {
    const region = asset.regions[asset.region[i]], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const side = x >= 0 ? 'L' : 'R', prefix = side === 'L' ? 'l' : 'r';
    let id = region;
    if (region === 'torso') {
      const centerZ = lerp(pelvis[2], upperSpine[2], (y - pelvis[1]) / (upperSpine[1] - pelvis[1]));
      const dz = z - centerZ, lateral = Math.abs(x) > 1.25 * Math.abs(dz);
      if (y >= m.underbustY) {
        id = lateral ? `thorax.side.${side}` : dz >= 0 ? `thorax.front.${side}` : `thorax.back.${side}`;
      } else if (y >= navel) {
        id = lateral ? `waist.side.${side}` : dz >= 0 ? 'abdomen.upper' : `lumbar.${side}`;
      } else if (dz >= 0 && !lateral) {
        id = y < m.hipY ? 'pelvis.front' : 'abdomen.lower';
      } else if (lateral) {
        id = `glute.side.${side}`;
      } else {
        const level = y > m.hipY ? 'upper' : y > lerp(m.crotchY, m.hipY, 0.35) ? 'rear' : 'lower';
        id = `glute.${level}.${side}`;
      }
    } else if (region.startsWith('thigh') || region.startsWith('calf')) {
      const hip = J(`${prefix}-upper-leg`), knee = J(`${prefix}-knee`), ankle = J(`${prefix}-ankle`);
      const isThigh = y > knee[1], top = isThigh ? hip : knee, bottom = isThigh ? knee : ankle;
      const t = (top[1] - y) / (top[1] - bottom[1]);
      const dx = (x - lerp(top[0], bottom[0], t)) * (side === 'L' ? 1 : -1);
      const dz = z - lerp(top[2], bottom[2], t);
      const direction = Math.abs(dx) > Math.abs(dz) ? dx > 0 ? 'outer' : 'inner' : dz > 0 ? 'front' : 'back';
      const kneeBand = Math.abs(y - knee[1]) < (hip[1] - knee[1]) * 0.08;
      if (kneeBand) id = `knee.${side}`;
      else if (isThigh) id = `thigh.${y > m.crotchY - (m.crotchY - knee[1]) * 0.15 ? 'root' : 'body'}.${direction}.${side}`;
      else id = t > 0.85 ? `ankle.${side}` : `calf.${direction}.${side}`;
    } else if (region.startsWith('breast')) {
      id = `breast.free.${side}`;
    } else if (region.startsWith('upperarm')) {
      const shoulder = J(`${prefix}-shoulder`), elbow = J(`${prefix}-elbow`);
      const axis = elbow.map((v, k) => v - shoulder[k]);
      const length2 = axis.reduce((s, v) => s + v * v, 0);
      const t = axis.reduce((s, v, k) => s + (P[i * 3 + k] - shoulder[k]) * v, 0) / length2;
      id = t < 0.2 ? `shoulder.${side}` : t > 0.88 ? `elbow.${side}` : `upperarm.${z >= lerp(shoulder[2], elbow[2], t) ? 'front' : 'back'}.${side}`;
    } else if (region.startsWith('shoulder')) id = `shoulder.${side}`;
    owner.push(id);
    const ids = members.get(id) ?? []; ids.push(i); members.set(id, ids);
  }
  const adj = adjacency(asset.quads, asset.nBody), blocks = new Map<string, ShapeBlock>();
  for (const [id, ids] of members) {
    const neighbors = new Set<string>(), boundary = [];
    for (const i of ids) {
      let edge = false;
      for (const j of adj[i]) if (owner[j] !== id) { neighbors.add(owner[j]); edge = true; }
      if (edge) boundary.push(i);
    }
    const center: V3 = [0, 0, 0], low: V3 = [Infinity, Infinity, Infinity], high: V3 = [-Infinity, -Infinity, -Infinity];
    for (const i of ids) for (let k = 0; k < 3; k++) {
      center[k] += P[i * 3 + k] / ids.length;
      low[k] = Math.min(low[k], P[i * 3 + k]); high[k] = Math.max(high[k], P[i * 3 + k]);
    }
    blocks.set(id, { id, vertices: Uint32Array.from(ids), boundary: Uint32Array.from(boundary), neighbors: [...neighbors].sort(), center, bounds: [low, high] });
  }
  const select = (...prefixes: string[]) => [...blocks.keys()].filter(id => prefixes.some(prefix => id.startsWith(prefix))).sort();
  const groups = {
    glute: select('glute.'), waist: select('waist.', 'lumbar.', 'abdomen.upper'),
    abdomen: select('abdomen.', 'pelvis.front'), thigh: select('thigh.'), calf: select('calf.'),
    chest: select('breast.', 'thorax.front', 'thorax.side'), back: select('thorax.back', 'lumbar.'),
    arms: select('shoulder.', 'upperarm.', 'elbow.', 'forearm'),
    jointsAndEnds: select('knee.', 'ankle.', 'hand', 'foot', 'neck', 'head', 'face'),
  };
  const result = { reference: P, owner, blocks, groups };
  cache.set(asset, result); return result;
}
