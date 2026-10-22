import type { Sex } from '../../core/measurements';
import { DEFAULT_MORPHOLOGY, type Morphology } from '../../core/morphology';
import { type BodyAsset, addTarget } from './asset';
import type { Measured } from './measure';
import type { Soft, SoftKey } from './rings';
import { type V3, centroid, norm, sub, cross } from './geometry';
import { LocalControlRig, toLocal, type BoundControl, type ControlFrame, type LocalTransform } from './localControls';

export const CONTROL_VERSION = 2;
export const ease = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export interface ShapeCondition { morphology: Morphology; bodyFat: number; muscle: number }
export const defaultCondition = (): ShapeCondition => ({ morphology: { ...DEFAULT_MORPHOLOGY }, bodyFat: 0.26, muscle: 0 });
export interface ShapeControl extends BoundControl {
  tissue: SoftKey;
  range: [number, number];
  boundary: string;
}
interface Band {
  id: string; key: SoftKey; y: number; up: number; down: number; angle: number; width: number;
  side?: number; part?: 'upper' | 'rear' | 'lower'; gain?: number;
}

/**
 * 全部控制在骨性父參照內運算。每個分區有自己的狀態及響應；公斤分類不合併自由度。
 * 變換從同一曲面求出再合成，鎖定欄位不參與綁定、支撐範圍或局部座標。
 */
export class SurfaceRig {
  readonly controls: ShapeControl[] = [];
  private readonly rig: LocalControlRig;
  private readonly reference: Record<string, ControlFrame>;
  private readonly kinds = new Map<string, { radial: number; drop: number }>();
  private readonly asset: BodyAsset;

