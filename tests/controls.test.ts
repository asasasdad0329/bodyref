import { describe, expect, it } from 'vitest';
import { LocalControlRig, toLocal, toWorld, type ControlFrame } from '../src/body/mh/localControls';

const frame: ControlFrame = { origin: [3, 20, -4], axes: [[0, 0, -1], [0, 1, 0], [1, 0, 0]], scale: [2, 4, 3] };

describe('局部形狀控制的幾何不變量', () => {
  it('非世界軸的父參照可往返，控制平移跟著父軸而非固定世界方向', () => {
    const point = toWorld(frame, [1, 2, 3]);
    expect(toLocal(frame, point)).toEqual([1, 2, 3]);
    const rig = new LocalControlRig([{ id: 'rear', parent: 'pelvis', origin: [0, 0, 0], vertices: new Uint32Array([0]), weights: new Float32Array([1]) }]);
    const out = rig.apply(new Float32Array(point), { pelvis: frame }, { rear: { translation: [0, 0, 5] } });
    expect(out[0] - point[0]).toBeCloseTo(5);
    expect(out[1]).toBeCloseTo(point[1]);
    expect(out[2]).toBeCloseTo(point[2]);
  });

  it('獨立控制在共享區合成且登錄順序不改變結果，附著零權重保持原位', () => {
    const nodes = ['upper', 'lower'].map(id => ({ id, parent: 'pelvis', origin: [0, 0, 0] as [number, number, number], vertices: new Uint32Array([0, 1]), weights: new Float32Array([0.5, 0]) }));
    const surface = new Float32Array([5, 24, -6, 6, 23, -7]);
    const state = { upper: { translation: [0, 2, 0] as [number, number, number] }, lower: { translation: [0, 0, 4] as [number, number, number] } };
    const rig = new LocalControlRig(nodes);
    const both = rig.apply(surface, { pelvis: frame }, state);
    expect(both).toEqual(new LocalControlRig([...nodes].reverse()).apply(surface, { pelvis: frame }, state));
    expect(both.slice(3)).toEqual(surface.slice(3));
    expect(rig.apply(surface, { pelvis: frame }, {})).toEqual(surface);
    const upper = rig.apply(surface, { pelvis: frame }, { upper: state.upper });
    const lower = rig.apply(surface, { pelvis: frame }, { lower: state.lower });
    expect(upper[1]).not.toEqual(lower[1]);
    expect(upper[0]).not.toEqual(lower[0]);
    expect(rig.apply(new Float32Array(surface), { pelvis: frame }, state, new Float32Array(surface))).toEqual(both);
  });

  it('拒絕翻轉尺度及缺少父參照，不能讓無效候選靜默進入曲面', () => {
    const rig = new LocalControlRig([{ id: 'chest', parent: 'ribcage', origin: [0, 0, 0], vertices: new Uint32Array([0]), weights: new Float32Array([1]) }]);
    const surface = new Float32Array([1, 2, 3]);
    expect(() => rig.apply(surface, {}, { chest: {} })).toThrow('缺少父參照');
    expect(() => rig.apply(surface, { ribcage: frame }, { chest: { scale: [-1, 1, 1] } })).toThrow('無效控制變換');
  });

  it('純材料的快速路徑保留父軸方向與公分意義，與通用變換一致', () => {
    const rig = new LocalControlRig([{ id: 'cover', parent: 'pelvis', origin: [0, 0, 0], vertices: new Uint32Array([0]), weights: new Float32Array([0.5]), material: new Float32Array([-2, 3, 4]) }]);
    const surface = new Float32Array([5, 24, -6]);
    const fast = rig.apply(surface, { pelvis: frame }, { cover: { material: 2 } });
    const general = rig.apply(surface, { pelvis: frame }, { cover: { material: 2, scale: [1, 1, 1] } });
    expect([...fast]).toEqual([9, 27, -4]);
    expect(fast).toEqual(general);
  });
});
