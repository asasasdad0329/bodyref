"""③ 數值控制的控制數據（DECISIONS #80～#84）：臀那一圈 2873 個控制點的位移，用共用的變形方向表示。

網站上只記「數值 → 控制」：算形是我們事先做的（glute_mh_mix 的格子，預設骨架、預設的型沿路徑），
網站拿換算後的 (脂肪 F, 去脂 L)（glute_mh_input）算出每個控制點的位移，再照骨架放上素體（glute_mh_bind）。
  - 所有控制點是一起動的（例如「臀變圓」一次帶動幾百個點）。把格子上全部的位移（相對預設骨架的中性型）
    做奇異值分解，取前 MODES 個共用的變形方向；每個身材只要記每個方向動多少（#84）。
  - 每個方向動多少是 (F, L) 的平滑函數：脂肪方向每一欄去脂一組三次 B 樣條（節點 KNOTS，瘦端密、胖端疏），
    去脂方向欄與欄之間用 PCHIP（不會過衝的分段三次）。
  - 網站：位移 ＝ Σ 方向 k ×（方向 k 在 (F, L) 的量），單位公分。
python3 tools/blender/glute_mh_control.py <格子資料夾> <輸出.npz> [方向數]
  讀 <格子資料夾>/L*.npz（每欄 F 2～130 每 1 kg 的控制籠），輸出方向、曲線係數與誤差報告。只用 numpy、scipy。
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
MODES = 60


def knot_vector():
    k = DEGREE
    return np.r_[[KNOTS[0]] * k, KNOTS, [KNOTS[-1]] * k]


class Control:
    def __init__(self, Ls, coef, modes, neutral):
        """Ls：各欄的去脂；coef：(欄, 曲線係數, 方向) 每個方向動多少的曲線；modes：(方向, 點, 3)；neutral：中性型。"""
        self.Ls, self.coef, self.modes, self.neutral = np.asarray(Ls, float), coef, modes, neutral
        self.t = knot_vector()
        self._pchip = PchipInterpolator(self.Ls, self.coef, axis=0)

    def weights(self, F, L):
        """(F, L) 時每個方向動多少。範圍外夾在邊上（網站要回報超出，不外插）。"""
        F = float(np.clip(F, KNOTS[0], KNOTS[-1]))
        L = float(np.clip(L, self.Ls[0], self.Ls[-1]))
        return BSpline(self.t, self._pchip(L), DEGREE)(F)

    def displacement(self, F, L):
        return np.tensordot(self.weights(F, L), self.modes, axes=1)

    def cage(self, F, L):
        return self.neutral + self.displacement(F, L)


def load_grid(grid_dir):
    cols = {}
    for f in sorted(glob.glob(f'{grid_dir}/L*.npz')):
        d = np.load(f)
        cols[float(d['L'])] = (d['F'], d['cages'].astype(float))
    return cols


def fit(cols, neutral, n_modes=MODES):
    Ls = sorted(cols)
    F = cols[Ls[0]][0]
    X = np.concatenate([(cols[L][1] - neutral).reshape(len(F), -1) for L in Ls])
    U, S, Vt = np.linalg.svd(X, full_matrices=False)
    modes = Vt[:n_modes].reshape(n_modes, len(neutral), 3)
    W = (U[:, :n_modes] * S[:n_modes]).reshape(len(Ls), len(F), n_modes)
    t = knot_vector()
    coef = np.stack([make_lsq_spline(F, W[i], t, k=DEGREE).c for i in range(len(Ls))])
    return Control(Ls, coef, modes, neutral)


def quantize(ctl):
    """方向用 16 位元存（每個方向一個比例），曲線係數用 32 位元浮點。回傳存檔用的 dict 與還原後的 Control。"""
    scale = np.abs(ctl.modes).reshape(len(ctl.modes), -1).max(1) / 32767.0
    q = np.round(ctl.modes / scale[:, None, None]).astype(np.int16)
    back = Control(ctl.Ls, ctl.coef.astype(np.float32).astype(float), q * scale[:, None, None], ctl.neutral)
    data = dict(Ls=ctl.Ls.astype(np.float32), knots=np.array(KNOTS, np.float32), degree=DEGREE,
                coef=ctl.coef.astype(np.float32), modes=q, scale=scale.astype(np.float32),
                neutral=ctl.neutral.astype(np.float32))
    return data, back


if __name__ == '__main__':
    import glute_mh_frame as gfr
    grid_dir, out = sys.argv[1], sys.argv[2]
    n_modes = int(sys.argv[3]) if len(sys.argv) > 3 else MODES
    N = gfr.Frame().default()
    cols = load_grid(grid_dir)
    data, ctl = quantize(fit(cols, N, n_modes))
    Q = gm.build().F
    Ls = list(ctl.Ls)
    F = cols[Ls[0]][0]
    print('欄（去脂）', [f'{L:g}' for L in Ls], f'方向 {n_modes} 個、每個方向每欄 {ctl.coef.shape[1]} 個曲線係數')
    for L in Ls:
        P = np.stack([ctl.cage(f, L) for f in F])
        E = np.linalg.norm(P - cols[L][1], axis=2)
        print(f'L {L:5.1f} 平均 {E.mean():.4f} 最大 {E.max():.3f}（F {F[E.max(1).argmax()]:g}）')
    # 拿掉一欄、用其他欄預測（欄與欄之間的內插誤差；方向照樣用全部的形找，偏樂觀的只有方向這一半）
    for i in range(1, len(Ls) - 1):
        keep = [j for j in range(len(Ls)) if j != i]
        sub = Control(np.array(Ls)[keep], ctl.coef[keep], ctl.modes, ctl.neutral)
        L = Ls[i]
        P = np.stack([sub.cage(f, L) for f in F])
        E = np.linalg.norm(P - cols[L][1], axis=2)
        j = E.max(1).argmax()
        hp = gf.hip_prominent(gm.preview(P[j], Q, 2)[0])[0]
        ha = gf.hip_prominent(gm.preview(cols[L][1][j], Q, 2)[0])[0]
        print(f'拿掉 L {L:5.1f}：平均 {E.mean():.4f} 最大 {E.max():.3f}（F {F[j]:g}，臀圍差 {hp - ha:+.2f}）')
    np.savez_compressed(out, **data)
    size = data['modes'].nbytes + data['coef'].nbytes + data['scale'].nbytes + data['neutral'].nbytes
    print(f'大小：方向 {data["modes"].nbytes / 1e6:.2f} MB（16 位元）＋ 曲線 {data["coef"].nbytes / 1e3:.0f} KB ＋ 中性 '
          f'{data["neutral"].nbytes / 1e3:.0f} KB ＝ {size / 1e6:.2f} MB')
