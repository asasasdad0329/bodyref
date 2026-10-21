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
import { BODY_CASES } from './fixtures/bodyCases';
import { makeShapeBaseline, SHAPE_BASELINES } from '../src/lab/shapeBaseline';
import { cross, dot, sub, vert, adjacency } from '../src/body/mh/geometry';
import type { PelvicShapeControls } from '../src/body/mh/shapeControls';
import shapeBaseline from './fixtures/shapeBaseline.json';

let engine: BodyEngine;

describe('腰腹臀腿控制原型', () => {
  let rig: PelvicShapeControls;
  beforeAll(() => { rig = makeShapeBaseline(engine.asset, SHAPE_BASELINES[0]); });

  it('中性控制逐頂點重現固定基準，試探控制不污染下次求解', () => {
    const original = rig.baseline.slice();
    const neutral = rig.apply();
    expect(neutral.positions).toEqual(original);
    rig.apply(rig.hipPose('fat', 4));
    rig.fitHip('muscle', neutral.measured.values.hip + 2);
    expect(rig.apply().positions).toEqual(original);
    expect(rig.baseline).toEqual(original);
  });

  it('參考、細腰大臀及偏胖基準的量測、截面與體積不隨控制開發漂移', () => {
    for (const c of SHAPE_BASELINES) {
      const setup = c.id === 'reference' ? rig : makeShapeBaseline(engine.asset, c);
      const expected = shapeBaseline.cases.find((b) => b.id === c.id)!;
      for (const key of Object.keys(expected.values) as (keyof typeof expected.values)[]) {
        expect(setup.baselineResult.measured.values[key], `${c.id} ${key}`).toBeCloseTo(expected.values[key], 2);
      }
      expect(setup.baselineResult.volume).toBeCloseTo(expected.volume, 1);
      for (const key of ['waist', 'hip', 'thigh'] as const) {
        const actual = setup.baselineResult.measured.tapes[key]!;
        const section = expected.sections[key];
        expect(actual.length).toBe(section.length);
        actual.forEach((p, i) => p.forEach((v, axis) => expect(v).toBeCloseTo(section[i][axis], 3)));
      }
    }
  }, 15000);

  it('共享權重保持非負且總和不超過 1，支撐外與關節完全不動', () => {
    const moved = rig.apply(rig.hipPose('fat', 8));
    for (let i = 0; i < engine.asset.nBody; i++) {
      const weights = rig.controls.map((c) => c.weights[i]);
      expect(weights.every((v) => v >= 0 && Number.isFinite(v))).toBe(true);
      expect(weights.reduce((sum, v) => sum + v, 0)).toBeLessThanOrEqual(1.000001);
      if (!rig.support[i]) for (let k = 0; k < 3; k++) expect(moved.positions[i * 3 + k]).toBe(rig.baseline[i * 3 + k]);
    }
    expect(moved.positions.subarray(engine.asset.nBody * 3)).toEqual(rig.baseline.subarray(engine.asset.nBody * 3));
  });

  it('單一左臀側控制沿外側展寬，不穿越左右腿的空間捷徑', () => {
    const changed = rig.apply({ sideGluteL: 2 }).positions;
    let lateral = 0, movedRight = 0;
    for (let i = 0; i < engine.asset.nBody; i++) {
      const dx = changed[i * 3] - rig.baseline[i * 3];
      if (rig.baseline[i * 3] > 5) lateral = Math.max(lateral, dx);
      if (rig.baseline[i * 3] < -5) movedRight = Math.max(movedRight, Math.abs(dx));
      expect(changed[i * 3 + 1]).toBe(rig.baseline[i * 3 + 1]);
    }
    expect(lateral).toBeGreaterThan(0.5);
    expect(movedRight).toBeLessThan(0.03);
  });

  it('同臀圍的肌脂模式分布不同，固定大腿時仍有正面側寬連動', () => {
    const target = rig.baselineResult.measured.values.hip + 2;
    const muscle = rig.fitHip('muscle', target, true), fat = rig.fitHip('fat', target, true);
    for (const fit of [muscle, fat]) {
      expect(fit.reached).toBe(true);
      expect(Math.abs(fit.error)).toBeLessThan(0.5);
      expect(Math.abs(fit.result.measured.values.thigh - rig.baselineResult.measured.values.thigh)).toBeLessThan(0.5);
      expect(Math.abs(fit.result.measured.values.waist - rig.baselineResult.measured.values.waist)).toBeLessThan(0.5);
      // 固定大腿是量測限制，不會封死整個大腿根；臀側仍可增加正面寬度。
      let lateral = 0;
      for (let i = 0; i < engine.asset.nBody; i++) if (rig.baseline[i * 3] > 10)
        lateral = Math.max(lateral, fit.result.positions[i * 3] - rig.baseline[i * 3]);
      expect(lateral).toBeGreaterThan(0.15);
    }
    let difference = 0;
    for (let i = 0; i < muscle.result.positions.length; i++) difference = Math.max(difference, Math.abs(muscle.result.positions[i] - fat.result.positions[i]));
    expect(difference).toBeGreaterThan(0.1);
    expect(muscle.result.volume).toBeGreaterThan(rig.baselineResult.volume);
    expect(fat.result.volume).toBeGreaterThan(rig.baselineResult.volume);
  });

  it('超出模式範圍時保留殘差，不能以負向局部削洞達標', () => {
    const out = rig.fitHip('fat', 150, true);
    expect(out.reached).toBe(false);
    expect(out.error).toBeLessThan(-20);
    expect(Object.values(out.pose).every((v) => v >= 0)).toBe(true);
    expect(() => rig.apply({ sideGluteL: -10 })).toThrow();
    expect(() => rig.apply({ missing: 1 })).toThrow();
    expect(() => rig.fitHip('fat', NaN)).toThrow();
  });

  it('臀圍序列連續增長，局部控制與聯動不引入面翻轉或權重跳躍', () => {
    const adj = adjacency(engine.asset.quads, engine.asset.nBody);
    for (const c of rig.controls) {
      let maxSlope = 0;
      for (let i = 0; i < adj.length; i++) for (const j of adj[i]) {
        const edge = Math.hypot(...sub(vert(rig.baseline, i), vert(rig.baseline, j)));
        if (edge > 0.01) maxSlope = Math.max(maxSlope, Math.abs(c.weights[i] - c.weights[j]) / edge);
      }
      expect(maxSlope, c.id).toBeLessThan(0.4 / rig.scale);
    }
    const normal = (P: Float32Array, a: number, b: number, c: number) => cross(sub(vert(P, b), vert(P, a)), sub(vert(P, c), vert(P, a)));
    for (const mode of ['muscle', 'fat'] as const) {
      let previous = rig.baselineResult.measured.values.hip;
      for (const amount of [0.5, 1, 2, 4, 8]) {
        const result = rig.apply(rig.hipPose(mode, amount));
        expect(result.measured.values.hip).toBeGreaterThan(previous);
        previous = result.measured.values.hip;
        for (let f = 0; f < engine.asset.quads.length; f += 4) {
          const [a, b, c, d] = engine.asset.quads.subarray(f, f + 4);
          for (const tri of [[a, b, c], [a, c, d]]) {
            const [u, v, w] = tri;
            const before = normal(rig.baseline, u, v, w);
            if (dot(before, before) < 1e-10) continue;
            expect(dot(before, normal(result.positions, u, v, w)), `${mode} ${amount} face ${f / 4}`).toBeGreaterThan(0);
          }
        }
      }
    }
  }, 15000);
});

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
