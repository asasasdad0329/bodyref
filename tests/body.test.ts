import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseBodyAsset } from '../src/body/mh/asset';
import { BodyEngine, targetsFrom } from '../src/body/mh/engine';
import { suggest } from '../src/core/linkage';
import type { Sex } from '../src/core/measurements';
import { REFERENCE, bodyDensity } from '../src/core/reference';

let engine: BodyEngine;

beforeAll(() => {
  const buf = readFileSync('public/body.bin');
  engine = new BodyEngine(parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
});

function input(sex: Sex, locked: Record<string, number>, bustDiff: number | null = null) {
  const v = suggest({ sex, locked, bustDiff }).values;
  return { sex, targets: targetsFrom(v), bmi: v.weight / (v.height / 100) ** 2, bodyFat: v.bodyFat, armAngle: 16, values: v };
}

describe('人體網格', () => {
  const cases: [string, Sex, Record<string, number>, number | null][] = [
    ['女性參考', 'female', { height: 160, weight: 52 }, null],
    ['男性參考', 'male', { height: 172, weight: 68 }, null],
    ['誇張沙漏', 'female', { height: 160, weight: 50, bust: 94, underbust: 66, waist: 56, hip: 94 }, null],
    ['偏胖', 'female', { height: 158, weight: 80 }, null],
    ['高壯男性', 'male', { height: 190, weight: 95 }, null],
    ['E 罩杯', 'female', { height: 162, weight: 60 }, 20],
  ];
  for (const [name, sex, locked, diff] of cases) {
    it(`${name}：網格上量到的每個數值都符合（誤差 0.5 cm 內）`, () => {
      const inp = input(sex, locked, diff);
      const out = engine.run(inp);
      for (const [k, r] of Object.entries(out.residual)) expect(Math.abs(r), k).toBeLessThan(0.5);
    });
  }

  it('參考體型的模型體積接近真實人體（換算係數 0.9–1.1）', () => {
    for (const sex of ['female', 'male'] as const) {
      const ref = REFERENCE[sex];
      const inp = input(sex, { height: ref.height, weight: ref.weight });
      const fit = engine.fitOnly(inp);
      const factor = (ref.weight * 1000) / bodyDensity(inp.bodyFat) / fit.volume;
      expect(factor, sex).toBeGreaterThan(0.9);
      expect(factor, sex).toBeLessThan(1.1);
    }
  });

  it('顯示用輸出：移除原本的頭、加上人台頭與結構線', () => {
    const out = engine.run(input('female', { height: 160, weight: 52 }));
    const allTriangles = (engine.asset.quads.length / 4) * 2 * 3;
    expect(out.bodyIndex.length).toBeLessThan(allTriangles);
    expect(out.head.index.length).toBeGreaterThan(0);
    expect(out.guides.length).toBeGreaterThan(10);
    expect(out.positions.every(Number.isFinite)).toBe(true);
    expect(out.marks.topY).toBeCloseTo(160, 0);
  });
});
