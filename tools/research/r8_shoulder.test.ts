// R8：網站肩寬（經後頸的弧長）和網格骨點距離的對照。研究用，平常跳過。
// 執行：R8_OUT=<輸出檔.json> npx vitest run tools/research/r8_shoulder.test.ts
// 量的是目前的形狀層；換形狀層後要重跑，結論記在 docs/work/00-foundation/research-frame.md。
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { bodyInputFor } from '../../src/body/goals';
import { parseBodyAsset } from '../../src/body/mh/asset';
import { BodyEngine } from '../../src/body/mh/engine';
import { suggest } from '../../src/core/linkage';
import type { Sex } from '../../src/core/measurements';

const OUT = process.env.R8_OUT;

describe.skipIf(!OUT)('R8 肩寬換算', () => {
  it('弧長與骨點距離', () => {
    const buf = readFileSync('public/body.bin');
    const engine = new BodyEngine(parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    const cases: [Sex, Record<string, number>][] = [
      ['female', { height: 160, weight: 52 }], ['female', { height: 160, weight: 45 }], ['female', { height: 158, weight: 80 }],
      ['female', { height: 170, weight: 60 }], ['female', { height: 160, weight: 52, shoulder: 35 }], ['female', { height: 160, weight: 52, shoulder: 41 }],
      ['male', { height: 172, weight: 68 }], ['male', { height: 172, weight: 58 }], ['male', { height: 172, weight: 95 }],
      ['male', { height: 185, weight: 80 }], ['male', { height: 172, weight: 68, shoulder: 41 }], ['male', { height: 172, weight: 68, shoulder: 49 }],
    ];
    const rows = cases.map(([sex, locked]) => {
      const sug = suggest({ sex, locked, bustDiff: null });
      const out = engine.run({ ...bodyInputFor({ sex, sug, bustDiff: null }), armAngle: 16 });
      const bone = out.measurement.sources.shoulderBone;
      return { sex, ...locked, arc: +out.values.shoulder.toFixed(2), bone: +bone.toFixed(2),
        diff: +(out.values.shoulder - bone).toFixed(2), bf: +out.bodyFat.toFixed(3) };
    });
    writeFileSync(OUT!, JSON.stringify(rows, null, 1));
  }, 300000);
});
