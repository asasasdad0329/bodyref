"""臀的骨架線：骨盆寬與骨盆前傾（DECISIONS #58；研究 R15、R28）。只用 numpy、scipy、ipctk。

骨頭動，軟組織的量不變：這裡只產生「這副骨架下的中性型」（控制籠），脂肪線、肌肉線、組成線、接觸都在它上面照常跑；
所有規則（堆積點、控制線、肌肉筆觸）綁在原本中性型的頂點上，所以各線自動跟著骨架調整（glute_mh_fat.FatLine(frame=...)）。

1. 骨盆寬（髂嵴寬，R15）：女性 p5～p95 23.7～31.0、中位數 27.3（中性型就是中位數，#63）。
   - 髂嵴那一圈（約 95 公分以上）靠近皮膚，半寬照骨頭變：（胯寬 − 27.3）÷ 2。
   - 臀那一圈（髖關節高度以下）照資料：身高、BMI 固定時臀寬 ∝ 胯寬^0.23（臀圍 ∝ 胯寬^0.08）；中間平順過渡。
   - 骨盆那一段按離正中的距離等比放寬（臀縫附近幾乎不動）；兩腿整條平移（腿縫跟著變，#63）。
   - 臀那一段寬變多時前後變薄，截面積不變（臀圍只變一點，對應臀圍 ∝ 胯寬^0.08）。髂嵴那一圈是骨頭變寬，不補。
2. 骨盆前傾（R28）：女性站姿約 12～13°，個人差約 ±5°；中性型當作平均，線取 ±10°。
   - 骨盆繞兩髖關節的連線轉：大腿不動（站姿），臀跟著骨盆；腰的切口不動，中間平順過渡（腰椎前凸）。
3. 兩個切口是和腰、大腿共用的骨架約定（#55）：腿的切口隨腿平移，腰的切口照髂嵴寬等比放寬，前傾時都不動。
變形後兩片皮可能相碰（前傾時恥丘往下、往後壓向大腿），用通用的接觸（glute_mh_contact.Walk）從原本的中性型走過去。
"""
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glute_mh as gm  # noqa: E402
import glute_mh_contact as gc  # noqa: E402

PW0 = 27.3                 # 中性型的髂嵴寬（ANSUR II 女性中位數，R15）
PW_RANGE = (23.7, 31.0)    # p5～p95
TILT_RANGE = (-10.0, 10.0)
HIP = np.array([84.0, -2.0])   # 兩髖關節連線的 (y, z)（MakeHuman 的 upper-leg 關節，左右 ±9.4）
HIP_Y = 81.6               # 量臀寬的高度


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


class Frame:
    def __init__(self):
        g = gm.build()
        self.V, self.F = g.V.copy(), g.F
        # 原本中性型每個高度的半寬與前後中心（細分兩次後量），變形時用
        P, _ = gm.preview(self.V, self.F, 2)
        ys = np.arange(70.0, 101.01, 0.5)
        hw, zc = [], []
        for y in ys:
            S = P[np.abs(P[:, 1] - y) < 0.2]
            hw.append(np.abs(S[:, 0]).max())
            zc.append((S[:, 2].max() + S[:, 2].min()) / 2)
        self.ys, self.hw, self.zc = ys, np.array(hw), np.array(zc)
        self._cache = {}

    def deform(self, V, pw=PW0, tilt=0.0):
        """規則上的形（還沒處理接觸）。"""
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        out = V.copy()
        if abs(pw - PW0) > 1e-9:
            s = pw / PW0
            hw = np.interp(y, self.ys, self.hw)
            d_c = (pw - PW0) / 2
            d_h = np.interp(HIP_Y, self.ys, self.hw) * (s ** 0.23 - 1)
            d = d_h + (d_c - d_h) * smooth((y - 85.0) / 10.0)
            r = np.where(y <= 76.0, 1.5, np.where(y >= 80.0, hw, 1.5 + (hw - 1.5) * (y - 76.0) / 4.0))
            out[:, 0] = x + np.sign(x) * d * np.clip(np.abs(x) / r, 0, 1)
            sx = 1 + d / hw
            c = smooth((y - 74.0) / 3.0) * (1 - smooth((y - 90.0) / 5.0))
            zc = np.interp(y, self.ys, self.zc)
            out[:, 2] = z + (z - zc) * (1 / sx - 1) * c
        if abs(tilt) > 1e-9:
            w = smooth((y - 74.0) / 6.0) * (1 - smooth((y - 92.0) / 8.5))
            th = np.radians(tilt) * w
            dy, dz = out[:, 1] - HIP[0], out[:, 2] - HIP[1]
            out[:, 1] = HIP[0] + dy * np.cos(th) - dz * np.sin(th)
            out[:, 2] = HIP[1] + dy * np.sin(th) + dz * np.cos(th)
        return out

    def neutral(self, pw=PW0, tilt=0.0, steps=10):
        """這副骨架下的中性型（控制籠）：從原本的中性型沿骨架參數每一小步做接觸走過去，結果只由 (pw, tilt) 決定。"""
        key = (round(pw, 6), round(tilt, 6))
        if key == (round(PW0, 6), 0.0):
            return self.V.copy()
        if key not in self._cache:
            walk = gc.Walk(self.V, self.F, 0.0, lambda t: self.deform(self.V, PW0 + t * (pw - PW0), t * tilt), 1.0 / steps)
            self._cache[key] = walk(1.0)
        return self._cache[key].copy()
