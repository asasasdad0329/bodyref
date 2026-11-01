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
   - 每個點跟著轉多少看它屬於骨盆還是大腿（tilt_weights），中間用雙調和插值。
3. 站姿（#81）：雙腳與肩同寬（MakeHuman 原本的站姿）；臀的模建的時候腿往內轉了 5°，這裡再張回去。
4. 兩個切口是和腰、大腿共用的骨架約定（#55）：腿的切口隨腿平移，腰的切口照髂嵴寬等比放寬，前傾時都不動。
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
# 網站的預設骨架（DECISIONS #77）：骨盆寬取相對寬的約第 75～80 百分位（R15 的標準差約 2.2 → 28.8～29.2）；
# 前傾取約 12～13°。中性型的前傾估計約 10～15°（髖關節中心與髂前上棘的位置，照 Harrington 2007 的骨盆比例回推；
# 網格上沒有明顯的腰窩可以直接量），和假設的 12～13° 相符，所以預設不轉。
DEFAULT_PW = 29.0
DEFAULT_TILT = 0.0
# 站姿（DECISIONS #81）：雙腳與肩同寬，照 MakeHuman 原本的站姿（腳踝中心距約 32 公分、腿往外張約 5°）。
# 臀的模（glute_mh.build）把腿往內轉了 5°（兩腿直直併著）；STANCE 是從那裡再往外張回去的角度，5 就是 MakeHuman 原本的。
STANCE_POSE = 5.0          # glute_mh.Glute.pose_legs 往內轉的角度
DEFAULT_STANCE = 5.0
HIP = np.array([84.0, -2.0])   # 兩髖關節連線的 (y, z)（MakeHuman 的 upper-leg 關節，左右 ±9.4）
HIP_Y = 81.6               # 量臀寬的高度


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


