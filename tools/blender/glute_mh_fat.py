"""臀的純脂肪線，在 MakeHuman 起胚的中性型上（DECISIONS #61、#71；研究 R20、R21、R25、R26）。只用 numpy、scipy。

python3 tools/blender/glute_mh_fat.py <輸出資料夾> [viewer]

分層：中性型 ＝ 底層（骨架＋肌肉）＋ 脂肪厚度 × 法線；厚度 T(點, F) 由堆積點與增長曲線給（#61，規律沿用 glute_fat.py）。
做法分兩步（作者 2026-10-29：做的時候要有體積的概念，記下來的只要表面）：
  1. 不受重力時怎麼長：照數據的規律（堆積點、範圍內每 kg 全身脂肪 0.18 kg），沿中性時的方向（抹平過的法線，
     組織離開骨頭的方向）長，方向沒正對表面時補回體積。切口附近只往切口平面長；正中兩邊貼到正中為止；
     胯下（大陰唇底面、會陰）夾在兩腿之間不往下長。中性以下照厚度公式收。
  2. 重力：把脂肪層當成立體的體積（glute_mh_soft.FatVolume），只加臀那一袋多出來的重量，解線性彈性的平衡：
     - 體積不變（脂肪幾乎不可壓縮）；皮與淺筋膜是膜（彎曲勁度），臀上半有淺筋膜從髂嵴拉著較硬、下半鬆（Han 2022）；
     - 附著區綁住：臀溝內段、臀縫、薦骨、臀側凹陷（大轉子上方）（Rohrich 的 zones of adherence）；
     - 溝下的大腿、肚子、上下切口不受這袋的重力（是別的部位的事）；
     - 接觸：垂下來的臀不擠進大腿後面的表面，兩邊不穿過正中。
     中性起每 SOFT_STEP kg 解一次（前一格當起點），中間直線內插；位移只留大尺度的部分（籠格子尺度的起伏是數值的）。
輸出：fat_line.json（每 1 kg 的臀圍、寬、厚、大腿圍）、fat_line.npz（每 1 kg 的控制籠）；加 viewer 另存
fat_viewer.npz（細分 2 次的網格，每 4 kg 一組）給 fat_viewer.py 做成可旋轉的檢視頁。產物不進倉庫。
"""
import json
from pathlib import Path
import sys

import numpy as np
from scipy.spatial import ConvexHull

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glute_mh as gm  # noqa: E402
import glute_mh_soft as gs  # noqa: E402

# ---------- 軸（同 glute_fat.py）----------
F0 = 17.0                     # 中性型：160 cm、54.5 kg、DXA 體脂約 31%
FMIN, FMAX = 9.0, 110.0       # 瘦端約 BMI 16.5；胖端到全身體重約 204 公斤那一級（R21）
REGION_SLOPE = 0.18           # 範圍內每 kg 全身脂肪多約 0.18 kg 脂肪（R20、R21）
STEP_F = 0.5
SPREAD_REF = 33.0
BELLY_FOLLOW = 0.4            # 肚子只跟著鄰區變這麼多
TOP_TAPER = (96.0, 101.0, 0.55)   # 上緣切口附近增長放緩到 55%，之後才接得上腰
TMIN = 0.25
GAIN = 0.9

