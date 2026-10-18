import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { parseBodyAsset } from '../../src/body/mh/asset';
import { RingBody } from '../../src/body/mh/rings';

it('proto cases', { timeout: 600000 }, () => {
  const buf = readFileSync('public/body.bin');
  const a = parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const tri: number[] = [];
  for (let q = 0; q < a.quads.length; q += 4) tri.push(a.quads[q], a.quads[q + 1], a.quads[q + 2], a.quads[q], a.quads[q + 2], a.quads[q + 3]);
  const rb = new RingBody(a);
  const cases: Record<string, { height: number; bust: number; underbust: number; waist: number; hip: number; thigh: number }> = {
    avg: { height: 160, bust: 83, underbust: 70, waist: 64, hip: 89, thigh: 51 },
    slim: { height: 165, bust: 86, underbust: 68, waist: 57, hip: 90, thigh: 50 },
    heavy: { height: 162, bust: 108, underbust: 92, waist: 98, hip: 118, thigh: 68 },
    curvy: { height: 160, bust: 88, underbust: 68, waist: 62, hip: 94, thigh: 54 },
  };
  for (const [name, T] of Object.entries(cases)) {
    const f = rb.fit('female', T, { neutralize: true });
    const r = (x: number) => Math.round(x * 10) / 10;
    console.log(name, f.iterations, JSON.stringify(Object.fromEntries(Object.keys(T).map((k) => [k, r(f.values[k as keyof typeof f.values])]))));
    let minY = Infinity;
    for (let i = 0; i < a.nBody; i++) minY = Math.min(minY, f.P[i * 3 + 1]);
    const v = Array.from(f.P.subarray(0, a.nBody * 3), (x, i) => Math.round((i % 3 === 1 ? x - minY : x) * 100) / 1000);
    writeFileSync('/tmp/claude-0/-home-user-bodyreferencewebsite/58516b04-ab8e-5675-a7f9-122b92028875/scratchpad/web/pc-' + name + '.json', JSON.stringify({ v, i: tri }));
  }
});
