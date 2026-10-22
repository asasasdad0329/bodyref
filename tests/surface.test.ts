import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { addTarget, parseBodyAsset } from '../src/body/mh/asset';
import { BodyModel } from '../src/body/mh/model';
import { centroid, dot, norm, sub, vert, horizontal, horizontalPoints, slice, tape } from '../src/body/mh/geometry';
import { measure, measureContext, measureSkeleton } from '../src/body/mh/measure';

const buffer = readFileSync('public/body.bin');
const asset = parseBodyAsset(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

it('軀幹快速截點與完整折線在跨頂點及一般高度得到相同的皮尺', () => {
  const ctx = measureContext(asset, 'female'), P = new Float32Array(asset.base);
  const heights = [P[asset.landmarks.underbustL * 3 + 1], P[4121 * 3 + 1], ...Array.from({ length: 20 }, (_, i) => i * 3 + 20)];
  for (const y of heights) {
    const plane = horizontal(y), points = horizontalPoints(P, asset.quads, ctx.faces.trunk, y);
    const chains = slice(P, asset.quads, ctx.faces.trunk, plane).flat();
    expect(points.length).toBe(chains.length);
    if (points.length > 2) expect(tape(points, plane).length).toBeCloseTo(tape(chains, plane).length, 9);
  }
});

it('局部差分整理與兩曲面獨立整理一致，包括觸及正中接觸邊界時', () => {
  const model = new BodyModel(asset), base = new Float32Array(asset.base), shaped = new Float32Array(base);
  const contact = 12993;
  base[contact * 3] = 0.001; shaped[contact * 3] = 0.2;
  const expectedBase = new Float32Array(base), expectedShape = new Float32Array(shaped);
  model.finish(expectedBase); model.finish(expectedShape);
  model.finishPair(base, shaped, new Uint32Array([contact]));
  for (const [actual, expected] of [[base, expectedBase], [shaped, expectedShape]]) {
    expect(Math.max(...actual.map((v, i) => Math.abs(v - expected[i])))).toBeLessThan(0.001);
  }
  expect(shaped[contact * 3]).toBeGreaterThan(0);
});

it('放鬆上臂皮尺通過肩峰與肘尖的中點，並垂直肱骨軸', () => {
  const P = new Float32Array(asset.base), measured = measure(measureContext(asset, 'female'), P);
  const shoulder = centroid(P, ...asset.joints['l-shoulder']), elbow = centroid(P, ...asset.joints['l-elbow']);
  const direction = norm(sub(elbow, shoulder)), acromion = vert(P, asset.landmarks.acromionL), olecranon = vert(P, 10042);
  const middle = acromion.map((v, k) => (v + olecranon[k]) / 2) as [number, number, number];
  const path = measured.tapes.upperArm!;
  expect(path.length).toBeGreaterThan(8);
  for (const point of path) expect(Math.abs(dot(sub(point, middle), direction))).toBeLessThan(0.001);
});


it('骨架校準的快速長度與完整皮尺量測一致', () => {
  const ctx = measureContext(asset, 'female'), P = Float32Array.from(asset.base, (v, i) => v * (i % 3 === 1 ? 1.13 : 0.92));
  const full = measure(ctx, P), skeleton = measureSkeleton(ctx, P);
  for (const [key, value] of Object.entries(skeleton.values)) expect(value).toBe(full.values[key as keyof typeof full.values]);
  expect(skeleton.marks.soleY).toBe(full.marks.soleY);
});


it('局部聯立的指定皮尺與完整量測完全一致，未量的圈不冒充有效數值', () => {
  for (const sex of ['female', 'male'] as const) {
    const ctx = measureContext(asset, sex), wall = Float32Array.from(asset.base, (v, i) => v * (i % 3 === 1 ? 1.08 : 0.94));
    const P = new Float32Array(wall);
    if (sex === 'female') addTarget(asset, 'female-young-averagemuscle-averageweight-maxcup-averagefirmness', 0.5, P);
    const keys = ['bust', 'underbust', 'waist', 'hip', 'thigh', 'upperArm'] as const;
    const full = measure(ctx, P, undefined, [], sex === 'female' ? wall : undefined);
    const local = measure(ctx, P, undefined, [], sex === 'female' ? wall : undefined, keys);
    for (const key of keys) {
      expect(local.values[key], key).toBe(full.values[key]);
      expect(local.tapes[key], key).toEqual(full.tapes[key]);
    }
    expect(local.sources.navelWaist).toEqual(full.sources.navelWaist);
    expect(Number.isNaN(local.values.shoulder)).toBe(true);
  }
});
