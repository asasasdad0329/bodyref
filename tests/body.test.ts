import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { bodyInputFor } from '../src/body/goals';
import { parseBodyAsset } from '../src/body/mh/asset';
import { distributionPenalty, redistributionStep } from '../src/body/mh/distribution';
import { zeroSoft } from '../src/body/mh/rings';
import { BodyEngine, type EngineOutput } from '../src/body/mh/engine';
import { suggest } from '../src/core/linkage';
import type { Sex } from '../src/core/measurements';
import { REFERENCE, cupDiff } from '../src/core/reference';
import { meshVolume } from '../src/body/mh/geometry';
import { BODY_CASES, PLAN_CASES } from './fixtures/bodyCases';
import { PELVIS_BASE, pelvisWidthFor } from '../src/body/mh/pelvis';
import { GluteBody, parseGlute, toModel } from '../src/body/mh/glute';

let engine: BodyEngine;

beforeAll(() => {
  const buf = readFileSync('public/body.bin');
  engine = new BodyEngine(parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
});

function run(sex: Sex, locked: Record<string, number>, cup: string | null = null): EngineOutput {
  const bustDiff = cup ? cupDiff(cup)! : null;
  const sug = suggest({ sex, locked, bustDiff });
  return engine.run({ ...bodyInputFor({ sex, sug, bustDiff }), armAngle: 16 });
}

describe('人體網格', () => {
  it('自由腰的下限偏好不會反過來懲罰較飽滿的腰，把補償強推到臀腿', () => {
    const preferences = { waist: { target: 100, scale: 0.1, confidence: 0.65, minimumTarget: 90 } };
    const values = { waist: 100, minWaist: 90 } as Parameters<typeof distributionPenalty>[0];
    expect(distributionPenalty({ ...values, minWaist: 95 }, preferences)).toBe(distributionPenalty(values, preferences));
    expect(distributionPenalty({ ...values, minWaist: 85 }, preferences)).toBeGreaterThan(distributionPenalty(values, preferences));
  });
  const cases: [string, Sex, Record<string, number>, string | null][] = [
    ['女性參考', 'female', { height: 160, weight: 52 }, null],
    ['男性參考', 'male', { height: 172, weight: 68 }, null],
    ['誇張沙漏', 'female', { height: 160, weight: 50, bust: 94, underbust: 66, waist: 56, hip: 94 }, null],
    ['偏胖', 'female', { height: 158, weight: 80 }, null],
    ['高壯男性', 'male', { height: 190, weight: 95, bodyFat: 0.24 }, null],
    ['G 罩杯', 'female', { height: 168, thigh: 56, calf: 36 }, 'G'],
    ['S 罩杯', 'female', { height: 160, underbust: 70 }, 'S'],
    ['細腰但體重重', 'female', { height: 160, weight: 75, waist: 64 }, null],
  ];
  for (const [name, sex, locked, cup] of cases) {
    it(`${name}：手動填的數值都符合（圍度 0.5 cm、體重 0.5 kg 內）`, () => {
      const out = run(sex, locked, cup);
      for (const { goal, error } of out.residual) {
        if (goal.kind === 'measure' && (goal.key in locked || goal.key === 'height')) expect(Math.abs(error), goal.key).toBeLessThan(0.5);
        if (goal.kind === 'weight' && locked.weight) expect(Math.abs(error), 'weight').toBeLessThan(0.5);
        if (goal.kind === 'bodyFat' && locked.bodyFat) expect(Math.abs(error), 'bodyFat').toBeLessThan(0.01);
        if (goal.kind === 'diff' && cup) expect(Math.abs(error), 'diff').toBeLessThan(0.5);
      }
    });
  }

  it('女性骨架照身高加骨盆寬：髂嵴一圈放寬、兩腿平移，高度、腰以上與手臂不動', () => {
    // 同一個素體分別當女性（有骨盆寬）與男性（沒有）跑骨架，差就是骨盆寬（pelvis.ts，DECISIONS #77、#83）
    const rings = engine.rings as unknown as { ctx: { sex: Sex }; skeleton(B0: Float32Array, t: { height: number }, lens: number[]): { B: Float32Array; m: { marks: { crotchY: number } } } };
    const a = engine.asset;
    const B0 = new Float32Array(a.base);
    const arms = new Set(['upperarmL', 'upperarmR', 'forearmL', 'forearmR', 'handL', 'handR'].map(r => a.regions.indexOf(r)));
    expect(pelvisWidthFor(160)).toBeCloseTo(28.4, 1);
    for (const height of [140, 160, 190]) {
      rings.ctx.sex = 'male';
      const plain = rings.skeleton(B0, { height }, [0, 0, 0, 0]);
      rings.ctx.sex = 'female';
      const wide = rings.skeleton(B0, { height }, [0, 0, 0, 0]);
      const s = height / 160, crotch = plain.m.marks.crotchY;
      const half = (P: Float32Array, u: number) => {
        let m = 0;
        for (let i = 0; i < a.nBody; i++) if (!arms.has(a.region[i]) && Math.abs(P[i * 3 + 1] - (crotch + u * s)) < 0.6 * s) m = Math.max(m, Math.abs(P[i * 3]));
        return m;
      };
      const crest = (pelvisWidthFor(height) - PELVIS_BASE * s) / 2;
      expect(Math.abs(half(wide.B, 25) - half(plain.B, 25) - crest)).toBeLessThan(0.05 * s);   // 髂嵴那一圈
      const legs = half(wide.B, -10) - half(plain.B, -10);
      expect(legs).toBeGreaterThan(0);
      expect(legs).toBeLessThan(crest);                                                      // 臀與腿放寬得比髂嵴少（R15）
      expect(Math.abs(half(wide.B, 45) - half(plain.B, 45))).toBeLessThan(0.02);              // 腰以上收回 0
      let dy = 0, dArm = 0;
      for (let i = 0; i < a.nBody; i++) {
        dy = Math.max(dy, Math.abs(wide.B[i * 3 + 1] - plain.B[i * 3 + 1]));
        if (arms.has(a.region[i])) dArm = Math.max(dArm, Math.abs(wide.B[i * 3] - plain.B[i * 3]) + Math.abs(wide.B[i * 3 + 2] - plain.B[i * 3 + 2]));
      }
      expect(dy).toBeLessThan(1e-4);
      expect(dArm).toBeLessThan(1e-4);
    }
  });

  it('只填身高時，參考體型的體重、體脂與三圍接近參考值', () => {
    for (const sex of ['female', 'male'] as const) {
      const ref = REFERENCE[sex];
      const out = run(sex, { height: ref.height });
      expect(Math.abs(out.weight - ref.weight) / ref.weight, `${sex} weight`).toBeLessThan(0.04);
      expect(Math.abs(out.bodyFat - ref.bodyFat), `${sex} bodyFat`).toBeLessThan(0.03);
      expect(Math.abs(out.values.waist - ref.girths.waist), `${sex} waist`).toBeLessThan(5);
      expect(Math.abs(out.values.hip - ref.girths.hip), `${sex} hip`).toBeLessThan(4);
    }
  });

  it('結果不受上一次輸入影響（拖動滑桿時會沿用上一次的解當起點）', () => {
    const fresh = run('female', { height: 160 });
    run('female', { height: 160, weight: 75, waist: 64 });
    run('female', { height: 160, bodyFat: 0.35, hip: 110 });
    const again = run('female', { height: 160 });
    for (const key of ['bust', 'waist', 'hip', 'thigh', 'upperArm'] as const) {
      expect(Math.abs(again.values[key] - fresh.values[key]), key).toBeLessThan(0.3);
    }
    expect(Math.abs(again.weight - fresh.weight)).toBeLessThan(0.3);
  }, 15000);

  it('罩杯只影響胸部：體脂相同時，A 到 G 的腰圍與臀圍幾乎不變', () => {
    const a = run('female', { height: 160, bodyFat: 0.27 }, 'A');
    const g = run('female', { height: 160, bodyFat: 0.27 }, 'G');
    expect(g.values.bust - g.values.underbust).toBeCloseTo(25, 0);
    expect(Math.abs(g.values.waist - a.values.waist)).toBeLessThan(1.5);
    expect(Math.abs(g.values.hip - a.values.hip)).toBeLessThan(1.5);
  });

  it('體重沒鎖定時，把腰圍改粗會讓體重跟著變重', () => {
    const base = run('female', { height: 160 });
    const thick = run('female', { height: 160, waist: base.values.waist + 12 });
    expect(thick.weight - base.weight).toBeGreaterThan(3);
    expect(thick.bodyFat).toBeGreaterThan(base.bodyFat);
  });

  it('體重變重時，指定的罩杯維持不變', () => {
    for (const weight of [52, 62, 75]) {
      const out = run('female', { height: 165, weight }, 'D');
      expect(out.values.bust - out.values.underbust, `${weight} kg`).toBeCloseTo(17.5, 0);
    }
  });

  it('顯示用輸出：移除原本的頭、加上人台頭與結構線', () => {
    const out = run('female', { height: 160, weight: 52 });
    const allTriangles = (engine.asset.quads.length / 4) * 2 * 3;
    expect(out.bodyIndex.length).toBeLessThan(allTriangles);
    expect(out.head.index.length).toBeGreaterThan(0);
    expect(out.guides.length).toBeGreaterThan(10);
    expect(out.positions.every(Number.isFinite)).toBe(true);
    expect(out.marks.topY).toBeCloseTo(160, 0);
  });

  const regression = (id: string) => {
    const c = BODY_CASES.find((c) => c.id === id)!;
    return run(c.sex, c.locked as Record<string, number>, c.cup ?? null);
  };

  for (const [id, low, high] of [['T2', 22, 26], ['T3', 28, 32], ['T4', 31, 35.5]] as const) {
    it(`${id}：預設上臂不再因總量分配過細或過粗`, () => {
      const out = regression(id);
      expect(out.values.upperArm).toBeGreaterThan(low);
      expect(out.values.upperArm).toBeLessThan(high);
      for (const { goal, error } of out.residual) {
        expect(Math.abs(error), goal.kind === 'measure' ? goal.key : goal.kind).toBeLessThan(goal.kind === 'bodyFat' ? 0.01 : 0.5);
      }
    });
  }

  it('偏胖預設的腰腹增量不能靠繼續放大臀腿補償', () => {
    const out = regression('T4');
    expect(out.values.waist).toBeGreaterThan(86);
    expect(out.values.hip).toBeLessThan(118);
    expect(out.values.thigh).toBeLessThan(71);
    expect(Math.abs(out.weight - 80)).toBeLessThan(0.5);
  });

  it('鎖體重縮手臂時，臀圍的額外補償受到限制', () => {
    const before = regression('T4');
    const after = regression('UA-T4-30');
    expect(Math.abs(after.values.upperArm - 30)).toBeLessThan(0.5);
    expect(Math.abs(after.weight - 80)).toBeLessThan(0.5);
    expect(after.values.hip - before.values.hip).toBeLessThan(4);
    expect(after.values.thigh - before.values.thigh).toBeLessThan(2);
  }, 10000);

  it('分配與解除鎖定不依賴快取路徑', () => {
    const before = regression('T3');
    regression('T4');
    regression('UA-T4-30');
    const after = regression('T3');
    for (const key of ['waist', 'hip', 'thigh', 'calf', 'upperArm'] as const) {
      expect(Math.abs(after.values[key] - before.values[key]), key).toBeLessThan(0.3);
    }
    expect(Math.abs(after.weight - before.weight)).toBeLessThan(0.3);
  }, 15000);
  it('只指定大臀時，跨區基底不能讓手動臀圍卡在下限外', () => {
    const out = regression('T7-hip130');
    expect(Math.abs(out.values.hip - 130)).toBeLessThan(0.5);
  });

  it('有無相近骨架快取，輸出保持一致', () => {
    regression('T4');
    const c = BODY_CASES.find((c) => c.id === 'UA-T4-30')!;
    const sug = suggest({ sex: c.sex, locked: c.locked });
    const input = { ...bodyInputFor({ sex: c.sex, sug, bustDiff: null }), armAngle: 16 };
    const reused = engine.run(input);
    const fresh = new BodyEngine(engine.asset).run(input);
    for (const k of ['waist', 'hip', 'thigh', 'upperArm'] as const) {
      expect(Math.abs(reused.values[k] - fresh.values[k]), k).toBeLessThan(0.01);
    }
    expect(Math.abs(reused.weight - fresh.weight)).toBeLessThan(0.01);
  }, 15000);

  it('分配候選分別守住脂肪與去脂總量，且不動指定部位', () => {
    const step = redistributionStep(['general', 'belly', 'armMuscle', 'trunkMuscle'],
      { general: { waist: 1 }, belly: { waist: 3 }, armMuscle: { waist: 0 }, trunkMuscle: { waist: 2 } },
      { waist: 80 } as EngineOutput['values'], { waist: { target: 85, scale: 0.1, confidence: 1 } },
      [], zeroSoft(), { ...zeroSoft(), general: 10, belly: 5, armMuscle: 5, trunkMuscle: 10 });
    expect(step.belly).toBeGreaterThan(0);
    expect(step.general + step.belly).toBeCloseTo(0, 10);
    expect(step.armMuscle + step.trunkMuscle).toBeCloseTo(0, 10);
    expect(step.buttock).toBe(0);
  });

  for (const id of ['H94', 'H104', 'H114', 'H124', 'H130']) {
    it(`${id}：擴展臀部承托範圍後仍對準指定腰臀`, () => {
      const out = regression(id);
      for (const { goal, error } of out.residual) expect(Math.abs(error), goal.kind).toBeLessThan(0.5);
      expect(out.positions.every(Number.isFinite)).toBe(true);
      // 擴展支撐不能靠把大腿加得比分配階段更粗來假裝接順。
      if (id === 'H130') expect(out.values.thigh).toBeLessThan(80.5);
    });
  }

  it('相鄰臀圍連續變化，回到同一臀圍時不沿用別的承托範圍', () => {
    const first = regression('H104');
    const next = run('female', { height: 165, bust: 97, underbust: 76, waist: 68, hip: 105 });
    let maxDisplacement = 0;
    for (let i = 0; i < first.positions.length; i += 3) {
      maxDisplacement = Math.max(maxDisplacement, Math.hypot(...[0, 1, 2].map((k) => next.positions[i + k] - first.positions[i + k])));
    }
    expect(maxDisplacement).toBeLessThan(1.5);
    regression('H130');
    const again = regression('H104');
    expect(Math.abs(first.weight - again.weight)).toBeLessThan(0.01);
    expect(Math.max(...first.positions.map((v, i) => Math.abs(v - again.positions[i])))).toBeLessThan(0.01);
  }, 15000);

  it('偏胖男性不能把自由重量藏成上背的局部凸塊', () => {
    const out = regression('T6');
    expect(out.composition.upperBack).toBeLessThan(2);
    expect(Math.abs(out.weight - 97)).toBeLessThan(0.5);
  });

});

type CaseResult = { out: EngineOutput; neutral: Float32Array };
const planResults = new Map<string, CaseResult>();
function planResult(id: string): CaseResult {
  const cached = planResults.get(id);
  if (cached) return cached;
  const c = BODY_CASES.find(c => c.id === id)!;
  const bustDiff = c.cup ? cupDiff(c.cup)! : null;
  const sug = suggest({ sex: c.sex, locked: c.locked, bustDiff });
  const out = engine.run({ ...bodyInputFor({ sex: c.sex, sug, bustDiff, morphology: c.morphology, muscleMass: c.muscleMass }), armAngle: 16 });
  const result = { out, neutral: engine.rings.inspectSolved() };
  planResults.set(id, result); return result;
}

// 主計畫的固定輸入逐例驗證；保留既有 timeout 和誤差，不把截圖成功當作合格。
describe('形狀控制計畫的必要尺寸與幾何', () => {
  const required = [...BODY_CASES.filter(c => c.id.startsWith('AUDIT-')),
    ...PLAN_CASES.filter(c => !c.id.startsWith('FIXED-'))];
  for (const c of required) it(`${c.id}：同一表面達標且無新增折返`, () => {
    const { out, neutral } = planResult(c.id);
    for (const { goal, error } of out.residual) expect(Math.abs(error), JSON.stringify(goal)).toBeLessThan(goal.kind === 'bodyFat' ? 0.01 : 0.5);
    expect(out.quality, c.id).toEqual({ valid: true, collapsedFaces: 0, foldedFaces: 0, nonFinite: 0, intersectingPairs: 0 });
    expect(Object.values(out.tissues).every(v => v >= 0)).toBe(true);
    const volume = meshVolume(neutral, engine.asset.quads);
    expect(Math.abs(volume - out.volume)).toBeLessThan(0.01);
    expect(Math.abs(volume / 1000 - out.tissues.fat / 0.9 - (out.tissues.muscle + out.tissues.otherLean) / 1.06)).toBeLessThan(0.001);
    expect(Math.abs(out.tissues.otherLean - out.accounting.otherLeanBase - out.accounting.otherLeanControl - out.accounting.breastOtherLean)).toBeLessThan(0.001);
    // 從輸出的真實皮尺路徑獨立重算周長，不能以目標值冒充幾何結果。
    const path = out.measurement.neutralPaths.bust!;
    let perimeter = 0;
    for (let i = 0; i < path.length; i++) {
      const next = (i + 1) % path.length;
      perimeter += Math.hypot(path[i][0] - path[next][0], path[i][1] - path[next][1], path[i][2] - path[next][2]);
    }
    expect(Math.abs(perimeter - out.values.bust)).toBeLessThan(0.001);
  });
});

// 超約束序列也保留全部輸入；可行解與控制容量不足分別驗證，不能刪除失敗點。
describe('固定多圈增重的容量與失敗診斷', () => {
  for (const c of PLAN_CASES.filter(c => c.id.startsWith('FIXED-'))) it(`${c.id}：保留目標、實際曲面與診斷一致`, () => {
    const { out, neutral } = planResult(c.id);
    expect(out.quality.valid).toBe(true);
    expect(out.diagnostics.some(d => d.kind === 'input-conflict')).toBe(false);
    for (const r of out.residual.filter(r => r.goal.kind === 'measure')) expect(Math.abs(r.error), JSON.stringify(r.goal)).toBeLessThan(0.5);
    const mass = out.residual.find(r => r.goal.kind === 'weight')!;
    expect(mass.goal.value).toBe(c.locked.weight);
    expect(mass.error).toBeCloseTo(out.weight - c.locked.weight!, 7);
    expect(out.diagnostics.some(d => d.kind === 'unconverged')).toBe(Math.abs(mass.error) > 0.5);
    if (c.locked.weight! <= 60 || c.id === 'FIXED-75') expect(Math.abs(mass.error)).toBeLessThan(0.5);
    expect(Object.values(out.tissues).every(v => v >= 0)).toBe(true);
    expect(meshVolume(neutral, engine.asset.quads)).toBeCloseTo(out.volume, 2);
    expect(out.volume / 1000).toBeCloseTo(out.tissues.fat / 0.9 + (out.tissues.muscle + out.tissues.otherLean) / 1.06, 3);
  }, 30_000);  // 多圈增重要反覆求解，CI 機器上偶爾超過預設的 5 秒
});


// 同尺寸的型態必須改到責任區；毫米級數值檢查只攔住失效控制，外觀仍另作多視角驗收。
function regionalRms(a: CaseResult, b: CaseResult, area: 'abdomen' | 'hip' | 'chest' | 'back' | 'arm' | 'thigh'): number {
  const asset = engine.asset, h = a.out.values.height, crotch = a.out.marks.crotchY;
  const under = a.out.measurement.neutralPaths.underbust![0][1];
  let sum = 0, count = 0;
  for (let i = 0; i < asset.nBody; i++) {
    const region = asset.regions[asset.region[i]], y = a.neutral[i * 3 + 1], z = a.neutral[i * 3 + 2];
    const torso = region === 'torso';
    const include = area === 'abdomen' ? torso && y > crotch + 0.02 * h && y < under && z > 0
      : area === 'hip' ? (torso || region.startsWith('thigh')) && y > crotch - 0.06 * h && y < crotch + 0.1 * h && z < 0
      : area === 'chest' ? (torso || region.startsWith('breast')) && y > under && z > 0
      : area === 'back' ? torso && y > crotch + 0.1 * h && z < 0
      : area === 'arm' ? region.startsWith('upperarm') || region.startsWith('shoulder')
      : region.startsWith('thigh') && y < crotch - 0.02 * h;
    if (!include) continue;
    for (let k = 0; k < 3; k++) sum += (a.neutral[i * 3 + k] - b.neutral[i * 3 + k]) ** 2;
    count++;
  }
  expect(count).toBeGreaterThan(20);
  return Math.sqrt(sum / count);
}

describe('固定尺寸的局部形態配對', () => {
  for (const sex of ['female', 'male']) for (const thigh of ['', '-thigh']) {
    for (const hip of ['balanced', 'projected']) it(`${sex}${thigh}：${hip} 臀下切換腹型仍改變腹部`, () => {
      const a = planResult(`MORPH-${sex}-${hip}-soft${thigh}`), b = planResult(`MORPH-${sex}-${hip}-smooth${thigh}`);
      expect(regionalRms(a, b, 'abdomen')).toBeGreaterThan(0.1);
    }, 10000);
    for (const abdomen of ['soft', 'smooth']) it(`${sex}${thigh}：${abdomen} 腹下切換臀型仍改變臀部`, () => {
      const a = planResult(`MORPH-${sex}-balanced-${abdomen}${thigh}`), b = planResult(`MORPH-${sex}-projected-${abdomen}${thigh}`);
      expect(regionalRms(a, b, 'hip')).toBeGreaterThan(0.1);
    }, 10000);
  }
  for (const sex of ['female', 'male']) for (const fixed of ['free', 'fixed']) it(`${sex}-${fixed}：獨立肌肉量連動主要區域`, () => {
    const [low, high] = sex === 'female' ? [20, 26] : [30, 36];
    const a = planResult(`MUSCLE-${sex}-${fixed}-${low}`), b = planResult(`MUSCLE-${sex}-${fixed}-${high}`);
    for (const area of ['chest', 'back', 'arm', 'hip', 'thigh'] as const) expect(regionalRms(a, b, area), area).toBeGreaterThan(0.1);
  }, 10000);
});

// 小步輸入應連續改形；這是工程跳變護欄，不能代替多視角外觀判讀。
describe('小幅尺寸與組成變動不跨到另一個表面解', () => {
  const scenarios = [
    ...['teardrop', 'long', 'round'].map(shape => ({ id: `SMALL-E-${shape}`, key: 'bust', values: [85, 85.25, 85.5] })),
    { id: 'COMP-F18', key: 'bodyFat', values: [0.18, 0.185, 0.19] },
    { id: 'COMP-M18', key: 'bodyFat', values: [0.18, 0.185, 0.19] },
    { id: 'MUSCLE-male-fixed-30', key: 'muscleMass', values: [32, 32.25, 32.5] },
    { id: 'MUSCLE-female-fixed-20', key: 'muscleMass', values: [22, 22.25, 22.5] },
    { id: 'HF104', key: 'hip', values: [104, 104.25, 104.5] },
    { id: 'MORPH-male-projected-smooth-thigh', key: 'hip', values: [100, 100.05, 100.1, 100.15, 100.2, 100.25, 100.3, 100.35, 100.4, 100.45, 100.5] },
  ];
  for (const scenario of scenarios) {
    const samples = new Map<number, CaseResult>();
    const sample = (value: number) => {
      const cached = samples.get(value);
      if (cached) return cached;
      const c = BODY_CASES.find(c => c.id === scenario.id)!;
      const locked = { ...c.locked, ...(scenario.key === 'muscleMass' ? {} : { [scenario.key]: value }) };
      const bustDiff = c.cup ? cupDiff(c.cup)! : null;
      const out = engine.run({ ...bodyInputFor({ sex: c.sex, sug: suggest({ sex: c.sex, locked, bustDiff }),
        bustDiff, morphology: c.morphology, muscleMass: scenario.key === 'muscleMass' ? value : c.muscleMass }), armAngle: 16 });
      expect(out.diagnostics).toEqual([]);
      const result = { out, neutral: engine.rings.inspectSolved() };
      samples.set(value, result); return result;
    };
    for (let step = 1; step < scenario.values.length; step++) it(`${scenario.id} ${scenario.key} ${scenario.values[step - 1]} → ${scenario.values[step]}`, () => {
      const before = sample(scenario.values[step - 1]), after = sample(scenario.values[step]);
      let sum = 0, max = 0;
      for (let i = 0; i < engine.asset.nBody; i++) {
        const distance = Math.hypot(...[0, 1, 2].map(k => after.neutral[i * 3 + k] - before.neutral[i * 3 + k]));
        sum += distance * distance; max = Math.max(max, distance);
      }
      expect(max).toBeGreaterThan(0.001);
      expect(max).toBeLessThan(0.5);
      expect(Math.sqrt(sum / engine.asset.nBody)).toBeLessThan(0.1);
    }, 15000);
  }
});

describe('新臀（預覽，glute.ts）', () => {
  let glute: GluteBody;
  beforeAll(() => {
    const buf = readFileSync('public/glute.bin');
    glute = new GluteBody(engine.asset, parseGlute(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    engine.glute = glute;
  });
  const runG = (newGlute: boolean, locked: Record<string, number>, sex: Sex = 'female') => {
    const sug = suggest({ sex, locked, bustDiff: null });
    return engine.run({ ...bodyInputFor({ sex, sug, bustDiff: null }), armAngle: 16, newGlute });
  };

  it('數值換算與方向的量和 Python 原型相同（glute_mh_input、glute_mh_control）', () => {
    const c = toModel(160, 54.5, 0.31);
    expect(c.F).toBeCloseTo(16.895, 3);
    expect(c.L).toBeCloseTo(35.2803, 3);
    expect(toModel(175, 70, 0.3).L).toBeCloseTo(35.5525, 3);
    const want: [number, number, number[]][] = [
      [20, 35.3, [30.79734, -26.879943, -7.614295, -14.63535]],
      [4, 30, [-64.6662, -22.260025, -18.337949, -3.302725]],
      [100, 70, [293.974815, -0.687864, -7.460813, 11.266773]],
    ];
    for (const [F, L, w] of want) {
      const got = glute.weights(F, L);
      w.forEach((v, m) => expect(got[m]).toBeCloseTo(v, 3));
    }
  });

  it('開關：素體細分一次，只換臀那一圈與切口外漸弱的範圍；體重帳目與其他部位不變', () => {
    const off = runG(false, { height: 160 });
    const on = runG(true, { height: 160 });
    expect(on.positions.length / 3).toBe(glute.n1);
    expect(off.positions.length / 3).toBe(engine.asset.nBody);
    expect(on.weight).toBe(off.weight);
    expect(on.glute).toBeDefined();
    expect(on.values.hip).toBe(on.glute!.hip);
    // 腰、大腿圍在新的網格上重量（只加新舊網格的差），不會亂跳
    expect(Math.abs(on.values.waist - off.values.waist)).toBeLessThan(3);
    expect(Math.abs(on.values.thigh - off.values.thigh)).toBeLessThan(8);
    expect(on.values.calf).toBe(off.values.calf);
    // 臀那一圈與漸弱範圍以外：就是原本的形細分一次
    const base = glute.subdivide(off.positions);
    const touched = new Uint8Array(glute.n1);
    for (const v of glute.data.region) touched[v] = 1;
    for (const v of glute.data.fade) touched[v] = 1;
    let outside = 0, inside = 0;
    for (let i = 0; i < glute.n1; i++) {
      const d = Math.hypot(on.positions[i * 3] - base[i * 3], on.positions[i * 3 + 1] - base[i * 3 + 1], on.positions[i * 3 + 2] - base[i * 3 + 2]);
      if (touched[i]) inside = Math.max(inside, d); else outside = Math.max(outside, d);
    }
    expect(outside).toBeLessThan(1e-4);
    expect(inside).toBeGreaterThan(0.5);
    // 三角形：每個可見的四邊形變四個，編號都在範圍內
    expect(on.bodyIndex.length).toBe(off.bodyIndex.length * 4);
    expect(on.bodyIndex.reduce((m, v) => Math.max(m, v), 0)).toBeLessThan(glute.n1);
    expect(on.cavity.length).toBe(glute.n1);
    for (let i = 0; i < on.positions.length; i++) if (!Number.isFinite(on.positions[i])) throw new Error('非有限值');
  }, 30000);

  it('臀圍有鎖時，網站上量到的新臀臀圍對上（去脂不動，改脂肪）', () => {
    for (const hip of [92, 100, 110]) {
      const out = runG(true, { height: 160, hip });
      expect(Math.abs(out.values.hip - hip), `hip ${hip}`).toBeLessThan(0.5);
      expect(out.glute!.clamped).toBe(false);
    }
  }, 60000);

  it('結果不依賴上一次輸入；男性不受開關影響', () => {
    const a = runG(true, { height: 160 });
    runG(true, { height: 175, weight: 80 });
    runG(true, { height: 160, hip: 105 });
    const b = runG(true, { height: 160 });
    let diff = 0;
    for (let i = 0; i < a.positions.length; i++) diff = Math.max(diff, Math.abs(a.positions[i] - b.positions[i]));
    expect(diff).toBeLessThan(1e-4);
    const m0 = runG(false, { height: 175 }, 'male'), m1 = runG(true, { height: 175 }, 'male');
    expect(m1.positions.length).toBe(m0.positions.length);
    expect(m1.glute).toBeUndefined();
  }, 60000);

  it('脂肪、去脂小步變化時，臀那一圈連續（跨過曲線節點與去脂欄）', () => {
    const sug = suggest({ sex: 'female', locked: { height: 160 }, bustDiff: null });
    const B1 = glute.skeleton1(engine.rings.fitComposition(bodyInputFor({ sex: 'female', sug, bustDiff: null }), { neutralize: true }).skeleton);
    let worst = 0;
    for (const L of [29.5, 35.3, 41, 52, 70]) {
      for (let F = 2; F < 130; F += 0.5) {
        const a = glute.region(B1, F, L, 1), b = glute.region(B1, F + 0.5, L + 0.1, 1);
        let d = 0;
        for (let i = 0; i < a.length; i += 3) d = Math.max(d, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
        worst = Math.max(worst, d);
      }
    }
    expect(worst).toBeLessThan(0.5);
  }, 60000);
});
