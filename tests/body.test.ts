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
import { applyRatios } from '../src/core/proportions';
import { measure } from '../src/body/mh/measure';
import { horizontal, slice } from '../src/body/mh/geometry';

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
    }, 10000);
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

  it('結果不受上一次輸入影響（每次從確定起點求解）', () => {
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
  }, 15000);

  it('體重沒鎖定時，把腰圍改粗會讓體重跟著變重', () => {
    const base = run('female', { height: 160 });
    const thick = run('female', { height: 160, waist: base.values.waist + 12 });
    expect(thick.weight - base.weight).toBeGreaterThan(3);
    expect(thick.bodyFat).toBeGreaterThan(base.bodyFat);
  }, 15000);

  it('體重變重時，指定的罩杯維持不變', () => {
    for (const weight of [52, 62, 75]) {
      const out = run('female', { height: 165, weight }, 'D');
      expect(out.values.bust - out.values.underbust, `${weight} kg`).toBeCloseTo(17.5, 0);
    }
  }, 15000);

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
    const { locked } = applyRatios({ sex: c.sex, locked: c.locked, bustDiff: c.cup ? cupDiff(c.cup)! : null }, c.ratios ?? {});
    return run(c.sex, locked as Record<string, number>, c.cup ?? null);
  };

  for (const c of BODY_CASES.filter((c) => /^(CUP-E-|PRESET-)/.test(c.id))) {
    it(`${c.id}：預設與代表體型的手動條件全部對準`, () => {
      const out = regression(c.id);
      for (const { goal, error } of out.residual) expect(Math.abs(error), goal.kind === 'measure' ? goal.key : goal.kind).toBeLessThan(
        goal.kind === 'bodyFat' || goal.kind === 'muscleRate' ? 0.01 : 0.5);
      expect(out.positions.every(Number.isFinite)).toBe(true);
    }, 15000);
  }

  it('胸壁與乳房分開量測，顯示平滑不能把已對準的胸部削扁', () => {
    const sex = 'female' as const, bustDiff = 20;
    const sug = suggest({ sex, locked: { height: 162, bust: 95, underbust: 75, waist: 62, hip: 110 }, bustDiff });
    const res = engine.rings.fitComposition(bodyInputFor({ sex, sug, bustDiff }), { neutralize: true });
    expect(res.chestWall).toBeDefined();
    const shown = engine.model.display(res.P, 16).P;
    const measured = measure(engine.rings.ctx, shown, res.measured.levels, sex, res.chestWall);
    expect(Math.abs(measured.values.bust - res.values.bust)).toBeLessThan(0.35);
    expect(Math.abs(measured.values.underbust - 75)).toBeLessThan(0.5);
    const peak = Math.max(...Array.from(engine.rings.ctx.breast, (i) => shown[i * 3 + 2]));
    let sternum = -Infinity;
    for (let i = 0; i < engine.asset.nBody; i++) if (Math.abs(shown[i * 3]) < 1 && Math.abs(shown[i * 3 + 1] - measured.marks.bustY) < 1.5) sternum = Math.max(sternum, shown[i * 3 + 2]);
    // E 罩杯須有獨立於胸壁的可見前凸，不能用整片胸廓變粗湊胸圍差。
    expect(peak - sternum).toBeGreaterThan(3);
  }, 15000);

  it('大胸廓的罩杯差不能被胸壁吃掉，只留下貼在尖峰上的薄層', () => {
    const sex = 'female' as const;
    const sug = suggest({ sex, locked: { height: 160, weight: 120 } });
    const input = bodyInputFor({ sex, sug, bustDiff: null });
    const out = engine.rings.fitComposition(input, { neutralize: true });
    const wall = out.chestWall!;
    const projection = Math.max(...Array.from(engine.rings.ctx.breast, (i) => out.P[i * 3 + 2] - wall[i * 3 + 2]));
    // 這是此偏胖 C 罩杯個案的美術防退步界線，不是一般人的罩杯換算公式。
    expect(projection).toBeGreaterThan(2.5);
    expect(Math.abs(out.values.bust - input.frame.bust!)).toBeLessThan(0.5);
    expect(Math.abs(out.values.underbust - input.frame.underbust!)).toBeLessThan(0.5);
    expect(Math.abs(out.weight - 120)).toBeLessThan(0.5);
  }, 15000);

  it('固定細腰與高體脂時，後腰中線不能高出兩側形成脊柱尖稜', () => {
    for (const id of ['CUP-E-W50', 'F-SHAPE-BF35', 'LOCK-W80']) {
      const out = regression(id), y = out.tapes.waist!.anchor[1];
      const loops = slice(out.positions, engine.asset.quads, engine.rings.ctx.faces.trunk, horizontal(y));
      const backAt = (x: number) => {
        let back = Infinity;
        for (const loop of loops) for (let i = 1; i < loop.length; i++) {
          const a = loop[i - 1], b = loop[i];
          if (Math.abs(b[0] - a[0]) < 1e-6 || x < Math.min(a[0], b[0]) || x > Math.max(a[0], b[0])) continue;
          const t = (x - a[0]) / (b[0] - a[0]);
          back = Math.min(back, a[2] + (b[2] - a[2]) * t);
        }
        expect(Number.isFinite(back), id).toBe(true);
        return back;
      };
      expect(Math.min(backAt(-3), backAt(3)) - backAt(0), id).toBeLessThan(1);
    }
  }, 30000);

  for (const [id, low, high] of [['T2', 22, 26], ['T3', 28, 32], ['T4', 31, 35.5]] as const) {
    it(`${id}：預設上臂不再因總量分配過細或過粗`, () => {
      const out = regression(id);
      expect(out.values.upperArm).toBeGreaterThan(low);
      expect(out.values.upperArm).toBeLessThan(high);
      for (const { goal, error } of out.residual) {
        expect(Math.abs(error), goal.kind === 'measure' ? goal.key : goal.kind).toBeLessThan(goal.kind === 'bodyFat' ? 0.01 : 0.5);
      }
    }, 10000);
  }

  it('偏胖預設的腰腹增量不能靠繼續放大臀腿補償', () => {
    const out = regression('T4');
    expect(out.values.waist).toBeGreaterThan(86);
    expect(out.values.hip).toBeLessThan(118);
    expect(out.values.thigh).toBeLessThan(71);
    expect(Math.abs(out.weight - 80)).toBeLessThan(0.5);
  }, 10000);

  it('鎖體重縮手臂時，臀圍的額外補償受到限制', () => {
    const before = regression('T4');
    const after = regression('UA-T4-30');
    expect(Math.abs(after.values.upperArm - 30)).toBeLessThan(0.5);
    expect(Math.abs(after.weight - 80)).toBeLessThan(0.5);
    expect(after.values.hip - before.values.hip).toBeLessThan(4);
    expect(after.values.thigh - before.values.thigh).toBeLessThan(2);
  }, 20000);

  it('分配與解除鎖定不依賴快取路徑', () => {
    const before = regression('T3');
    regression('T4');
    regression('UA-T4-30');
    const after = regression('T3');
    for (const key of ['waist', 'hip', 'thigh', 'calf', 'upperArm'] as const) {
      expect(Math.abs(after.values[key] - before.values[key]), key).toBeLessThan(0.3);
    }
    expect(Math.abs(after.weight - before.weight)).toBeLessThan(0.3);
  }, 30000);
  it('只指定大臀時，跨區基底不能讓手動臀圍卡在下限外', () => {
    const out = regression('T7-hip130');
    expect(Math.abs(out.values.hip - 130)).toBeLessThan(0.5);
  }, 10000);

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
  }, 30000);

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

  const anatomyOutputs = new Map<string, EngineOutput>();
  const anatomyCase = (id: string) => {
    if (!anatomyOutputs.has(id)) anatomyOutputs.set(id, regression(id));
    return anatomyOutputs.get(id)!;
  };
  const anatomyIds = BODY_CASES.filter((c) => /^(LOCK-|F-|M-)/.test(c.id)).map((c) => c.id);
  for (const id of anatomyIds) {
    it(`${id}：固定圍度時仍校正重量、脂肪與獨立肌肉，三類重量完整記帳`, () => {
      const out = anatomyCase(id);
      for (const { goal, error } of out.residual) {
        expect(Math.abs(error), goal.kind === 'measure' ? goal.key : goal.kind).toBeLessThan(
          goal.kind === 'bodyFat' || goal.kind === 'muscleRate' ? 0.01 : 0.5);
      }
      expect(out.positions.every(Number.isFinite)).toBe(true);
      expect(Object.values(out.tissueMass).every((kg) => kg > 0)).toBe(true);
      expect(out.tissueMass.fat + out.tissueMass.muscle + out.tissueMass.otherLean).toBeCloseTo(out.weight, 8);
      expect(out.tissueMass.fat / out.weight).toBeCloseTo(out.bodyFat, 8);
      expect(out.tissueMass.muscle / out.weight).toBeCloseTo(out.muscleRate, 8);
      // 不准把自由重量藏在沒有獨立量測的胸大肌或背部。
      if (id.startsWith('LOCK-')) expect(out.composition.pectoralMuscle).toBeLessThan(2);
    }, 10000);
  }

  const regionRms = (a: EngineOutput, b: EngineOutput, lo: number, hi: number, front: boolean) => {
    let sum = 0, count = 0;
    const regions = new Set(['torso', 'breastL', 'breastR', 'thighL', 'thighR'].map((name) => engine.asset.regions.indexOf(name)));
    for (let i = 0; i < engine.asset.nBody; i++) {
      const y = a.positions[i * 3 + 1];
      if (!regions.has(engine.asset.region[i]) || y < lo || y > hi) continue;
      if (front && a.positions[i * 3 + 2] < 0) continue;
      sum += [0, 1, 2].reduce((s, k) => s + (a.positions[i * 3 + k] - b.positions[i * 3 + k]) ** 2, 0); count++;
    }
    expect(count).toBeGreaterThan(20);
    return Math.sqrt(sum / count);
  };

  it('固定腰臀與脂肪時，獨立肌肉率仍改變女性腰腹臀形，而非只改顯示數字', () => {
    const a = anatomyCase('F-M30'), b = anatomyCase('F-M43');
    expect(b.tissueMass.muscle - a.tissueMass.muscle).toBeGreaterThan(7);
    expect(Math.abs(a.bodyFat - b.bodyFat)).toBeLessThan(0.002);
    expect(regionRms(a, b, a.marks.crotchY - 3, a.marks.crotchY + 30, false)).toBeGreaterThan(0.2);
  });

  it('同樣胸腰臀仍有不同脂肪覆蓋；女性胸部與腰腹都參與形變', () => {
    const a = anatomyCase('F-SHAPE-BF18'), b = anatomyCase('F-SHAPE-BF35');
    expect(b.composition.chest).toBeGreaterThan(a.composition.chest);
    expect(regionRms(a, b, 105, 135, true)).toBeGreaterThan(0.15);
    expect(regionRms(a, b, a.marks.crotchY + 5, 105, true)).toBeGreaterThan(0.2);
  });

  it('男性固定胸圍、體脂時，肌肉率能改變胸前形態', () => {
    const a = anatomyCase('M-CHEST-M30'), b = anatomyCase('M-CHEST-M45');
    expect(regionRms(a, b, 115, 145, true)).toBeGreaterThan(0.15);
    expect(b.tissueMass.muscle - a.tissueMass.muscle).toBeGreaterThan(10);
  });

  it('臀圍增大也增加正面臀側及大腿上外側的寬度，即使大腿圍固定', () => {
    const base = { height: 165, bust: 97, underbust: 76, waist: 68, thigh: 56 };
    const a = run('female', { ...base, hip: 94 }), b = run('female', { ...base, hip: 114 });
    const span = (out: EngineOutput) => {
      let width = 0;
      const regions = new Set(['torso', 'thighL', 'thighR'].map((name) => engine.asset.regions.indexOf(name)));
      for (let i = 0; i < engine.asset.nBody; i++) {
        const y = out.positions[i * 3 + 1];
        if (regions.has(engine.asset.region[i]) && Math.abs(y - out.marks.crotchY) < 3) width = Math.max(width, 2 * Math.abs(out.positions[i * 3]));
      }
      return width;
    };
    for (const out of [a, b]) for (const r of out.residual) expect(Math.abs(r.error), r.goal.kind).toBeLessThan(0.5);
    expect(Math.abs(b.values.thigh - 56)).toBeLessThan(0.5);
    expect(span(b) - span(a)).toBeGreaterThan(1);
  }, 15000);

  it('改肌肉與體脂後回到原狀，形態校準不受歷史影響', () => {
    const a = anatomyCase('F-M30'); anatomyCase('M-CHEST-BF32'); anatomyCase('F-SHAPE-BF35');
    const b = regression('F-M30');
    expect(Math.max(...a.positions.map((v, i) => Math.abs(v - b.positions[i])))).toBeLessThan(0.01);
    expect(Math.abs(a.muscleRate - b.muscleRate)).toBeLessThan(0.0001);
  });

  it('同一罩杯格點內的小數尺寸不污染骨架與形態快取', () => {
    const locked = { height: 165, underbust: 74, bust: 90.2, waist: 68, hip: 100 };
    const a = run('female', locked);
    run('female', { ...locked, bust: 90.4 });
    const sug = suggest({ sex: 'female', locked });
    const input = { ...bodyInputFor({ sex: 'female', sug, bustDiff: null }), armAngle: 16 };
    const b = new BodyEngine(engine.asset).run(input);
    expect(Math.max(...a.positions.map((v, i) => Math.abs(v - b.positions[i])))).toBeLessThan(0.01);
  }, 15000);

  it('脂肪加肌肉要求超過可用重量時保留組成殘差，不回報虛假的達標', () => {
    const out = run('female', { height: 165, weight: 62, bodyFat: 0.45, muscleRate: 0.5 });
    const residual = out.residual.find((r) => r.goal.kind === 'muscleRate')!;
    expect(Math.abs(residual.error)).toBeGreaterThan(0.03);
    expect(out.tissueMass.otherLean).toBeGreaterThan(0);
    expect(out.positions.every(Number.isFinite)).toBe(true);
  }, 20000);

  it('大罩杯向上下與側邊展開，不能只長成前後很長的錐形', () => {
    const out = regression('T5-125');
    const region = engine.asset.regions.indexOf('breastL');
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < engine.asset.nBody; i++) if (engine.asset.region[i] === region) {
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], out.positions[i * 3 + k]); hi[k] = Math.max(hi[k], out.positions[i * 3 + k]); }
    }
    // 美術回歸的形態上界，不是人體比例定律。
    expect(hi[2] - lo[2]).toBeLessThan(1.1 * (hi[1] - lo[1]));
    expect(hi[2] - lo[2]).toBeLessThan(1.8 * (hi[0] - lo[0]));
    // 向內展開也不能讓左乳房越過正中線。
    expect(lo[0]).toBeGreaterThan(0);
    for (const { error } of out.residual) expect(Math.abs(error)).toBeLessThan(0.5);
  }, 10000);

  it('男性增加胸圍時也展寬胸廓，不能只向胸前長出肉塊', () => {
    const locked = { height: 175, weight: 80, bodyFat: 0.2, muscleRate: 0.45, underbust: 88, waist: 82, hip: 100,
      shoulder: 45, upperArmLen: 33, forearmLen: 26, thighLen: 31, calfLen: 43 };
    const a = run('male', { ...locked, bust: 100 }), b = run('male', { ...locked, bust: 108 });
    const chestExtent = (out: EngineOutput) => {
      const y = out.tapes.bust!.anchor[1]; let width = 0, front = -Infinity, back = Infinity;
      const regions = new Set(['torso', 'breastL', 'breastR'].map((name) => engine.asset.regions.indexOf(name)));
      for (let i = 0; i < engine.asset.nBody; i++) if (regions.has(engine.asset.region[i]) && Math.abs(out.positions[i * 3 + 1] - y) < 1.3) {
        width = Math.max(width, 2 * Math.abs(out.positions[i * 3])); front = Math.max(front, out.positions[i * 3 + 2]); back = Math.min(back, out.positions[i * 3 + 2]);
      }
      return { width, front, back };
    };
    for (const out of [a, b]) for (const r of out.residual) expect(Math.abs(r.error), r.goal.kind).toBeLessThan(r.goal.kind === 'bodyFat' || r.goal.kind === 'muscleRate' ? 0.01 : 0.5);
    const from = chestExtent(a), to = chestExtent(b);
    expect(to.width - from.width).toBeGreaterThan(0.5);
    expect(to.width - from.width).toBeGreaterThan(0.35 * Math.max(0.1, to.front - from.front));
    expect(Math.abs(to.back - from.back)).toBeLessThan(1);
  }, 15000);

});