# ---------- 1. 堆積點（同 glute_fat.py）----------
DEPOTS = {
    'everywhere':  dict(c=None, amax=2.2, on=0.0, k=30.0),
    'buttock':     dict(c=(6.0, 81.0, -11.0), r=(7.0, 7.0, 7.0), face=(0, 0, -1), amax=4.5, on=0.0, k=28.0, sp=0.6),
    'lowerButtock': dict(c=(6.5, 77.5, -9.5), r=(6.0, 3.5, 6.0), face=(0, -0.6, -1), amax=2.5, on=0.0, k=18.0, sp=0.5),
    'hipDip':      dict(c=(15.5, 86.5, -4.5), r=(3.0, 3.0, 3.5), face=(1, 0, -0.6), amax=1.4, on=0.0, k=7.0, sp=0.0),
    'saddle':      dict(c=(15.5, 78.0, -1.0), r=(4.0, 4.5, 6.0), face=(1, 0, 0), amax=5.0, on=14.0, k=24.0, sp=0.7),
    # 腰側：中心在切口上方（舊模的切口在 98、中心 100.5；這裡切口在 100.5，中心跟著往上），切口只吃到它的下緣，
    # 不然切口的兩個外角會鼓成兩個角
    'flank':       dict(c=(13.5, 103.0, -2.0), r=(5.0, 3.0, 6.0), face=(1, 0, 0), amax=6.0, on=18.0, k=45.0, sp=0.8),
    'mons':        dict(c=(0.0, 81.0, 7.0), r=(3.5, 2.0, 3.0), face=(0, 0, 1), amax=1.8, on=0.0, k=25.0, sp=0.3),
    'innerThigh':  dict(c=(3.5, 73.0, 1.0), r=(3.0, 4.0, 5.0), face=(-1, 0, 0), amax=2.2, on=8.0, k=25.0, sp=0.4),
    'backThigh':   dict(c=(8.0, 73.5, -9.0), r=(5.0, 3.0, 4.0), face=(0, 0, -1), amax=1.8, on=15.0, k=25.0, sp=0.5),
    # 大腿上段一整圈（臀溝下方的後、內、外側）：變胖時大腿和臀一起長，從下面把臀溝撐出來（R27：掃描統計模型、Seamscape）。
    # 從中性開始長（中性的厚度不變），中心在大腿軸上、臀溝下方
    'thighRoot':   dict(c=(9.0, 70.5, -1.0), r=(7.0, 3.5, 7.0), face=None, amax=float(__import__('os').environ.get('THIGH_AMAX', '4.0')),
                        on=F0, k=30.0, sp=0.3, medial=False, grow_only=True),
    'frontThigh':  dict(c=(9.0, 74.0, 6.0), r=(4.5, 4.5, 5.0), face=(0.3, 0, 1), amax=3.5, on=4.0, k=22.0, sp=0.6),
}

# ---------- 2. 附著線：每條控制線上，厚度增長乘上 (1 − 最大比例 × 權重) ----------
ATTACH = dict(fold=0.85, cleft=0.9, sacrum=0.6, suprapubic=0.3, groin=0.45)
# 中性以上多長的脂肪：臀溝那條線也會長（被兩側的脂肪往外推），只是比兩側少（作者 2026-10-30：大體重時那個縫也要外推）
ATTACH_GROW = dict(ATTACH, fold=float(__import__('os').environ.get('FOLD_GROW_ATTACH', '0.25')),
                   cleft=float(__import__('os').environ.get('CLEFT_GROW_ATTACH', '0.5')))
# 臀縫兩壁、兩腿內側的脂肪照樣往正中長：兩邊的肉擠在一起、貼合（擋在正中），臀縫底不會留下空洞
TOWARD_MID = __import__('os').environ.get('TOWARD_MID', '1') == '1'

# ---------- 3. 重力（立體的脂肪層，glute_mh_soft）----------
ADHERE = dict(fold=1.0, cleft=1.0, sacrum=1.0)     # 附著區：控制線（皮綁在深層）
ADHERE_SHARP = float(__import__('os').environ.get('ADHERE_SHARP', '3'))
LGD = dict(c=(15.5, 86.5), r=(2.5, 2.5))             # 臀側凹陷（大轉子上方）附著區，只算朝外側的面
SOFT_G = float(__import__('os').environ.get('SOFT_G', '0.25'))   # 重力：每公克多出來的脂肪的力（和彈簧勁度同一套單位；校成 109 kg 時臀下緣垂過臀溝幾公分）
SOFT_K = 1           # 脂肪層沿厚度切幾層
SOFT_STEP = 4.0      # 每幾 kg 解一次平衡，中間內插
K_ANCH = 30.0        # 附著區拉回原位的勁度
SF_UP = 4.0          # 臀上半淺筋膜：皮膚那層的邊加硬的倍數
LOOSE = 0.5          # 臀下半：層間（隔膜）勁度的倍數
SKIN = 5.0           # 皮膚（膜）比脂肪硬的倍數
BEND = 100.0         # 皮膚那層的彎曲勁度
D_SMOOTH = 10        # 位移平順的次數
GROW_BLEND = float(__import__('os').environ.get('GROW_BLEND', '0.5'))   # 長的方向：0 中性時的方向、1 當下的形的方向


