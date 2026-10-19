import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { parseBodyAsset } from '../../src/body/mh/asset';
import { type RingTargets, RingBody } from '../../src/body/mh/rings';
import { suggest } from '../../src/core/linkage';
import type { Sex } from '../../src/core/measurements';

// 組成驅動的驗收案例：骨架類數值用連動建議補齊，軟組織圍度只有手動填的才固定
const SOFT = ['bust', 'waist', 'hip', 'thigh', 'calf', 'upperArm'] as const;
const FRAME = ['height', 'shoulder', 'neck', 'wrist', 'ankle', 'underbust', 'upperArmLen', 'forearmLen', 'thighLen', 'calfLen'] as const;
const CASES: Record<string, [Sex, Record<string, number>]> = {
  male97: ['male', { height: 170, weight: 97 }],
  target: ['female', { height: 172, bust: 120, underbust: 87, waist: 70, hip: 117, thigh: 70 }],
  w68: ['female', { height: 162, bust: 97, underbust: 76, waist: 68, hip: 114 }],
  avgF: ['female', { height: 160 }],
  avgM: ['male', { height: 175 }],
  heavyF: ['female', { height: 162, weight: 85 }],
};

it('composition prototype', { timeout: 900000 }, () => {
  const buf = readFileSync('public/body.bin');
  const a = parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const tri: number[] = [];
  for (let q = 0; q < a.quads.length; q += 4) tri.push(a.quads[q], a.quads[q + 1], a.quads[q + 2], a.quads[q], a.quads[q + 2], a.quads[q + 3]);
  const rb = new RingBody(a);
  const only = process.env.ONLY?.split(',');
  const r = (x: number) => Math.round(x * 10) / 10;
  for (const [name, [sex, locked]] of Object.entries(CASES)) {
    if (only && !only.includes(name)) continue;
    const v = suggest({ sex, locked }).values;
    const frame = Object.fromEntries(FRAME.map((k) => [k, v[k]])) as RingTargets;
    if (sex === 'female') Object.assign(frame, { bust: v.bust, underbust: v.underbust });
    const lockedSoft = Object.fromEntries(SOFT.filter((k) => locked[k] !== undefined).map((k) => [k, locked[k]]));
    const t0 = performance.now();
    const f = rb.fitComposition({ sex, frame, weight: v.weight, bodyFat: v.bodyFat, weightLocked: locked.weight !== undefined, locked: lockedSoft }, { neutralize: true });
    const vals = Object.fromEntries(['bust', 'underbust', 'waist', 'hip', 'thigh', 'calf', 'upperArm', 'neck', 'shoulder'].map((k) => [k, r(f.values[k as keyof typeof f.values])]));
    const off = Object.entries(lockedSoft).filter(([k, x]) => Math.abs(f.values[k as keyof typeof f.values] - (x as number)) > 0.3).map(([k]) => k);
    console.log(name, Math.round(performance.now() - t0) + 'ms it', f.iterations, 'W', r(f.weight), '(in', r(v.weight) + ')', 'bf', r(f.bodyFat * 100), '(in', r(v.bodyFat * 100) + ')', JSON.stringify(vals), off.length ? 'OFF ' + off : '');
    console.log('   kg', JSON.stringify(Object.fromEntries(Object.entries(f.kg).filter(([, x]) => Math.abs(x) > 0.05).map(([k, x]) => [k, r(x)]))));
    let minY = Infinity;
    for (let i = 0; i < a.nBody; i++) minY = Math.min(minY, f.P[i * 3 + 1]);
    writeFileSync('/tmp/claude-0/-home-user-bodyreferencewebsite/58516b04-ab8e-5675-a7f9-122b92028875/scratchpad/web/cp-' + name + '.json', JSON.stringify({ v: Array.from(f.P.subarray(0, a.nBody * 3), (x, i) => Math.round((i % 3 === 1 ? x - minY : x) * 100) / 1000), i: tri }));
  }
});
