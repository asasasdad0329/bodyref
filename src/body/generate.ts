import { Vector3 } from 'three';
import type { BodyMeasurements, MeasureId } from '../core/measurements';
import { type Frame, type KeyRing, type Loft, frameFromAxis, loft, mirrorLoft, placeRing, sliceVolume } from './loft';
import {
  type Bulge,
  type Pt,
  type SectionShape,
  convexHull,
  extents,
  fitBulges,
  fitToGirth,
  resample,
  sectionPoints,
} from './section';

// 由完整量測數據生成人台。座標單位為公分：y 朝上、地面 y = 0、人台面向 +z。
// 四肢先在 +x 側（人台的左側）生成，再鏡射到另一側。
// 量測線畫在 +x 側；圍度的量測線就是該處關鍵截面的布尺路徑。

export interface Quality {
  torsoCols: number;
  limbCols: number;
  headCols: number;
  handCols: number;
  footCols: number;
  /** 補間截面的大約間距（cm） */
  step: number;
}

export const FINE: Quality = { torsoCols: 96, limbCols: 56, headCols: 48, handCols: 24, footCols: 32, step: 1.25 };
export const COARSE: Quality = { torsoCols: 32, limbCols: 20, headCols: 20, handCols: 12, footCols: 12, step: 4 };

export interface BodyPart {
  name: string;
  loft: Loft;
}

export interface MeasurePath {
  closed: boolean;
  points: Vector3[];
  /** 標籤位置 */
  anchor: Vector3;
}

export interface Landmarks {
  ankleY: number;
  kneeY: number;
  crotchY: number;
  hipY: number;
  waistY: number;
  underbustY: number;
  bustY: number;
  shoulderY: number;
  chinY: number;
  top: number;
}

export interface BodyShape {
  parts: BodyPart[];
  paths: Record<MeasureId, MeasurePath>;
  landmarks: Landmarks;
  /** 模型實際高度；腿長與身高不一致時會和輸入身高不同 */
  modelHeight: number;
  /** 腿長占身高比例過高，軀幹被拉到最小長度 */
  torsoClamped: boolean;
  /** 體積（cm³），已排除部位之間主要的重疊 */
  volume: number;
}

export interface GenerateOptions {
  quality: Quality;
  /** 手臂外展角度（度） */
  armAngle: number;
}

interface Ring {
  key: KeyRing;
  /** 未重新取樣前的密集截面點，用來畫布尺路徑 */
  dense: Pt[];
  shape: SectionShape;
}

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const TAU = Math.PI * 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function makeRing(shape: SectionShape, frame: Frame, cols: number): Ring {
  const dense = sectionPoints(shape);
  return { key: { frame, pts: placeRing(resample(dense, cols), frame) }, dense, shape };
}

/**
 * 以截面的布尺路徑作為量測線，稍微往外推避免和表面重疊。
 * 標籤放在正前方，或四肢的外側（四肢截面的 +u 指向內側）。
 */
function ringPath(r: Ring, anchorSide: 'front' | 'side' = 'front', offset = 0.18): MeasurePath {
  const hull = convexHull(r.dense);
  let cu = 0, cv = 0;
  for (const [u, v] of hull) { cu += u; cv += v; }
  cu /= hull.length; cv /= hull.length;
  const pushed: Pt[] = hull.map(([u, v]) => {
    const du = u - cu, dv = v - cv;
    const len = Math.hypot(du, dv) || 1;
    return [u + (du / len) * offset, v + (dv / len) * offset];
  });
  const points = placeRing(pushed, r.key.frame);
  let best = 0;
  for (let i = 1; i < pushed.length; i++) {
    const better = anchorSide === 'front' ? pushed[i][1] > pushed[best][1] : pushed[i][0] < pushed[best][0];
    if (better) best = i;
  }
  return { closed: true, points, anchor: points[best].clone() };
}