def growth(F, on, k):
    """增長曲線：從 on 公斤開始（平滑起步），先快後慢，k 越小越快飽和。值在 0～1。"""
    u = 2.0 * np.log1p(np.exp((F - on) / 2.0))
    return 1 - np.exp(-u / k)


def mirrored(N, V):
    """法線換成左半的方向（右半的 x 反過來），堆積點的朝向才能左右共用。"""
    return np.c_[N[:, 0] * np.where(V[:, 0] < 0, -1, 1), N[:, 1:]]


def areas(V, F):
    """每個頂點分到的表面積（四邊形面積平均分給四個角）。"""
    a = np.zeros(len(V))
    n = 0.5 * np.linalg.norm(np.cross(V[F[:, 2]] - V[F[:, 0]], V[F[:, 3]] - V[F[:, 1]]), axis=1)
    for k in range(4):
        np.add.at(a, F[:, k], 0.25 * n)
    return a


class FatLine:
    def __init__(self):
        g = gm.build()
        self.V0, self.F = g.V.copy(), g.F
        self.N0 = gm.vertex_normals(self.V0, self.F)
        self.mid = np.abs(self.V0[:, 0]) < 1e-6
        C = gm.control_weights(self.V0, self.N0)
        Z = gm.zone_weights(self.V0, self.N0)
        self.A = np.ones(len(self.V0))
        for name, s in ATTACH.items():
            self.A *= 1 - s * C[name]
        self.A_grow = np.ones(len(self.V0))
        for name, s in ATTACH_GROW.items():
            self.A_grow *= 1 - s * C[name]
        self.belly = Z['belly']
        self.crotch = Z['crotch']
        # 胯下不長的只有朝下的底面（大陰唇底、會陰）；朝正中的壁（臀縫最底、兩腿內側）照樣長，兩邊才擠得攏
        medial = np.clip(-np.sign(self.V0[:, 0]) * self.N0[:, 0], 0, None)
        self.crotch_hold = np.clip(self.crotch * 2, 0, 1) * np.clip(1 - medial / 0.6, 0, 1)
        y = self.V0[:, 1]
        y0, y1, keep = TOP_TAPER
        self.top = 1 - (1 - keep) * np.clip((y - y0) / (y1 - y0), 0, 1)
        self.T0 = self.thickness(F0)
        self.base = self.V0 - self.T0[:, None] * self.N0
        # 長的方向：中性時的法線抹平（組織離開骨頭的方向）。沿當下的法線一步步長會像吹氣球，溝兩壁越長越朝彼此、穿過去
        self.W = gm.averaging_matrix(len(self.V0), self.F)
        D = self.N0.copy()
        for _ in range(25):
            D = D + 0.35 * (self.W @ D - D)
        self.D0 = D / np.linalg.norm(D, axis=1, keepdims=True)
        self.cut = gm.cut_frame(self.V0, self.F)
        # 重力只作用在臀那一袋：臀溝線（往外水平延伸）以上，不含肚子與上緣
        fp = np.array(gm.CONTROL_LINES['fold']['pts'])
        self.y_crease = np.interp(np.abs(self.V0[:, 0]), fp[:, 0], fp[:, 1])
        u = np.clip((y - self.y_crease) / 2.0, 0, 1)
        self.glute = u * u * (3 - 2 * u) * (1 - self.belly) * (1 - np.clip((y - 96.5) / 4.0, 0, 1))
        a = np.zeros(len(self.V0))
        for name, k in ADHERE.items():
            # 只綁那一條線（控制線的權重取次方，變窄）：線上方的組織可以翻過去
            a = np.maximum(a, k * C[name] ** ADHERE_SHARP)
        x = np.abs(self.V0[:, 0])
        a = np.maximum(a, np.exp(-(((x - LGD['c'][0]) / LGD['r'][0]) ** 2 + ((y - LGD['c'][1]) / LGD['r'][1]) ** 2))
                       * np.clip(np.abs(self.N0[:, 0]) * 2, 0, 1))
        self.adhere = a
        self._unl, self._sag = {}, {}
        assert np.abs(self.shape(F0) - self.V0).max() < 1e-9, '底層＋中性厚度要還原中性型'

    def maps(self, V, N, F):
        """每個堆積點在每個頂點上的分布（0～1），範圍隨脂肪量擴大。用中性位置算，堆積點跟著組織走。"""
        Nm = mirrored(N, V)
        Vm = np.c_[np.abs(V[:, 0]), V[:, 1:]]
        M = {}
        for name, d in DEPOTS.items():
            if d['c'] is None:
                M[name] = np.ones(len(V))
                continue
            c, r = np.array(d['c']), np.array(d['r'])
            q = (Vm - c) / (r * (1 + d['sp'] * (F - F0) / SPREAD_REF))
            M[name] = np.exp(-0.5 * (q ** 2).sum(1))
            if d['face'] is not None:
                f = np.array(d['face'], float)
                M[name] *= np.clip(Nm @ (f / np.linalg.norm(f)), 0, 1)
            if not d.get('medial', True):
                M[name] *= np.clip(1 + Nm[:, 0] / 0.5, 0, 1)      # 朝內（正中）的面不長：大腿內側已有 innerThigh，兩腿貼合處另外處理
        return M

    def thickness(self, F):
        M = self.maps(self.V0, self.N0, F)
        T = np.full(len(self.V0), TMIN)
        for name, d in DEPOTS.items():
            if d.get('grow_only'):          # 只管中性以上多長的（中性與更瘦時的厚度不變）
                continue
            T += GAIN * d['amax'] * growth(F, d['on'], d['k']) * M[name] * self.A
        return T

    def constrain(self, V):
        V[self.mid, 0] = 0.0
        # 兩腿內側長胖後貼在一起：最多貼到正中（擠壓成接觸面），不穿過去
        left, right = (self.V0[:, 0] > 0) & ~self.mid, (self.V0[:, 0] < 0) & ~self.mid
        V[left, 0] = np.maximum(V[left, 0], 0.05)
        V[right, 0] = np.minimum(V[right, 0], -0.05)
        return V

    def distribution(self, F):
        """此刻新增的脂肪往哪裡去：各堆積點增長曲線的斜率 × 分布 × 附著係數。
        胯下（大陰唇底面、會陰）夾在兩腿之間，沒有往下長的空間；大陰唇的脂肪從恥丘那邊長（mons）。"""
        M = self.maps(self.V0, self.N0, F)
        w = np.zeros(len(self.V0))
        for name, d in DEPOTS.items():
            w += d['amax'] * (growth(F + 0.25, d['on'], d['k']) - growth(F - 0.25, d['on'], d['k'])) / 0.5 * M[name]
        w *= self.A_grow * (1 - (1 - BELLY_FOLLOW) * self.belly) * self.top * (1 - self.crotch_hold)
        return w

    def unloaded(self, F):
        """不受重力時的形與每個點長了多厚。中性以下照厚度公式沿長的方向收；中性以上從中性用同樣的步長一步步長，
        體積照規律（方向沒正對表面時補回），結果只由 F 決定。"""
        if F <= F0:
            T = self.T0 + (self.thickness(F) - self.T0) * (1 - (1 - BELLY_FOLLOW) * self.belly)
            return self.constrain(self.V0 + (T - self.T0)[:, None] * self.D0), np.zeros(len(self.V0))
        n = int(round((F - F0) / STEP_F * 1e6)) // 1000000
        k = max([j for j in self._unl if j <= n], default=0)
        V, acc = (a.copy() for a in self._unl[k]) if k else (self.V0.copy(), np.zeros(len(self.V0)))
        steps = [(F0 + (j + 0.5) * STEP_F, STEP_F, j + 1) for j in range(k, n)]
        rest = F - (F0 + n * STEP_F)
        if rest > 1e-9:
            steps.append((F0 + n * STEP_F + rest / 2, rest, None))
        for Fm, dF, key in steps:
            w = self.distribution(Fm)
            area = areas(V, self.F)
            dT = REGION_SLOPE * dF / 0.9 * 1000 * w / (area * w).sum()      # 公分³（脂肪密度 0.9），左右兩半合計
            Nc = gm.vertex_normals(V, self.F)
            # 長的方向：中性時的方向（組織離開骨頭）和當下的形的方向（像吹氣球一樣撐圓，臀下段朝下的面往下長）混合，
            # 兩者都抹平過：溝兩壁的方向被平均掉，不會越長越朝彼此
            N = Nc.copy()
            for _ in range(25):
                N = N + 0.35 * (self.W @ N - N)
            N = GROW_BLEND * N / np.linalg.norm(N, axis=1, keepdims=True) + (1 - GROW_BLEND) * self.D0
            N /= np.linalg.norm(N, axis=1, keepdims=True)
            N = gm.growth_dirs(V, N, self.cut, toward_mid=TOWARD_MID)
            cos = np.clip((N * Nc).sum(1), 0.2, 1)
            dT *= (area * dT).sum() / (area * dT * cos).sum()
            V = self.constrain(V + dT[:, None] * N)
            acc = acc + dT
            if key is not None:
                self._unl[key] = (V.copy(), acc.copy())
        return V, acc

    def _soft_setup(self):
        n, K = len(self.V0), SOFT_K
        self.vol = gs.FatVolume(self.F, n, K)
        ef = gm.edge_faces(self.F)
        bnd = np.zeros(n, bool)
        for e, fs in ef.items():
            if len(fs) == 1:
                bnd[list(e)] = True
        col, lay = np.tile(np.arange(n), K + 1), np.repeat(np.arange(K + 1), n)
        # 只解臀那一袋（加外圍三圈）；其他地方沒有這袋的重力，留在不受重力的位置
        g = (self.glute > 0.02).astype(float)
        for _ in range(3):
            g = np.maximum(g, (self.W @ g > 0).astype(float))
        self.s_free = (lay > 0) & ~bnd[col] & (g[col] > 0)
        self.s_col, self.s_lay = col, lay
        y = self.V0[:, 1]
        back = np.clip(-self.N0[:, 2] * 2, 0, 1)
        E = self.vol.E
        ce = col[E].T
        ymid, bk = (y[ce[0]] + y[ce[1]]) / 2, (back[ce[0]] + back[ce[1]]) / 2
        up = np.clip((ymid - 86.0) / 4.0, 0, 1) * bk           # 臀上半：淺筋膜從髂嵴拉著（皮膚那層加硬）
        low = np.clip((84.0 - ymid) / 4.0, 0, 1) * bk           # 臀下半：隔膜鬆
        k = np.ones(len(E))
        sk = self.vol.skin_edge
        k[sk] *= SKIN * (1 + (SF_UP - 1) * up[sk])
        inter = lay[E[:, 0]] != lay[E[:, 1]]
        k[inter] *= 1 - (1 - LOOSE) * low[inter]
        self.s_kedge = k
        self.s_kanch = K_ANCH * self.adhere[col] * (lay > 0)
        self.s_side = np.sign(np.round(self.V0[col, 0], 6))
        self.s_thigh = (self.glute < 0.05) & (self.N0[:, 2] < -0.3) & (y < self.y_crease + 0.5)
        self.s_lap = gs.laplacian(self.F, n)

    def sag(self, Fg):
        """格點 Fg 上重力造成的皮膚位移（相對不受重力的形）。"""
        if Fg in self._sag:
            return self._sag[Fg]
        if not hasattr(self, 'vol'):
            self._soft_setup()
        K, n = SOFT_K, len(self.V0)
        U, acc = self.unloaded(Fg)
        Xr = self.vol.layers(self.base, U)
        load = np.zeros(len(Xr))
        dm = 0.9 * np.clip(acc, 0, None) * areas(U, self.F) * self.glute           # 臀這袋多出來的脂肪（公克）
        for kk in range(1, K + 1):
            load[kk * n:(kk + 1) * n] = SOFT_G * dm / K
        fp = np.array(gm.CONTROL_LINES['fold']['pts'])
        hf = gs.height_field(np.c_[np.abs(U[self.s_thigh, 0]), U[self.s_thigh, 1], U[self.s_thigh, 2]],
                             lambda x: np.interp(x, fp[:, 0], fp[:, 1]))
        check = (self.s_lay == K) & (self.glute[self.s_col] > 0.3)
        kb = [0.0] * (K + 1)
        kb[K] = BEND
        if K > 1:
            kb[K - 1] = 0.2 * BEND
        X = self.vol.solve_linear(Xr, self.s_free, self.s_kedge, self.s_kanch, load, self.s_side, (hf, check),
                                  lap=self.s_lap, k_bend=kb)
        D = X[K * n:(K + 1) * n] - U
        for _ in range(D_SMOOTH):
            D = D + 0.5 * (self.W @ D - D)
        self._sag[Fg] = D
        return D

    def shape(self, F):
        """任一全身脂肪量 F 的控制籠：不受重力的形 ＋ 重力的位移（中性起每 SOFT_STEP kg 解一次，中間直線內插）。"""
        U, _ = self.unloaded(F)
        if F <= F0:
            return U
        j = int(np.floor((F - F0) / SOFT_STEP + 1e-9))
        Fa, Fb = F0 + j * SOFT_STEP, F0 + (j + 1) * SOFT_STEP
        Da = self.sag(Fa) if Fa > F0 else 0.0
        t = (F - Fa) / SOFT_STEP
        return self.constrain(U + (1 - t) * Da + t * self.sag(Fb))


