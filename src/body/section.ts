// 身體截面：用超橢圓加上局部隆起（胸、臀、小腿肚等）描述一圈截面，
// 並能把截面縮放到指定的圍度。圍度一律以「拉緊的布尺」計算，也就是凸包周長，
// 例如量上胸圍時布尺會跨過兩胸之間的凹處。

export type Pt = [number, number];

/** 截面上的局部隆起。angle 以參數角表示：0 = +u 側，π/2 = 正前方，-π/2 = 正後方 */
export interface Bulge {
  angle: number;
  /** 半寬（弧度） */
  width: number;
  /** 往外推的距離，與 hw 同單位 */
  amount: number;
}

/** u = 左右方向、v = 前後方向（+v 為前） */
export interface SectionShape {
  /** 左右半寬 */
  hw: number;
  /** 往前的深度 */
  df: number;
  /** 往後的深度 */
  db: number;
  /** 超橢圓指數，2 = 橢圓，越大越方 */
  n?: number;
  bulges?: Bulge[];
  /** 截面中心沿 v 方向的位移 */
  dv?: number;
  /** 截面中心沿 u 方向的位移 */
  du?: number;
}

const DENSE = 192;

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** 依參數角取樣截面，第 0 點固定在正前方 */
export function sectionPoints(s: SectionShape, count = DENSE): Pt[] {
  const e = 2 / (s.n ?? 2);
  const pts: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.PI / 2 + (2 * Math.PI * i) / count;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    let u = s.hw * Math.sign(c) * Math.abs(c) ** e;
    let v = (sn >= 0 ? s.df : s.db) * Math.sign(sn) * Math.abs(sn) ** e;
    if (s.bulges) {
      let push = 0;
      for (const b of s.bulges) {
        const d = Math.abs(wrapAngle(t - b.angle));
        if (d < b.width) push += b.amount * (1 - (d / b.width) ** 2) ** 0.75;
      }
      if (push !== 0) {
        const r = Math.hypot(u, v) || 1;
        u += (u / r) * push;
        v += (v / r) * push;
      }
    }
    pts.push([u + (s.du ?? 0), v + (s.dv ?? 0)]);
  }
  return pts;
}

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * 凸包。截面點本身是一條不自交的封閉曲線，可以用 Melkman 演算法在線性時間內完成；
 * 開頭三點共線時退回一般的排序演算法。
 */
export function convexHull(pts: Pt[]): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const c0 = cross(pts[0], pts[1], pts[2]);
  if (Math.abs(c0) < 1e-12) return monotoneHull(pts);
  const D: Pt[] = new Array(2 * n + 1);
  let bot = n - 2;
  let top = bot + 3;
  D[bot] = D[top] = pts[2];
  if (c0 > 0) {
    D[bot + 1] = pts[0];
    D[bot + 2] = pts[1];
  } else {
    D[bot + 1] = pts[1];
    D[bot + 2] = pts[0];
  }
  for (let i = 3; i < n; i++) {
    const p = pts[i];
    if (cross(D[bot], D[bot + 1], p) > 0 && cross(D[top - 1], D[top], p) > 0) continue;
    while (cross(D[bot], D[bot + 1], p) <= 0) bot++;
    D[--bot] = p;
    while (cross(D[top - 1], D[top], p) <= 0) top--;
    D[++top] = p;
  }
  return D.slice(bot, top);
}

function monotoneHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function loopLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}

/** 拉緊布尺量到的圍度 */
export function tapeLength(pts: Pt[]): number {
  return loopLength(convexHull(pts));
}

export function scaleShape(s: SectionShape, k: number): SectionShape {
  return {
    ...s,
    hw: s.hw * k,
    df: s.df * k,
    db: s.db * k,
    dv: (s.dv ?? 0) * k,
    du: (s.du ?? 0) * k,
    bulges: s.bulges?.map((b) => ({ ...b, amount: b.amount * k })),
  };
}

/** 等比例縮放截面，使布尺圍度等於 C */
export function fitToGirth(shape: SectionShape, C: number): SectionShape {
  const k = C / tapeLength(sectionPoints(shape));
  return scaleShape(shape, k);
}

/**
 * 在固定的底形上加入隆起，並求出隆起量使布尺圍度等於 C。
 * 若底形本身已經比 C 大，就不加隆起，改為把底形縮到 C。
 * 回傳的 amount 是實際使用的隆起量（與 hw 同單位）。
 */
export function fitBulges(base: SectionShape, bulges: Omit<Bulge, 'amount'>[], C: number): { shape: SectionShape; amount: number } {
  const withAmount = (a: number): SectionShape => ({
    ...base,
    bulges: [...(base.bulges ?? []), ...bulges.map((b) => ({ ...b, amount: a }))],
  });
  if (tapeLength(sectionPoints(base)) >= C) return { shape: fitToGirth(base, C), amount: 0 };
  let lo = 0;
  let hi = base.hw * 0.25;
  while (tapeLength(sectionPoints(withAmount(hi))) < C && hi < base.hw * 4) hi *= 2;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (tapeLength(sectionPoints(withAmount(mid))) < C) lo = mid;
    else hi = mid;
  }
  const amount = (lo + hi) / 2;
  return { shape: withAmount(amount), amount };
}

/** 沿弧長平均重新取樣，第 0 點保持在正前方，讓每一圈的同一欄位對應到相同方位 */
export function resample(pts: Pt[], n: number): Pt[] {
  const m = pts.length;
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[m];
  const out: Pt[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / n;
    while (seg < m - 1 && cum[seg + 1] < d) seg++;
    const a = pts[seg];
    const b = pts[(seg + 1) % m];
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const t = (d - cum[seg]) / segLen;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** 截面在 u/v 方向的範圍 */
export function extents(pts: Pt[]): { uMin: number; uMax: number; vMin: number; vMax: number } {
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const [u, v] of pts) {
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  return { uMin, uMax, vMin, vMax };
}
