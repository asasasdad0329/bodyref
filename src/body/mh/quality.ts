import type { BodyAsset } from './asset';
import { intersectionPairs } from './intersections';

export interface ShapeQuality {
  valid: boolean;
  collapsedFaces: number;
  foldedFaces: number;
  nonFinite: number;
  intersectingPairs: number;
}

/**
 * 幾何故障護欄，不是「自然人體」評分。以同一拓撲的中性參照排除既有細節，
 * 攔截新增的面積塌縮與四邊面折返；正常乳下褶、臀褶不因看見界線便被磨平。
 * 外觀與跨區輪廓仍須另以多視角驗收。
 */
export class SurfaceQuality {
  private readonly faces: Uint32Array;
  private readonly reference: Float64Array;
  private readonly referenceIntersections: Set<number>;
  constructor(private readonly asset: BodyAsset, base: Float32Array) {
    const regions = new Set(['torso', 'breastL', 'breastR', 'thighL', 'thighR', 'shoulderL', 'shoulderR', 'upperarmL', 'upperarmR'].map(r => asset.regions.indexOf(r)));
    this.faces = Uint32Array.from({ length: asset.quads.length / 4 }, (_, i) => i)
      .filter(f => [0, 1, 2, 3].every(k => regions.has(asset.region[asset.quads[f * 4 + k]])));
    this.reference = new Float64Array(this.faces.length * 2);
    this.faces.forEach((f, row) => this.reference.set(this.metric(base, f), row * 2));
    this.referenceIntersections = intersectionPairs(base, asset.quads, this.faces);
  }
  private metric(P: Float32Array, f: number): [number, number] {
    const q = this.asset.quads, a = q[f * 4] * 3, b = q[f * 4 + 1] * 3, c = q[f * 4 + 2] * 3, d = q[f * 4 + 3] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const wx = P[d] - P[a], wy = P[d + 1] - P[a + 1], wz = P[d + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = vy * wz - vz * wy, my = vz * wx - vx * wz, mz = vx * wy - vy * wx;
    const n = Math.hypot(nx, ny, nz), m = Math.hypot(mx, my, mz);
    return [Math.min(n, m), (nx * mx + ny * my + nz * mz) / Math.max(1e-15, n * m)];
  }
  evaluate(P: Float32Array): ShapeQuality {
    let collapsedFaces = 0, foldedFaces = 0, nonFinite = 0;
    for (let i = 0; i < this.asset.nBody * 3; i++) if (!Number.isFinite(P[i])) nonFinite++;
    this.faces.forEach((f, row) => {
      const [area, alignment] = this.metric(P, f), baseArea = this.reference[row * 2], baseAlignment = this.reference[row * 2 + 1];
      if (baseArea > 1e-6 && area < baseArea * 0.02) collapsedFaces++;
      if (baseAlignment > 0.3 && alignment < -0.25) foldedFaces++;
    });
    const intersectingPairs = nonFinite ? 0 : [...intersectionPairs(P, this.asset.quads, this.faces)].filter(pair => !this.referenceIntersections.has(pair)).length;
    return { valid: !collapsedFaces && !foldedFaces && !nonFinite && !intersectingPairs, collapsedFaces, foldedFaces, nonFinite, intersectingPairs };
  }
}
