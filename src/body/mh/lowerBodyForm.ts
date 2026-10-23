import form from './forms/femaleLowerBody.json';
import type { BodyAsset } from './asset';
import { adjacency, centroid } from './geometry';
import { LocalControlRig, type BoundControl, type LocalTransform } from './localControls';
import { shapeBlocks } from './shapeBlocks';
import type { Soft } from './rings';
import type { ShapeCondition } from './controls';
import { LowerBodySurface } from './lowerBodySurface';

export type LowerBodyState = Partial<Record<string, number>>;
const ease = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// 雕形區間外沿端點切線延伸，避免平方項在縮小端反向膨脹。
const curve = (v: number) => Math.abs(v) <= 1 ? v * v : 2 * Math.abs(v) - 1;

/** 已雕製的五部位曲面，經 B 的模型區塊綁成形狀骨。 */
export class LowerBodyForm {
  readonly reference: Float32Array;
  readonly ownership: Float32Array;
  readonly controls: readonly BoundControl[];
  private readonly rig: LocalControlRig;
  private readonly channel: string[] = [];
  private readonly neighbors: number[][];
  private evaluatedSurface?: LowerBodySurface;
  get surface(): LowerBodySurface { return this.evaluatedSurface ??= new LowerBodySurface(this.asset, this.ownership); }

  constructor(private readonly asset: BodyAsset) {
    if (asset.nBody !== form.bodyVertexCount) throw new Error('C1 雕形拓撲不符');
    const blocks = shapeBlocks(asset);
    this.reference = blocks.reference;
    this.neighbors = adjacency(asset.quads, asset.nBody);
    this.ownership = Float32Array.from({ length: asset.nBody }, (_, i) => {
      const r = asset.regions[asset.region[i]];
      return r === 'torso' ? 1 - ease(18, 24, this.reference[i * 3 + 1])
        : /^(thigh|calf|foot)/.test(r) ? 1 : 0;
    });
    const ids = [...new Set(form.rows.map(row => blocks.owner[row[0]]))].sort();
    const weights = ids.map(id => Float32Array.from(blocks.owner, owner => owner === id ? 1 : 0));
    const temporary = new Float32Array(asset.nBody);
    for (const weight of weights) for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < weight.length; i++) {
        temporary[i] = (2 * weight[i] + this.neighbors[i].reduce((s, j) => s + weight[j], 0)) / (2 + this.neighbors[i].length);
      }
      weight.set(temporary);
    }
    for (const row of form.rows) {
      const i = row[0], sum = weights.reduce((s, w) => s + w[i], 0);
      for (const w of weights) w[i] /= sum;
      for (let k = 0; k < 3; k++) if (Math.abs(this.reference[i * 3 + k] - row[k + 1]) > 2e-5) {
        throw new Error('C1 來源網格改變，須重新綁定');
      }
    }
    const controls: BoundControl[] = [];
    ids.forEach((id, b) => form.channels.forEach((ch, c) => {
      const rows = form.rows.filter(row => weights[b][row[0]] > 0 && row.slice(4 + c * 3, 7 + c * 3).some(v => v !== 0));
      if (!rows.length) return;
      controls.push({ id: `${id}/${ch.id}`, parent: 'shape', origin: [0, 0, 0],
        vertices: Uint32Array.from(rows, row => row[0]), weights: Float32Array.from(rows, row => weights[b][row[0]]),
        material: Float32Array.from(rows.flatMap(row => row.slice(4 + c * 3, 7 + c * 3))) });
      this.channel.push(ch.id);
    }));
    this.controls = controls;
    this.rig = new LocalControlRig(controls);
  }

  /** 未接數據的雕形重現，供與 Blender 中間狀態比對。 */
  evaluate(state: LowerBodyState): Float32Array {
    return this.apply(this.reference, state, true);
  }

  apply(source: Float32Array, state: LowerBodyState, pose = false, scale = 1,
    output: Float32Array = new Float32Array(source)): Float32Array {
    const values = Object.fromEntries(form.channels.map(ch => [ch.id, ch.id === 'pose' ? (pose ? 1 : 0)
      : ch.factors.length === 2 && ch.factors[0] === ch.factors[1] ? curve(state[ch.factors[0]] ?? 0)
      : ch.factors.reduce((v, name) => v * (state[name] ?? 0), 1)]));
    const transforms: Record<string, LocalTransform> = {};
    this.controls.forEach((c, i) => {
      const value = values[this.channel[i]] * scale;
      if (value) transforms[c.id] = { material: value };
    });
    return this.rig.apply(source, { shape: { origin: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], scale: [1, 1, 1] } }, transforms, output);
  }

  /** 骨架長度改變後的尺度由骨性高度求得，不取目前脂肪外輪廓。 */
  scale(B: Float32Array): number {
    const height = (P: Float32Array) => centroid(P, ...this.asset.joints.neck)[1] - centroid(P, ...this.asset.joints['l-ankle'])[1];
    return height(B) / height(this.reference);
  }

  /**
   * 數據相依性：圍度是曲面求解目標；kg 經實際體積校準成 soft 後，
   * 才走已完成的脂肪、肌肉通道。這些倍率是參數單位，非醫學 cm/kg。
   */
  state(q: Record<'hip' | 'waist' | 'thigh' | 'calf', number>, s: Soft, condition: ShapeCondition): LowerBodyState {
    const cover = s.general * .45, lean = s.otherLean * .28;
    return {
      hip: (q.hip - 1) * 4 + (s.buttock + s.gluteUpper + s.gluteLower + s.hipSide + s.hipRoot) * .13,
      hip_upper: s.gluteUpper * .3, hip_lower: s.gluteLower * .3,
      hip_side: s.hipSide * .3, hip_root: s.hipRoot * .3,
      hip_profile: condition.morphology.hip === 'projected' ? 1 : 0,
      glute_fat: cover * .8 + (s.buttock + s.gluteLower + s.hipSide + s.hipRoot) * .07,
      glute_muscle: s.gluteMuscle + lean,
      waist: (q.waist - 1) * 4 + .45 * (s.flank + s.lowerBack + s.general),
      waist_fat: cover * 2 + s.flank * .55 + s.lowerBack * .35,
      waist_muscle: s.trunkMuscle * .65 + lean,
      abdomen: s.belly * .25 + s.lowerAbdomen * .12,
      abdomen_fat: cover * 2 + s.lowerAbdomen * .25,
      abdomen_muscle: s.trunkMuscle * .55 + lean,
      abdomen_profile: condition.morphology.abdomen === 'smooth' ? 1 : 0,
      thigh: (q.thigh - 1) * 3.7,
      thigh_fat: cover * .6 + s.thighFat * 5 + s.thighCover * 2,
      thigh_muscle: s.thighMuscle * 5 + lean,
      calf: (q.calf - 1) * 4,
      calf_fat: cover * .5 + s.calfFat * 6,
      calf_muscle: s.calfMuscle * 5 + lean * .6,
    };
  }

  /** 同一份細分幾何用於量測、體積和顯示。 */
  sampleSurface(P: Float32Array): void { this.surface.update(P); }
}
