"""臀的純脂肪線，在 MakeHuman 起胚的中性型上（DECISIONS #61、#71；研究 R20、R21、R25、R26）。只用 numpy、scipy。

python3 tools/blender/glute_mh_fat.py <輸出資料夾> [viewer]

分層：中性型 ＝ 底層（骨架＋肌肉）＋ 脂肪厚度 × 法線；厚度 T(點, F) 由堆積點與增長曲線給（#61，規律沿用 glute_fat.py）。
做法分兩步（作者 2026-10-29：做的時候要有體積的概念，記下來的只要表面）：
  1. 不受重力時怎麼長：照數據的規律（堆積點、範圍內每 kg 全身脂肪 0.18 kg），沿中性時的方向（抹平過的法線，
     組織離開骨頭的方向）長，方向沒正對表面時補回體積。切口附近只往切口平面長；
     胯下前段（大陰唇底面）夾在兩腿之間不往下長。中性以下照厚度公式收。
  2. 重力：把脂肪層當成立體的體積（glute_mh_soft.FatVolume），只加臀那一袋多出來的重量，解線性彈性的平衡：
     - 體積不變（脂肪幾乎不可壓縮）；皮與淺筋膜是膜（彎曲勁度），臀上半有淺筋膜從髂嵴拉著較硬、下半鬆（Han 2022）；
     - 附著區綁住：臀溝內段、臀縫、薦骨、臀側凹陷（大轉子上方）（Rohrich 的 zones of adherence）；
     - 溝下的大腿、肚子、上下切口不受這袋的重力（是別的部位的事）；
     - 兩邊不穿過正中（這一步裡的近似，真正的接觸在第 3 步）。
     中性起每 SOFT_STEP kg 解一次（前一格當起點），中間直線內插；位移只留大尺度的部分（籠格子尺度的起伏是數值的）。
  3. 接觸（DECISIONS #73，glute_mh_contact）：前兩步的形當目標，從中性型每 CONTACT_STEP kg 一步走過去，
     皮膚任何兩片相碰（臀縫兩壁、臀底和大腿、兩腿內側、胯下）都兩邊一起讓開、不互相穿過；左右鏡像對稱。
     沒有站姿專用的擋板，換姿勢時同一套照樣能用。
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
import glute_mh_contact as gc  # noqa: E402

# ---------- 軸（同 glute_fat.py）----------
F0 = 17.0                     # 中性型：160 cm、54.5 kg、DXA 體脂約 31%
# 瘦端約 BMI 16.5。胖端：原本到全身體重約 204 公斤那一級（R21，脂肪約 109 kg）；作者 2026-11-01 定上限臀圍 172、
# 且 172 時要能同臀圍換組成，臀只做到真人在那個臀圍時臀本身的大小（其餘由腹部、大腿撐，DECISIONS #79），
# 偏脂肪的那一頭要比 204 公斤那一級的平均多一些，取到 130
FMIN, FMAX = 2.0, 130.0      # 瘦端到皮包骨（#83，R29：BMI 12～13 外推脂肪 1.5～3 kg）
# 很瘦時（全身脂肪 9 kg 以下）臀腿的脂肪掉得比照原本的公式更快：極瘦時這一區只佔全身脂肪約 15%（R29），
# 原本的公式在 2 kg 時還留 0.57 kg。9 kg 以下多出的厚度漸漸乘上 0.5（2 kg 時）。造型假設
DEPLETE = (9.0, 2.0, 0.5)
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

# ---------- 型（DECISIONS #75：量照數據、形偏美）----------
# 型 t：0 照資料的平均分配（各線原本的樣子），1 偏美型。只在 0～1 之間內插，不外插（AGENTS：不准用線性外插放大造型）。
# 型只改「多出來的量往哪裡去」與「撐不撐得住」，總量照規律不變；中性型與中性以下的厚度不變。
# 偏美型（造型假設，作者 2026-10-31 看參考圖與型的試驗）：臀的中心偏高（上緣的架子）、臀下緣少一點、
# 臀側凹陷填平、大腿上段多、腰側與全身平均少、肚子少跟、臀溝更清楚。
BEAUTY = dict(
    depots={'buttock': dict(amax=7.5, c=(6.5, 82.5, -11.0)), 'lowerButtock': dict(amax=2.0),
            'hipDip': dict(amax=3.0, r=(3.5, 4.0, 4.0)), 'saddle': dict(amax=6.5), 'thighRoot': dict(amax=5.0),
            'innerThigh': dict(amax=3.0), 'flank': dict(amax=1.5), 'everywhere': dict(amax=1.0)},
    belly_follow=0.2, fold_grow=0.55)
# 插畫型（型 t = 2）：更接近作者給的參考圖（2026-10-31）。臀更大、更高、範圍更大（和四周融在一起），臀側凹陷全填，
# 腰側、全身平均、肚子幾乎不長。型在 1～2 之間是偏美型和插畫型之間內插（兩個目標，不外插）。
# 臀下緣、大腿後側、大腿上段照樣跟著長：臀的圓要整片撐出來，不能靠把下面挖空（作者 2026-11-01：第一版臀和腿之間出現一道溝）
STYLIZED = dict(
    depots={'buttock': dict(amax=10.0, c=(6.5, 83.0, -11.5), r=(8.0, 8.0, 8.0)), 'lowerButtock': dict(amax=2.2),
            'hipDip': dict(amax=4.0, r=(4.0, 4.5, 4.5)), 'saddle': dict(amax=7.0), 'thighRoot': dict(amax=6.5),
            'innerThigh': dict(amax=3.0), 'backThigh': dict(amax=2.2), 'flank': dict(amax=0.5), 'everywhere': dict(amax=0.5)},
    belly_follow=0.1, fold_grow=0.55)
LEAN0 = 35.3                  # 中性的全身去脂（同 glute_mh_muscle.L0）
# 型作用在整個範圍（作者 2026-11-01，#77：統一到所有範圍）：中性與中性以下的脂肪也照型分配，總量照資料不變。
# 這個比例是中性時照型重新分配的程度（1 ＝ 中性的脂肪完全照型的堆積點分配）。造型假設
TYPE_AT_NEUTRAL = 1.0


def _lerp(a, b, u):
    a, b = np.array(a, float), np.array(b, float)
    return tuple(a + u * (b - a)) if a.ndim else float(a + u * (b - a))


def type_depots(t):
    """型 t 的堆積點：0～1 在原本與偏美型之間、1～2 在偏美型與插畫型之間直線內插。"""
    out = {}
    for name, d in DEPOTS.items():
        e = dict(d)
        keys = [k for k in ('amax', 'c', 'r') if d.get(k) is not None]
        beauty = {k: BEAUTY['depots'].get(name, {}).get(k, d[k]) for k in keys}
        styl = {k: STYLIZED['depots'].get(name, {}).get(k, beauty[k]) for k in keys}
        for k in keys:
            e[k] = _lerp(d[k], beauty[k], min(t, 1.0)) if t <= 1 else _lerp(beauty[k], styl[k], t - 1)
        out[name] = e
    return out


def type_value(key, base, t):
    """型 t 時的單一數值（肚子跟著長的比例、臀溝多長的比例）。"""
    return base + min(t, 1.0) * (BEAUTY[key] - base) + max(t - 1, 0.0) * (STYLIZED[key] - BEAUTY[key])


def firmness(t, F, L):
    """型的挺度：重力的倍數（1 照原本）。撐不撐得住看組成：肌肉多撐得住（中性一半、多 20 kg 去脂全部），
    脂肪多撐不住（全身脂肪 35 kg 以上漸少，110 kg 時只剩兩成）。很胖時照樣會垂，只是分配讓形偏圓。造型假設。
    偏美型最多減一半，插畫型最多減七成。"""
    m = np.clip(0.5 + (L - LEAN0) / 40.0, 0, 1)
    b = np.clip((F - 35.0) / 75.0, 0, 0.8)
    k = 0.5 * min(t, 1.0) + 0.2 * max(t - 1, 0.0)
    return 1 - k * m * (1 - b)


def depletion(F):
    """很瘦時臀腿脂肪多掉的比例（DEPLETE）：9 kg 以上 1，2 kg 時 0.5。"""
    hi, lo, k = DEPLETE
    u = float(np.clip((hi - F) / (hi - lo), 0, 1))
    return 1 - (1 - k) * u * u * (3 - 2 * u)


def default_type(F, L):
    """網站預設的型（#77 插畫型，強度照組成）。皮包骨時沒有脂肪也沒有肌肉可以塑形，型漸漸降到 0（#83）：
    脂肪 9 kg、去脂 33 kg 以上照 type_reach；往下到脂肪 2、去脂 27 時是 0。造型假設。"""
    import glute_mh_muscle as gmu
    s = lambda u: float(np.clip(u, 0, 1) ** 2 * (3 - 2 * np.clip(u, 0, 1)))
    g = s((F - FMIN) / 7.0) * s((L - gmu.LMIN) / 6.0)
    return type_reach(2.0, F, L) * g


def type_reach(t, F, L):
    """變化區間：插畫型（型超過 1 的部分）做得到多少，看組成撐不撐得住（DECISIONS #75：肌肉與脂肪要平衡）。
    型作用在整個範圍（#77），中性也有：
      去脂：中性 0.5，多 18 kg 起全部，少於中性漸少（去脂 29 約 0.3）；
      脂肪：中性附近到 60 kg 全部；很瘦時可塑的脂肪少（9 kg 剩 0.6）；60 kg 以上漸弱，110 kg 剩 0.4。
    回傳這個組成實際用的型（1 以下照原樣）。造型假設。"""
    if t <= 1:
        return t
    s = lambda u: float(np.clip(u, 0, 1) ** 2 * (3 - 2 * np.clip(u, 0, 1)))
    m = float(np.clip(0.5 + (L - LEAN0) / 36.0, 0, 1))
    f = (1 - 0.4 * s((F0 - F) / 8.0)) * (1 - 0.6 * s((F - 60.0) / 50.0))
    return 1 + (t - 1) * m * f


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
CONTACT_STEP = 1.0   # 接觸：每幾 kg 走一步
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


class LegContinuation:
    """腿的切口附近（作者 2026-11-01：切口上方不該鼓出一圈；腿圍變大時是臀底與大腿的相接處變粗、轉折變緩）。
    大腿往下一直接到膝蓋，切口只是這個部位的邊：切口往上 H 公分內，每個方位長的量不超過同一方位 H 公分處的量（封頂），
    再平順地接成和 H 公分處一樣（延續，切口處全部照它）。總量照規律固定，多出來的會往上移到相接處。
    用原本中性型的位置算，綁在頂點上。f → self(f)。"""

    def __init__(self, Vc, F, H=5.0):
        n = len(Vc)
        bnd = gc.boundary_mask(F, n)
        idx, src, w = [], [], []
        for side in (1, -1):
            B = np.nonzero(bnd & (Vc[:, 1] < 80) & (side * Vc[:, 0] > 0.3))[0]
            c = Vc[B].mean(0)
            a = np.linalg.svd(Vc[B] - c)[2][2]
            a = a if a[1] > 0 else -a
            e1 = np.cross(a, [0.0, 0.0, 1.0]); e1 /= np.linalg.norm(e1)
            e2 = np.cross(a, e1)
            h = (Vc - c) @ a
            rel = Vc - c - np.outer(h, a)
            ang = np.arctan2(rel @ e2, rel @ e1)
            leg = (side * Vc[:, 0] > 0) & (np.linalg.norm(rel, axis=1) < 25)
            band = np.nonzero(leg & (np.abs(h - H) < 1.0))[0]
            for v in np.nonzero(leg & (h < H - 0.5))[0]:
                dang = np.abs(np.angle(np.exp(1j * (ang[band] - ang[v]))))
                idx.append(v)
                src.append(band[np.argmin(dang + 0.3 * np.abs(h[band] - H))])
                u = np.clip(h[v] / H, 0, 1)
                w.append(1 - u * u * (3 - 2 * u))
        self.idx, self.src, self.w = np.array(idx), np.array(src), np.array(w)

    def __call__(self, f):
        g = np.array(f, float, copy=True)
        a, b = f[self.idx], f[self.src]
        g[self.idx] = (1 - self.w) * np.minimum(a, b) + self.w * b
        return g


class FatLine:
    def __init__(self, frame=None, type=0.0):
        """frame：這副骨架下的中性型（glute_mh_frame.Frame.neutral）；預設原本的中性型。
        type：型（0 照資料、1 偏美（BEAUTY）、2 插畫型（STYLIZED））。
        規則（堆積點、控制線、區域、附著）都在原本中性型的頂點上算（Vc、Nc），綁在組織上；形（底層、長的方向、切口）用 V0。"""
        g = gm.build()
        self.F = g.F
        self.Vc = g.V.copy()
        self.Nc = gm.vertex_normals(self.Vc, self.F)
        self.V0 = self.Vc.copy() if frame is None else np.asarray(frame, float).copy()
        self.N0 = gm.vertex_normals(self.V0, self.F)
        assert 0.0 <= type <= 2.0, '型只在 0～2 之間（兩個目標之間內插，不外插）'
        self.type = type
        self.depots = type_depots(type)
        self.belly_follow = type_value('belly_follow', BELLY_FOLLOW, type)
        self.cont = LegContinuation(self.Vc, self.F)
        self.mid = np.abs(self.Vc[:, 0]) < 1e-6
        C = gm.control_weights(self.Vc, self.Nc)
        Z = gm.zone_weights(self.Vc, self.Nc)
        self.A = np.ones(len(self.V0))
        for name, s in ATTACH.items():
            self.A *= 1 - s * C[name]
        self.A_grow = np.ones(len(self.V0))
        for name, s in ATTACH_GROW.items():
            if name == 'fold':
                s = type_value('fold_grow', s, type)
            self.A_grow *= 1 - s * C[name]
        self.belly = Z['belly']
        self.crotch = Z['crotch']
        # 胯下不長的只有朝下的底面（大陰唇底、會陰）；朝正中的壁（臀縫最底、兩腿內側）照樣長，兩邊才擠得攏
        medial = np.clip(-np.sign(self.Vc[:, 0]) * self.Nc[:, 0], 0, None)
        self.crotch_hold = np.clip(self.crotch * 2, 0, 1) * np.clip(1 - medial / 0.6, 0, 1)
        if __import__('os').environ.get('PERI_GROW', '1') == '1':
            # 會陰後段（肛門四周，臀縫底）也有脂肪（坐骨肛門窩），會跟著長、把臀縫底的凹填起來；只有前段（大陰唇底）不長
            self.crotch_hold *= np.clip((self.Vc[:, 2] + 1.0) / 2.0, 0, 1)
        y = self.Vc[:, 1]
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
        self.y_crease = np.interp(np.abs(self.Vc[:, 0]), fp[:, 0], fp[:, 1])
        u = np.clip((y - self.y_crease) / 2.0, 0, 1)
        self.glute = u * u * (3 - 2 * u) * (1 - self.belly) * (1 - np.clip((y - 96.5) / 4.0, 0, 1))
        a = np.zeros(len(self.V0))
        for name, k in ADHERE.items():
            # 只綁那一條線（控制線的權重取次方，變窄）：線上方的組織可以翻過去
            a = np.maximum(a, k * C[name] ** ADHERE_SHARP)
        x = np.abs(self.Vc[:, 0])
        a = np.maximum(a, np.exp(-(((x - LGD['c'][0]) / LGD['r'][0]) ** 2 + ((y - LGD['c'][1]) / LGD['r'][1]) ** 2))
                       * np.clip(np.abs(self.Nc[:, 0]) * 2, 0, 1))
        self.adhere = a
        self._unl, self._sag = {}, {}
        self._Tt = {}
        assert type > 0 or np.abs(self.shape(F0) - self.V0).max() < 1e-9, '底層＋中性厚度要還原中性型'

    def maps(self, V, N, F, depots=None):
        """每個堆積點在每個頂點上的分布（0～1），範圍隨脂肪量擴大。用中性位置算，堆積點跟著組織走。"""
        Nm = mirrored(N, V)
        Vm = np.c_[np.abs(V[:, 0]), V[:, 1:]]
        M = {}
        for name, d in (DEPOTS if depots is None else depots).items():
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
        M = self.maps(self.Vc, self.Nc, F)
        T = np.zeros(len(self.V0))
        for name, d in DEPOTS.items():
            if d.get('grow_only'):          # 只管中性以上多長的（中性與更瘦時的厚度不變）
                continue
            T += GAIN * d['amax'] * growth(F, d['on'], d['k']) * M[name] * self.A
        return TMIN + depletion(F) * T

    def thickness_typed(self, F):
        """中性與中性以下（F ≤ F0）照型分配的厚度：同樣的堆積點公式換成型的堆積點，再把總量調回資料的量
        （型只改分配）。型 0 就是 thickness。"""
        Td = self.thickness(F)
        if self.type == 0:
            return Td
        M = self.maps(self.Vc, self.Nc, F, self.depots)
        T = np.full(len(self.V0), TMIN)
        for name, d in self.depots.items():
            if d.get('grow_only'):
                continue
            T += GAIN * d['amax'] * growth(F, d['on'], d['k']) * M[name] * self.A
        a = areas(self.Vc, self.F)
        T = TMIN + (T - TMIN) * (a * (Td - TMIN)).sum() / max((a * (T - TMIN)).sum(), 1e-12)
        return Td + TYPE_AT_NEUTRAL * (T - Td)

    def Tt(self, F):
        """F ≤ F0 時每個點的脂肪厚度（照型）；肚子只跟著變一部分。型 0、F0 時就是 T0。"""
        if F not in self._Tt:
            self._Tt[F] = self.T0 + self.cont((self.thickness_typed(F) - self.T0)
                                              * (1 - (1 - self.belly_follow) * self.belly))
        return self._Tt[F]

    def neutral_skin(self, start, D0):
        """型的中性皮膚（還沒處理接觸）：中性的脂肪照型重新分配，從 start（原本的中性皮膚）沿長的方向移。"""
        if self.type == 0:
            return start.copy()
        D = gm.cut_normals(D0, self.cut)
        return self.constrain(start + (self.Tt(F0) - self.T0)[:, None] * D, clamp=False)

    def constrain(self, V, clamp=True):
        V[self.mid, 0] = 0.0
        if clamp:
            # 站姿專用的擋板（肌肉線還在用）：兩邊最多貼到正中。脂肪線的接觸改由 glute_mh_contact 處理
            left, right = (self.Vc[:, 0] > 0) & ~self.mid, (self.Vc[:, 0] < 0) & ~self.mid
            V[left, 0] = np.maximum(V[left, 0], 0.05)
            V[right, 0] = np.minimum(V[right, 0], -0.05)
        return V

    def distribution(self, F):
        """此刻新增的脂肪往哪裡去：各堆積點增長曲線的斜率 × 分布 × 附著係數。
        胯下（大陰唇底面、會陰）夾在兩腿之間，沒有往下長的空間；大陰唇的脂肪從恥丘那邊長（mons）。"""
        M = self.maps(self.Vc, self.Nc, F, self.depots)
        w = np.zeros(len(self.V0))
        for name, d in self.depots.items():
            w += d['amax'] * (growth(F + 0.25, d['on'], d['k']) - growth(F - 0.25, d['on'], d['k'])) / 0.5 * M[name]
        w *= self.A_grow * (1 - (1 - self.belly_follow) * self.belly) * self.top * (1 - self.crotch_hold)
        return self.cont(w)

    def smooth_dirs(self, V):
        """長的方向的基準：表面法線抹平（組織離開骨頭的方向）。"""
        D = gm.vertex_normals(V, self.F)
        for _ in range(25):
            D = D + 0.35 * (self.W @ D - D)
        return D / np.linalg.norm(D, axis=1, keepdims=True)

    def unloaded(self, F, start=None, D0=None, cache=None):
        """不受重力時的形與每個點長了多厚。中性以下照厚度公式沿長的方向收；中性以上從中性用同樣的步長一步步長，
        體積照規律（方向沒正對表面時補回），結果只由 F 決定。
        start：中性脂肪時的皮膚（預設中性型；組成線傳入肌肉變了之後的皮膚），D0：它的長的方向，cache：走過的格點。"""
        if start is None:
            start, D0, cache = self.V0, self.D0, self._unl
        if F <= F0:
            T = self.Tt(F)
            # 切口附近只在切口平面裡收（切口是接身體其他部分的地方，不能離開那個平面）
            D = gm.cut_normals(D0, self.cut)
            return self.constrain(start + (T - self.T0)[:, None] * D, clamp=False), np.zeros(len(self.V0))
        cache = {} if cache is None else cache
        n = int(round((F - F0) / STEP_F * 1e6)) // 1000000
        k = max([j for j in cache if j <= n], default=0)
        V, acc = (a.copy() for a in cache[k]) if k else (self.neutral_skin(start, D0), np.zeros(len(self.V0)))
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
            N = GROW_BLEND * N / np.linalg.norm(N, axis=1, keepdims=True) + (1 - GROW_BLEND) * D0
            N /= np.linalg.norm(N, axis=1, keepdims=True)
            N = gm.growth_dirs(V, N, self.cut, toward_mid=TOWARD_MID)
            cos = np.clip((N * Nc).sum(1), 0.2, 1)
            dT *= (area * dT).sum() / (area * dT * cos).sum()
            V = self.constrain(V + dT[:, None] * N, clamp=False)
            acc = acc + dT
            if key is not None:
                cache[key] = (V.copy(), acc.copy())
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
        y = self.Vc[:, 1]
        back = np.clip(-self.Nc[:, 2] * 2, 0, 1)
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
        self.s_side = np.sign(np.round(self.Vc[col, 0], 6))
        self.s_thigh = (self.glute < 0.05) & (self.Nc[:, 2] < -0.3) & (y < self.y_crease + 0.5)
        self.s_lap = gs.laplacian(self.F, n)

    def sag(self, Fg):
        """格點 Fg 上重力造成的皮膚位移（相對不受重力的形）。"""
        if Fg in self._sag:
            return self._sag[Fg]
        self._sag[Fg] = self.sag_of(*self.unloaded(Fg), self.base, firmness(self.type, Fg, LEAN0))
        return self._sag[Fg]

    def sag_of(self, U, acc, base, g=1.0):
        """不受重力的形 U（多長的厚度 acc）在重力下的皮膚位移；脂肪層在底層 base（肌肉表面）和皮膚之間。
        g：重力的倍數（型的挺度，firmness）。"""
        if not hasattr(self, 'vol'):
            self._soft_setup()
        K, n = SOFT_K, len(self.V0)
        Xr = self.vol.layers(base, U)
        load = np.zeros(len(Xr))
        dm = 0.9 * np.clip(acc, 0, None) * areas(U, self.F) * self.glute           # 臀這袋多出來的脂肪（公克）
        for kk in range(1, K + 1):
            load[kk * n:(kk + 1) * n] = g * SOFT_G * dm / K
        kb = [0.0] * (K + 1)
        kb[K] = BEND
        if K > 1:
            kb[K - 1] = 0.2 * BEND
        X = self.vol.solve_linear(Xr, self.s_free, self.s_kedge, self.s_kanch, load, self.s_side, None,
                                  lap=self.s_lap, k_bend=kb)
        D = X[K * n:(K + 1) * n] - U
        for _ in range(D_SMOOTH):
            D = D + 0.5 * (self.W @ D - D)
        return D

    def target(self, F):
        """規則算出來的形（不受重力的形 ＋ 重力的位移；中性起每 SOFT_STEP kg 解一次，中間直線內插），還沒處理接觸，
        兩片皮可能互相穿過。"""
        return self.with_sag(self.unloaded(F)[0], F, self.sag)

    def with_sag(self, U, F, sag):
        """不受重力的形加上重力的位移：重力在中性起每 SOFT_STEP kg 的格點上解（sag(格點)），中間直線內插。"""
        if F <= F0:
            return U
        j = int(np.floor((F - F0) / SOFT_STEP + 1e-9))
        Fa, Fb = F0 + j * SOFT_STEP, F0 + (j + 1) * SOFT_STEP
        Da = sag(Fa) if Fa > F0 else 0.0
        t = (F - Fa) / SOFT_STEP
        return self.constrain(U + (1 - t) * Da + t * sag(Fb), clamp=False)

    def shape(self, F):
        """任一全身脂肪量 F 的控制籠：從中性型（沒有穿面）每 CONTACT_STEP kg 一步走向規則算出的形，
        每一步用通用的接觸（glute_mh_contact）讓碰在一起的皮膚兩邊一起讓開、不穿過。結果只由 F 決定。"""
        if not hasattr(self, 'walk'):
            self.walk = gc.Walk(self.neutral_shape(), self.F, F0, self.target, CONTACT_STEP)
        return self.walk(F)

    def neutral_shape(self):
        """型的中性（中性的脂肪照型分配）：從原本的中性型分 4 步做接觸走過去。型 0 就是原本的中性型。"""
        if not hasattr(self, '_Nt'):
            T = self.target(F0)
            self._Nt = self.V0.copy() if np.abs(T - self.V0).max() < 1e-9 else \
                gc.Walk(self.V0, self.F, 0.0, lambda u: self.V0 + u * (T - self.V0), 0.25)(1.0)
        return self._Nt.copy()


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
