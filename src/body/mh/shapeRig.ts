import type { BodyAsset } from './asset';
import { smoothField, type V3 } from './geometry';
import type { Measured } from './measure';
import type { Soft } from './rings';

const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

export interface ShapeBone {
  name: string;
  parent: 'pelvis' | 'lumbar' | 'thorax';
  pivot: V3;
  radial: V3;
  /** 在局部座標允許的平移方向；姿勢骨架不使用這些控制。 */
  axes: readonly ['radial', 'vertical'];
}

/**
 * 截面骨的局部延伸：相鄰高度與環向控制共享、正規化的蒙皮權重。
 * 參照由當前造型的標記點建立，所以同一尺寸在不同肌脂形態有不同響應。
 * 結構依據與造型校準的區別見 docs/SHAPE_EVIDENCE.md。
 */
export class SurfaceRig {
  readonly bones: ShapeBone[] = [];
  readonly indices: Int16Array;
  readonly weights: Float32Array;
  private readonly layers = 7;
  private readonly sectors = 12;
  private readonly influences = 16;

  constructor(a: BodyAsset, B: Float32Array, marks: Measured['marks'], adj: number[][],
    torsoZ: (y: number) => number, acromionY: number, male: boolean) {
    const L = marks.underbustY - marks.crotchY;
    const ys = [marks.crotchY - 0.35 * L, marks.crotchY + 0.02 * L, marks.hipY,
      marks.waistY, marks.underbustY, marks.bustY, acromionY];
    for (let j = 1; j < ys.length; j++) ys[j] = Math.max(ys[j], ys[j - 1] + 0.5);
    for (let j = 0; j < this.layers; j++) for (let k = 0; k < this.sectors; k++) {
      const theta = k * 2 * Math.PI / this.sectors;
      this.bones.push({ name: `${['thighRoot', 'lowerGlute', 'hip', 'waist', 'lowerThorax', 'chest', 'shoulder'][j]}:${k}`,
        parent: j < 3 ? 'pelvis' : j === 3 ? 'lumbar' : 'thorax',
        pivot: [0, ys[j], torsoZ(ys[j])], radial: [Math.sin(theta), 0, Math.cos(theta)], axes: ['radial', 'vertical'] });
    }
    const allowed = new Set(['torso', 'thighL', 'thighR', 'shoulderL', 'shoulderR',
      ...(male ? ['breastL', 'breastR'] : [])].map((r) => a.regions.indexOf(r)));
    const coverage = Float32Array.from({ length: a.nBody }, (_, i) => allowed.has(a.region[i]) ? 1 : 0);
    smoothField(coverage, adj, 6);
    this.indices = new Int16Array(a.nBody * this.influences).fill(-1);
    this.weights = new Float32Array(a.nBody * this.influences);
    // 非負三次 B 樣條權重，控制點不必穿過表面；交界保有二階連續性。
    const knots = [ys[0], ys[0], ys[0], ys[0],
      (ys[1] + ys[2] + ys[3]) / 3, (ys[2] + ys[3] + ys[4]) / 3,
      (ys[3] + ys[4] + ys[5]) / 3, ys[6], ys[6], ys[6], ys[6]];
    const basis = (k: number, degree: number, y: number): number => {
      if (!degree) return y >= knots[k] && y < knots[k + 1] ? 1 : 0;
      const left = knots[k + degree] - knots[k], right = knots[k + degree + 1] - knots[k + 1];
      return (left ? (y - knots[k]) / left * basis(k, degree - 1, y) : 0)
        + (right ? (knots[k + degree + 1] - y) / right * basis(k + 1, degree - 1, y) : 0);
    };
    for (let i = 0; i < a.nBody; i++) {
      const x = B[i * 3], y = B[i * 3 + 1], z = B[i * 3 + 2];
      if (y <= ys[0] || y >= ys.at(-1)! || coverage[i] < 1e-4) continue;
      let theta = Math.atan2(x, z - torsoZ(y));
      if (theta < 0) theta += Math.PI * 2;
      const t = theta * this.sectors / (2 * Math.PI), sector = Math.floor(t), u = t - sector;
      const angular = [(1 - u) ** 3 / 6, (3 * u ** 3 - 6 * u * u + 4) / 6,
        (-3 * u ** 3 + 3 * u * u + 3 * u + 1) / 6, u ** 3 / 6];
      const fade = coverage[i] * smooth((y - ys[0]) / (ys[1] - ys[0])) * smooth((ys.at(-1)! - y) / (ys.at(-1)! - ys.at(-2)!));
      let slot = i * this.influences;
      for (let layer = 0; layer < this.layers; layer++) {
        const v = basis(layer, 3, y);
        if (v < 1e-9) continue;
        for (let k = 0; k < 4; k++, slot++) {
          this.indices[slot] = layer * this.sectors + (sector + k - 1 + this.sectors) % this.sectors;
          this.weights[slot] = v * angular[k] * fade;
        }
      }
    }
  }

