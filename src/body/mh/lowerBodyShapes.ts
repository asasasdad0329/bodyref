import { addTarget, type BodyAsset } from './asset';
import { adjacency, centroid, cross, norm, sub, type V3 } from './geometry';
import { shapeBlocks } from './shapeBlocks';

export type LowerShape = 'glute' | 'waist' | 'abdomen' | 'thigh' | 'calf';
export interface ShapeBone {
  id: string;
  shape: LowerShape;
  parent: string;
  blocks: readonly string[];
  vertices: Uint32Array;
  /** 小／大造型相對於中間造型的有號局部位移，不是表面法線凸起。 */
  small: Float32Array;
  large: Float32Array;
}

/**
 * 造型參數不帶 cm、kg 或 UI 鎖定狀態。-1／0／1 是已建立的小／中／大形態，
 * 其間沿同一個 C1 連續曲線；越過端點沿端點切線延伸，不突然換另一種膨脹公式。
 */
function displacement(small: number, large: number, value: number): number {
  const t = Math.abs(value), endpoint = value < 0 ? small : large;
  if (t >= 1) return endpoint * t;
  // 同一頂點分量兩端反向時，零點切線採調和平均，避免中間產生額外凸起。
  const lo = -small, hi = large;
  const tangent = lo * hi > 0 ? 2 * lo * hi / (lo + hi) : 0;
  return endpoint * t * t * (2 - t) + Math.sign(value) * tangent * t * (1 - t) ** 2;
}

const ease = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 既有材料的試作草稿，未接入產品。
 * 此草稿從材料出發，尚未完成「美術目標造型 → 有解剖／生理依據的漂亮變形
 * → 結構骨重現」；不得將插值或綁定測試通過當成造型階段完成。
 */
export class LowerBodyShapes {
  readonly bones: readonly ShapeBone[];
  readonly reference: Float32Array;
  private readonly pelvis: V3;
  private readonly referenceFrames: Record<string, { axes: V3[]; length: number }>;
  private readonly trajectories: readonly ShapeBone[];

