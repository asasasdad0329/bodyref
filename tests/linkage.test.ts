import { ANKLE_HEIGHT, applyRatios, ratiosOf } from '../src/core/proportions';
import { describe, expect, it } from 'vitest';
import { navelWaistPreference, rarity, suggest } from '../src/core/linkage';

describe('數值連動', () => {
  it('女性上胸與罩杯不反向改變全身建議，明確數值仍保留', () => {
    const a = suggest({ sex: 'female', locked: { height: 160, underbust: 70, bust: 85 } });
    const b = suggest({ sex: 'female', locked: { height: 160, underbust: 70, bust: 125 } });
    const small = suggest({ sex: 'female', locked: { height: 160 }, bustDiff: 10 });
    const large = suggest({ sex: 'female', locked: { height: 160 }, bustDiff: 55 });
    expect(a.values.bust).toBe(85); expect(b.values.bust).toBe(125);
    for (const key of ['weight', 'bodyFat', 'waist', 'hip', 'shoulder', 'upperArmLen'] as const) {
      expect(a.values[key]).toBe(b.values[key]); expect(small.values[key]).toBe(large.values[key]);
    }
    expect(large.values.bust - large.values.underbust).toBe(55);
  });
  it('來源肚臍腰與最細腰造型參照使用各自的平均值', () => {
    const source = navelWaistPreference('female', 158, 80);
    const minimum = suggest({ sex: 'female', locked: { height: 158, weight: 80 } }).values.waist;
    expect(source.target).toBeGreaterThan(95); expect(source.target).toBeLessThan(110);
    expect(source.target - minimum).toBeGreaterThan(5);
    expect(source.scale).toBeGreaterThan(0);
  });
  it('只填參考身高體重時，建議值等於參考體型', () => {
    const s = suggest({ sex: 'female', locked: { height: 160, weight: 52 } });
    expect(s.values.waist).toBeCloseTo(64, 1);
    expect(s.values.hip).toBeCloseTo(89, 1);
    expect(s.locked.weight).toBe(true);
    expect(s.locked.waist).toBe(false);
  });

  it('臀圍變大時，大腿圍的建議值跟著變大', () => {
    const base = suggest({ sex: 'female', locked: { height: 160, weight: 52 } }).values;
    const big = suggest({ sex: 'female', locked: { height: 160, weight: 52, hip: 100 } }).values;
    expect(big.hip).toBe(100);
    expect(big.thigh).toBeGreaterThan(base.thigh + 3);
  });

  it('體重增加時，各圍度都變大，腰圍比手腕增加得多', () => {
    const a = suggest({ sex: 'female', locked: { height: 160, weight: 50 } }).values;
    const b = suggest({ sex: 'female', locked: { height: 160, weight: 70 } }).values;
    expect(b.waist / a.waist).toBeGreaterThan(b.wrist / a.wrist);
  });

  it('指定罩杯時上下胸圍差符合，且主要是上胸圍變大', () => {
    const base = suggest({ sex: 'female', locked: { height: 160, weight: 52 } }).values;
    const e = suggest({ sex: 'female', locked: { height: 160, weight: 52 }, bustDiff: 20 }).values;
    expect(e.bust - e.underbust).toBeCloseTo(20, 1);
    expect(e.bust - base.bust).toBeGreaterThan(base.underbust - e.underbust);
  });

  it('常見範圍包住建議值', () => {
    const s = suggest({ sex: 'male', locked: { height: 175, weight: 70 } });
    expect(s.range.waist[0]).toBeLessThan(s.values.waist);
    expect(s.range.waist[1]).toBeGreaterThan(s.values.waist);
  });

  it('最細腰不拿肚臍腰資料冒充同量法的百分位，也不改掉手動值', () => {
    const r = rarity({ sex: 'female', locked: { height: 160, weight: 52, waist: 56 } });
    expect(r.find(x => x.id === 'waist')).toBeUndefined();
    expect(suggest({ sex: 'female', locked: { height: 160, weight: 52, waist: 56 } }).values.waist).toBe(56);
  });
});

describe('身體比例', () => {
  it('腿長比換算成大腿長與小腿長，股下符合指定比例', () => {
    const { locked, derived } = applyRatios({ sex: 'female', locked: { height: 168 } }, { legRatio: 0.49 });
    expect(derived).toEqual(['thighLen', 'calfLen']);
    expect((locked.thighLen! + locked.calfLen!) / 168 + ANKLE_HEIGHT).toBeCloseTo(0.49, 4);
  });

  it('同時指定腿長比與大腿：小腿時，兩者都符合', () => {
    const { locked } = applyRatios({ sex: 'female', locked: { height: 160 } }, { legRatio: 0.46, thighCalf: 0.8 });
    expect(locked.thighLen! / locked.calfLen!).toBeCloseTo(0.8, 4);
    const r = ratiosOf(suggest({ sex: 'female', locked }).values);
    expect(r.legRatio).toBeCloseTo(0.46, 4);
  });

  it('只指定上臂：前臂時，手臂總長維持建議值', () => {
    const inp = { sex: 'male' as const, locked: { height: 175 } };
    const base = suggest(inp).values;
    const { locked } = applyRatios(inp, { upperFore: 1.4 });
    expect(locked.upperArmLen! + locked.forearmLen!).toBeCloseTo(base.upperArmLen + base.forearmLen, 4);
    expect(locked.upperArmLen! / locked.forearmLen!).toBeCloseTo(1.4, 4);
  });
});
