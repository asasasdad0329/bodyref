import type { BodyAsset } from './asset';
import { type Plane, type V3, centroid, cross, horizontal, norm, slice, sub, vert } from './geometry';

// 結構線：像繪畫人偶或服裝人台上的參考線，用平面切顯示用的網格得到。
// 正中線、經過胸點的公主線、側縫線、下胸／腰／臀橫線、頭部十字線，以及四肢的外側線與關節橫線。

export type Polyline = V3[];

export interface GuideLevels {
  underbustY: number;
  waistY: number;
  hipY: number;
  topY: number;
  height: number;
}

function facesOf(a: BodyAsset, names: string[]): Uint32Array {
  const allowed = new Set(names.map((r) => a.regions.indexOf(r)));
  const out: number[] = [];
  for (let f = 0; f < a.quads.length / 4; f++) {
    for (let k = 0; k < 4; k++) {
      if (allowed.has(a.region[a.quads[f * 4 + k]])) {
        out.push(f);
        break;
      }
    }
  }
  return Uint32Array.from(out);
}

export class GuideBuilder {
  private readonly sets: Record<string, Uint32Array>;

  constructor(private readonly a: BodyAsset) {
    this.sets = {
      center: facesOf(a, ['torso', 'breastL', 'breastR', 'neck']),
      trunk: facesOf(a, ['torso', 'breastL', 'breastR']),
      neck: facesOf(a, ['neck']),
      thighL: facesOf(a, ['thighL']),
      thighR: facesOf(a, ['thighR']),
      calfL: facesOf(a, ['calfL']),
      calfR: facesOf(a, ['calfR']),
      upperarmL: facesOf(a, ['upperarmL']),
      upperarmR: facesOf(a, ['upperarmR']),
      forearmL: facesOf(a, ['forearmL']),
      forearmR: facesOf(a, ['forearmR']),
      kneeL: facesOf(a, ['thighL', 'calfL']),
      kneeR: facesOf(a, ['thighR', 'calfR']),
      elbowL: facesOf(a, ['upperarmL', 'forearmL']),
      elbowR: facesOf(a, ['upperarmR', 'forearmR']),
    };
  }

  build(P: Float32Array, lv: GuideLevels): Polyline[] {
    const a = this.a;
    const J = (n: string) => centroid(P, ...a.joints[n]);
    const cut = (set: string, plane: Plane, keep?: (p: V3) => boolean): Polyline[] => {
      const chains = slice(P, a.quads, this.sets[set], plane);
      if (!keep) return chains;
      // 只留下符合條件的片段，在不符合的點斷開
      const out: Polyline[] = [];
      for (const c of chains) {
        let cur: Polyline = [];
        for (const p of c) {
          if (keep(p)) cur.push(p);
          else if (cur.length) {
            if (cur.length > 1) out.push(cur);
            cur = [];
          }
        }
        if (cur.length > 1) out.push(cur);
      }
      return out;
    };
    const lines: Polyline[] = [];
    const acromionY = (vert(P, a.landmarks.acromionL)[1] + vert(P, a.landmarks.acromionR)[1]) / 2;
    const pelvis = J('pelvis');

    // 正中線（前後，延伸過頭頂）
    const chin = J('head')[1] - 0.03 * lv.height;
    lines.push(...cut('center', { p: [0, 0, 0], n: [1, 0, 0] }, (p) => p[1] > lv.hipY - 0.06 * lv.height && p[1] < chin));
    // 公主線：經過兩側胸點的縱線，前後各一條
    for (const name of ['bustApexL', 'bustApexR']) {
      const x = vert(P, a.landmarks[name])[0];
      lines.push(...cut('trunk', { p: [x, 0, 0], n: [1, 0, 0] }, (p) => p[1] > lv.hipY && p[1] < acromionY - 1));
    }
    // 側縫線
    for (const side of [1, -1]) {
      lines.push(...cut('trunk', { p: [0, 0, pelvis[2]], n: [0, 0, 1] }, (p) => p[0] * side > 0 && p[1] > lv.hipY - 2 && p[1] < lv.underbustY + 4));
    }
    // 下胸、腰、臀橫線
    for (const y of [lv.underbustY, lv.waistY, lv.hipY]) lines.push(...cut('trunk', horizontal(y)));
    // 頸部橫線
    const neck = J('neck'), head = J('head');
    const neckAxis = norm(sub(head, neck));
    lines.push(...cut('neck', { p: [neck[0] + (head[0] - neck[0]) * 0.3, neck[1] + (head[1] - neck[1]) * 0.3, neck[2] + (head[2] - neck[2]) * 0.3], n: neckAxis }));

    for (const [s, S] of [['l', 'L'], ['r', 'R']] as const) {
      const hip = J(`${s}-upper-leg`), knee = J(`${s}-knee`), ankle = J(`${s}-ankle`);
      const shoulder = J(`${s}-shoulder`), elbow = J(`${s}-elbow`), wrist = J(`${s}-hand`);
      const Z: V3 = [0, 0, 1];
      // 腿：經過腿軸、朝前的平面（前中線與後中線）
      lines.push(...cut(`thigh${S}`, { p: knee, n: norm(cross(sub(hip, knee), Z)) }, (p) => p[1] < lv.hipY - 3));
      lines.push(...cut(`calf${S}`, { p: knee, n: norm(cross(sub(knee, ankle), Z)) }));
      lines.push(...cut(`knee${S}`, horizontal(knee[1])));
      // 手臂：經過臂軸、法向量朝前的平面（外側線與內側線）
      const upperAxis = norm(sub(elbow, shoulder)), foreAxis = norm(sub(wrist, elbow));
      const front = (axis: V3) => norm(cross(axis, cross(Z, axis)));
      lines.push(...cut(`upperarm${S}`, { p: elbow, n: front(upperAxis) }));
      lines.push(...cut(`forearm${S}`, { p: elbow, n: front(foreAxis) }));
      lines.push(...cut(`elbow${S}`, { p: elbow, n: norm(sub(wrist, shoulder)) }));
    }
    return lines;
  }
}
