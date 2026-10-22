import type { Sex } from '../../core/measurements';
import { DEFAULT_MORPHOLOGY, type Morphology } from '../../core/morphology';
import { type BodyAsset, addTarget } from './asset';
import type { Measured } from './measure';
import type { Soft, SoftKey } from './rings';
import { type V3, centroid } from './geometry';

export const CONTROL_VERSION = 1;
export const ease = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface ShapeCondition {
  morphology: Morphology;
  bodyFat: number;
  /** 相對素體的肌肉條件；不由形變後輸出體重反推。 */
  muscle: number;
  thighConstrained?: boolean;
}
export const defaultCondition = (): ShapeCondition => ({ morphology: { ...DEFAULT_MORPHOLOGY }, bodyFat: 0.26, muscle: 0 });

export interface ShapeControl {
  id: string;
  parent: 'pelvis' | 'ribcage' | 'spine' | 'hipL' | 'hipR';
  origin: V3;
  /** 局部三軸：向外、向上、向前。 */
  axes: [V3, V3, V3];
  tissue: SoftKey;
  range: [number, number];
  weights: Float32Array;
  displacement: Float32Array;
  boundary: string;
}

interface Band {
  id: string;
  key: SoftKey;
  y: number;
  up: number;
  down: number;
  angle: number;
  width: number;
  drop: number;
  side?: -1 | 1;
  gain?: number;
  part?: 'upper' | 'rear' | 'lower';
  taper?: number;
}

/**
 * 骨性局部座標上的控制帶。支撐先由資產分區與高度邊界建立，再沿拓撲平滑；
 * 不使用控制點的球形距離。分區的共同位移一次合成，公斤以合成後網格校準。
 */
export class SurfaceRig {
  readonly controls: ShapeControl[] = [];
  readonly fields = new Map<SoftKey, Float32Array>();

