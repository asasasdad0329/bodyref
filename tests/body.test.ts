import { describe, expect, it } from 'vitest';
import { FINE, generateBody } from '../src/body/generate';
import { buildMesh, signedVolume } from '../src/body/loft';
import { calibrationFactor, estimate, referenceMeasurements } from '../src/core/estimate';
import type { MeasureId } from '../src/core/measurements';

const GIRTHS: MeasureId[] = ['neck', 'bust', 'underbust', 'waist', 'hip', 'upperArm', 'wrist', 'thigh', 'calf', 'ankle'];

function pathLength(points: { distanceTo(o: unknown): number }[], closed: boolean): number {
  let len = 0;
  const n = points.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) len += points[i].distanceTo(points[(i + 1) % n]);
  return len;
}

describe('人台生成', () => {
  for (const sex of ['female', 'male'] as const) {
    it(`${sex}：每個部位都是封閉且法線朝外的網格`, () => {
      const body = generateBody(referenceMeasurements(sex), { quality: FINE, armAngle: 10 });
      for (const part of body.parts) {
        const mesh = buildMesh(part.loft);
        expect(mesh.positions.every(Number.isFinite), part.name).toBe(true);
        expect(signedVolume(mesh.positions, mesh.index), part.name).toBeGreaterThan(0);
      }
    });

    it(`${sex}：量測線長度等於輸入的圍度`, () => {
      const m = referenceMeasurements(sex);
      const body = generateBody(m, { quality: FINE, armAngle: 10 });
      for (const id of GIRTHS) {
        // 量測線往外推了 0.18 cm，周長約多 2π × 0.18
        const len = pathLength(body.paths[id].points, true) - 2 * Math.PI * 0.18;
        expect(Math.abs(len - m[id]), id).toBeLessThan(0.25);
      }
      expect(Math.abs(pathLength(body.paths.shoulder.points, false) - m.shoulder)).toBeLessThan(0.3);
    });

    it(`${sex}：模型體積與真實人體相近（校正係數接近 1）`, () => {
      const c = calibrationFactor(sex);
      expect(c).toBeGreaterThan(0.85);
      expect(c).toBeLessThan(1.15);
    });
  }
});

describe('推算', () => {
  it('參考身高體重會得到參考體型', () => {
    const e = estimate({ sex: 'female', height: 160, weight: 52, bodyFat: 0.26, cup: null, overrides: {} });
    expect(e.sigma).toBeCloseTo(1, 2);
    expect(e.measurements.waist).toBeCloseTo(64, 0);
  });

  it('模型體重等於輸入體重', () => {
    for (const [sex, h, w] of [['female', 165, 70], ['female', 155, 42], ['male', 180, 95], ['male', 168, 55]] as const) {
      const e = estimate({ sex, height: h, weight: w, bodyFat: null, cup: null, overrides: {} });
      expect(Math.abs(e.modelWeight - w), `${sex} ${h}/${w}`).toBeLessThan(0.2);
    }
  });

  it('體重增加時腰圍比手腕圍增加得多', () => {
    const a = estimate({ sex: 'female', height: 160, weight: 50, bodyFat: null, cup: null, overrides: {} }).measurements;
    const b = estimate({ sex: 'female', height: 160, weight: 70, bodyFat: null, cup: null, overrides: {} }).measurements;
    expect(b.waist / a.waist).toBeGreaterThan(b.wrist / a.wrist);
  });

  it('手動指定的數值不會被推算覆蓋', () => {
    const e = estimate({ sex: 'female', height: 160, weight: 55, bodyFat: null, cup: 'D', overrides: { waist: 60 } });
    expect(e.measurements.waist).toBe(60);
    expect(e.source.waist).toBe('manual');
    expect(e.measurements.bust - e.measurements.underbust).toBeCloseTo(17.5, 5);
  });
});
