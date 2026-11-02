import type { BodyAsset } from './asset';
import { type HeadParts, cutNeck, eggHead, headParts } from './egghead';
import { type V3, cavity, centroid, lerp3, meshVolume, vert } from './geometry';
import { GuideBuilder } from './guides';
import type { BodyInput } from '../goals';
import { MEASURE_KEYS, type MeasureKey, type Measured } from './measure';
import { type ArmPose, BodyModel, rotateArmPoint } from './model';
import { RingBody, type CompositionResult, type Soft } from './rings';
import { type GluteBody, MODEL_HEIGHT, toModel } from './glute';

// 把「骨架 + 身體組成 + 手動數值」變成畫面需要的一切：顯示用網格、結構線、量測線、實際量到的數值、體重與身體組成。
// 在 Web Worker 裡執行，避免拖動滑桿時卡住畫面。

/** 手動填的目標：量測值、體重、體脂率、上下胸圍差 */
export type Goal =
  | { kind: 'measure'; key: MeasureKey; value: number }
  | { kind: 'weight'; value: number }
  | { kind: 'bodyFat'; value: number }
  | { kind: 'muscleMass'; value: number }
  | { kind: 'diff'; value: number };

export interface EngineInput extends BodyInput {
  armAngle: number;
  /** 新臀（預覽）：女性的臀那一圈換成臀的獨立模型（glute.ts），整個素體細分一次 */
  newGlute?: boolean;
}

export interface TapePath {
  closed: boolean;
  /** x, y, z 連續排列 */
  points: Float32Array;
  anchor: V3;
}

export interface EngineOutput {
  positions: Float32Array;
  /** 每個頂點的凹陷程度（0–1），畫面用來把凹處稍微壓暗 */
  cavity: Float32Array;
  /** 可見的身體三角形 */
  bodyIndex: Uint32Array;
  /** 蛋形人台頭與頸部延伸 */
  head: { positions: Float32Array; index: Uint32Array };
  guides: Float32Array<ArrayBufferLike>[];
  tapes: Partial<Record<MeasureKey, TapePath>>;
  /** 網格上實際量到的數值（cm） */
  values: Record<MeasureKey, number>;
  /** 模型的體重（瘦體重 + 脂肪）與體脂率 */
  weight: number;
  bodyFat: number;
  tissues: { fat: number; muscle: number; otherLean: number };
  accounting: { otherLeanBase: number; otherLeanControl: number; breastOtherLean: number };
  diagnostics: { kind: 'input-conflict' | 'unconverged' | 'invalid-shape' | 'preview'; message: string }[];
  quality: ReturnType<RingBody['fitComposition']>['quality'];
  measurement: { version: 3; chestWallUnderbust: number; standingBust: number; sources: Measured['sources']; neutralPaths: Measured['tapes'] };
  /** 手動填的數值與模型做到的差距（模型值 − 目標值） */
  residual: { goal: Goal; error: number }[];
  /** 各區脂肪與肌肉比素體多出的公斤數 */
  composition: Soft;
  /** 體積（cm³） */
  volume: number;
  marks: { topY: number; crotchY: number; kneeY: number; ankleY: number };
  /** 新臀（預覽）開著時：換到臀的模（160 公分）上的脂肪、去脂與量到的臀圍 */
  glute?: { F: number; L: number; clamped: boolean; hip: number };
}

export class BodyEngine {
  readonly model: BodyModel;
  readonly rings: RingBody;
  private readonly guides: GuideBuilder;
  readonly head: HeadParts;
  private fitted: { key: string; result: ReturnType<RingBody['fitComposition']>; approximate: boolean } | null = null;
  /** 新臀的資料（另外載入；沒有時預覽開關無效） */
  glute: GluteBody | null = null;

  constructor(readonly asset: BodyAsset) {
    this.model = new BodyModel(asset);
    this.rings = new RingBody(asset);
    this.guides = new GuideBuilder(asset);
    this.head = headParts(asset);
  }

