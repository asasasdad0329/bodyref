import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { goalsFor } from '../../src/body/goals';
import { parseBodyAsset } from '../../src/body/mh/asset';
import { BodyEngine } from '../../src/body/mh/engine';
import { MEASURE_KEYS, measure, measureContext } from '../../src/body/mh/measure';
import { type RingTargets, RingBody } from '../../src/body/mh/rings';
import { suggest } from '../../src/core/linkage';

// 腰的切面寬與厚：舊模型（現在的網站）與環切面原型比較
it('waist cross-section', { timeout: 600000 }, () => {
  const buf = readFileSync('public/body.bin');
  const a = parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ctx = measureContext(a);
  const torso = a.regions.indexOf('torso');
  const section = (P: Float32Array, y: number) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < a.nBody; i++) {
      if (a.region[i] !== torso || Math.abs(P[i * 3 + 1] - y) > 0.6) continue;
      x0 = Math.min(x0, P[i * 3]); x1 = Math.max(x1, P[i * 3]);
      z0 = Math.min(z0, P[i * 3 + 2]); z1 = Math.max(z1, P[i * 3 + 2]);
    }
    return `寬 ${(x1 - x0).toFixed(1)} cm、厚 ${(z1 - z0).toFixed(1)} cm`;
  };
  const locked = { height: 162, bust: 97, underbust: 76, waist: 68, hip: 114 };
  const sug = suggest({ sex: 'female', locked });
  // 舊模型：鎖體重（當時預設會鎖）與不鎖
  const engine = new BodyEngine(a);
  for (const w of [null, sug.values.weight * 0.85]) {
    const lk = w ? { ...locked, weight: w } : locked;
    const s2 = suggest({ sex: 'female', locked: lk });
    const o = engine.run({ ...goalsFor({ sex: 'female', sug: s2, bustDiff: null }), armAngle: 16 });
    const P = new Float32Array(a.base.length);
    P.set(o.positions);
    const m = measure(ctx, P);
    console.log('old', w ? `weight locked ${w.toFixed(1)}` : 'weight free', 'w', o.weight.toFixed(1), 'waist', m.values.waist.toFixed(1), section(P, m.marks.waistY));
  }
  const T = Object.fromEntries(MEASURE_KEYS.map((k) => [k, sug.values[k]])) as RingTargets;
  const f = new RingBody(a).fit('female', T, { neutralize: true });
  const m = measure(ctx, f.P);
  console.log('ring', 'waist', m.values.waist.toFixed(1), section(f.P, m.marks.waistY), 'hip', m.values.hip.toFixed(1), 'bust', m.values.bust.toFixed(1));
  let minY = Infinity;
  for (let i = 0; i < a.nBody; i++) minY = Math.min(minY, f.P[i * 3 + 1]);
  const tri: number[] = [];
  for (let q = 0; q < a.quads.length; q += 4) tri.push(a.quads[q], a.quads[q + 1], a.quads[q + 2], a.quads[q], a.quads[q + 2], a.quads[q + 3]);
  writeFileSync('/tmp/claude-0/-home-user-bodyreferencewebsite/58516b04-ab8e-5675-a7f9-122b92028875/scratchpad/web/fb-w68.json', JSON.stringify({ v: Array.from(f.P.subarray(0, a.nBody * 3), (x, i) => Math.round((i % 3 === 1 ? x - minY : x) * 100) / 1000), i: tri }));
});
