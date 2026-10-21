import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { bodyInputFor } from '../src/body/goals';
import { parseBodyAsset } from '../src/body/mh/asset';
import { redistributionStep } from '../src/body/mh/distribution';
import { zeroSoft } from '../src/body/mh/rings';
import { BodyEngine, type EngineOutput } from '../src/body/mh/engine';
import { suggest } from '../src/core/linkage';
import type { Sex } from '../src/core/measurements';
import { REFERENCE, cupDiff } from '../src/core/reference';
import { BODY_CASES, H104_THIGH } from './fixtures/bodyCases';
import { DEFAULT_MORPHOLOGY, type Morphology } from '../src/core/morphology';
import { BreastRig } from '../src/body/mh/breast';

let engine: BodyEngine;

beforeAll(() => {
  const buf = readFileSync('public/body.bin');
  engine = new BodyEngine(parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
});

function run(sex: Sex, locked: Record<string, number>, cup: string | null = null, options: { morphology?: Morphology; muscleMass?: number } = {}): EngineOutput {
  const bustDiff = cup ? cupDiff(cup)! : null;
  const sug = suggest({ sex, locked, bustDiff });
  return engine.run({ ...bodyInputFor({ sex, sug, bustDiff, ...options }), armAngle: 16 });
}

function expectHard(out: EngineOutput) {
  for (const { goal, error } of out.residual) expect(Math.abs(error), JSON.stringify(goal)).toBeLessThan(goal.kind === 'bodyFat' ? 0.01 : 0.5);
  expect(Object.values(out.tissues).every(x => Number.isFinite(x) && x >= 0)).toBe(true);
  expect(out.tissues.fat + out.tissues.muscle + out.tissues.otherLean).toBeCloseTo(out.weight, 8);
  expect(Object.values(out.accounting).reduce((s, x) => s + x, 0)).toBeCloseTo(out.tissues.otherLean, 8);
  expect((out.tissues.fat / 0.9 + (out.tissues.muscle + out.tissues.otherLean) / 1.06) * 1000).toBeCloseTo(out.volume, 4);
}

describe('共同形狀控制與組成', () => {
  it('局部差分平滑與兩份完整曲面一致', () => {
    const m = engine.model, rig = new BreastRig(engine.asset, engine.asset.base, m.adj);
    const base = new Float32Array(engine.asset.base), shaped = new Float32Array(base);
    rig.apply(shaped, 3.5, 'long');
    const expectedBase = new Float32Array(base), expectedShape = new Float32Array(shaped);
    m.finish(expectedBase); m.finish(expectedShape);
    m.finishPair(base, shaped, rig.support);
    expect(Math.max(...base.map((v, i) => Math.abs(v - expectedBase[i])))).toBeLessThan(0.00003);
    expect(Math.max(...shaped.map((v, i) => Math.abs(v - expectedShape[i])))).toBe(0);
  });
  for (const breast of ['teardrop', 'long', 'round'] as const) it(`${breast}：B／G／S 維持站姿胸圍差與總帳`, () => {
    for (const cup of ['B', 'G', 'S']) expectHard(run('female', { height: 160, underbust: 70 }, cup,
      { morphology: { ...DEFAULT_MORPHOLOGY, breast } }));
  }, 15000);
  for (const breast of ['teardrop', 'long', 'round'] as const) for (const bust of [85, 90, 95, 100]) {
    it(`${breast}：E${bust} 的四組腰臀都符合，含小胸廓`, () => {
      for (const waist of [56, 64]) for (const hip of [104, 114]) expectHard(run('female', { height: 160, bust, underbust: bust - 20, waist, hip }, null,
        { morphology: { ...DEFAULT_MORPHOLOGY, breast } }));
    }, 15000);
  }
  for (const hip of [94, 104, 114, 124, 130]) it(`H${hip}：固定原版 H104 大腿，連接仍對準`, () => {
    expectHard(run('female', { height: 165, bust: 97, underbust: 76, waist: 68, hip, thigh: H104_THIGH }));
  });
  for (const sex of ['female', 'male'] as const) it(`${sex}：同尺寸的肌脂交換與獨立肌肉量`, () => {
    const locked: Record<string, number> = sex === 'female' ? { height: 165, weight: 60, bust: 94, underbust: 74, waist: 68, hip: 104 }
      : { height: 175, weight: 80, bust: 105, waist: 85, hip: 100 };
    const low = run(sex, { ...locked, bodyFat: 0.25 }, null, { muscleMass: sex === 'female' ? 20 : 26 });
    const high = run(sex, { ...locked, bodyFat: 0.25 }, null, { muscleMass: sex === 'female' ? 28 : 36 });
    expectHard(low); expectHard(high);
    expect(Math.max(...high.positions.map((v, i) => Math.abs(v - low.positions[i])))).toBeGreaterThan(0.3);
    expect(high.tissues.muscle - low.tissues.muscle).toBeGreaterThan(7.5);
  }, 15000);
  for (const sex of ['female', 'male'] as const) it(`${sex}：臀腹型可獨立選擇並守住尺寸與體重`, () => {
    const locked: Record<string, number> = sex === 'female' ? { height: 165, weight: 60, bust: 94, underbust: 74, waist: 68, hip: 104, thigh: 56 }
      : { height: 175, weight: 80, bust: 105, waist: 85, hip: 100, thigh: 58 };
    const a = run(sex, locked);
    const b = run(sex, locked, null, { morphology: { breast: 'round', hip: 'projected', abdomen: 'smooth' } });
    expectHard(a); expectHard(b);
    expect(Math.max(...b.positions.map((v, i) => Math.abs(v - a.positions[i])))).toBeGreaterThan(0.15);
  }, 15000);
  it('肌肉大於已鎖去脂量時明列輸入衝突，沒有默改鎖定值', () => {
    const out = run('female', { height: 160, weight: 50, bodyFat: 0.3 }, null, { muscleMass: 40 });
    expect(out.diagnostics.some(d => d.kind === 'input-conflict')).toBe(true);
    const muscle = out.residual.find(r => r.goal.kind === 'muscleMass')!;
    expect(muscle.goal.value).toBe(40);
    expect(out.positions.every(Number.isFinite)).toBe(true);
  });
  for (const sex of ['female', 'male'] as const) it(`${sex}：自由圍度的獨立肌肉量也有可見響應`, () => {
    const locked = sex === 'female' ? { height: 165, weight: 60, bodyFat: 0.25 } : { height: 175, weight: 80, bodyFat: 0.25 };
    const a = run(sex, locked, null, { muscleMass: sex === 'female' ? 20 : 26 });
    const b = run(sex, locked, null, { muscleMass: sex === 'female' ? 28 : 36 });
    expectHard(a); expectHard(b);
    expect(Math.max(...a.positions.map((v, i) => Math.abs(v - b.positions[i])))).toBeGreaterThan(0.3);
  }, 15000);
  for (const id of ['MULTI90', 'MULTI90-T']) it(`${id}：容量不足保留尺寸、原體重殘差及未收斂診斷`, () => {
    const c = BODY_CASES.find(c => c.id === id)!;
    const out = run(c.sex, c.locked as Record<string, number>);
    if (!out.diagnostics.length) expectHard(out);
    else {
      expect(out.diagnostics.every(d => d.kind === 'unconverged')).toBe(true);
      for (const r of out.residual.filter(r => r.goal.kind === 'measure')) expect(Math.abs(r.error)).toBeLessThan(0.5);
      const weight = out.residual.find(r => r.goal.kind === 'weight')!;
      expect(weight.goal.value).toBe(90);
      expect(weight.error).toBeCloseTo(out.weight - 90, 6);
      expect(Object.values(out.tissues).every(x => x >= 0)).toBe(true);
    }
  }, 15000);
});

describe('人體網格', () => {
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
    expect(thick.tissues.fat - base.tissues.fat).toBeGreaterThan(3);
  });

  it('局部增脂不拿新增肌肉或其他去脂補差額', () => {
    // 明確相同杯型，兩者都不走「只填身高」的參考體重校正。
    const base = run('female', { height: 160 }, 'B');
    const thick = run('female', { height: 160, waist: base.values.waist + 12 }, 'B');
    expect(Math.abs(thick.tissues.muscle - base.tissues.muscle)).toBeLessThan(0.05);
    const bodyOtherLean = (o: EngineOutput) => o.accounting.otherLeanBase + o.accounting.otherLeanControl;
    expect(Math.abs(bodyOtherLean(thick) - bodyOtherLean(base))).toBeLessThan(0.05);
    expect(thick.tissues.fat - base.tissues.fat).toBeGreaterThan(3);
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

  // 舊值量在肩肘 55%；現改採 NHANES 放鬆中點 50%，不能沿用舊截面界限。
  // 固定由已留出的 log RMSE × 1.645 得到的 90% 預測區間，不從候選網格反算。
  for (const [id, low, high] of [['T2', 23.2596, 27.2785], ['T3', 29.9856, 35.1666], ['T4', 31.5853, 37.0427]] as const) {
    it(`${id}：預設放鬆上臂符合獨立 NHANES 預測範圍`, () => {
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
