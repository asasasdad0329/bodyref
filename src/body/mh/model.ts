import type { BodyAsset } from './asset';
import { type V3, adjacency, centroid, smooth, taubin } from './geometry';

// 把求解好的網格整理成畫面上的樣子：乳頭附近抹平、表面去掉細小凹凸、手臂轉到指定角度。
// 形狀本身由 rings.ts 決定，這裡不改任何量測。

export class BodyModel {
  readonly adj: number[][];
  readonly nippleVerts: Uint32Array;
  /** 顯示前要抹平的頂點（手、腳的細節保留） */
  private readonly surfaceVerts: Uint32Array;
  private readonly deltaSupports = new WeakMap<Uint32Array, Uint32Array>();

  constructor(readonly asset: BodyAsset) {
    this.adj = adjacency(asset.quads, asset.nBody);
    // 尖端標記跟隨 CC0 材料的實際支撐；素體上的固定半徑在大杯時會涵蓋整片下極。
    this.nippleVerts = Uint32Array.from(asset.targets.get('nipple-point-decr')!.indices).filter(i => i < asset.nBody);
    const tips = new Set(['handL', 'handR', 'footL', 'footR'].map((r) => asset.regions.indexOf(r)));
    const surface: number[] = [];
    for (let i = 0; i < asset.nBody; i++) if (!tips.has(asset.region[i])) surface.push(i);
    this.surfaceVerts = Uint32Array.from(surface);
  }

  /** 顯示用網格：乳頭附近抹平、整體表面去掉細小凹凸，手臂轉到指定的外展角度 */
  finish(P: Float32Array): void {
    smooth(P, this.adj, this.nippleVerts, 2, 0.3);
    taubin(P, this.adj, this.surfaceVerts, 4);
  }

  /** 平滑為線性算子；只傳播兩曲面的局部差，避免再平滑整份胸壁。 */
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
    const delta = new Float32Array(shaped.length);
    for (const i of support) for (let k = 0; k < 3; k++) delta[i * 3 + k] = shaped[i * 3 + k] - base[i * 3 + k];
    this.finish(shaped);
    smooth(delta, this.adj, this.nippleVerts, 2, 0.3);
    taubin(delta, this.adj, affected, 4);
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