function sideBulges(center: number, sep: number, width: number, amount: number): Bulge[] {
  return [
    { angle: center + sep, width, amount },
    { angle: center - sep, width, amount },
  ];
}

export function generateBody(m: BodyMeasurements, opts: GenerateOptions): BodyShape {
  const q = opts.quality;
  const H = m.height;
  const female = m.sex === 'female';
  const s = H / 160; // 身高比例，用於沒有直接量測的部位
  const paths = {} as Record<MeasureId, MeasurePath>;

  // ── 垂直配置 ──────────────────────────────────────────────
  const ankleY = 0.039 * H;
  const kneeY = ankleY + m.calfLen;
  const crotchY = kneeY + m.thighLen;
  const headH = 0.135 * H;
  const neckBaseNominal = 0.84 * H;
  let T = neckBaseNominal - crotchY;
  const torsoClamped = T < 0.3 * H;
  if (torsoClamped) T = 0.3 * H;
  const neckBaseY = crotchY + T;
  const lift = neckBaseY - neckBaseNominal;
  const chinY = H - headH + lift;
  const ty = (f: number) => crotchY + f * T;

  const shoulderStraight = 0.9 * m.shoulder;
  const shoulderHW = shoulderStraight / 2 - 1.2;
  const rNeck = m.neck / TAU;

  // ── 軀幹 ──────────────────────────────────────────────────
  const hip = m.hip, waist = m.waist, ub = m.underbust;
  const whr = waist / hip;
  const belly = clamp((whr - (female ? 0.8 : 0.92)) * 1.4, 0, 0.3);
  const glute = female ? 0.065 : 0.035;
  const gl = (k: number) => sideBulges(-Math.PI / 2, 0.42, 0.8, glute * k);

  type TorsoKey = { f: number; C: number; shape: SectionShape };
  // 臀部最凸出的位置在臀圍線稍下方，往下到胯下高度（臀溝）時收進大腿
  const lowerKeys: TorsoKey[] = female
    ? [
        { f: -0.04, C: 0.58 * hip, shape: { hw: 1, df: 0.32, db: 0.52, n: 2, bulges: gl(0.6), dv: -0.06 } },
        { f: 0, C: 0.88 * hip, shape: { hw: 1, df: 0.4, db: 0.74, n: 2.1, bulges: gl(1) } },
        { f: 0.055, C: 0.975 * hip, shape: { hw: 1, df: 0.47, db: 0.82, n: 2.1, bulges: gl(1) } },
        { f: 0.117, C: hip, shape: { hw: 1, df: 0.51, db: 0.79, n: 2.1, bulges: gl(0.8) } },
        { f: 0.2, C: waist + 0.7 * (hip - waist), shape: { hw: 1, df: 0.58 + belly * 0.4, db: 0.78, n: 2.05, bulges: gl(0.35) } },
        { f: 0.3, C: waist + 0.28 * (hip - waist), shape: { hw: 1, df: 0.66 + belly * 0.7, db: 0.74, n: 2 } },
        { f: 0.429, C: waist, shape: { hw: 1, df: 0.72 + belly, db: 0.74, n: 2, dv: 0.02 } },
        { f: 0.52, C: lerp(waist, ub, 0.55), shape: { hw: 1, df: 0.72 + belly * 0.6, db: 0.74, n: 2 } },
        { f: 0.61, C: ub, shape: { hw: 1, df: 0.7, db: 0.74, n: 2.1 } },
      ]
    : [
        { f: -0.04, C: 0.6 * hip, shape: { hw: 1, df: 0.38, db: 0.46, n: 2.1, bulges: gl(0.6), dv: -0.04 } },
        { f: 0, C: 0.88 * hip, shape: { hw: 1, df: 0.48, db: 0.6, n: 2.1, bulges: gl(1) } },
        { f: 0.055, C: 0.975 * hip, shape: { hw: 1, df: 0.54, db: 0.68, n: 2.1, bulges: gl(1) } },
        { f: 0.117, C: hip, shape: { hw: 1, df: 0.58, db: 0.68, n: 2.15, bulges: gl(0.8) } },
        { f: 0.2, C: waist + 0.65 * (hip - waist), shape: { hw: 1, df: 0.62 + belly * 0.4, db: 0.72, n: 2.1 } },
        { f: 0.3, C: waist + 0.25 * (hip - waist), shape: { hw: 1, df: 0.68 + belly * 0.7, db: 0.7, n: 2.05 } },
        { f: 0.429, C: waist, shape: { hw: 1, df: 0.74 + belly, db: 0.7, n: 2.05, dv: 0.02 } },
        { f: 0.52, C: lerp(waist, ub, 0.55), shape: { hw: 1, df: 0.72 + belly * 0.6, db: 0.7, n: 2.1 } },
        { f: 0.61, C: ub, shape: { hw: 1, df: 0.66, db: 0.7, n: 2.2 } },
      ];

  const tc = q.torsoCols;
  const hFrame = (y: number) => frameFromAxis(new Vector3(0, y, 0), UP);
  const torsoRings: Ring[] = lowerKeys.map((k) => makeRing(fitToGirth(k.shape, k.C), hFrame(ty(k.f)), tc));
  const crotchRing = torsoRings[1];
  const hipRing = torsoRings[3];
  const waistRing = torsoRings[6];
  const ubRing = torsoRings[8];
  const ubRel = lowerKeys[8].shape;

  // 胸部：在肋骨截面上加兩個隆起，隆起量由上胸圍反推。
  // 男性的上下胸圍差大多來自胸廓本身，只留一小部分給平緩的胸肌。
  const diff = m.bust - ub;
  const sep = female ? 0.62 : 0.5;
  const bw = female ? 0.46 + 0.004 * Math.max(0, diff) : 0.85;
  const breastDefs = sideBulges(Math.PI / 2, sep, bw, 0).map(({ angle, width }) => ({ angle, width }));
  const growth = female ? 2 : Math.max(2.5, diff * 0.7);
  const bustBase = fitToGirth(ubRel, Math.min(m.bust, ub + growth));
  const { shape: bustShape, amount: A } = fitBulges(bustBase, breastDefs, m.bust);
  const droop = female ? Math.max(0, diff - 15) : 0;
  const bustProfile = female
    ? { f635: Math.min(0.85, 0.55 + 0.012 * droop), f660: 0.9, f715: Math.max(0.5, 0.8 - 0.01 * droop), armpit: Math.max(0.2, 0.42 - 0.008 * droop), f800: 0.12 }
    : { f635: 0.3, f660: 0.7, f715: 0.95, armpit: 0.75, f800: 0.3 };
  const withBreast = (base: SectionShape, k: number): SectionShape => ({
    ...base,
    bulges: [...(base.bulges ?? []), ...breastDefs.map((b) => ({ ...b, amount: A * k }))],
  });
  const chestRing = (f: number, C: number, k: number) => makeRing(withBreast(fitToGirth(ubRel, C), k), hFrame(ty(f)), tc);

  torsoRings.push(chestRing(0.635, ub + growth * 0.3, bustProfile.f635));
  torsoRings.push(chestRing(0.66, ub + growth * 0.6, bustProfile.f660));
  const bustRing = makeRing(bustShape, hFrame(ty(0.688)), tc);
  torsoRings.push(bustRing);
  torsoRings.push(chestRing(0.715, ub + growth * 1.3, bustProfile.f715));

  const armpitRel: SectionShape = female ? { hw: 1, df: 0.62, db: 0.74, n: 2.3 } : { hw: 1, df: 0.58, db: 0.72, n: 2.4 };
  const armpitBase = fitToGirth(armpitRel, female ? ub * 1.06 + 1.5 : ub * 1.08 + 2);
  torsoRings.push(makeRing(withBreast(armpitBase, bustProfile.armpit), hFrame(ty(0.753)), tc));
  const ap = extents(sectionPoints(armpitBase));
  const frontA = ap.vMax, backA = -ap.vMin, hwA = ap.uMax;
  const shHW = Math.max(shoulderHW, hwA * 0.95);

  // 鎖骨下方的上胸：男性比較飽滿
  torsoRings.push(
    makeRing(withBreast({ hw: lerp(hwA, shHW, 0.3), df: frontA * (female ? 0.9 : 0.97), db: backA * 0.99, n: 2.4 }, bustProfile.f800), hFrame(ty(0.8)), tc),
  );
  torsoRings.push(makeRing({ hw: lerp(hwA, shHW, 0.68), df: frontA * (female ? 0.76 : 0.86), db: backA * 0.95, n: 2.6 }, hFrame(ty(0.846)), tc));
  const shoulderRing = makeRing({ hw: shHW, df: frontA * 0.5, db: backA * 0.8, n: 3, dv: -0.4 * s }, hFrame(ty(0.922)), tc);
  torsoRings.push(shoulderRing);
  torsoRings.push(
    makeRing({ hw: rNeck * 1.2 + 0.45 * (shHW - rNeck * 1.2), df: rNeck * 0.9 + 0.6 * s, db: backA * 0.62, n: 2.4, dv: -backA * 0.12 }, hFrame(ty(0.961)), tc),
  );

  // 頸部：軸線微微前傾，截面垂直於軸線
  const neckZ = -backA * 0.28;
  const neckStart = new Vector3(0, neckBaseY, neckZ);
  const neckEnd = new Vector3(0, chinY + 0.3 * headH, neckZ + 2.4 * s);
  const neckAxis = neckEnd.clone().sub(neckStart);
  const alongNeck = (y: number) => neckStart.clone().addScaledVector(neckAxis, (y - neckBaseY) / neckAxis.y);
  const neckFrame = (y: number) => frameFromAxis(alongNeck(y), neckAxis);
  torsoRings.push(makeRing({ hw: rNeck * 1.12, df: rNeck * 1.12, db: rNeck * 1.12 }, frameFromAxis(neckStart, UP.clone().add(neckAxis.clone().normalize())), tc));
  const neckRing = makeRing(fitToGirth({ hw: 1, df: 0.95, db: 1 }, m.neck), neckFrame(lerp(neckBaseY, chinY + 0.3 * headH, 0.4)), tc);
  torsoRings.push(neckRing);
  torsoRings.push(makeRing(fitToGirth({ hw: 1, df: 0.95, db: 1 }, m.neck * 0.96), neckFrame(chinY), tc));
  torsoRings.push(makeRing(fitToGirth({ hw: 1, df: 0.95, db: 1 }, m.neck * 0.88), neckFrame(chinY + 0.18 * headH), tc));

  const torsoBottom = new Vector3(0, ty(-0.062), -0.12 * hipRing.shape.hw);
  const torsoLoft = loft(torsoRings.map((r) => r.key), q.step, torsoBottom, neckEnd);
  const neckChinKey = torsoRings.length - 2;

  // ── 腿 ───────────────────────────────────────────────────
  const rThigh = m.thigh / TAU;
  const forearmC = 0.6 * m.upperArm + 0.4 * m.wrist + 1.2;
  const kneeC = 0.42 * m.thigh + 0.44 * m.calf;
  const rKnee = kneeC / TAU;
  const rAnkle = m.ankle / TAU;
  const crotchHW = crotchRing.shape.hw;
  const topX = Math.max(rThigh * 1.02, crotchHW * 0.98 - rThigh * 0.95);
  const kneeX = Math.max(rKnee + 0.6, topX * 0.62 + 0.8);
  const ankleX = Math.max(rAnkle + 2.2, kneeX * 0.9);
  const legTopY = crotchY + 0.1 * T;
  const legX = (y: number) =>
    y >= kneeY ? lerp(kneeX, topX, (y - kneeY) / (legTopY - kneeY)) : lerp(ankleX, kneeX, (y - ankleY) / (kneeY - ankleY));
  const lc = q.limbCols;
  // 腿部截面的 +u 指向內側（大腿內側、小腿內側）
  const legRing = (y: number, z: number, C: number, shape: SectionShape) =>
    makeRing(fitToGirth(shape, C), frameFromAxis(new Vector3(legX(y), y, z * s), DOWN), lc);
  const calfBulge = (k: number): Bulge[] => [{ angle: -Math.PI / 4, width: 0.9, amount: k }];
  const tl = m.thighLen, cl = m.calfLen;
  const legRings: Ring[] = [
    legRing(legTopY, -1.4, 0.92 * m.thigh, { hw: 1, df: 0.95, db: 1 }),
    legRing(crotchY, -1.3, 1.02 * m.thigh, { hw: 1, df: 0.95, db: 1 }),
    legRing(crotchY - 0.06 * tl, -1.1, m.thigh, { hw: 1, df: 0.97, db: 1 }),
    legRing(crotchY - 0.45 * tl, -0.2, 0.87 * m.thigh, { hw: 1, df: 1, db: 0.95 }),
    legRing(kneeY + 0.2 * tl, 0.2, Math.max(kneeC * 1.02, 0.7 * m.thigh + 0.04 * m.calf), { hw: 1, df: 0.92, db: 0.9 }),
    legRing(kneeY, 0.3, kneeC, { hw: 1, df: 0.92, db: 0.85, n: 2.2, bulges: [{ angle: Math.PI / 2, width: 0.5, amount: 0.06 }] }),
    legRing(kneeY - 0.13 * cl, 0, lerp(kneeC, m.calf, 0.6), { hw: 1, df: 0.85, db: 0.98, bulges: calfBulge(0.04) }),
    legRing(kneeY - 0.3 * cl, -0.2, m.calf, { hw: 1, df: 0.8, db: 1.12, bulges: calfBulge(0.07) }),
    legRing(kneeY - 0.55 * cl, -0.2, lerp(m.calf, m.ankle, 0.4), { hw: 1, df: 0.82, db: 1.02, bulges: calfBulge(0.04) }),
    legRing(kneeY - 0.8 * cl, -0.4, lerp(m.calf, m.ankle, 0.85), { hw: 1, df: 0.85, db: 0.9 }),
    legRing(ankleY + 0.02 * H, -0.5, m.ankle, { hw: 1, df: 0.9, db: 0.95 }),
    legRing(ankleY, -0.5, m.ankle * 1.12, { hw: 1, df: 0.85, db: 0.85 }),
    legRing(ankleY - 2.5 * s, -0.5, m.ankle * 1.05, { hw: 1, df: 0.85, db: 0.85 }),
  ];
  const legLoft = loft(
    legRings.map((r) => r.key),
    q.step,
    new Vector3(topX, legTopY + 2.5 * s, -1.4 * s),
    new Vector3(ankleX, ankleY - 4.5 * s, -0.5 * s),
  );

  // ── 腳 ───────────────────────────────────────────────────
  const FL = 0.152 * H;
  const fs = FL / 24.3;
  const toeOut = (7 * Math.PI) / 180;
  const footDir = new Vector3(Math.sin(toeOut), 0, Math.cos(toeOut));
  const ankleC = new Vector3(ankleX, 0, -0.5 * s);
  const heel = ankleC.clone().addScaledVector(footDir, -0.28 * FL);
  const footAt = (t: number, y: number) => heel.clone().addScaledVector(footDir, t * FL).setY(y * fs);
  const footRing = (t: number, hw: number, yc: number, up: number, down: number, du = 0) =>
    makeRing({ hw: hw * fs, df: up * fs, db: down * fs, n: 2.4, du: du * fs }, frameFromAxis(footAt(t, yc), footDir, UP), q.footCols);
  const footRings = [
    footRing(0.04, 2.2, 3.5, 2.3, 3.4),
    footRing(0.14, 2.9, 4.0, 3.4, 3.95),
    footRing(0.28, 3.1, 4.9, 3.6, 4.85),
    footRing(0.46, 3.5, 3.9, 2.9, 3.85),
    footRing(0.64, 4.2, 2.4, 2.1, 2.35, 0.2),
    footRing(0.74, 4.5, 1.85, 1.75, 1.8, 0.4),
    footRing(0.86, 4.2, 1.4, 1.3, 1.35, 0.5),
    footRing(0.95, 3.4, 1.15, 1.0, 1.1, 0.6),
  ];
  const footLoft = loft(footRings.map((r) => r.key), q.step * 0.7, footAt(0, 3.4), footAt(1, 1.1));

  // ── 手臂 ─────────────────────────────────────────────────
  const rDelt = (1.12 * m.upperArm) / TAU;
  const shoulderY = ty(0.922);
  const jointZ = -backA * 0.12;
  const joint = new Vector3(shoulderStraight / 2 - 0.55 * rDelt, shoulderY - 0.62 * rDelt, jointZ);
  const acromion = new Vector3(shoulderStraight / 2, shoulderY, jointZ);
  const alpha = (opts.armAngle * Math.PI) / 180;
  const dir1 = new Vector3(Math.sin(alpha), -Math.cos(alpha), 0);
  // 求出肩關節到手肘的距離，使肩點到手肘正好等於上臂長
  const dA = joint.clone().sub(acromion);
  const bq = dA.dot(dir1);
  const L1 = -bq + Math.sqrt(Math.max(0, bq * bq - dA.lengthSq() + m.upperArmLen ** 2));
  const elbow = joint.clone().addScaledVector(dir1, L1);
  const beta = alpha + (5 * Math.PI) / 180;
  const dir2 = new Vector3(Math.sin(beta), -Math.cos(beta), 0.1).normalize();
  const wrist = elbow.clone().addScaledVector(dir2, m.forearmLen);
  const elbowC = 0.55 * m.upperArm + 0.45 * forearmC - 0.3;
  const armFrame = (c: Vector3, axis: Vector3) => frameFromAxis(c, axis);
  const elbowAxis = dir1.clone().add(dir2).normalize();
  const upper = (t: number) => joint.clone().addScaledVector(dir1, t * L1);
  const lower = (t: number) => elbow.clone().addScaledVector(dir2, t * m.forearmLen);
  const armRing = (c: Vector3, axis: Vector3, C: number, shape: SectionShape) => makeRing(fitToGirth(shape, C), armFrame(c, axis), lc);
  const HL = 0.108 * H;
  const hs = HL / 17.3;
  const handAt = (t: number) => wrist.clone().addScaledVector(dir2, t * HL);
  const handRing = (t: number, hw: number, df: number, db: number) =>
    makeRing({ hw: hw * hs, df: df * hs, db: db * hs, n: 2.3 }, armFrame(handAt(t), dir2), q.handCols);
  const armRings: Ring[] = [
    makeRing({ hw: 0.8 * rDelt, df: 0.8 * rDelt, db: 0.8 * rDelt }, armFrame(joint.clone().addScaledVector(dir1, -0.55 * rDelt), dir1), lc),
    armRing(joint, dir1, 1.12 * m.upperArm, { hw: 1, df: 1.08, db: 1 }),
    armRing(upper(0.28), dir1, 1.04 * m.upperArm, { hw: 1, df: 1, db: 1 }),
    armRing(upper(0.5), dir1, m.upperArm, { hw: 1, df: 1.02, db: 0.96 }),
    armRing(upper(0.8), dir1, lerp(m.upperArm, elbowC, 0.6), { hw: 1, df: 0.95, db: 0.95 }),
    armRing(elbow, elbowAxis, elbowC, { hw: 1, df: 0.88, db: 0.9 }),
    armRing(lower(0.22), dir2, forearmC, { hw: 1, df: 0.9, db: 0.85 }),
    armRing(lower(0.55), dir2, lerp(forearmC, m.wrist, 0.5), { hw: 1, df: 1.15, db: 1.05 }),
    armRing(wrist, dir2, m.wrist, { hw: 1, df: 1.42, db: 1.38 }),
  ];
  // 手：簡化成手套形，掌心朝向身體
  const handRings: Ring[] = [
    handRing(0.22, 1.45, 3.6, 3.4),
    handRing(0.48, 1.3, 3.8, 3.6),
    handRing(0.7, 1.05, 3.5, 3.2),
    handRing(0.88, 0.85, 2.8, 2.5),
  ];
  // 手的截面欄數比手臂少，所以把手腕截面也用手的欄數重做一份，讓兩段網格分開
  const wristForHand = makeRing(armRings[8].shape, armRings[8].key.frame, q.handCols);
  const armLoft = loft(armRings.map((r) => r.key), q.step, joint.clone().addScaledVector(dir1, -0.98 * rDelt), null);
  const handLoft = loft([wristForHand.key, ...handRings.map((r) => r.key)], q.step * 0.7, wrist.clone().addScaledVector(dir2, -1.5 * s), handAt(1));
  // 手臂末端在手腕處以小錐收口，藏在手的截面內
  armLoft.capEnd = wrist.clone().addScaledVector(dir2, 1.5 * s);

  // ── 頭 ───────────────────────────────────────────────────
  const headScale = (H / 160) ** 0.35 * (female ? 1 : 1.05);
  const headZ = neckZ + 1.0 * s;
  const hc = q.headCols;
  // [高度比例, 半寬, 最後方 z, 最前方 z]（以 160 cm 女性為基準）
  const headTable: [number, number, number, number][] = [
    [0.02, 2.0, 4.2, 7.6],
    [0.08, 4.0, 1.0, 8.3],
    [0.18, 5.5, -4.5, 8.6],
    [0.32, 6.6, -8.3, 8.9],
    [0.48, 7.1, -9.5, 9.0],
    [0.62, 7.3, -9.9, 8.6],
    [0.76, 6.9, -9.6, 7.4],
    [0.88, 5.8, -8.2, 5.4],
    [0.955, 3.9, -5.6, 2.6],
  ];
  const headRings = headTable.map(([t, hw, zb, zf]) => {
    const half = ((zf - zb) / 2) * headScale;
    const zc = headZ + ((zf + zb) / 2) * headScale;
    return makeRing({ hw: hw * headScale, df: half, db: half, n: 2.3 }, frameFromAxis(new Vector3(0, chinY + t * headH, zc), UP), hc);
  });
  const headLoft = loft(
    headRings.map((r) => r.key),
    q.step * 0.8,
    new Vector3(0, chinY - 0.004 * headH, headZ + 6 * headScale),
    new Vector3(0, H + lift, headZ - 1.6 * headScale),
  );

  // ── 部位與體積 ───────────────────────────────────────────
  const parts: BodyPart[] = [
    { name: 'torso', loft: torsoLoft },
    { name: 'head', loft: headLoft },
    { name: 'legL', loft: legLoft },
    { name: 'legR', loft: mirrorLoft(legLoft) },
    { name: 'footL', loft: footLoft },
    { name: 'footR', loft: mirrorLoft(footLoft) },
    { name: 'armL', loft: armLoft },
    { name: 'armR', loft: mirrorLoft(armLoft) },
    { name: 'handL', loft: handLoft },
    { name: 'handR', loft: mirrorLoft(handLoft) },
  ];
  const volume =
    sliceVolume(torsoLoft, torsoLoft.keyRows[1], torsoLoft.keyRows[neckChinKey]) +
    sliceVolume(headLoft, 0, headLoft.rows - 1, true) +
    2 *
      (sliceVolume(legLoft, legLoft.keyRows[1], legLoft.keyRows[10]) +
        sliceVolume(footLoft, 0, footLoft.rows - 1, true) +
        sliceVolume(armLoft, armLoft.keyRows[1], armLoft.rows - 1) +
        sliceVolume(handLoft, 0, handLoft.rows - 1, true));

  // ── 量測線 ───────────────────────────────────────────────
  paths.neck = ringPath(neckRing);
  paths.bust = ringPath(bustRing);
  paths.underbust = ringPath(ubRing);
  paths.waist = ringPath(waistRing);
  paths.hip = ringPath(hipRing);
  paths.upperArm = ringPath(armRings[3], 'side');
  paths.wrist = ringPath(armRings[8], 'side');
  paths.thigh = ringPath(legRings[2], 'side');
  paths.calf = ringPath(legRings[7], 'side');
  paths.ankle = ringPath(legRings[10], 'side');

  // 肩寬：沿背部的弧線（中段略高，經過後頸根部），弧長等於輸入值
  const a = shoulderStraight / 2;
  const backZ = (shoulderRing.shape.dv ?? 0) - shoulderRing.shape.db - 0.4;
  const arcPoints = (b: number) => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 48; i++) {
      const t = (Math.PI * i) / 48;
      pts.push(new Vector3(a * Math.cos(t), shoulderY + 0.012 * H * Math.sin(t), backZ + b - b * Math.sin(t)));
    }
    return pts;
  };
  const arcLength = (pts: Vector3[]) => pts.reduce((sum, p, i) => (i ? sum + p.distanceTo(pts[i - 1]) : 0), 0);
  let lo = 0, hi = a * 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (arcLength(arcPoints(mid)) < m.shoulder) lo = mid;
    else hi = mid;
  }
  const arc = arcPoints((lo + hi) / 2);
  paths.shoulder = { closed: false, points: arc, anchor: arc[24].clone() };

  const lateral = (r: Ring, extra: number) => r.key.frame.c.clone().addScaledVector(r.key.frame.U, -(r.shape.hw + extra));
  const elbowOut = lateral(armRings[5], 0.4);
  const wristOut = lateral(armRings[8], 0.4);
  paths.upperArmLen = { closed: false, points: [acromion.clone().setY(shoulderY + 0.3), elbowOut], anchor: acromion.clone().lerp(elbowOut, 0.5) };
  paths.forearmLen = { closed: false, points: [elbowOut, wristOut], anchor: elbowOut.clone().lerp(wristOut, 0.5) };

  const outerX = (rings: Ring[]) => Math.max(...rings.map((r) => r.key.frame.c.x + r.shape.hw)) + 2;
  const thighX = outerX(legRings.slice(1, 6));
  const calfX = outerX(legRings.slice(5, 12));
  const thighA = new Vector3(thighX, crotchY, 0), thighB = new Vector3(thighX, kneeY, 0);
  const calfA = new Vector3(calfX, kneeY, 0), calfB = new Vector3(calfX, ankleY, 0);
  paths.thighLen = { closed: false, points: [thighA, thighB], anchor: thighA.clone().lerp(thighB, 0.5) };
  paths.calfLen = { closed: false, points: [calfA, calfB], anchor: calfA.clone().lerp(calfB, 0.5) };

  return {
    parts,
    paths,
    landmarks: {
      ankleY,
      kneeY,
      crotchY,
      hipY: ty(0.117),
      waistY: ty(0.429),
      underbustY: ty(0.61),
      bustY: ty(0.688),
      shoulderY,
      chinY,
      top: H + lift,
    },
    modelHeight: H + lift,
    torsoClamped,
    volume,
  };
}
