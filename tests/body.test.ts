import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { goalsFor } from '../src/body/goals';
import { parseBodyAsset } from '../src/body/mh/asset';
import { BodyEngine, type EngineOutput } from '../src/body/mh/engine';
import { suggest } from '../src/core/linkage';
import type { Sex } from '../src/core/measurements';
import { REFERENCE, cupDiff } from '../src/core/reference';

let engine: BodyEngine;

beforeAll(() => {
  const buf = readFileSync('public/body.bin');
  engine = new BodyEngine(parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
});

function run(sex: Sex, locked: Record<string, number>, cup: string | null = null): EngineOutput {
  const bustDiff = cup ? cupDiff(cup)! : null;
  const sug = suggest({ sex, locked, bustDiff });
  return engine.run({ ...goalsFor({ sex, sug, bustDiff }), armAngle: 16 });
}

describe('人體網格', () => {
  const cases: [string, Sex, Record<string, number>, string | null][] = [
    ['女性參考', 'female', { height: 160, weight: 52 }, null],
    ['男性參考', 'male', { height: 172, weight: 68 }, null],
    ['誇張沙漏', 'female', { height: 160, weight: 50, bust: 94, underbust: 66, waist: 56, hip: 94 }, null],
    ['偏胖', 'female', { height: 158, weight: 80 }, null],
    ['高壯男性', 'male', { height: 190, weight: 95, bodyFat: 0.24 }, null],
    ['G 罩杯', 'female', { height: 168, thigh: 56, calf: 36 }, 'G'],
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
});
