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

});
