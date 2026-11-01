// 骨盆寬（髂嵴寬）是骨架的一部分（DECISIONS #77、#83；基礎軌 D2：骨架影響軟組織，軟組織不改骨架）。
// 規則和 tools/blender/glute_mh_frame.py 的 Frame.deform 相同（臀的骨架線，研究 R15）：
//   - 髂嵴那一圈靠近皮膚，半寬照骨頭變：（胯寬 − 起點胯寬）÷ 2；
//   - 臀那一圈（髖關節以下）照資料：身高、BMI 固定時臀寬 ∝ 胯寬^0.23；中間平順過渡；
//   - 兩腿整條平移；骨盆那一段按離正中的距離等比放寬；臀那一段寬變多時前後變薄（截面積不變）。
// 網站多做的：髂嵴以上往肋骨平順收回 0（臀的模到腰的切口為止）；手臂不動。
// 高度用胯下對齊：網站的「胯下以上幾公分」換成臀的模的高度（臀的模把胯下到上緣那一段壓成 0.8835 倍，見 Glute.align）。
// 目前只套在女性（C1）；男性等 C3。

/** MakeHuman 女性起點（160 公分）的髂嵴寬（ANSUR II 女性中位數，R15） */
export const PELVIS_BASE = 27.3;
/** 預設：照身高的第 77 百分位（#77 相對寬的 75～80）。ANSUR II 女性：log 髂嵴寬 = -0.765 + 0.799 log 身高，殘差 sd 0.0751 */
export function pelvisWidthFor(height: number, z = 0.739): number {
  return Math.exp(-0.765 + 0.799 * Math.log(height) + z * 0.0751);
}

// 臀的模的空間（160 公分、胯下 77）每 0.5 公分的半寬與前後中心（glute_mh_frame.Frame 量的，70～101 公分）
const Y0 = 70.0, DY = 0.5;
const HALF_WIDTH = [13.87, 15.72, 16.82, 17.28, 17.36, 17.40, 17.44, 17.49, 17.53, 17.59, 17.64, 17.68, 17.72, 17.75, 17.77, 17.79, 17.79, 17.79, 17.78, 17.75, 17.74, 17.69, 17.63, 17.56, 17.48, 17.39, 17.32, 17.22, 17.09, 16.94, 16.77, 16.68, 16.50, 16.30, 16.19, 16.00, 15.80, 15.62, 15.53, 15.37, 15.29, 15.15, 15.08, 14.95, 14.83, 14.77, 14.65, 14.58, 14.43, 14.27, 14.11, 13.94, 13.77, 13.59, 13.43, 13.27, 13.05, 12.91, 12.72, 12.54, 12.38, 12.23, 12.09];
const CENTER_Z = [1.22, 1.47, 1.63, 1.72, 1.68, 1.58, 1.47, 1.33, 1.16, 0.97, 0.74, 0.50, 0.24, 0.00, -0.23, -0.51, -0.75, -0.99, -1.21, -1.41, -1.61, -1.79, -1.95, -2.08, -2.19, -2.30, -2.37, -2.45, -2.40, -2.34, -2.24, -2.16, -2.07, -1.96, -1.84, -1.68, -1.53, -1.35, -1.10, -0.88, -0.60, -0.34, -0.06, 0.20, 0.49, 0.69, 0.90, 1.08, 1.25, 1.41, 1.53, 1.68, 1.78, 1.88, 1.94, 1.98, 2.00, 2.05, 2.09, 2.16, 2.29, 2.67, 3.25];
const table = (t: number[], y: number) => {
  const u = Math.max(0, Math.min(t.length - 1, (y - Y0) / DY));
  const i = Math.min(t.length - 2, Math.floor(u));
  return t[i] + (t[i + 1] - t[i]) * (u - i);
};
const smooth = (u: number) => { const t = Math.max(0, Math.min(1, u)); return t * t * (3 - 2 * t); };
const HIP_Y = 81.6;
const ALIGN = { shift: 3.1, from: 73.9, top: 100.5, dz: -3.8 };   // Glute.align
const ALIGN_K = 1 - ALIGN.shift / (ALIGN.top - ALIGN.from);

/** 網站的高度 → 臀的模的高度（胯下對齊、縮放到 160 公分） */
function modelY(y: number, crotchY: number, s: number): number {
  const u = (y - crotchY) / s;
  const band = ALIGN.top - ALIGN.from;
  if (u < 0) return 77 + u;
  if (u < band) return 77 + u * ALIGN_K;
  return ALIGN.top + (u - band);
}

/** 把骨盆寬套到骨架上（原地修改 B）。B：縮放到身高、腳底貼地之後的素體；skip：不動的頂點（手臂）。 */
export function applyPelvis(B: Float32Array, n: number, crotchY: number, height: number, pelvis: number, skip?: (i: number) => boolean): void {
  const s = height / 160;
  const pw = pelvis / s;
  if (Math.abs(pw - PELVIS_BASE) < 1e-6) return;
  const dC = (pw - PELVIS_BASE) / 2;
  const dH = table(HALF_WIDTH, HIP_Y) * (Math.pow(pw / PELVIS_BASE, 0.23) - 1);
  for (let i = 0; i < n; i++) {
    if (skip?.(i)) continue;
    const x = B[i * 3], y = B[i * 3 + 1], z = B[i * 3 + 2];
    const ym = modelY(y, crotchY, s);
    const d = (dH + (dC - dH) * smooth((ym - 85) / 10)) * (1 - smooth((ym - 100) / 12));
    if (Math.abs(d) < 1e-9) continue;
    const hw = table(HALF_WIDTH, ym);
    const r = ym <= 76 ? 1.5 : ym >= 80 ? hw : 1.5 + (hw - 1.5) * (ym - 76) / 4;
    B[i * 3] = x + Math.sign(x) * d * s * Math.min(1, Math.abs(x) / (r * s));
    const sx = 1 + d / hw;
    const c = smooth((ym - 74) / 3) * (1 - smooth((ym - 90) / 5));
    const zc = (table(CENTER_Z, ym) - ALIGN.dz) * s;
    B[i * 3 + 2] = z + (z - zc) * (1 / sx - 1) * c;
  }
}
