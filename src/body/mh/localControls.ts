import type { V3 } from './geometry';

/** 右手正交局部座標；軸為世界座標中的單位向量，原點與尺度隨骨性框架更新。 */
export interface ControlFrame {
  origin: V3;
  axes: [V3, V3, V3];
  scale: V3;
}

export interface LocalTransform {
  /** 局部公分平移。 */
  translation?: V3;
  /** 各軸正倍率；零／負倍率不能作為合法的形態候選。 */
  scale?: V3;
  /** 繞局部 y 軸旋轉，弧度。 */
  yaw?: number;
  /** 綁定的有號材料位移倍率；與縮放、平移共用父參照。 */
  material?: number;
}

export interface BoundControl {
  id: string;
  parent: string;
  /** 綁定在父參照的局部無因次座標，不是預算好的世界位移。 */
  origin: V3;
  vertices: Uint32Array;
  weights: Float32Array;
  /** 每個綁定頂點的局部公分向量，保留原生目標的內收與切向分量。 */
  material?: Float32Array;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function toLocal(frame: ControlFrame, point: V3): V3 {
  const d: V3 = [point[0] - frame.origin[0], point[1] - frame.origin[1], point[2] - frame.origin[2]];
  return frame.axes.map((axis, k) => dot(d, axis) / frame.scale[k]) as V3;
}

export function toWorld(frame: ControlFrame, point: V3): V3 {
  return frame.origin.map((v, k) => v + frame.axes.reduce((s, axis, j) => s + axis[k] * point[j] * frame.scale[j], 0)) as V3;
}

/** 控制全部參照同一份輸入曲面，交界的變換一次合成；不依控制登錄順序逐次推頂點。 */
export class LocalControlRig {
  readonly controls: readonly BoundControl[];

  constructor(controls: readonly BoundControl[]) {
    const ids = new Set<string>();
    for (const c of controls) {
      if (ids.has(c.id)) throw new Error(`重複控制：${c.id}`);
      if (c.vertices.length !== c.weights.length) throw new Error(`控制權重長度不符：${c.id}`);
      if (c.material && c.material.length !== c.vertices.length * 3) throw new Error(`材料位移長度不符：${c.id}`);
      if (!c.weights.every(w => Number.isFinite(w) && w >= 0 && w <= 1)) throw new Error(`無效控制權重：${c.id}`);
      ids.add(c.id);
    }
    this.controls = controls;
  }

  apply(surface: Float32Array, frames: Readonly<Record<string, ControlFrame>>,
    state: Readonly<Record<string, LocalTransform | undefined>>, output: Float32Array = new Float32Array(surface)): Float32Array {
    // 輸入／輸出可共用，仍以固定快照求所有控制的響應。
    const source = output === surface ? new Float32Array(surface) : surface;
    output.set(source);
    const displacement = new Float64Array(source.length);
    for (const control of this.controls) {
      const transform = state[control.id];
      if (!transform) continue;
      const frame = frames[control.parent];
      if (!frame) throw new Error(`缺少父參照：${control.parent}`);
      if (!frame.scale.every(s => Number.isFinite(s) && s > 0)) throw new Error(`無效父參照尺度：${control.parent}`);
      const scale = transform.scale ?? [1, 1, 1];
      const translation = transform.translation ?? [0, 0, 0];
      const yaw = transform.yaw ?? 0;
      const material = transform.material ?? 0;
      if (!scale.every(s => Number.isFinite(s) && s > 0) || !translation.every(Number.isFinite) || !Number.isFinite(yaw) || !Number.isFinite(material)) {
        throw new Error(`無效控制變換：${control.id}`);
      }
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      for (let row = 0; row < control.vertices.length; row++) {
        const i = control.vertices[row] * 3, w = control.weights[row];
        if (!w) continue;
        const dx = source[i] - frame.origin[0], dy = source[i + 1] - frame.origin[1], dz = source[i + 2] - frame.origin[2];
        const ax = frame.axes[0], ay = frame.axes[1], az = frame.axes[2];
        const lx = (dx * ax[0] + dy * ax[1] + dz * ax[2]) / frame.scale[0];
        const ly = (dx * ay[0] + dy * ay[1] + dz * ay[2]) / frame.scale[1];
        const lz = (dx * az[0] + dy * az[1] + dz * az[2]) / frame.scale[2];
        const x = (lx - control.origin[0]) * scale[0], y = (ly - control.origin[1]) * scale[1], z = (lz - control.origin[2]) * scale[2];
        const mx = (control.origin[0] + cs * x + sn * z - lx) * frame.scale[0] + translation[0] + (control.material?.[row * 3] ?? 0) * material;
        const my = (control.origin[1] + y - ly) * frame.scale[1] + translation[1] + (control.material?.[row * 3 + 1] ?? 0) * material;
        const mz = (control.origin[2] - sn * x + cs * z - lz) * frame.scale[2] + translation[2] + (control.material?.[row * 3 + 2] ?? 0) * material;
        for (let k = 0; k < 3; k++) displacement[i + k] += (ax[k] * mx + ay[k] * my + az[k] * mz) * w;
      }
    }
    for (let i = 0; i < output.length; i++) output[i] = source[i] + displacement[i];
    return output;
  }
}
