import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseBodyAsset } from '../src/body/mh/asset';
import { BodyModel } from '../src/body/mh/model';
import { centroid, dot, norm, sub, vert } from '../src/body/mh/geometry';
import { measure, measureContext } from '../src/body/mh/measure';

const buffer = readFileSync('public/body.bin');
const asset = parseBodyAsset(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

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
