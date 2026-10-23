import form from './forms/femaleGlute.json';
import type { BodyAsset } from './asset';
import { adjacency, centroid, type V3 } from './geometry';
import { LocalControlRig, type BoundControl, type ControlFrame, type LocalTransform } from './localControls';
import { shapeBlocks } from './shapeBlocks';
import { SubdivisionSurface } from './subdivision';

/** 雕形進程，不是肌肉公斤、體脂率或臀圍；尚未接數據定錨。 */
export interface GluteFormState { muscle: number; fat: number }

/** 一個模型區塊的形狀骨，包含共同驅動的造型與肌脂通道。 */
export interface GluteFormBone {
  id: string;
  controls: readonly BoundControl[];
}

/**
 * 先完成的三維臀型 → 模型形狀骨的重現。
 * 位移全部來自可編輯的 Blender 資產，不在這裡用圍度材料重造外觀。
 * 目前僅重現女性參照框架；C1 其餘部位完成後才接框架及數據求解。
 */
export class GluteForm {
  readonly bones: readonly GluteFormBone[];
  readonly reference: Float32Array;
  private readonly rig: LocalControlRig;
  private readonly frame: ControlFrame;
  private surface?: SubdivisionSurface;

  constructor(private readonly asset: BodyAsset) {
    if (asset.nBody !== form.bodyVertexCount) throw new Error('臀型資產與模型拓撲不符');
    const blocks = shapeBlocks(asset);
    this.reference = blocks.reference;
    for (const row of form.rows) for (let k = 0; k < 3; k++) {
      if (Math.abs(this.reference[row[0] * 3 + k] - row[k + 1]) > 2e-5) {
        throw new Error('臀型來源網格已改變，須重新對應雕形資產');
      }
    }
    const origin = centroid(this.reference, ...asset.joints.pelvis);
    this.frame = { origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], scale: [1, 1, 1] };
    const ids = [...new Set(form.rows.map(row => blocks.owner[row[0]]))].sort();
    const neighbors = adjacency(asset.quads, asset.nBody);
    const weights = ids.map(id => Float32Array.from(blocks.owner, owner => owner === id ? 1 : 0));
    const temporary = new Float32Array(asset.nBody);
    // 交界共同承擔已完成的曲面位移；平滑的是骨權重，不能再平滑或改寫目標曲面。
    for (const weight of weights) for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < weight.length; i++) {
        temporary[i] = (2 * weight[i] + neighbors[i].reduce((sum, j) => sum + weight[j], 0)) / (2 + neighbors[i].length);
      }
      weight.set(temporary);
    }
    for (const row of form.rows) {
      const i = row[0], sum = weights.reduce((total, weight) => total + weight[i], 0);
      for (const weight of weights) weight[i] /= sum;
    }
    this.bones = ids.map((id, b) => {
      const rows = form.rows.filter(row => weights[b][row[0]] > 0);
      const vertices = Uint32Array.from(rows, row => row[0]);
      const weight = Float32Array.from(vertices, i => weights[b][i]);
      const center = blocks.blocks.get(id)!.center.map((v, k) => v - origin[k]) as V3;
      const controls = form.channels.map((channel, c): BoundControl => ({
        id: `${id}/${channel}`, parent: 'pelvis', origin: center, vertices, weights: weight,
        material: Float32Array.from(rows.flatMap(row => row.slice(4 + 3 * c, 7 + 3 * c))),
      }));
      return { id, controls };
    });
    this.rig = new LocalControlRig(this.bones.flatMap(bone => bone.controls));
  }

  /** 從同一參照重建，無前一次形變殘留；不得把造型端點當作可無限外插的尺寸。 */
  evaluate({ muscle, fat }: GluteFormState): Float32Array {
    if (![muscle, fat].every(v => Number.isFinite(v) && v >= -1 && v <= 1)) {
      throw new Error('臀型造型進程須介於 -1 與 1；數值定錨尚未建立');
    }
    // 與資產的連續驅動相同：基礎造型、肌肉、脂肪及兩者共同承接。
    const values = [1, muscle, muscle * muscle, fat, fat * fat, muscle * fat];
    const state: Record<string, LocalTransform> = {};
    for (const bone of this.bones) bone.controls.forEach((control, i) => {
      state[control.id] = { material: values[i] };
    });
    return this.rig.apply(this.reference, { pelvis: this.frame }, state);
  }

  /** 與雕形稿相同的二級細分；後續數值定錨須量這個表面，不能只在顯示端細分。 */
  evaluateSurface(state: GluteFormState): { positions: Float32Array; indices: Uint32Array } {
    this.surface ??= new SubdivisionSurface(this.asset.quads, this.asset.nBody);
    return { positions: this.surface.evaluate(this.evaluate(state)), indices: this.surface.indices };
  }
}
