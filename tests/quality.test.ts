import { expect, it } from 'vitest';
import type { BodyAsset } from '../src/body/mh/asset';
import { SurfaceQuality } from '../src/body/mh/quality';

it('兩片各自有效的面互相穿過時，也必須拒絕；原參照與分離的面保持有效', () => {
  const base = new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0, 2,-0.5,-1, 2,0.5,-1, 2,0.5,1, 2,-0.5,1]);
  const asset = { nBody: 8, regions: ['torso'], region: new Uint8Array(8), quads: new Uint16Array([0,1,2,3, 4,5,6,7]) } as unknown as BodyAsset;
  const guard = new SurfaceQuality(asset, base);
  expect(guard.evaluate(base).valid).toBe(true);
  const crossed = new Float32Array(base);
  for (let i = 4; i < 8; i++) crossed[i * 3] = 0;
  const result = guard.evaluate(crossed);
  expect(result.collapsedFaces).toBe(0);
  expect(result.foldedFaces).toBe(0);
  expect(result.intersectingPairs).toBe(1);
  expect(result.valid).toBe(false);
  crossed[0] = NaN;
  expect(guard.evaluate(crossed).nonFinite).toBe(1);
});
