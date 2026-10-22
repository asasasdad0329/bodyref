import type { BodyAsset } from './asset';
import { type V3, adjacency, centroid, smooth } from './geometry';

// 中性曲面整理是求解與量測的一部分；姿勢只在完成後套用，不另修輪廓。

export class BodyModel {
  readonly adj: number[][];
  readonly nippleVerts: Uint32Array;
  /** 顯示前要抹平的頂點（手、腳的細節保留） */
  private readonly surfaceVerts: Uint32Array;
  private readonly contactVerts: Uint32Array;
  private deltaScratch?: Float32Array;
  private readonly deltaSupports = new WeakMap<Uint32Array, Uint32Array>();

  constructor(readonly asset: BodyAsset) {
    this.adj = adjacency(asset.quads, asset.nBody);
    // 尖端標記跟隨 CC0 材料的實際支撐；素體上的固定半徑在大杯時會涵蓋整片下極。
    this.nippleVerts = Uint32Array.from(asset.targets.get('nipple-point-decr')!.indices).filter(i => i < asset.nBody);
    const tips = new Set(['handL', 'handR', 'footL', 'footR'].map((r) => asset.regions.indexOf(r)));
    const surface: number[] = [];
    for (let i = 0; i < asset.nBody; i++) if (!tips.has(asset.region[i])) surface.push(i);
    this.surfaceVerts = Uint32Array.from(surface);
    const bilateral = new Set(['torso', 'breastL', 'breastR', 'thighL', 'thighR'].map(r => asset.regions.indexOf(r)));
    this.contactVerts = Uint32Array.from(surface.filter(i => bilateral.has(asset.region[i]) && Math.abs(asset.base[i * 3]) > 1e-5));
  }

  /** 中性表面的受限平滑；內腿、臀溝和胸骨附著不因負步長穿過另一側。 */
  finish(P: Float32Array): void {
    smooth(P, this.adj, this.nippleVerts, 2, 0.3);
    for (let pass = 0; pass < 4; pass++) {
      smooth(P, this.adj, this.surfaceVerts, 1, 0.5);
      smooth(P, this.adj, this.surfaceVerts, 1, -0.53);
      for (const i of this.contactVerts) {
        const side = Math.sign(this.asset.base[i * 3]);
        P[i * 3] = side * Math.max(Math.min(0.005, Math.abs(this.asset.base[i * 3]) * 0.1), side * P[i * 3]);
      }
    }
  }

  /** 並行傳播局部差；接觸投影也同時作用於兩曲面，避免再平滑整份胸壁。 */
  finishPair(base: Float32Array, shaped: Float32Array, support: Uint32Array): void {
    let affected = this.deltaSupports.get(support);
    if (!affected) {
      const reach = new Set(support);
      const surface = new Set(this.surfaceVerts);
      // 四輪 Taubin 各有正、負兩步；每步最多沿拓撲傳播一圈。
      for (let pass = 0; pass < 8; pass++) {
        for (const i of [...reach]) for (const j of this.adj[i]) if (surface.has(j)) reach.add(j);
      }
      affected = Uint32Array.from(reach).filter(i => surface.has(i));
      this.deltaSupports.set(support, affected);
    }
    if (this.deltaScratch?.length !== shaped.length) this.deltaScratch = new Float32Array(shaped.length);
    const delta = this.deltaScratch; delta.fill(0);
    for (const i of support) for (let k = 0; k < 3; k++) delta[i * 3 + k] = shaped[i * 3 + k] - base[i * 3 + k];
    smooth(shaped, this.adj, this.nippleVerts, 2, 0.3);
    smooth(delta, this.adj, this.nippleVerts, 2, 0.3);
    for (let pass = 0; pass < 4; pass++) {
      for (const factor of [0.5, -0.53]) {
        smooth(shaped, this.adj, this.surfaceVerts, 1, factor);
        smooth(delta, this.adj, affected, 1, factor);
      }
      for (const i of this.contactVerts) {
        const side = Math.sign(this.asset.base[i * 3]), originalBase = shaped[i * 3] - delta[i * 3];
        const margin = Math.min(0.005, Math.abs(this.asset.base[i * 3]) * 0.1);
        shaped[i * 3] = side * Math.max(margin, side * shaped[i * 3]);
        delta[i * 3] = shaped[i * 3] - side * Math.max(margin, side * originalBase);
      }
    }
    for (let i = 0; i < base.length; i++) base[i] = shaped[i] - delta[i];
  }

  display(rest: Float32Array, armAngle: number, polish = true): { P: Float32Array; armRotation: { L: ArmPose; R: ArmPose } } {
    const P = new Float32Array(rest);
    if (polish) this.finish(P);
    const rot = { L: this.poseArm(P, 'L', armAngle), R: this.poseArm(P, 'R', armAngle) };
    return { P, armRotation: rot };
  }

  /** 以肩關節為中心，把手臂轉到與垂直線夾 angle 度（線性混合蒙皮） */
  private poseArm(P: Float32Array, side: 'L' | 'R', angle: number): ArmPose {
    const a = this.asset;
    const j = side === 'L' ? 'l' : 'r';
    const sh = centroid(P, ...a.joints[`${j}-shoulder`]);
    const wr = centroid(P, ...a.joints[`${j}-hand`]);
    const sign = side === 'L' ? 1 : -1;
    const current = Math.atan2(sign * (wr[0] - sh[0]), sh[1] - wr[1]);
    const theta = sign * ((angle * Math.PI) / 180 - current);
    const c = Math.cos(theta), sn = Math.sin(theta);
    const W = a.armWeight[side];
    const rotate = (i: number, w: number) => {
      const x = P[i * 3] - sh[0], y = P[i * 3 + 1] - sh[1];
      const rx = c * x - sn * y, ry = sn * x + c * y;
      P[i * 3] = sh[0] + x + (rx - x) * w;
      P[i * 3 + 1] = sh[1] + y + (ry - y) * w;
    };
    for (let i = 0; i < a.nBody; i++) if (W[i] > 0) rotate(i, W[i]);
    for (const name of [`${j}-elbow`, `${j}-hand`]) {
      const [st, cnt] = a.joints[name];
      for (let i = st; i < st + cnt; i++) rotate(i, 1);
    }
    return { pivot: sh, theta };
  }
}

export interface ArmPose {
  pivot: V3;
  /** 繞 z 軸的旋轉角（弧度） */
  theta: number;
}

/** 把點繞肩關節（z 軸）旋轉，用來移動手臂上的量測線 */
export function rotateArmPoint(p: V3, pose: ArmPose): V3 {
  const c = Math.cos(pose.theta), s = Math.sin(pose.theta);
  const x = p[0] - pose.pivot[0], y = p[1] - pose.pivot[1];
  return [pose.pivot[0] + c * x - s * y, pose.pivot[1] + s * x + c * y, p[2]];
}