def girth(P, y, side=None):
    S = P[np.abs(P[:, 1] - y) < 0.1]
    if side is not None:
        S = S[S[:, 0] * side > 0]
    return float(ConvexHull(S[:, [0, 2]]).area) if len(S) > 5 else float('nan')


def measure(P):
    S = P[np.abs(P[:, 1] - 81.6) < 0.1]
    return dict(hipCirc=round(girth(P, 81.6), 2), hipBreadth=round(2 * float(S[:, 0].max()), 2),
                buttockDepth=round(float(S[:, 2].max() - S[:, 2].min()), 2), thighCirc=round(girth(P, 72.0, 1), 2))


if __name__ == '__main__':
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    fl = FatLine()
    print('中性脂肪厚度（公分）：最薄', round(float(fl.T0.min()), 2), '最厚', round(float(fl.T0.max()), 2))
    Fs = np.arange(FMIN, FMAX + 0.01, 1.0)
    rows, cages = [], []
    for F in Fs:
        V = fl.shape(F)
        P, _ = gm.preview(V, fl.F, 2)
        m = measure(P)
        rows.append(dict(F=float(F), **m))
        cages.append(V.astype(np.float32))
        print(f'F {F:5.1f}  臀圍 {m["hipCirc"]:6.2f}  寬 {m["hipBreadth"]:5.2f}  厚 {m["buttockDepth"]:5.2f}  大腿圍 {m["thighCirc"]:5.2f}')
    hip = np.array([r['hipCirc'] for r in rows])
    slope = np.gradient(hip, Fs)
    print('中性附近臀圍斜率（公分/kg）', round(float(slope[int(np.argmin(np.abs(Fs - F0)))]), 3), '目標約 0.7')
    (out / 'fat_line.json').write_text(json.dumps(dict(F0=F0, rows=rows, depots=DEPOTS), ensure_ascii=False, indent=1))
    np.savez_compressed(out / 'fat_line.npz', F=Fs, cages=np.stack(cages), quads=fl.F)
    if 'viewer' in sys.argv:
        sel = [i for i, F in enumerate(Fs) if (F - FMIN) % 4 == 0]
        meshes = [gm.preview(cages[i].astype(float), fl.F, 2) for i in sel]
        Q = meshes[0][1]
        tris = np.r_[Q[:, [0, 1, 2]], Q[:, [0, 2, 3]]].astype(np.uint32)
        # 分區（檢視頁上色）：0 臀、1 肚子（只當連接）、2 褲管以下的大腿；用中性型算，跟著細分
        Pn, _ = gm.preview(fl.V0, fl.F, 2)
        Nn = gm.vertex_normals(Pn, Q)
        zone = np.where(gm.zone_weights(Pn, Nn)['belly'] > 0.5, 1, np.where(Pn[:, 1] < 73.0, 2, 0)).astype(np.uint8)
        np.savez_compressed(out / 'fat_viewer.npz', F=Fs[sel], positions=np.stack([m[0] for m in meshes]).astype(np.float32),
                            tris=tris, F0=F0, hip=hip[sel], thigh=np.array([r['thighCirc'] for r in rows])[sel], zone=zone,
                            title='臀・純脂肪線（立體＋重力）', axis='全身脂肪')
        print('viewer frames', len(sel), 'verts', len(meshes[0][0]))