  run(input: EngineInput): EngineOutput {
    const diagnostics: EngineOutput['diagnostics'] = [];
    let solveInput = input;
    if (input.muscleMass !== undefined && input.weightLocked) {
      const available = input.weight * (input.bodyFatLocked ? 1 - input.bodyFat : 1);
      if (input.muscleMass >= available) {
        diagnostics.push({ kind: 'input-conflict', message: `骨骼肌 ${input.muscleMass.toFixed(1)} kg 已超過鎖定體重與體脂所剩的去脂總量 ${available.toFixed(1)} kg，沒有空間容納其餘去脂組織。請調整其中一項；目前顯示有差距的近似體型。` });
        solveInput = { ...input, muscleMass: available * 0.7 };
      }
    }
    const { armAngle: _angle, newGlute: _glute, ...shapeInput } = input;
    const key = JSON.stringify(shapeInput);
    if (this.fitted?.key !== key) {
      let result = this.rings.fitComposition(solveInput, { neutralize: true });
      let restoreInspection = this.rings.preserveInspection();
      let approximate = false;
      // 共同校正已在實際控制上處理固定圈與總量；不能在外層再把自由腿
      // 變成兩個虛構的手動條件，重跑整個求解卻得到更差的尺寸／重量折衷。
      const sizeError = (r: typeof result) => residualOf(input, r.values, r.weight, r.bodyFat)
        .filter(x => x.goal.kind === 'measure' || x.goal.kind === 'diff').reduce((sum, x) => sum + x.error ** 2, 0);
      const missesSize = residualOf(input, result.values, result.weight, result.bodyFat)
        .some(x => (x.goal.kind === 'measure' || x.goal.kind === 'diff') && Math.abs(x.error) > 0.5);
      if (!diagnostics.length && input.weightLocked && Object.keys(input.locked).length >= 2 && missesSize) {
        // 超約束時保留明確尺寸的近似解，不能為湊體重把指定臀腿推大。
        // 原輸入仍用於殘差與診斷，沒有把放寬的重量冒充成功。
        const candidate = this.rings.fitComposition({ ...solveInput, weightLocked: false, estimateReference: false }, { neutralize: true });
        if (candidate.quality.valid && Object.values(candidate.tissues).every(x => x >= 0) && sizeError(candidate) < sizeError(result)) {
          result = candidate; approximate = true; restoreInspection = this.rings.preserveInspection();
        }
      }
      restoreInspection();
      this.fitted = { key, result, approximate };
    }
    const res = this.fitted.result;
    const { P, armRotation } = this.model.display(res.P, input.armAngle, false);
    const glute = input.newGlute && input.sex === 'female' && this.glute ? this.gluteState(input, res, P, this.glute) : null;
    const values = glute ? { ...res.values, ...glute.values } : res.values;
    if (glute) {
      diagnostics.push({ kind: 'preview', message: `新臀（預覽）：臀那一圈換成臀的獨立模型（換到 160 公分的模上：脂肪 ${glute.F.toFixed(1)} kg、去脂 ${glute.L.toFixed(1)} kg）。臀圍、腰圍、大腿圍在新的網格上量；體重與其他部位還是原本的算法。` });
      if (glute.clamped) diagnostics.push({ kind: 'preview', message: '這組數值超出新臀做好的範圍（模上脂肪 2～130 kg、去脂 29～91 kg），臀先停在範圍邊上。' });
    }
    const residual = [...residualOf(input, values, res.weight, res.bodyFat), ...(input.muscleMass === undefined ? [] : [{ goal: { kind: 'muscleMass' as const, value: input.muscleMass }, error: res.tissues.muscle - input.muscleMass }])];
    if (!diagnostics.length && (residual.some(r => Math.abs(r.error) > (r.goal.kind === 'bodyFat' ? 0.01 : 0.5)) || Object.values(res.tissues).some(x => x < 0))) {
      diagnostics.push({ kind: 'unconverged', message: this.fitted.approximate
        ? `目前控制未能同時符合鎖定尺寸與體重；顯示優先維持尺寸的近似解，實際體重 ${res.weight.toFixed(1)} kg。原體重目標仍保留，這不代表輸入在生理上不可能。`
        : '目前控制尚未找到同時符合全部尺寸與組成的解；這是模型求解未達標，不能據此判定這個體型不可能。' });
    }
    if (!res.quality.valid) diagnostics.push({ kind: 'invalid-shape', message: `目前曲面有 ${res.quality.foldedFaces} 個新增折返面、${res.quality.collapsedFaces} 個塌縮面、${res.quality.intersectingPairs} 對穿插面；即使尺寸接近目標，也尚未形成有效體型。` });
    const a = this.asset;
    const m = res.measured;

    const J = (n: string) => centroid(P, ...a.joints[n]);
    const knee = J('l-knee'), ankle = J('l-ankle');
    let topY = -Infinity;
    for (let i = 0; i < a.nBody; i++) topY = Math.max(topY, P[i * 3 + 1]);
    const crotchY = m.marks.crotchY;

    const guides: Float32Array[] = this.guides.build(P, {
      underbustY: m.marks.underbustY,
      waistY: m.marks.waistY,
      hipY: m.marks.hipY,
      topY,
      height: res.values.height,
    }).map((line) => Float32Array.from(line.flat()));
    const egg = eggHead(P, this.head);
    const neckCut = cutNeck(P, a, this.head);
    guides.push(...egg.guides);
    const headPositions = new Float32Array(egg.positions.length + neckCut.plug.positions.length);
    headPositions.set(egg.positions);
    headPositions.set(neckCut.plug.positions, egg.positions.length);
    const eggCount = egg.positions.length / 3;
    const headIndex = Uint32Array.from([...egg.index, ...Array.from(neckCut.plug.index, (i) => i + eggCount)]);

    // 量測線：手臂上的跟著手臂轉
    const tapes: EngineOutput['tapes'] = {};
    const armKeys: MeasureKey[] = ['upperArm', 'wrist'];
    for (const key of MEASURE_KEYS) {
      const path = m.tapes[key];
      if (!path) continue;
      let pts = glute?.tapes[key] ?? path;
      if (armKeys.includes(key)) pts = pts.map((p) => rotateArmPoint(p, armRotation.L as ArmPose));
      tapes[key] = closedTape(pts, key !== 'shoulder', ['upperArm', 'wrist', 'thigh', 'calf', 'ankle'].includes(key));
    }
    const seg = (p: V3, q: V3): TapePath => ({
      closed: false,
      points: Float32Array.from([...p, ...q]),
      anchor: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2],
    });
    const acromion = vert(P, a.landmarks.acromionL), elbow = J('l-elbow'), wrist = J('l-hand');
    tapes.upperArmLen = seg(acromion, elbow);
    tapes.forearmLen = seg(elbow, wrist);
    // 腿長畫在左腿外側
    const thighR = a.regions.indexOf('thighL'), calfR = a.regions.indexOf('calfL');
    let outer = -Infinity;
    for (let i = 0; i < a.nBody; i++) {
      const r = a.region[i];
      if (r === thighR || r === calfR) outer = Math.max(outer, P[i * 3]);
    }
    const x = outer + 2.5;
    tapes.thighLen = seg([x, crotchY, knee[2]], [x, knee[1], knee[2]]);
    tapes.calfLen = seg([x, knee[1], knee[2]], [x, ankle[1], ankle[2]]);

