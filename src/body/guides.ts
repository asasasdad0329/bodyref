import { Vector3 } from 'three';
import type { Loft } from './loft';

// 結構線：像繪畫用人偶或服裝人台上的參考線，畫在放樣網格的表面上。
// 橫線是某一列截面；縱線可以沿著固定欄位，或是取每一列和某個平面的交點（例如 x = 0 的正中線），
// 後者不受截面點分佈影響，線條比較平順。

export type Polyline = Vector3[];

function rowPoint(l: Loft, r: number, j: number): Vector3 {
  const i = (r * l.cols + (((j % l.cols) + l.cols) % l.cols)) * 3;
  return new Vector3(l.positions[i], l.positions[i + 1], l.positions[i + 2]);
}

function rowCenter(l: Loft, r: number): Vector3 {
  return new Vector3(l.centers[r * 3], l.centers[r * 3 + 1], l.centers[r * 3 + 2]);
}

/** 一整圈截面 */
export function ringLine(l: Loft, row: number): Polyline {
  const pts: Polyline = [];
  for (let j = 0; j <= l.cols; j++) pts.push(rowPoint(l, row, j));
  return pts;
}

/** 沿固定欄位的縱線，可延伸到兩端的封口頂點 */
export function columnLine(l: Loft, col: number, r0: number, r1: number, caps = false): Polyline {
  const pts: Polyline = [];
  if (caps && r0 === 0 && l.capStart) pts.push(l.capStart.clone());
  for (let r = r0; r <= r1; r++) pts.push(rowPoint(l, r, col));
  if (caps && r1 === l.rows - 1 && l.capEnd) pts.push(l.capEnd.clone());
  return pts;
}

export type PlaneAxis = 'x' | 'z';
export type Pick = 'max' | 'min';

/**
 * 每一列和平面（axis = value）的交點連成的縱線。
 * 一圈截面和平面通常有兩個交點，pick 指定取另一個座標（x 平面取 z、z 平面取 x）較大或較小的那個。
 * value 為 'center' 時使用每一列自己的中心。截面沒碰到平面的列會把線斷開。
 */
export function planeLines(l: Loft, axis: PlaneAxis, value: number | 'center', pick: Pick, r0: number, r1: number): Polyline[] {
  const other: PlaneAxis = axis === 'x' ? 'z' : 'x';
  const lines: Polyline[] = [];
  let current: Polyline = [];
  for (let r = r0; r <= r1; r++) {
    const v = value === 'center' ? rowCenter(l, r)[axis] : value;
    let best: Vector3 | null = null;
    for (let j = 0; j < l.cols; j++) {
      const a = rowPoint(l, r, j);
      const b = rowPoint(l, r, j + 1);
      const da = a[axis] - v;
      const db = b[axis] - v;
      if (da === db || (da > 0 && db > 0) || (da < 0 && db < 0)) continue;
      const p = a.clone().lerp(b, da / (da - db));
      if (!best || (pick === 'max' ? p[other] > best[other] : p[other] < best[other])) best = p;
    }
    if (best) current.push(best);
    else if (current.length) {
      lines.push(current);
      current = [];
    }
  }
  if (current.length > 1) lines.push(current);
  return lines.filter((line) => line.length > 1);
}

/** 把線稍微推離各列中心，避免和表面重疊閃爍 */
export function liftLines(l: Loft, lines: Polyline[], amount: number): Polyline[] {
  return lines.map((line) =>
    line.map((p) => {
      // 找最接近的列中心（依高度沿網格軸向），往外推
      let bestR = 0;
      let bestD = Infinity;
      for (let r = 0; r < l.rows; r++) {
        const d = rowCenter(l, r).distanceToSquared(p);
        if (d < bestD) {
          bestD = d;
          bestR = r;
        }
      }
      const dir = p.clone().sub(rowCenter(l, bestR));
      const len = dir.length();
      return len > 1e-6 ? p.clone().addScaledVector(dir, amount / len) : p.clone();
    }),
  );
}

export function mirrorLines(lines: Polyline[]): Polyline[] {
  return lines.map((line) => line.map((p) => new Vector3(-p.x, p.y, p.z)));
}