  constructor(private readonly asset: BodyAsset) {
    const map = shapeBlocks(asset), P = map.reference;
    this.reference = P;
    this.pelvis = centroid(P, ...asset.joints.pelvis);
    this.referenceFrames = this.frames(P);
    const n = asset.nBody, adj = adjacency(asset.quads, n);
    const target = (name: string) => {
      if (!asset.targets.has(name)) throw new Error(`缺少造型材料：${name}`);
      const delta = new Float32Array(P.length); addTarget(asset, name, 1, delta); return delta;
    };
    const small = target('measure-hips-circ-decr'), large = target('measure-hips-circ-incr');
    const thin = target('universal-female-young-averagemuscle-minweight');
    const full = target('universal-female-young-averagemuscle-maxweight');
    const hip = centroid(P, ...asset.joints['l-upper-leg']);
    const knee = centroid(P, ...asset.joints['l-knee']);
    // 大臀不是後方加一顆球：擴展下半臀及側臀的組織，同時帶動後、外腿根。
    // 以現有 CC0 有號雕形保留切向位移和臀下褶，不沿表面法線堆出固定凸包。
    for (let i = 0; i < n; i++) {
      const id = map.owner[i], y = P[i * 3 + 1], z = P[i * 3 + 2] - this.pelvis[2];
      const root = (1 - ease(hip[1] - 2, hip[1] + 8, y)) * ease(knee[1], hip[1] - 7, y);
      const rearSide = 1 - ease(0, 9, z);
      const blend = root * rearSide * (id.startsWith('glute.') || id.startsWith('thigh.') ? 0.45 : 0);
      for (let k = 0; k < 3; k++) {
        small[i * 3 + k] += thin[i * 3 + k] * blend * 0.6;
        large[i * 3 + k] += full[i * 3 + k] * blend;
      }
    }
    const bones: ShapeBone[] = [];
    const bind = (shape: LowerShape, ids: readonly string[], minimumShape: Float32Array, maximumShape: Float32Array) => {
      // 造型場先整理交界，再拆骨；不對每次輸入結果加補丁。
      const tmpDelta = new Float32Array(P.length);
      for (const field of [minimumShape, maximumShape]) for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
          tmpDelta[i * 3 + k] = (4 * field[i * 3 + k] + adj[i].reduce((sum, j) => sum + field[j * 3 + k], 0)) / (4 + adj[i].length);
        }
        field.set(tmpDelta);
      }
      // 完整造型先成立，骨的權重只是分解同一位移；共享邊界不重複增量。
      const weights = ids.map(id => Float32Array.from({ length: n }, (_, i) => map.owner[i] === id ? 1 : 0));
      const tmp = new Float32Array(n);
      for (const w of weights) for (let pass = 0; pass < 6; pass++) {
        for (let i = 0; i < n; i++) tmp[i] = (2 * w[i] + adj[i].reduce((sum, j) => sum + w[j], 0)) / (2 + adj[i].length);
        w.set(tmp);
      }
      ids.forEach((id, row) => {
        const w = weights[row], vertices = Uint32Array.from({ length: n }, (_, i) => i).filter(i => w[i] > 1e-6);
        const minimum = new Float32Array(vertices.length * 3), maximum = new Float32Array(vertices.length * 3);
        const side = id.endsWith('.R') ? 'R' : 'L';
        const parent = shape === 'thigh' ? `femur.${side}` : shape === 'calf' ? `calf.${side}` : 'pelvis';
        const axes = this.referenceFrames[parent].axes;
        vertices.forEach((i, j) => {
          for (let k = 0; k < 3; k++) {
            minimum[j * 3 + k] = axes[k].reduce((sum, v, d) => sum + minimumShape[i * 3 + d] * v, 0) * w[i];
            maximum[j * 3 + k] = axes[k].reduce((sum, v, d) => sum + maximumShape[i * 3 + d] * v, 0) * w[i];
          }
        });
        bones.push({ id: `${shape}:${id}`, shape, parent, blocks: [id], vertices, small: minimum, large: maximum });
      });
    };
    bind('glute', [...map.groups.glute, ...map.groups.waist.filter(id => id.startsWith('lumbar.')),
      ...map.groups.thigh.filter(id => id.includes('.root.'))], small, large);

    // 腰的完整小／大形態承接肋緣、上腹及上臀；保留原生有號切向分量。
    // 腰側收束與前後厚度不同步，不能用一圈的等比縮放取代。
    bind('waist', [...map.groups.waist, 'abdomen.lower', ...map.groups.glute.filter(id => id.includes('.upper.'))],
      target('measure-waist-circ-decr'), target('measure-waist-circ-incr'));

    // 腹部使用完整的瘦／豐滿腹部材料：前凸、側展、下腹高度一起改變。
    // 腰側是共同承接，不另貼側腹球塊；骨盆前側保留附著而不把腹前往下整片拉長。
    const abdomenSmall = thin.slice(), abdomenLarge = full.slice();
    for (let i = 0; i < n; i++) {
      const z = P[i * 3 + 2] - this.pelvis[2];
      const front = ease(-2, 6, z);
      for (let k = 0; k < 3; k++) {
        abdomenSmall[i * 3 + k] *= front * (k === 1 ? 0.25 : 1);
        abdomenLarge[i * 3 + k] *= front * (k === 1 ? 0.2 : 0.8);
      }
    }
    bind('abdomen', [...map.groups.abdomen, ...map.groups.waist.filter(id => id.startsWith('waist.')),
      ...map.groups.thigh.filter(id => id.includes('.root.front.') || id.includes('.root.inner.'))],
      abdomenSmall, abdomenLarge);

    // 大腿保留前／後／內／外側的有號雕形，從根部逐步收至膝。
    // 上端包含臀下、側臀及骨盆前側，固定某一皮尺時也不能把根部切斷。
    const muscle = target('universal-female-young-maxmuscle-averageweight');
    const limbShape = (name: 'thigh' | 'calf', direction: 'decr' | 'incr') => {
      const field = target(`measure-${name}-circ-${direction}`);
      // 原始圍度雕形在中段過度集中；完整肌腹／覆蓋形態補足根部與遠端。
      // 這些是本專案的造型材料配比，不是人體統計或 UI 數值換算。
      for (let i = 0; i < field.length; i++) {
        field[i] = direction === 'decr' ? field[i] * 0.55 + thin[i] * 0.45
          : field[i] * (name === 'thigh' ? 0.45 : 0.25) + full[i] * 0.45 + muscle[i] * 0.5;
      }
      return field;
    };
    bind('thigh', [...map.groups.thigh, ...map.groups.glute.filter(id => id.includes('.lower.') || id.includes('.side.')),
      'pelvis.front', 'knee.L', 'knee.R'], limbShape('thigh', 'decr'), limbShape('thigh', 'incr'));

    // 小腿肚向後內側增厚，前脛骨及跟腱兩端承接；不把小腿當作圓柱。
    bind('calf', [...map.groups.calf, 'knee.L', 'knee.R', 'ankle.L', 'ankle.R'],
      limbShape('calf', 'decr'), limbShape('calf', 'incr'));
    this.bones = bones;
    // 共同驅動時先合併同父參照的骨；單骨操作仍使用原來綁定，無須改變造型。
    this.trajectories = [...new Set(bones.map(b => `${b.shape}/${b.parent}`))].map(key => {
      const members = bones.filter(b => `${b.shape}/${b.parent}` === key), first = members[0];
      const small = new Float32Array(n * 3), large = new Float32Array(n * 3);
      for (const b of members) b.vertices.forEach((i, j) => {
        for (let k = 0; k < 3; k++) { small[i * 3 + k] += b.small[j * 3 + k]; large[i * 3 + k] += b.large[j * 3 + k]; }
      });
      const vertices = Uint32Array.from({ length: n }, (_, i) => i).filter(i =>
        small[i * 3] || small[i * 3 + 1] || small[i * 3 + 2] || large[i * 3] || large[i * 3 + 1] || large[i * 3 + 2]);
      const pack = (field: Float32Array) => Float32Array.from({ length: vertices.length * 3 }, (_, j) => field[vertices[Math.floor(j / 3)] * 3 + j % 3]);
      return { ...first, id: key, vertices, small: pack(small), large: pack(large) };
    });
  }

  private frames(P: Float32Array): Record<string, { axes: V3[]; length: number }> {
    const J = (name: string) => centroid(P, ...this.asset.joints[name]);
    const frame = (top: V3, bottom: V3) => {
      const delta = sub(top, bottom), y = norm(delta), x = norm(cross(y, [0, 0, 1])), z = norm(cross(x, y));
      return { axes: [x, y, z], length: Math.hypot(...delta) };
    };
    const out: Record<string, { axes: V3[]; length: number }> = { pelvis: frame(J('neck'), J('pelvis')) };
    for (const side of ['L', 'R']) {
      const prefix = side.toLowerCase();
      out[`femur.${side}`] = frame(J(`${prefix}-upper-leg`), J(`${prefix}-knee`));
      out[`calf.${side}`] = frame(J(`${prefix}-knee`), J(`${prefix}-ankle`));
    }
    return out;
  }

  /** 同一形態也可由各形狀骨重現；boneState 只供既有控制介面單項驅動。 */
  apply(surface: Float32Array, state: Partial<Record<LowerShape, number>>, boneState: Readonly<Record<string, number>> = {}): void {
    const frames = this.frames(surface), scale = frames.pelvis.length / this.referenceFrames.pelvis.length;
    const source = Object.keys(boneState).length ? this.bones : this.trajectories;
    for (const bone of source) {
      const value = boneState[bone.id] ?? state[bone.shape] ?? 0;
      if (!Number.isFinite(value)) throw new Error(`無效造型位置：${bone.id}`);
      if (!value) continue;
      const frame = frames[bone.parent], along = frame.length / this.referenceFrames[bone.parent].length;
      bone.vertices.forEach((i, j) => {
        const x = displacement(bone.small[j * 3], bone.large[j * 3], value) * scale;
        const y = displacement(bone.small[j * 3 + 1], bone.large[j * 3 + 1], value) * along;
        const z = displacement(bone.small[j * 3 + 2], bone.large[j * 3 + 2], value) * scale;
        for (let k = 0; k < 3; k++) surface[i * 3 + k] += frame.axes[0][k] * x + frame.axes[1][k] * y + frame.axes[2][k] * z;
      });
    }
  }
}
