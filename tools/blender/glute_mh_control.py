"""③ 數值控制的控制數據（DECISIONS #80～#83）：臀那一圈每一個控制點，位移寫成「脂肪、去脂 → 位移」的平滑曲線。

網站上只記「數值 → 控制」：算形是我們事先做的（glute_mh_mix 的格子，預設骨架、預設的型沿路徑），
網站拿換算後的 (脂肪 F, 去脂 L)（glute_mh_input）查曲線，得到 2873 個控制點的位移，再照骨架放上素體（glute_mh_bind）。
  - 脂肪方向：每一欄去脂一組三次 B 樣條（節點 KNOTS，瘦端密、胖端疏），最小平方擬合每 1 kg 的形。
  - 去脂方向：欄與欄之間用 PCHIP（不會過衝的分段三次）內插。
  - 位移是相對「預設骨架的中性型」（glute_mh_frame.Frame.default），單位公分。
python3 tools/blender/glute_mh_control.py <格子資料夾> <輸出.npz>
  讀 <格子資料夾>/L*.npz（每欄 F 2～130 每 1 kg 的控制籠），輸出係數與誤差報告。只用 numpy、scipy。
"""
import glob
import sys
from pathlib import Path

import numpy as np
from scipy.interpolate import BSpline, PchipInterpolator, make_lsq_spline

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glute_mh as gm  # noqa: E402
import glute_mh_fat as gf  # noqa: E402

KNOTS = [2, 4, 6, 8, 10, 12, 14, 17, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130]
DEGREE = 3


def knot_vector():
    k = DEGREE
    return np.r_[[KNOTS[0]] * k, KNOTS, [KNOTS[-1]] * k]


class Control:
    def __init__(self, Ls, coef, neutral):
        """Ls：各欄的去脂；coef：(欄, 係數, 點, 3)；neutral：預設骨架的中性型（點, 3）。"""
        self.Ls, self.coef, self.neutral = np.asarray(Ls, float), coef, neutral
        self.t = knot_vector()
        self._pchip = PchipInterpolator(self.Ls, self.coef, axis=0)

    def displacement(self, F, L):
        F = float(np.clip(F, KNOTS[0], KNOTS[-1]))
        L = float(np.clip(L, self.Ls[0], self.Ls[-1]))
        c = self._pchip(L)
        return BSpline(self.t, c.reshape(len(c), -1), DEGREE)(F).reshape(-1, 3)

    def cage(self, F, L):
        return self.neutral + self.displacement(F, L)


def fit(grid_dir):
    import glute_mh_frame as gfr
    N = gfr.Frame().default()
    cols = {}
    for f in sorted(glob.glob(f'{grid_dir}/L*.npz')):
        d = np.load(f)
        cols[float(d['L'])] = (d['F'], d['cages'].astype(float))
    Ls = sorted(cols)
    F = cols[Ls[0]][0]
    t = knot_vector()
    coef = []
    for L in Ls:
        Y = (cols[L][1] - N).reshape(len(F), -1)
        coef.append(make_lsq_spline(F, Y, t, k=DEGREE).c.reshape(-1, len(N), 3))
    return Control(Ls, np.stack(coef), N), cols


if __name__ == '__main__':
    grid_dir, out = sys.argv[1], sys.argv[2]
    ctl, cols = fit(grid_dir)
    Q = gm.build().F
    F = cols[ctl.Ls[0]][0]
    print('欄（去脂）', [f'{L:g}' for L in ctl.Ls], '每欄係數', ctl.coef.shape[1])
    worst = []
    for L in ctl.Ls:
        P = np.stack([ctl.cage(f, L) for f in F])
        E = np.linalg.norm(P - cols[L][1], axis=2)
        worst.append(E.max())
        print(f'L {L:5.1f} 擬合 平均 {E.mean():.4f} 最大 {E.max():.3f}（F {F[E.max(1).argmax()]:g}）')
    # 拿掉一欄、用其他欄預測（欄與欄之間的內插誤差，偏保守：實際的欄距只有這裡的一半）
    for i in range(1, len(ctl.Ls) - 1):
        keep = [j for j in range(len(ctl.Ls)) if j != i]
        sub = Control(ctl.Ls[keep], ctl.coef[keep], ctl.neutral)
        L = ctl.Ls[i]
        P = np.stack([sub.cage(f, L) for f in F])
        E = np.linalg.norm(P - cols[L][1], axis=2)
        j = E.max(1).argmax()
        hp = gf.measure(gm.preview(P[j], Q, 2)[0])['hipCirc']
        ha = gf.measure(gm.preview(cols[L][1][j], Q, 2)[0])['hipCirc']
        print(f'拿掉 L {L:5.1f}：平均 {E.mean():.4f} 最大 {E.max():.3f}（F {F[j]:g}，臀圍差 {hp - ha:+.2f}）')
    np.savez_compressed(out, Ls=ctl.Ls, knots=np.array(KNOTS, float), degree=DEGREE,
                        coef=ctl.coef.astype(np.float32), neutral=ctl.neutral.astype(np.float32))
    n = ctl.coef.size
    print(f'係數 {n:,} 個：float32 {n * 4 / 1e6:.1f} MB、量化成 16 位元（0.005 公分一格）{n * 2 / 1e6:.1f} MB')
