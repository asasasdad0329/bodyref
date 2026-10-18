import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { parseBodyAsset } from '../../src/body/mh/asset';
import { MEASURE_KEYS } from '../../src/body/mh/measure';
import { type RingTargets, RingBody } from '../../src/body/mh/rings';
import { suggest } from '../../src/core/linkage';
import type { Sex } from '../../src/core/measurements';

// 原型的驗收案例：鎖定的數值照填，其他量測用連動模型的建議值補齊

const CASES: Record<string, [Sex, Record<string, number>]> = {
  target: ['female', { height: 172, bust: 120, underbust: 87, waist: 70, hip: 117, thigh: 70 }],
  avg: ['female', { height: 160 }],
  curvy: ['female', { height: 160, bust: 88, underbust: 68, waist: 62, hip: 94, thigh: 54 }],
  heavy: ['female', { height: 162, weight: 85 }],
  male: ['male', { height: 175 }],
  maleHeavy: ['male', { height: 175, weight: 100 }],
  male97: ['male', { height: 170, weight: 97 }],
};

it('ring prototype', { timeout: 900000 }, () => {
  const buf = readFileSync('public/body.bin');
  const a = parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const tri: number[] = [];
  for (let q = 0; q < a.quads.length; q += 4) tri.push(a.quads[q], a.quads[q + 1], a.quads[q + 2], a.quads[q], a.quads[q + 2], a.quads[q + 3]);
  const rb = new RingBody(a);
  const only = process.env.ONLY?.split(',');
  for (const [name, [sex, locked]] of Object.entries(CASES)) {
    if (only && !only.includes(name)) continue;
    const v = suggest({ sex, locked }).values;
    const T = Object.fromEntries(MEASURE_KEYS.map((k) => [k, v[k]])) as RingTargets;
    const t0 = performance.now();
    const f = rb.fit(sex, T, { neutralize: true });
    const r = (x: number) => Math.round(x * 10) / 10;
    const off = MEASURE_KEYS.filter((k) => Math.abs(f.values[k] - T[k]!) > 0.3).map((k) => `${k} ${r(f.values[k])}/${r(T[k]!)}`);
    console.log(name, JSON.stringify(Object.fromEntries(Object.entries(f.params).map(([k, x]) => [k, r(x * 100) / 100]))), Math.round(performance.now() - t0) + 'ms', 'it', f.iterations, off.length ? 'OFF ' + off.join(', ') : 'all within 0.3 cm');
    let minY = Infinity;
    for (let i = 0; i < a.nBody; i++) minY = Math.min(minY, f.P[i * 3 + 1]);
    const out = Array.from(f.P.subarray(0, a.nBody * 3), (x, i) => Math.round((i % 3 === 1 ? x - minY : x) * 100) / 1000);
    writeFileSync('/tmp/claude-0/-home-user-bodyreferencewebsite/58516b04-ab8e-5675-a7f9-122b92028875/scratchpad/web/fb-' + name + '.json', JSON.stringify({ v: out, i: tri }));
  }
});
