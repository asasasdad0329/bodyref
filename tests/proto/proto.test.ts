import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { goalsFor } from '../../src/body/goals';
import { parseBodyAsset } from '../../src/body/mh/asset';
import { BodyEngine } from '../../src/body/mh/engine';
import { RingBody } from '../../src/body/mh/rings';
import { suggest } from '../../src/core/linkage';

it('proto', { timeout: 600000 }, () => {
  const buf = readFileSync('public/body.bin');
  const a = parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const tri: number[] = [];
  for (let q = 0; q < a.quads.length; q += 4) tri.push(a.quads[q], a.quads[q + 1], a.quads[q + 2], a.quads[q], a.quads[q + 2], a.quads[q + 3]);
  const dump = (name: string, P: Float32Array) => {
    let minY = Infinity;
    for (let i = 0; i < a.nBody; i++) minY = Math.min(minY, P[i * 3 + 1]);
    const v = Array.from(P.subarray(0, a.nBody * 3), (x, i) => Math.round((i % 3 === 1 ? x - minY : x) * 100) / 1000);
    writeFileSync('/tmp/claude-0/-home-user-bodyreferencewebsite/58516b04-ab8e-5675-a7f9-122b92028875/scratchpad/web/' + name + '.json', JSON.stringify({ v, i: tri }));
  };
  const T = JSON.parse(process.env.T ?? '{"height":172,"bust":120,"underbust":87,"waist":70,"hip":117,"thigh":70}');
  const r = (x: number) => Math.round(x * 10) / 10;
  const engine = new BodyEngine(a);
  const locked = { ...T };
  const sug = suggest({ sex: 'female', locked });
  const o = engine.run({ ...goalsFor({ sex: 'female', sug, bustDiff: null }), armAngle: 0 });
  console.log('current', JSON.stringify(Object.fromEntries(Object.keys(T).map((k) => [k, r(o.values[k as keyof typeof o.values])]))), 'w', r(o.weight));
  dump('pr-current', o.positions);
  const rb = new RingBody(a);
  for (const neutralize of [false, true]) {
    const t0 = performance.now();
    const f = rb.fit('female', T, { neutralize });
    console.log('ring', neutralize, Math.round(performance.now() - t0) + 'ms', f.iterations, JSON.stringify(Object.fromEntries(Object.keys(T).map((k) => [k, r(f.values[k as keyof typeof f.values])]))), JSON.stringify(f.params));
    dump(neutralize ? 'pr-ringN' : 'pr-ring', f.P);
  }
});
