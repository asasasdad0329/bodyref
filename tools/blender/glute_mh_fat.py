"""臀的純脂肪線，在 MakeHuman 起胚的中性型上（DECISIONS #61、#71；研究 R20、R21）。只用 numpy、scipy。

python3 tools/blender/glute_mh_fat.py <輸出資料夾> [viewer]

規律沿用 glute_fat.py（#61），改動：
- 脂肪直接加在控制籠（glute_mh.build 的加密籠）上，再 Catmull-Clark 細分；不再擬合籠，變大變小都是成片平順的。
- 附著線用中性型上量出來的控制線（glute_mh.CONTROL_LINES），權重固定在頂點上，跟著組織走。
- 肚子只當連接（作者 2026-10-29）：不長、不垂，只跟著鄰區平順地變一點。
分層：中性型 ＝ 底層 ＋ 脂肪厚度 × 法線。
  厚度 T(點, F) ＝ 最薄厚度 ＋ Σ 堆積點的分布(點) × 增長曲線(F) × 附著係數(點)；中性型對應 F0。
  中性以下照公式；中性以上照體積規律一步步沿當下的法線充氣，厚的地方順便下垂。
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

# ---------- 軸（同 glute_fat.py）----------
F0 = 17.0                     # 中性型：160 cm、54.5 kg、DXA 體脂約 31%
FMIN, FMAX = 9.0, 110.0       # 瘦端約 BMI 16.5；胖端到全身體重約 204 公斤那一級（R21）
REGION_SLOPE = 0.18           # 範圍內每 kg 全身脂肪多約 0.18 kg 脂肪（R20、R21）
STEP_F = 0.5
SPREAD_REF = 33.0
SAG = 0.6
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
    'frontThigh':  dict(c=(9.0, 74.0, 6.0), r=(4.5, 4.5, 5.0), face=(0.3, 0, 1), amax=3.5, on=4.0, k=22.0, sp=0.6),
}

# ---------- 2. 附著線：每條控制線上，厚度增長乘上 (1 − 最大比例 × 權重) ----------
ATTACH = dict(fold=0.85, cleft=0.9, sacrum=0.6, suprapubic=0.3, groin=0.45)


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
        self.belly, self.edge = Z['belly'], Z['edge']
        y = self.V0[:, 1]
        y0, y1, keep = TOP_TAPER
        self.top = 1 - (1 - keep) * np.clip((y - y0) / (y1 - y0), 0, 1)
        # 下垂：肚子不垂（交給腹部）；恥丘附著在恥骨上，變厚但不往下垂到胯下；上下切口不動
        N0 = self.N0
        self.sag = (1 - self.belly) * (1 - self.edge)
        self.sag *= 1 - 0.85 * np.clip(N0[:, 2], 0, 1) * np.clip((84.5 - y) / 2.0, 0, 1) \
            * np.exp(-(self.V0[:, 0] / 6.0) ** 2)
        self.T0 = self.thickness(F0)
        self.base = self.V0 - self.T0[:, None] * self.N0
        self._states = {}
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
            f = np.array(d['face'], float)
            f /= np.linalg.norm(f)
            q = (Vm - c) / (r * (1 + d['sp'] * (F - F0) / SPREAD_REF))
            M[name] = np.exp(-0.5 * (q ** 2).sum(1)) * np.clip(Nm @ f, 0, 1)
        return M

    def thickness(self, F):
        M = self.maps(self.V0, self.N0, F)
        T = np.full(len(self.V0), TMIN)
        for name, d in DEPOTS.items():
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
        """此刻新增的脂肪往哪裡去：各堆積點增長曲線的斜率 × 分布 × 附著係數。"""
        M = self.maps(self.V0, self.N0, F)
        w = np.zeros(len(self.V0))
        for name, d in DEPOTS.items():
            w += d['amax'] * (growth(F + 0.25, d['on'], d['k']) - growth(F - 0.25, d['on'], d['k'])) / 0.5 * M[name]
        w *= self.A * (1 - (1 - BELLY_FOLLOW) * self.belly) * self.top
        return w

    def inflate(self, V, F, dF):
        w = self.distribution(F)
        vol = REGION_SLOPE * dF / 0.9 * 1000            # 公分³（脂肪密度 0.9），左右兩半合計
        dT = vol * w / (areas(V, self.F) * w).sum()
        V = V + dT[:, None] * gm.vertex_normals(V, self.F)
        excess = np.linalg.norm(V - self.V0, axis=1)
        V[:, 1] -= SAG * dT * excess / 5.0 * self.A * self.sag
        return self.constrain(V)

    def shape(self, F):
        """任一全身脂肪量 F 的控制籠。中性以下照公式；中性以上從中性用同樣的步長一步步充氣，結果只由 F 決定。"""
        if F <= F0:
            T = self.T0 + (self.thickness(F) - self.T0) * (1 - (1 - BELLY_FOLLOW) * self.belly)
            return self.constrain(self.base + T[:, None] * self.N0)
        n = int(round((F - F0) / STEP_F * 1e6)) // 1000000
        k = max([j for j in self._states if j <= n], default=0)
        V = self._states[k].copy() if k else self.V0.copy()
        for j in range(k, n):
            V = self.inflate(V, F0 + (j + 0.5) * STEP_F, STEP_F)
            self._states[j + 1] = V.copy()
        rest = F - (F0 + n * STEP_F)
        if rest > 1e-9:
            V = self.inflate(V, F0 + n * STEP_F + rest / 2, rest)
        return V


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
                            tris=tris, F0=F0, hip=hip[sel], thigh=np.array([r['thighCirc'] for r in rows])[sel], zone=zone)
        print('viewer frames', len(sel), 'verts', len(meshes[0][0]))