  constructor(a: BodyAsset, B: Float32Array, adj: number[][], sex: Sex, marks: Measured['marks'],
    normals: Float32Array, bodyWeight: Float32Array, generalWeight: Float32Array,
    torsoWeight: Float32Array, torsoZ: (y: number) => number, spread: number, condition: ShapeCondition) {
    this.asset = a;
    this.reference = this.frames(B);
    const n = a.nBody, L = marks.underbustY - marks.crotchY;
    const H = centroid(B, ...a.joints['l-shoulder'])[1] - marks.underbustY;
    const female = sex === 'female', fat = ease(0.12, 0.42, condition.bodyFat);
    const projected = condition.morphology.hip === 'projected';
    const softBelly = condition.morphology.abdomen === 'soft';
    const bands: Band[] = [];
    const pair = (b: Band) => { for (const side of [1, -1]) bands.push({ ...b, id: `${b.id}${side > 0 ? 'L' : 'R'}`, side, angle: b.angle * side }); };
    const rearY = marks.hipY + (female ? -0.015 : 0.04) * L;
    // 相同支撐中的三個分割，總和為一；求解器可分別重分配上、後、下量體。
    for (const [part, key] of [['upper', 'gluteUpper'], ['rear', 'buttock'], ['lower', 'gluteLower']] as const) {
      pair({ id: `glute-${part}`, key, part, y: rearY, up: (female ? 0.62 : 0.65) * L,
        down: (0.36 + 0.12 * spread) * L, angle: Math.PI - (female ? 0.62 : 0.48),
        width: (female ? 1.05 : 0.98) + 0.25 * spread, gain: projected ? 1.16 : 1 });
    }
    pair({ id: 'lateral-glute', key: 'hipSide', y: marks.hipY + 0.07 * L,
      up: 0.58 * L, down: (0.42 + 0.1 * spread) * L, angle: Math.PI / 2 + 0.12,
      width: female ? 1.1 : 1, gain: projected ? 0.75 : 1 });
    pair({ id: 'lateral-root', key: 'hipRoot', y: marks.crotchY + 0.05 * L,
      up: 0.55 * L, down: 0.3 * L, angle: Math.PI / 2 + 0.12, width: female ? 1.1 : 0.9 });
    bands.push({ id: 'abdomen-front', key: 'belly', y: marks.crotchY + (female ? (softBelly ? 0.48 : 0.57) : 0.62) * L,
      up: (female ? 0.64 : 0.75) * L, down: 0.64 * L, angle: 0, width: female ? 1.65 : 1.85 });
    bands.push({ id: 'lower-abdominal-cover', key: 'lowerAbdomen', y: marks.crotchY + 0.27 * L,
      up: 0.5 * L, down: 0.48 * L, angle: 0, width: 1.65 });
    pair({ id: 'waist-side', key: 'flank', y: marks.waistY, up: 0.65 * L, down: 0.68 * L,
      angle: Math.PI / 2 + (female ? 0.16 : 0.3), width: 1.35 });
    bands.push({ id: 'lumbar', key: 'lowerBack', y: marks.waistY, up: 0.9 * L, down: 0.72 * L, angle: Math.PI, width: 1.5 });
    bands.push({ id: 'thoracic-back', key: 'upperBack', y: marks.underbustY + 0.2 * H,
      up: 0.85 * H, down: 1.35 * H, angle: Math.PI, width: 1.6 });
    if (!female) bands.push({ id: 'pectoral-cover', key: 'chest', y: marks.bustY,
      up: 0.9 * H, down: 1.3 * H, angle: 0, width: 1.65 });
    const regions = new Set(['torso', 'thighL', 'thighR', 'shoulderL', 'shoulderR', ...(!female ? ['breastL', 'breastR'] : [])].map(r => a.regions.indexOf(r)));
    const bind = (id: string, key: SoftKey, parent: string, weights: Float32Array, material?: Float32Array): ShapeControl => {
      const vertices = Uint32Array.from({ length: n }, (_, i) => i).filter(i => weights[i] > 0.00001);
      const frame = this.reference[parent];
      const control: ShapeControl = { id, parent, origin: [0, 0, 0], vertices,
        weights: Float32Array.from(vertices, i => Math.min(1, weights[i])), tissue: key,
        range: key.endsWith('Muscle') ? [-0.6, 1.8] : [-1.2, 12],
        boundary: '同一骨性父參照；支撐外零權重，交界從同一輸入曲面共同合成' };
      if (material) {
        control.material = new Float32Array(vertices.length * 3);
        vertices.forEach((i, row) => {
          for (let k = 0; k < 3; k++) control.material![row * 3 + k] = frame.axes[k].reduce((s, v, d) => s + v * material[i * 3 + d], 0);
        });
      }
      this.controls.push(control); return control;
    };
    for (const b of bands) {
      const w = new Float32Array(n), allowed = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!regions.has(a.region[i])) continue;
        const x = B[i * 3], y = B[i * 3 + 1];
        if (b.side && x * b.side <= 0) continue;
        const u = (y - b.y) / (y > b.y ? b.up : b.down);
        const angle = Math.abs(Math.atan2(Math.sin(Math.atan2(x, B[i * 3 + 2] - torsoZ(y)) - b.angle), Math.cos(Math.atan2(x, B[i * 3 + 2] - torsoZ(y)) - b.angle)));
        if (Math.abs(u) >= 1 || angle >= b.width) continue;
        allowed[i] = 1;
        // 分別平滑的縱向與環向帶：擴展側向不額外縮短上下承接。
        let weight = (1 - u * u) ** 2 * (1 - (angle / b.width) ** 2) ** 2;
        if (b.part) {
          const upper = ease(-0.05, 0.65, u), lower = 1 - ease(-0.7, 0.02, u);
          const middle = Math.max(0, 1 - upper - lower), sum = upper + lower + middle;
          weight *= (b.part === 'upper' ? upper : b.part === 'lower' ? lower : middle) / sum;
          weight *= ease(0, 2.5, Math.abs(x));
        }
        if (b.key === 'lowerAbdomen') weight *= 1 - ease(marks.waistY - 0.23 * L, marks.waistY, y);
        w[i] = weight * bodyWeight[i];
      }
      const tmp = new Float32Array(n);
      for (let pass = 0; pass < 5; pass++) {
        for (let i = 0; i < n; i++) {
          if (!allowed[i]) { tmp[i] = 0; continue; }
          tmp[i] = (2 * w[i] + adj[i].reduce((s, j) => s + w[j], 0)) / (adj[i].length + 2);
        }
        w.set(tmp);
      }
      const parent = b.key === 'upperBack' || b.key === 'chest' ? 'ribcage' : 'pelvis';
      const c = bind(b.id, b.key, parent, w);
      c.origin = toLocal(this.reference[parent], [0, b.y, torsoZ(b.y)]);
      this.kinds.set(c.id, { radial: (b.gain ?? 1) / (L * 0.31), drop: b.key === 'belly' && softBelly ? -0.025 * fat : 0 });
    }
    const general = new Float32Array(n * 3), other = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = B[i * 3], z = B[i * 3 + 2] - torsoZ(B[i * 3 + 1]), radius = Math.hypot(x, z) || 1;
      for (let k = 0; k < 3; k++) {
        const direction = normals[i * 3 + k] * (1 - torsoWeight[i]) + (k === 0 ? x / radius : k === 2 ? z / radius : 0) * torsoWeight[i];
        general[i * 3 + k] = direction * generalWeight[i];
        other[i * 3 + k] = direction * (0.65 * torsoWeight[i] + 0.35 * generalWeight[i]);
      }
    }
    bind('general-cover', 'general', 'pelvis', new Float32Array(n).fill(1), general);
    bind('other-lean-envelope', 'otherLean', 'pelvis', new Float32Array(n).fill(1), other);
    const native = new Float32Array(B.length);
    addTarget(a, `universal-${sex}-young-maxmuscle-averageweight`, 1, native);
    let rawLo = Infinity, rawHi = -Infinity;
    for (let i = 0; i < n; i++) { rawLo = Math.min(rawLo, a.base[i * 3 + 1]); rawHi = Math.max(rawHi, a.base[i * 3 + 1]); }
    const scale = (marks.topY - marks.soleY) / (rawHi - rawLo);
    for (const [zone, key] of [['pectoral-muscle', 'chestMuscle'], ['back-muscle', 'trunkMuscle'], ['glute-muscle', 'gluteMuscle']] as const) {
      const w = new Float32Array(n), material = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const y = B[i * 3 + 1], z = B[i * 3 + 2] - torsoZ(y);
        const pelvis = 1 - ease(marks.hipY, marks.waistY + 0.12 * L, y), front = ease(-3, 4, z);
        const partition = zone === 'glute-muscle' ? pelvis : (1 - pelvis) * (zone === 'pectoral-muscle' ? front : 1 - front);
        // 臀肌止於臀下接合區；大腿後側由自己的肌肉控制負責，不向膝延長臀肌。
        const attachment = ease(marks.crotchY - 0.12 * L, marks.crotchY + 0.14 * L, y);
        w[i] = partition * bodyWeight[i] * attachment * (regions.has(a.region[i]) ? 1 : 0);
        const x = B[i * 3], radius = Math.hypot(x, z) || 1;
        for (let k = 0; k < 3; k++) {
          // 完整有號原生形態 + 平順體量包絡：兩項分開，絕不將內收截成外推。
          // 原生目標含脂肪收束，不能直接把它的淨體積當一公斤骨骼肌。
          const envelope = k === 0 ? x / radius : k === 2 ? z / radius : 0;
          material[i * 3 + k] = native[i * 3 + k] * scale + envelope * (female ? 0.7 : 0.9);
        }
      }
      bind(zone, key, zone === 'glute-muscle' ? 'pelvis' : 'ribcage', w, material);
    }
    this.rig = new LocalControlRig(this.controls);
  }

  private frames(surface: Float32Array): Record<string, ControlFrame> {
    const J = (id: string) => centroid(surface, ...this.asset.joints[id]);
    const pelvis = J('pelvis'), neck = J('neck');
    const up = norm(sub(neck, pelvis)), across = norm(sub(J('l-upper-leg'), J('r-upper-leg')));
    const forward = norm(cross(across, up)), side = norm(cross(up, forward));
    const ribcage: V3 = pelvis.map((v, k) => v + (neck[k] - v) * 0.7) as V3;
    return { pelvis: { origin: pelvis, axes: [side, up, forward], scale: [1, 1, 1] },
      ribcage: { origin: ribcage, axes: [side, up, forward], scale: [1, 1, 1] } };
  }

  apply(out: Float32Array, soft: Soft, single?: { id: string; amount: number }): void {
    const state: Record<string, LocalTransform> = {};
    if (single && !this.controls.some(c => c.id === single.id)) throw new Error(`未知的單控制：${single.id}`);
    for (const c of this.controls) {
      const amount = (soft[c.tissue] ?? 0) + (single?.id === c.id ? single.amount : 0);
      if (!amount) continue;
      const kind = this.kinds.get(c.id);
      state[c.id] = kind ? { scale: [Math.max(0.1, 1 + amount * kind.radial), 1, Math.max(0.1, 1 + amount * kind.radial)],
        translation: [0, amount * kind.drop, 0] } : { material: amount };
    }
    this.rig.apply(out, this.frames(out), state, out);
  }
}