    const positions = glute ? glute.positions : P.slice(0, a.nBody * 3);
    return {
      positions,
      cavity: glute ? this.glute!.cavity(positions) : cavity(P, a.quads, this.model.adj, a.nBody),
      bodyIndex: glute ? this.glute!.triangles(neckCut.faces) : neckCut.bodyIndex,
      head: { positions: headPositions, index: headIndex },
      guides,
      tapes,
      values,
      weight: res.weight,
      bodyFat: res.bodyFat,
      tissues: res.tissues,
      accounting: res.accounting,
      quality: res.quality,
      measurement: { version: 3, chestWallUnderbust: m.values.underbust, standingBust: m.values.bust, sources: m.sources, neutralPaths: m.tapes },
      diagnostics,
      residual,
      composition: res.kg,
      volume: meshVolume(res.P.subarray(0, a.nBody * 3), a.quads),
      marks: { topY, crotchY, kneeY: knee[1], ankleY: ankle[1] },
      glute: glute ? { F: glute.F, L: glute.L, clamped: glute.clamped, hip: glute.values.hip } : undefined,
    };
  }

  /** 新臀：網站的全身數值 → 模上的 (F, L) → 臀那一圈放在骨架上；臀圍有鎖時改找脂肪讓臀圍對上（去脂不動）。
   * 臀圍照新臀的量法（最翹處）；腰圍、大腿圍在原本的高度重量，只加上新舊網格（都細分一次）在那個高度的差。 */
  private gluteState(input: EngineInput, res: CompositionResult, P: Float32Array, glute: GluteBody) {
    const height = res.values.height, s = height / MODEL_HEIGHT;
    const conv = toModel(height, res.weight, res.bodyFat, input.muscleMass);
    const mk = res.measured.marks;
    const B1 = glute.skeleton1(res.skeleton);
    const L = conv.L;
    const F = input.locked.hip !== undefined ? glute.fatForHip(input.locked.hip, L, B1, mk.crotchY, s).F : conv.F;
    const R = glute.region(B1, F, L, s);
    const hip = glute.hip(glute.regionOnly(R), mk.crotchY, s);
    const body = P.subarray(0, this.asset.nBody * 3);
    const positions = glute.compose(body, R), before = glute.subdivide(body);
    const values: Partial<Record<MeasureKey, number>> = { hip: hip.girth };
    const tapes: Partial<Record<MeasureKey, V3[]>> = { hip: hip.path };
    const faces = this.rings.ctx.faces;
    const hipJ = centroid(P, ...this.asset.joints['l-upper-leg']), knee = centroid(P, ...this.asset.joints['l-knee']);
    const thighY = mk.crotchY - (mk.crotchY - knee[1]) * 0.1;
    const thighRef = lerp3(hipJ, knee, (hipJ[1] - thighY) / (hipJ[1] - knee[1]));
    for (const [key, set, y, ref] of [['waist', faces.trunk, mk.waistY, undefined], ['thigh', faces.thighL, thighY, thighRef]] as const) {
      const now = glute.tapeAt(positions, set, y, ref), was = glute.tapeAt(before, set, y, ref);
      if (!now || !was) continue;
      values[key] = res.values[key] + now.length - was.length;
      tapes[key] = now.path;
    }
    const r = glute.range;
    const clamped = F < r.F[0] || F > r.F[1] || L < r.L[0] || L > r.L[1]
      || (input.locked.hip !== undefined && Math.abs(hip.girth - input.locked.hip) > 0.5);
    return { F, L, clamped, positions, values: values as Pick<Record<MeasureKey, number>, 'hip'> & Partial<Record<MeasureKey, number>>, tapes };
  }
}