class Frame:
    def __init__(self):
        g = gm.Glute()
        g.align()
        g.pose_legs(deg=STANCE_POSE)
        Fc, w, self.J = g.F, g.w_pose, {k: v.copy() for k, v in g.J.items()}
        g.densify()
        self.V, self.F = g.V.copy(), g.F
        assert np.abs(self.V - gm.build().V).max() < 1e-9
        # 腿跟著轉的權重跟著細分（細分是線性的）
        self.w_stance = gm.subdivide(np.c_[w, np.zeros(len(w)), np.zeros(len(w))], Fc)[0][:, 0]
        # 原本中性型每個高度的半寬與前後中心（細分兩次後量），變形時用
        P, _ = gm.preview(self.V, self.F, 2)
        ys = np.arange(70.0, 101.01, 0.5)
        hw, zc = [], []
        for y in ys:
            S = P[np.abs(P[:, 1] - y) < 0.2]
            hw.append(np.abs(S[:, 0]).max())
            zc.append((S[:, 2].max() + S[:, 2].min()) / 2)
        self.ys, self.hw, self.zc = ys, np.array(hw), np.array(zc)
        self.w_tilt = self.tilt_weights()
        self._cache = {}

    def tilt_weights(self):
        """前傾時每個點跟著骨盆轉多少（0～1）。看組織屬於骨盆還是大腿，不看高度（作者 2026-11-01：只照高度分，
        骨盆一轉就把大腿外側、前側扯出一道折）：
          跟骨盆（1）：髂嵴那一圈（86～93 公分）、臀溝以上 3 公分的臀、恥骨上的恥丘；
          不動（0）：腿的切口往上 4 公分（大腿，站姿）、腰的切口（上面的軀幹站直，中間補成腰椎前凸）；
          其他（鼠蹊、大轉子、臀溝一帶、腰椎）用雙調和插值：平順地過渡，不會有折。"""
        from scipy.sparse import identity
        from scipy.sparse.linalg import spsolve
        V, F = self.V, self.F
        n = len(V)
        x, y, z = np.abs(V[:, 0]), V[:, 1], V[:, 2]
        bnd = gc.boundary_mask(F, n)
        thigh = np.zeros(n, bool)
        for side in (1, -1):
            B = np.nonzero(bnd & (V[:, 1] < 80) & (side * V[:, 0] > 0.3))[0]
            c = V[B].mean(0)
            a = np.linalg.svd(V[B] - c)[2][2]
            a = a if a[1] > 0 else -a
            h = (V - c) @ a
            rel = V - c - np.outer(h, a)
            thigh |= (side * V[:, 0] > 0) & (h < 4.0) & (np.linalg.norm(rel, axis=1) < 25)
        top = bnd & (V[:, 1] > 95)
        fp = np.array(gm.CONTROL_LINES['fold']['pts'])
        yf = np.interp(x, fp[:, 0], fp[:, 1])
        pelvis = (((y >= 86) & (y <= 93)) | ((z < -3) & (x < 13) & (y >= yf + 3) & (y < 86))
                  | ((x < 4) & (z > 3) & (y > 79) & (y < 86))) & ~thigh & ~top
        known = thigh | top | pelvis
        w = np.where(pelvis, 1.0, 0.0)
        L = identity(n, format='csr') - gm.averaging_matrix(n, F)
        A = (L.T @ L).tocsr()
        free = np.nonzero(~known)[0]
        kn = np.nonzero(known)[0]
        w[free] = spsolve(A[free][:, free].tocsc(), -(A[free][:, kn] @ w[kn]))
        return np.clip(w, 0, 1)

    def stance(self, V, deg):
        """兩腿繞各自的髖關節往外張 deg 度（正面看的平面裡），權重照 pose_legs：骨盆不動、胯下以下的腿整個轉。"""
        out = V.copy()
        for side, sgn in (('l-upper-leg', 1), ('r-upper-leg', -1)):
            m = np.sign(self.V[:, 0]) == sgn
            c = self.J[side]
            a = sgn * np.radians(deg) * self.w_stance[m]
            d = V[m][:, :2] - c[:2]
            out[m, 0] = c[0] + np.cos(a) * d[:, 0] - np.sin(a) * d[:, 1]
            out[m, 1] = c[1] + np.sin(a) * d[:, 0] + np.cos(a) * d[:, 1]
        out[np.abs(self.V[:, 0]) < 1e-6, 0] = 0.0
        return out

    def deform(self, V, pw=PW0, tilt=0.0, stance=0.0):
        """規則上的形（還沒處理接觸）。先站姿，再骨盆寬、前傾。"""
        if abs(stance) > 1e-9:
            V = self.stance(V, stance)
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
            w = self.w_tilt
            th = np.radians(tilt) * w
            dy, dz = out[:, 1] - HIP[0], out[:, 2] - HIP[1]
            out[:, 1] = HIP[0] + dy * np.cos(th) - dz * np.sin(th)
            out[:, 2] = HIP[1] + dy * np.sin(th) + dz * np.cos(th)
        return out

    def default(self):
        """網站預設骨架下的中性型（#77、#81）。"""
        return self.neutral(DEFAULT_PW, DEFAULT_TILT, DEFAULT_STANCE)

    def neutral(self, pw=PW0, tilt=0.0, stance=0.0, steps=10):
        """這副骨架下的中性型（控制籠）：從原本的中性型沿骨架參數每一小步做接觸走過去，結果只由 (pw, tilt, stance) 決定。"""
        key = (round(pw, 6), round(tilt, 6), round(stance, 6))
        if key == (round(PW0, 6), 0.0, 0.0):
            return self.V.copy()
        if key not in self._cache:
            walk = gc.Walk(self.V, self.F, 0.0,
                           lambda t: self.deform(self.V, PW0 + t * (pw - PW0), t * tilt, t * stance), 1.0 / steps)
            self._cache[key] = walk(1.0)
        return self._cache[key].copy()
