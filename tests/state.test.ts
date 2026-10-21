import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, DEFAULT_VIEW, decodeShare, encodeShare, presetState, PRESETS } from '../src/core/state';
import { ratioFromDisplay, ratioToDisplay } from '../src/core/proportions';
import { DEFAULT_MORPHOLOGY } from '../src/core/morphology';

describe('型態、肌肉與舊分享相容', () => {
  it('新碼保存三種局部型態、獨立肌肉和舊方向比例', () => {
    const state = { ...structuredClone(DEFAULT_STATE), muscleMass: 24.5,
      morphology: { breast: 'long' as const, hip: 'projected' as const, abdomen: 'smooth' as const },
      ratios: { thighCalf: 0.8, armRatio: 0.35 } };
    expect(decodeShare(encodeShare(state))).toEqual({ ...state, view: DEFAULT_VIEW });
  });
  it('舊碼提供確定型態預設，舊肌肉率不會變成手動體脂或肌肉', () => {
    const old = btoa(JSON.stringify({ sex: 'female', locked: { height: 165, bodyFat: 0.25 }, ratios: { thighCalf: 0.8 }, cup: 'E' }));
    const state = decodeShare(old)!;
    expect(state.morphology).toEqual(DEFAULT_MORPHOLOGY);
    expect(state.muscleMass).toBeNull();
    expect(state.locked.bodyFat).toBe(0.25);
    expect(state.ratios.thighCalf).toBe(0.8);
  });
  it('重設與範例清除肌肉鎖定和局部型態', () => {
    expect(presetState(PRESETS[0]).muscleMass).toBeNull();
    expect(presetState(PRESETS[0]).morphology).toEqual(DEFAULT_MORPHOLOGY);
  });
  it('所有比值方向可逆，既有 0.8 大腿／小腿顯示 1 : 1.25', () => {
    expect(ratioToDisplay('thighCalf', 0.8)).toBe(1.25);
    expect(ratioFromDisplay('thighCalf', 1.25)).toBe(0.8);
    expect(ratioToDisplay('legRatio', 0.48)).toBe(0.48);
    expect(ratioToDisplay('armRatio', 0.35)).toBe(0.35);
  });
});