/** 封閉的量測線：稍微往外推，標籤放在正前方或外側 */
function closedTape(pts: V3[], closed: boolean, lateral: boolean): TapePath {
  const c = pts.reduce<V3>((acc, p) => [acc[0] + p[0] / pts.length, acc[1] + p[1] / pts.length, acc[2] + p[2] / pts.length], [0, 0, 0]);
  const pushed = closed
    ? pts.map((p): V3 => {
        const d: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        return [p[0] + (d[0] / l) * 0.15, p[1] + (d[1] / l) * 0.15, p[2] + (d[2] / l) * 0.15];
      })
    : pts;
  let anchor = pushed[0];
  for (const p of pushed) {
    if (lateral ? p[0] > anchor[0] : p[2] > anchor[2]) anchor = p;
  }
  if (!closed) anchor = pushed[Math.floor(pushed.length / 2)];
  return { closed, points: Float32Array.from(pushed.flat()), anchor };
}

/** 手動填的數值和模型做到的差距 */
function residualOf(input: EngineInput, values: Record<MeasureKey, number>, weight: number, bodyFat: number): EngineOutput['residual'] {
  const out: EngineOutput['residual'] = [];
  for (const key of input.userLocked) {
    if (!(key in values)) continue;
    const target = key in input.locked ? input.locked[key as keyof typeof input.locked]! : input.frame[key as keyof typeof input.frame];
    if (target === undefined) continue;
    out.push({ goal: { kind: 'measure', key, value: target }, error: values[key] - target });
  }
  if (input.weightLocked) out.push({ goal: { kind: 'weight', value: input.weight }, error: weight - input.weight });
  if (input.bodyFatLocked) out.push({ goal: { kind: 'bodyFat', value: input.bodyFat }, error: bodyFat - input.bodyFat });
  if (input.sex === 'female' && input.bustDiff !== null) {
    out.push({ goal: { kind: 'diff', value: input.bustDiff }, error: values.bust - values.underbust - input.bustDiff });
  }
  return out;
}
