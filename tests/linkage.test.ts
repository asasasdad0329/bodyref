import { ANKLE_HEIGHT, RATIOS, applyRatios, ratiosOf, displayRatio, storedRatio } from '../src/core/proportions';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, decodeShare, encodeShare } from '../src/core/state';
import { rarity, suggest } from '../src/core/linkage';

describe('數值連動', () => {
  it('肌肉率獨立保存，不改體脂或虛構統計連動', () => {
    const base = suggest({ sex: 'female', locked: { height: 165, weight: 62, bodyFat: 0.25 } });
    const muscle = suggest({ sex: 'female', locked: { height: 165, weight: 62, bodyFat: 0.25, muscleRate: 0.43 } });
    expect(muscle.values.bodyFat).toBe(0.25);
    expect(muscle.values.muscleRate).toBe(0.43);
    for (const key of ['bust', 'waist', 'hip', 'thigh'] as const) expect(muscle.values[key]).toBe(base.values[key]);
    const state = { ...DEFAULT_STATE, locked: { height: 165, bodyFat: 0.25, muscleRate: 0.43 } };
    expect(decodeShare(encodeShare(state))?.locked).toEqual(state.locked);
    expect(decodeShare(encodeShare(DEFAULT_STATE))?.locked.muscleRate).toBeUndefined();
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
    for (const key of ['underbust', 'weight', 'waist', 'hip', 'upperArmLen'] as const) expect(e[key]).toBe(base[key]);
    expect(e.bust - base.bust).toBeGreaterThan(base.underbust - e.underbust);
  });

  it('常見範圍包住建議值', () => {
    const s = suggest({ sex: 'male', locked: { height: 175, weight: 70 } });
    expect(s.range.waist[0]).toBeLessThan(s.values.waist);
    expect(s.range.waist[1]).toBeGreaterThan(s.values.waist);
  });

  it('身高 160、體重 52 時腰圍 56 屬於少見', () => {
    const r = rarity({ sex: 'female', locked: { height: 160, weight: 52, waist: 56 } });
    const waist = r.find((x) => x.id === 'waist')!;
    expect(waist.percentile).toBeLessThan(0.05);
  });
});

describe('身體比例', () => {
  it('以 1：比值顯示，右側增加時對應部位確實變長，舊分享值保持同一長度', () => {
    const input = { sex: 'female' as const, locked: { height: 160 } };
    for (const d of RATIOS) {
      const value = (d.min + d.max) / 2;
      expect(storedRatio(d, displayRatio(d, value))).toBeCloseTo(value, 10);
    }
    for (const id of ['legRatio', 'armRatio'] as const) {
      const d = RATIOS.find((d) => d.id === id)!;
      const a = applyRatios(input, { [id]: storedRatio(d, d.min) }).locked;
      const b = applyRatios(input, { [id]: storedRatio(d, d.max) }).locked;
      const keys = id === 'legRatio' ? ['thighLen', 'calfLen'] as const : ['upperArmLen', 'forearmLen'] as const;
      expect(b[keys[0]]! + b[keys[1]]!).toBeGreaterThan(a[keys[0]]! + a[keys[1]]!);
    }
    const split = RATIOS.find((d) => d.id === 'thighCalf')!;
    const a = applyRatios(input, { thighCalf: storedRatio(split, 1.2) }).locked;
    const b = applyRatios(input, { thighCalf: storedRatio(split, 1.4) }).locked;
    expect(b.calfLen!).toBeGreaterThan(a.calfLen!);
    const state = { ...DEFAULT_STATE, ratios: { legRatio: 0.49, thighCalf: 0.8, armRatio: 0.34, upperFore: 1.4 } };
    expect(decodeShare(encodeShare(state))?.ratios).toEqual(state.ratios);
  });

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