  /** 區域量體驅動同一控制網；每個頂點只合成一次，相鄰控制不重複推出交界。 */
  apply(out: Float32Array, soft: Soft, spread: number, male: boolean): void {
    const delta = new Float32Array(this.bones.length * 3);
    const rear = [0, 0.38, 1, 0.12, 0, 0, 0];
    const side = [0, 0.72, 1, 0.16, 0, 0, 0];
    const belly = male ? [0, 0.12, 0.65, 1, 0.4, 0.08, 0] : [0, 0.12, 0.65, 1, 0.12, 0, 0];
    const flank = [0, 0, 0.38, 1, 0.18, 0, 0];
    const lower = [0, 0.08, 0.4, 1, 0.35, 0.05, 0];
    const upper = [0, 0, 0, 0.2, 0.75, 1, 0];
    const trunk = [0, 0.12, 0.35, 0.65, 0.8, 1, 0];
    const chest = [0, 0, 0, 0, 0.45, 1, 0];
    for (let b = 0; b < this.bones.length; b++) {
      const j = Math.floor(b / this.sectors), bone = this.bones[b];
      const [sx, , cz] = bone.radial;
      const front = Math.max(0, cz), back = Math.max(0, -cz), lateral = Math.abs(sx);
      // 骶尾中線相對受限；減薄時維持整片後側，避免切出兩道負向溝。
      const gluteAngle = back * (0.35 + 0.65 * lateral);
      const gluteLayer = rear[j] + spread * (j === 1 ? 0.18 : j === 3 ? 0.12 : 0);
      const sideLayer = side[j] + spread * (j === 1 ? 0.15 : 0);
      const glute = soft.buttock * gluteLayer * gluteAngle;
      const amplitude = glute + soft.hipSide * sideLayer * lateral * lateral
        + soft.belly * belly[j] * front * front
        + soft.flank * flank[j] * lateral * lateral
        + soft.lowerBack * lower[j] * back * back
        + soft.upperBack * upper[j] * back * back
        + soft.trunkMuscle * trunk[j] * (0.45 + 0.55 * Math.abs(cz))
        + (male ? soft.chest * chest[j] * front * front : 0);
      delta[b * 3] = amplitude * sx;
      delta[b * 3 + 1] = -Math.max(0, glute) * (j === 1 ? 0.08 : 0.03);
      delta[b * 3 + 2] = amplitude * cz;
    }
    for (let i = 0; i < this.indices.length / this.influences; i++) {
      for (let k = 0; k < this.influences; k++) {
        const index = this.indices[i * this.influences + k];
        if (index < 0) continue;
        const w = this.weights[i * this.influences + k];
        for (let d = 0; d < 3; d++) out[i * 3 + d] += w * delta[index * 3 + d];
      }
    }
  }
}

/** 乳房根部至原曲面的局部控制；保留原模型上下極差異，不重建解析半球。 */
export class BreastRig {
  readonly projection: Float32Array;
  readonly weights: Float32Array;
  readonly centerX: [number, number];
  private readonly vertical: Float32Array;

  constructor(a: BodyAsset, B: Float32Array, adj: number[][]) {
    this.projection = new Float32Array(a.nBody);
    this.weights = new Float32Array(a.nBody);
    this.vertical = new Float32Array(a.nBody);
    this.centerX = [B[a.landmarks.bustApexL * 3], B[a.landmarks.bustApexR * 3]];
    for (const region of ['breastL', 'breastR']) {
      const r = a.regions.indexOf(region);
      const ids = Array.from({ length: a.nBody }, (_, i) => i).filter((i) => a.region[i] === r);
      const boundary = new Set(ids.filter((i) => adj[i].some((j) => a.region[j] !== r)));
      const z = new Float32Array(a.nBody);
      const mean = ids.filter((i) => boundary.has(i)).reduce((s, i) => s + B[i * 3 + 2], 0) / boundary.size;
      for (const i of ids) z[i] = boundary.has(i) ? B[i * 3 + 2] : mean;
      // 根部邊界固定，內部調和延拓估計支撐面；不把量測高度當平面切口。
      for (let it = 0; it < 160; it++) for (const i of ids) {
        if (boundary.has(i)) continue;
        z[i] = adj[i].reduce((s, j) => s + (a.region[j] === r ? z[j] : B[j * 3 + 2]), 0) / adj[i].length;
      }
      let max = 0;
      for (const i of ids) { this.projection[i] = Math.max(0, B[i * 3 + 2] - z[i]); max = Math.max(max, this.projection[i]); }
      for (const i of ids) this.weights[i] = max ? smooth(this.projection[i] / max) : 0;
      const peakY = B[a.landmarks[region === 'breastL' ? 'bustApexL' : 'bustApexR'] * 3 + 1];
      for (const i of ids) {
        const y = B[i * 3 + 1] - peakY;
        this.vertical[i] = y * this.weights[i];
      }
    }
  }

  apply(out: Float32Array, amount: number): void {
    const scale = Math.exp(amount * 1.2) - 1;
    for (let i = 0; i < this.weights.length; i++) {
      const w = this.weights[i];
      if (!w) continue;
      const center = this.centerX[out[i * 3] >= 0 ? 0 : 1];
      // 根部權重漸近 0，內部採同一局部尺度；不只把胸峰往前拉成長錐。
      out[i * 3] += (out[i * 3] - center) * scale * w;
      out[i * 3 + 1] += this.vertical[i] * Math.max(0, scale);
      out[i * 3 + 2] += this.projection[i] * scale;
    }
  }

  /** 對同一網格逆轉大小控制，供體積記帳取得相同胸廓下的零增量參照。 */
  remove(out: Float32Array, amount: number): void {
    const scale = Math.exp(amount * 1.2) - 1;
    for (let i = 0; i < this.weights.length; i++) {
      const w = this.weights[i];
      if (!w) continue;
      const center = this.centerX[out[i * 3] >= 0 ? 0 : 1];
      const c = scale * w;
      out[i * 3] = (out[i * 3] + center * c) / (1 + c);
      out[i * 3 + 1] -= this.vertical[i] * Math.max(0, scale);
      out[i * 3 + 2] -= this.projection[i] * scale;
    }
  }
}