  constructor(a: BodyAsset, B: Float32Array, adj: number[][], sex: Sex, marks: Measured['marks'],
    normals: Float32Array, bodyWeight: Float32Array, generalWeight: Float32Array,
    torsoWeight: Float32Array, torsoZ: (y: number) => number, spread: number, condition: ShapeCondition) {
    const n = a.nBody, L = marks.underbustY - marks.crotchY;
    const H = centroid(B, ...a.joints['l-shoulder'])[1] - marks.underbustY;
    const female = sex === 'female';
    const fat = ease(0.12, 0.42, condition.bodyFat);
    const muscular = Math.tanh(condition.muscle);
    const projected = condition.morphology.hip === 'projected';
    const softBelly = condition.morphology.abdomen === 'soft';
    const bands: Band[] = [];
    const addPair = (band: Band) => {
      for (const sign of [1, -1] as const) bands.push({ ...band, id: `${band.id}${sign === 1 ? 'L' : 'R'}`, angle: band.angle * sign, side: sign });
    };
    // 女性覆蓋偏下、側向連接較長；男性臀肌較高，後側與腿後為主要走向。
    const rearY = female ? marks.hipY - (0.03 + 0.025 * fat) * L : marks.hipY + 0.035 * L;
    const rearUp = (female ? 0.55 + 0.25 * spread : 0.62 + 0.16 * spread) * L;
    const rearDown = (female ? (condition.thighConstrained ? 0.3 + 0.08 * spread : 0.4 + 0.29 * spread + 0.025 * fat) : 0.33 + 0.2 * spread) * L;
    for (const part of ['upper', 'rear', 'lower'] as const) addPair({
      id: `glute-${part}`, key: 'buttock', y: rearY, up: rearUp, down: rearDown,
      angle: Math.PI - (female ? 0.6 : 0.48), width: (female ? 0.76 : 0.9) + 0.44 * spread,
      drop: female ? 0.08 + 0.045 * fat : 0.025, gain: projected ? 1.16 : 1, part,
    });
    addPair({ id: 'lateral-glute', key: 'hipSide', y: marks.hipY + (female ? 0.08 - 0.03 * fat : 0.1) * L,
      up: (female ? 0.55 + 0.1 * spread : 0.51) * L,
      down: (female ? (condition.thighConstrained ? 0.32 : 0.45) : 0.32) * L,
      angle: Math.PI / 2 + (female ? 0.18 : 0.38), width: female ? 0.98 + 0.12 * spread : 1.02,
      drop: female ? 0.035 : 0.015, gain: (projected ? 0.75 : 1) * 0.7 });
    addPair({ id: 'lateral-root', key: 'hipSide', y: marks.crotchY + (female ? 0.055 : 0.14) * L,
      up: (female ? 0.6 + 0.13 * spread : 0.51) * L, down: (female ? (condition.thighConstrained ? 0.22 + 0.02 * spread : 0.35 + 0.12 * spread) : 0.42) * L,
      angle: Math.PI / 2 + (female ? 0.18 : 0.38), width: female ? 0.98 + 0.12 * spread : 1.02,
      drop: female ? 0.035 : 0.015, gain: (projected ? 0.75 : 1) * 0.3 });
    bands.push({ id: 'abdomen-front', key: 'belly',
      y: marks.crotchY + (female ? (softBelly ? 0.34 + 0.08 * fat : 0.47 + 0.02 * fat) : (softBelly ? 0.6 : 0.64)) * L,
      up: (female ? 0.5 + 0.09 * fat : 0.62) * L, down: (female ? 0.42 : 0.65) * L,
      angle: 0, width: (female ? 1.35 : 1.65) + 0.14 * fat, drop: softBelly ? (female ? 0.08 + 0.08 * fat : 0.2) : 0.02,
      taper: female ? 0.3 : 0.3 });
    bands.push({ id: 'lower-abdominal-cover', key: 'lowerAbdomen',
      y: marks.crotchY + (female ? 0.3 : 0.38) * L, up: 0.5 * L, down: 0.45 * L,
      angle: 0, width: female ? 1.45 : 1.65, drop: 0.06 + 0.08 * fat });
    addPair({ id: 'waist-side', key: 'flank', y: marks.waistY - (female ? 0.025 : -0.025) * L,
      up: (female ? 0.48 : 0.57) * L, down: (female ? 0.46 : 0.48) * L,
      angle: Math.PI / 2 + (female ? 0.22 : 0.4), width: 1.08 + 0.12 * fat, drop: 0.04 });
    bands.push({ id: 'lumbar', key: 'lowerBack', y: marks.waistY, up: 0.78 * L, down: 0.52 * L,
      angle: Math.PI, width: 1.35, drop: 0.015 });
    bands.push({ id: 'thoracic-back', key: 'upperBack', y: marks.underbustY + 0.2 * H,
      up: 0.65 * H, down: 1.08 * H, angle: Math.PI, width: 1.45, drop: 0 });
    // 男性胸脂為胸廓前方的廣覆蓋帶，不使用乳頭中心；其下外側可向下延伸。
    if (!female) bands.push({ id: 'pectoral-cover', key: 'chest', y: marks.bustY - 0.045 * H,
      up: 0.72 * H, down: (0.62 + 0.18 * fat) * H, angle: 0, width: 1.4, drop: 0.06 * fat });
    // 軀幹肌腹包含胸肩、背與臀上，與脂肪覆蓋的附著與位置不同。

    const regionSet = new Set(['torso', 'thighL', 'thighR', 'shoulderL', 'shoulderR'].map(r => a.regions.indexOf(r)));
    if (!female) for (const name of ['breastL', 'breastR']) regionSet.add(a.regions.indexOf(name));
    for (const band of bands) {
      const w = new Float32Array(n);
      const allowed = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!regionSet.has(a.region[i])) continue;
        const x = B[i * 3], y = B[i * 3 + 1], z = B[i * 3 + 2];
        if (band.side && band.side * x <= 0) continue;
        const u = (y - band.y) / (y > band.y ? band.up : band.down);
        if (Math.abs(u) >= 1) continue;
        const theta = Math.atan2(x, z - torsoZ(y));
        const angle = Math.abs(Math.atan2(Math.sin(theta - band.angle), Math.cos(theta - band.angle)));
        const width = band.width * (1 - (band.taper ?? 0) * ease(0, 1, -u));
        if (angle >= width) continue;
        allowed[i] = 1;
        const v = angle / width;
        const radial = Math.max(0, 1 - u * u - v * v) ** 2;
        const tensor = (1 - u * u) ** 2 * (1 - v * v) ** 2;
        const blend = band.key === 'buttock' || band.key === 'hipSide' ? 0.25 + 0.75 * spread : band.key === 'belly' || band.key === 'lowerAbdomen' ? 0 : 0.4;
        let weight = radial * (1 - blend) + tensor * blend;
        // 同一後臀支撐分成三段，分割和為一，不把三份體積重複相加。
        if (band.part) {
          const upper = ease(0, 0.6, u), lower = 1 - ease(-0.65, -0.05, u);
          weight *= band.part === 'upper' ? upper : band.part === 'lower' ? lower : 1 - upper - lower;
          if (band.part === 'upper') weight *= 1 + 0.15 * muscular;
          if (band.part === 'lower') weight *= 1 + 0.12 * fat;
        }
        // 骶尾正中漸變附著；不挖低兩側來製造中線。
        if (band.key === 'buttock') weight *= ease(0, 2.8, Math.abs(x));
        if (band.key === 'lowerAbdomen') weight *= 1 - ease(marks.waistY - 0.23 * L, marks.waistY - 0.02 * L, y);
        w[i] = weight * bodyWeight[i];
      }
      const tmp = new Float32Array(n);
      for (let pass = 0; pass < 8; pass++) {
        for (let i = 0; i < n; i++) {
          if (!allowed[i]) { tmp[i] = 0; continue; }
          let sum = 2 * w[i];
          for (const j of adj[i]) sum += w[j];
          tmp[i] = sum / (adj[i].length + 2);
        }
        w.set(tmp);
      }
      const field = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const gain = (band.gain ?? 1) * w[i];
        const x = B[i * 3], z = B[i * 3 + 2] - torsoZ(B[i * 3 + 1]);
        const radius = Math.hypot(x, z) || 1;
        // 骨盆覆蓋沿共同截面向外展開，不沿臀溝相向的法線推穿正中面。
        const direction = band.key === 'buttock' || band.key === 'hipSide' ? [x / radius, 0, z / radius] : normals.subarray(i * 3, i * 3 + 3);
        for (let k = 0; k < 3; k++) field[i * 3 + k] = gain * (direction[k] - (k === 1 ? band.drop * w[i] : 0));
      }
      if (band.key === 'belly' || band.key === 'lowerAbdomen' || band.key === 'chest') smoothDisplacement(field, adj, 8);
      const side = band.side ?? 1;
      const radius = L * 0.3;
      this.controls.push({ id: band.id, parent: band.key === 'upperBack' || band.key === 'chest' || band.id === 'pectoral-muscle' ? 'ribcage' : 'pelvis',
        origin: [Math.sin(band.angle) * radius, band.y, torsoZ(band.y) + Math.cos(band.angle) * radius],
        axes: [[side, 0, 0], [0, 1, 0], [0, 0, 1]], tissue: band.key, range: [0, 12], weights: w, displacement: field,
        boundary: '資產分區、上下控制帶與左右拓撲邊界固定；鄰區內部共享過渡' });
      const sum = this.fields.get(band.key) ?? new Float32Array(n * 3);
      for (let k = 0; k < sum.length; k++) sum[k] += field[k];
      this.fields.set(band.key, sum);
    }
    const general = new Float32Array(n * 3), other = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = B[i * 3 + 1], z = B[i * 3 + 2] - torsoZ(y);
      const chest = !female ? ease(marks.underbustY - 0.15 * H, marks.underbustY + 0.1 * H, y)
        * (1 - ease(marks.bustY + 0.5 * H, marks.bustY + 0.95 * H, y)) * ease(0, 5, z) * torsoWeight[i] : 0;
      const radial = torsoWeight[i] * (1 - ease(marks.waistY, marks.underbustY, y));
      const radius = Math.hypot(B[i * 3], z) || 1;
      for (let k = 0; k < 3; k++) {
        const outward = normals[i * 3 + k] * (1 - radial) + (k === 0 ? B[i * 3] / radius : k === 2 ? z / radius : 0) * radial;
        const direction = outward * (1 - chest) + (k === 2 ? chest : k === 0 ? 0.2 * chest * normals[i * 3] : 0);
        const armRegion = ['upperarmL', 'upperarmR'].some(r => a.region[i] === a.regions.indexOf(r));
        general[i * 3 + k] = direction * generalWeight[i] * (female && armRegion ? 0.8 : 1);
        // 其餘去脂採平順的胸腹包絡，不能沿胸肌法線鼓出假肌腹。
        // 肌肉增加、其餘去脂下降時，原生肌腹控制仍能保留自己的起伏。
        const envelope = normals[i * 3 + k] * (1 - torsoWeight[i])
          + (k === 0 ? B[i * 3] / radius : k === 2 ? z / radius : 0) * torsoWeight[i];
        other[i * 3 + k] = envelope * (0.65 * torsoWeight[i] + 0.35 * generalWeight[i]);
      }
    }
    this.fields.set('general', general);
    this.fields.set('otherLean', other);
    // CC0 原生肌肉校正保留胸大肌、背部及臀肌的整體曲面關係，
    // 以拓撲分區承接體量；不把去脂量堆成胸前的獨立圓頂。
    const native = new Float32Array(B.length);
    addTarget(a, `universal-${sex}-young-maxmuscle-averageweight`, 1, native);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { minY = Math.min(minY, a.base[i * 3 + 1]); maxY = Math.max(maxY, a.base[i * 3 + 1]); }
    const scale = (marks.topY - marks.soleY) / (maxY - minY);
    const nativeField = new Float32Array(n * 3);
    for (const zone of ['pectoral-muscle', 'back-muscle', 'glute-muscle'] as const) {
      const weights = new Float32Array(n), field = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const y = B[i * 3 + 1], z = B[i * 3 + 2] - torsoZ(y);
        const pelvis = 1 - ease(marks.hipY + 0.1 * L, marks.waistY, y);
        const front = ease(-2, 3, z);
        const partition = zone === 'glute-muscle' ? pelvis : (1 - pelvis) * (zone === 'pectoral-muscle' ? front : 1 - front);
        const upperThigh = ease(marks.crotchY - 0.65 * L, marks.crotchY - 0.2 * L, y)
          * (1 - ease(marks.crotchY, marks.crotchY + 0.3 * L, y));
        weights[i] = partition * Math.max(torsoWeight[i], bodyWeight[i] * upperThigh * pelvis);
        const j = i * 3, length = Math.hypot(normals[j], normals[j + 1], normals[j + 2]) || 1;
        const normal = [normals[j] / length, normals[j + 1] / length, normals[j + 2] / length];
        const projection = native[j] * normal[0] + native[j + 1] * normal[1] + native[j + 2] * normal[2];
        for (let k = 0; k < 3; k++) {
          // 原生 maxmuscle 同時含去脂收束，不能把其淨減少體積當「負的肌肉密度」。
          // 肌肉量控制只取向外肌腹及少量切向展開，減脂由脂肪帳另行負責。
          field[j + k] = (Math.max(0.05, projection) * normal[k] + 0.15 * (native[j + k] - projection * normal[k])) * weights[i] * scale;
          nativeField[i * 3 + k] += field[i * 3 + k];
        }
      }
      this.controls.push({ id: zone, parent: zone === 'glute-muscle' ? 'pelvis' : 'ribcage',
        origin: [0, zone === 'glute-muscle' ? marks.hipY : marks.bustY, torsoZ(marks.bustY)],
        axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], tissue: 'trunkMuscle', range: [-0.6, 1.8], weights,
        displacement: field, boundary: 'CC0 原生肌肉支撐、軀幹／腿根拓撲權重及共享分區' });
    }
    this.fields.set('trunkMuscle', nativeField);
  }

  apply(out: Float32Array, soft: Soft): void {
    for (const [key, field] of this.fields) {
      const amount = soft[key];
      if (!amount) continue;
      for (let i = 0; i < field.length; i++) out[i] += field[i] * amount;
    }
  }
}

/** 載入時建立連續的向量權重，避免不同方向的控制在交界形成梯級。 */
function smoothDisplacement(field: Float32Array, adj: number[][], passes: number): void {
  const tmp = new Float32Array(field.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < adj.length; i++) for (let k = 0; k < 3; k++) {
      let sum = field[i * 3 + k];
      for (const j of adj[i]) sum += field[j * 3 + k];
      tmp[i * 3 + k] = sum / (adj[i].length + 1);
    }
    field.set(tmp);
  }
}
