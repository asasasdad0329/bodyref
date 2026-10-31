"""臀的純肌肉線，在 MakeHuman 起胚的中性型上（DECISIONS #58、#71；研究 R2、R2b、R24）。只用 numpy、scipy。

python3 tools/blender/glute_mh_muscle.py <輸出資料夾> [viewer]

在中性型上只加減肌肉（去脂），脂肪的量不變：
  中性型 ＝ 底層（骨架＋肌肉）＋ 中性脂肪厚度 × 法線（和純脂肪線同一個拆法，glute_mh_fat.FatLine）。
  底層照體積規律一步步鼓起（或收），方向固定在中性時（組織離開骨頭的方向；沿當下的法線長會像吹氣球，
  臀下越長越往下）；切口附近只往切口平面長，底層的正中兩邊（臀縫兩壁、兩腿內側）貼到正中為止（底層不記錄，
  這是裡面那層的近似）。
  脂肪層再蓋回去（cover）：量不變（底層撐大處變薄、被擠處變厚），方向用抹平過的法線。
  皮膚的接觸（DECISIONS #73，glute_mh_contact，和純脂肪線同一套）：上面算出的形當目標，從中性型每 1 kg 一步
  走過去，碰在一起的皮膚兩邊一起讓開、不互相穿過。
規律：
  1. 軸：全身去脂軟組織 L（DXA，公斤，不含骨礦物）。中性 L0 ＝ 54.5 − 17（脂肪）− 2.2（骨礦物）≈ 35.3。
  2. 範圍內的去脂隨全身去脂直線增加（R24：NHANES 女性型區去脂每 kg 全身去脂 +0.16～0.18，佔比 15.3% → 16.7%，
     到最高也接近直線）。範圍比 DXA 的女性型區大一點，取 0.18。
  3. 形：每塊肌肉用幾筆「纖維方向的筆觸」描述（MUSCLES），沿線肌腹厚、肌腱端薄，橫截面是圓的；肌肉長大時也變寬。
     臀大肌從薦骨斜向外下、外下端收進髂脛束（薄），所以上半與中段鼓、大轉子後面凹；臀中肌在髂嵴下方撐出上外側；
     大轉子本身沒有肌肉，是臀側凹陷的底；股外側肌從大轉子下方開始，往下越來越厚。份量照 Handsfield 2014 的下肢
     肌肉體積：臀約 60%、範圍內的大腿根約 40%。
  4. 脂肪抹平：肌肉的形被上面的脂肪層抹平，脂肪越厚抹得越多（fat_blur）。純肌肉線的脂肪是中性厚度；
     組成線（肌肉、脂肪一起變）用當下的脂肪厚度，所以同樣大小、脂肪多的人肌肉的形就看不出來。
  5. 附著：骨頭貼著皮的地方不長（薦骨、髂嵴、恥骨上的恥丘、胯下的大陰唇與會陰）。臀溝是皮膚被筋膜綁在深層，
     溝的位置不跟著肌肉移動，肌肉長大時溝上方鼓、溝變深（內段強、往外漸弱）。肚子只跟著變（腹肌之後由腹部做）。
  6. 一般人口去脂的高端（約 55 kg 以上）多半是大體重帶來的，新增的去脂漸漸改成平順地攤開（SHAPED）。
  7. 中性以下（萎縮）不是肥大倒著放：整體平順地變小、變扁，沒有「負的肌肉形」。瘦的時候露出的骨頭突點與
     肌肉形留給組成線與骨架線（脂肪變薄時才看得到）。
範圍：L 29（160 cm 女性約第 1 百分位）到 91（R21：160 cm、204 kg 外推的去脂）。高的一端在一般人口裡是
大體重帶來的去脂，也涵蓋運動員；組成線再處理同臀圍下肌肉與脂肪的互換。
"""
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glute_mh as gm  # noqa: E402
import glute_mh_fat as gf  # noqa: E402
import glute_mh_contact as gc  # noqa: E402

L0 = 35.3
LMIN, LMAX = 29.0, 91.0
REGION_SLOPE = 0.18           # 範圍內每 kg 全身去脂多 0.18 kg（R24）
DENSITY = 1.06                # 肌肉密度（公克／公分³）
STEP_L = 0.5
CONTACT_STEP = 1.0           # 接觸：每幾 kg 走一步

# 肌肉：每塊用幾筆「纖維方向的筆觸」描述（雕塑的作法），起點 → 終點；每筆給沿線的相對厚度（肌腹厚、肌腱端薄）
# 與半寬（公分）。點用「哪一面、哪個位置」指定，貼到中性型的表面上：
#   ('back', x, y) 背面該 (x, y) 最後面的點；('front', x, y) 正面最前面的點；
#   ('lat', y, z) 外側該 (y, z) 最外面的點；('med', y, z) 大腿內側該 (y, z) 最內面的點。
# share：這塊肌肉在範圍內去脂的份量。Handsfield 2014 的下肢肌肉體積比例：臀大肌 12.3%（最大的一塊）、臀中肌 5.0%、
# 臀小肌 1.6%、闊筋膜張肌 0.9%；大腿肌肉只有上段在範圍內（約 10 公分），合計約 11%。所以臀約 60%、大腿根約 40%。
MUSCLES = {
    # 臀大肌：從薦骨、髂骨後緣斜向外下，上、中段收進大轉子後方的髂脛束，下段收到股骨臀肌粗隆。
    # 外下端是肌腱（薄），長大時上半與中段鼓、外下方被髂脛束拉住，大轉子後面的臀側凹陷變深
    'gluteusMaximus': dict(share=0.48, width=4.0, strokes=[
        ([('back', 4.5, 93.5), ('back', 10.0, 89.0), ('lat', 85.0, -5.0)], [0.6, 1.0, 0.25]),
        ([('back', 2.0, 88.0), ('back', 8.0, 83.0), ('lat', 80.5, -6.0)], [0.7, 1.0, 0.3]),
        ([('back', 1.6, 81.5), ('back', 6.5, 77.8), ('back', 11.5, 74.0)], [0.6, 1.0, 0.35])]),
    # 臀中肌：髂嵴下方的扇形，收到大轉子上緣；後半被臀大肌蓋住，露出的是上外側
    'gluteusMedius': dict(share=0.09, width=3.5, strokes=[
        ([('back', 8.5, 95.5), ('lat', 88.5, -4.0)], [0.8, 0.4]),
        ([('lat', 97.0, -3.0), ('lat', 88.5, -2.0)], [1.0, 0.4]),
        ([('lat', 96.0, 2.0), ('lat', 88.5, 0.5)], [0.8, 0.3])]),
    # 闊筋膜張肌：髂前上棘往外下，收進髂脛束
    'tensorFasciae': dict(share=0.03, width=2.0, strokes=[
        ([('front', 11.5, 90.0), ('lat', 82.0, 3.0)], [0.6, 0.4])]),
    # 股外側肌：大轉子下方開始（大轉子本身沒有肌肉，是臀側凹陷的底），往下越來越厚
    'vastusLateralis': dict(share=0.08, width=6.0, strokes=[
        ([('lat', 80.0, -1.0), ('lat', 76.0, -0.5), ('lat', 72.5, 0.0)], [0.0, 0.7, 1.0])]),
    # 股直肌＋股中間肌：大腿正前方的縱向隆起，從髂前下棘往下
    'quadricepsFront': dict(share=0.06, width=5.5, strokes=[
        ([('front', 10.5, 84.0), ('front', 10.0, 76.0), ('front', 9.8, 71.0)], [0.3, 0.8, 1.0])]),
    # 內收肌群：從恥骨與坐恥枝往下展開的楔形
    'adductors': dict(share=0.14, width=4.5, strokes=[
        ([('front', 3.5, 79.0), ('med', 74.0, 1.5), ('med', 69.5, 0.5)], [0.4, 1.0, 1.0]),
        ([('med', 76.0, -2.0), ('med', 72.5, -2.5), ('med', 69.5, -2.0)], [0.5, 1.0, 1.0])]),
    # 膕繩肌：起點在坐骨粗隆，站立時被臀大肌蓋住；看得到的肌腹從臀溝下方開始往下
    'hamstrings': dict(share=0.12, width=5.0, strokes=[
        ([('back', 6.5, 74.0), ('back', 7.5, 72.0), ('back', 8.0, 70.5)], [0.1, 0.7, 1.0])]),
}
WIDEN = 0.8       # 肌肉長大時也變寬：到最多去脂時寬度 × (1 + WIDEN)（肌肥大是整個截面變大，不是只變厚）
BLUR = 0.35       # 脂肪把肌肉的形抹平的程度：每一步的擴散係數 ×（脂肪厚度 ÷ 2 公分）²
BLUR_STEPS = 25
# 一般人口去脂的高端（約 55 kg 以上，160 cm 女性的第 90 百分位以上）多半是大體重帶來的：肌肉整體變大、皮與結締組織增加，
# 不是運動員那種一塊塊的肌肥大。這一段新增的去脂漸漸改成平順地攤開（各肌肉的形合起來再大幅抹平），到 75 kg 只剩 30% 照肌肉的形。
SHAPED = [(L0, 1.0), (55.0, 1.0), (75.0, 0.3), (91.0, 0.3)]


def surface_point(V, N, spec):
    """('back', x, y) 等指定方式 → 中性型表面上的點與法線（左半）。"""
    side, a, b = spec
    left = V[:, 0] >= 0
    if side in ('back', 'front'):
        m = left & (np.hypot(V[:, 0] - a, V[:, 1] - b) < 1.2) & ((N[:, 2] < 0) if side == 'back' else (N[:, 2] > 0))
        i = np.nonzero(m)[0][np.argmin(V[m, 2])] if side == 'back' else np.nonzero(m)[0][np.argmax(V[m, 2])]
    else:
        m = left & (np.hypot(V[:, 1] - a, V[:, 2] - b) < 1.2)
        if side == 'lat':
            i = np.nonzero(m)[0][np.argmax(V[m, 0])]
        else:
            m &= N[:, 0] < 0
            i = np.nonzero(m)[0][np.argmin(V[m, 0])]
    return V[i], N[i]


def muscle_fields(V, N, widen=1.0):
    """每塊肌肉在每個頂點上的形（0～1 × 沿線厚度）：筆觸附近、法線朝同一面的點才算；同一塊肌肉的幾筆取最大。"""
    Vm = np.c_[np.abs(V[:, 0]), V[:, 1:]]
    Nm = np.c_[N[:, 0] * np.where(V[:, 0] < 0, -1, 1), N[:, 1:]]
    out = {}
    for name, m in MUSCLES.items():
        f = np.zeros(len(V))
        for pts, thick in m['strokes']:
            P, Pn = zip(*[surface_point(V, N, p) for p in pts])
            P, Pn = np.array(P), np.array(Pn)
            seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
            s_at = np.r_[0, np.cumsum(seg)] / seg.sum()
            best = np.full(len(V), np.inf)
            s_best = np.zeros(len(V))
            n_best = np.zeros((len(V), 3))
            for k in range(len(P) - 1):
                a, d = P[k], P[k + 1] - P[k]
                t = np.clip(((Vm - a) @ d) / (d @ d), 0, 1)
                dist = np.linalg.norm(Vm - (a + t[:, None] * d), axis=1)
                better = dist < best
                best[better] = dist[better]
                s_best[better] = (s_at[k] + (s_at[k + 1] - s_at[k]) * t)[better]
                nn = Pn[k] + (Pn[k + 1] - Pn[k]) * t[:, None]
                n_best[better] = nn[better]
            n_best /= np.linalg.norm(n_best, axis=1, keepdims=True) + 1e-12
            # 橫截面是圓的（肌腹鼓、往兩邊收），不是平頂加陡邊：平頂的話長大後每塊肌肉的邊都是一道崖
            w = m['width'] * widen
            u = np.clip(1 - best / w, 0, 1)
            core = u * u * (3 - 2 * u)
            facing = np.clip(((Nm * n_best).sum(1) - 0.2) / 0.4, 0, 1)
            f = np.maximum(f, core * facing * np.interp(s_best, np.linspace(0, 1, len(thick)), thick))
        out[name] = f
    return out


def fat_blur(field, W, T, steps=BLUR_STEPS):
    """脂肪把下面的形抹平：厚的地方擴散得多（每一步的係數跟脂肪厚度的平方成正比，最多 0.5）。
    field 可以是一個值或一組向量（每列一個頂點）；W 是鄰點平均矩陣（gm.averaging_matrix）。"""
    a = np.clip(BLUR * (T / 2.0) ** 2, 0, 0.5)
    if field.ndim > 1:
        a = a[:, None]
    f = field.copy()
    for _ in range(steps):
        f = f + a * (W @ f - f)
    return f


# 附著：每條控制線上，增厚乘上 (1 − 比例 × 權重)
# 臀溝：皮膚被筋膜綁在深層（不是臀大肌下緣；下緣斜著穿過溝），溝的位置不跟著肌肉移動；內段強、往外漸弱（控制線的強度）
ATTACH = dict(fold=0.7, cleft=0.95, sacrum=0.9, suprapubic=0.7, groin=0.6)


class MuscleLine:
    def __init__(self):
        self.fat = gf.FatLine()
        fl = self.fat
        self.F, self.mid = fl.F, fl.mid
        V0, N0 = fl.V0, fl.N0
        C = gm.control_weights(V0, N0)
        Z = gm.zone_weights(V0, N0)
        A = np.ones(len(V0))
        for name, s in ATTACH.items():
            A *= 1 - s * C[name]
        # 恥丘、胯下沒有肌肉
        x, y, z = np.abs(V0[:, 0]), V0[:, 1], V0[:, 2]
        mons = np.exp(-((x / 4.0) ** 2 + ((y - 81.0) / 2.5) ** 2)) * np.clip(N0[:, 2] * 2, 0, 1)
        A *= (1 - mons) * (1 - Z['crotch'])
        # 髂嵴（上緣外側）貼骨
        A *= 1 - 0.8 * np.clip((y - 96.5) / 3.0, 0, 1) * np.clip((x - 9.0) / 3.0, 0, 1)
        self.A = A * (1 - (1 - gf.BELLY_FOLLOW) * fl.belly) * fl.top
        self.V0n, self.N0n = V0, N0
        self._fields = {}
        self.W = gm.averaging_matrix(len(V0), self.F)
        self.cut = gm.cut_frame(V0, self.F)
        self.base0 = fl.base.copy()
        self.N_base0 = gm.vertex_normals(self.base0, self.F)
        self.T0 = fl.T0
        self.area0 = gf.areas(self.base0, self.F)
        self.Ns0 = self.skin_normals(self.base0, self.T0)
        # 長大的方向固定在中性時（抹平過的底層法線，大致是組織離開骨頭的方向）。沿「當下」的法線一步步長會像吹氣球：
        # 臀下、大腿上段朝下的面越長越往下，擠在大腿切口上，溝下多出一層台階。
        D = fat_blur(self.N_base0, self.W, np.full(len(V0), 2.0))
        self.D0 = D / np.linalg.norm(D, axis=1, keepdims=True)
        self.th0 = np.clip(((fl.V0 - self.base0) * self.N_base0).sum(1), 0, None)   # 中性時沿底層法線量的脂肪厚度
        self._states = {}

    def skin_normals(self, B, T):
        """脂肪層蓋回去的方向：底層的法線先被脂肪抹平（脂肪越厚越平），凹處兩壁的方向才不會交叉。"""
        N = fat_blur(gm.vertex_normals(B, self.F), self.W, T)
        return N / np.linalg.norm(N, axis=1, keepdims=True)

    def cover(self, B, T=None):
        """底層蓋回脂肪層（純肌肉線用中性的脂肪；組成線傳入當下的厚度 T）。
        脂肪的量不變：底層表面撐大的地方脂肪變薄、凹進去被擠的地方變厚；蓋回去的方向用抹平過的法線，
        凹處（臀溝、臀縫底）兩壁的脂肪才不會互相穿過；最後確保脂肪至少有應有厚度的一半，皮不會跑進肌肉裡。
        還沒處理接觸（凹處兩壁可能互相穿過，由 shape 的接觸處理）。中性時剛好還原中性型。"""
        T = self.T0 if T is None else T
        ratio = self.area0 / gf.areas(B, self.F)
        for _ in range(4):
            ratio = self.W @ ratio
        t = T * ratio
        S = self.fat.V0 + (B - self.base0) + t[:, None] * self.skin_normals(B, T) - self.T0[:, None] * self.Ns0
        NB = gm.vertex_normals(B, self.F)
        short = np.clip(0.5 * self.th0 * ratio * (T / self.T0) - ((S - B) * NB).sum(1), 0, None)
        S = S + short[:, None] * NB
        # 切口附近的點只在切口平面裡移動（切口接著身體其他部分）：底層在正中被擋住時會橫移，連帶沿腿的方向移
        w, ax = self.cut
        d = S - self.fat.V0
        S = S - (w * (d * ax).sum(1))[:, None] * ax
        return self.fat.constrain(S, clamp=False)

    def fields(self, L):
        """L 時各肌肉的形（寬度隨去脂增加；用中性位置算，跟著組織走）。每 1 kg 算一次。"""
        k = int(round(L))
        if k not in self._fields:
            widen = 1 + WIDEN * np.clip((k - L0) / (LMAX - L0), 0, 1)
            self._fields[k] = {n: v * self.A for n, v in muscle_fields(self.V0n, self.N0n, widen).items()}
        return self._fields[k]

    def increment(self, B, dL, T, L):
        """這一步每個頂點的肌肉增厚：每塊肌肉分到 share × 體積，照它的形（肌腹厚、肌腱端薄、邊緣收）攤開；
        再被脂肪抹平（厚度 T 的脂肪層）。"""
        vol = REGION_SLOPE * dL / DENSITY * 1000     # 公分³，左右合計（dL 可以是負的）
        area = gf.areas(B, self.F)
        shaped = np.zeros(len(B))
        for name, f in self.fields(L).items():
            shaped += MUSCLES[name]['share'] * f / (area * f).sum()
        # 中性以下（萎縮）不是肥大倒著放：整體變小、變扁，沒有「負的肌肉形」
        k = 0.0 if L < L0 else float(np.interp(L, [p[0] for p in SHAPED], [p[1] for p in SHAPED]))
        if k < 1:
            smooth = fat_blur(shaped, self.W, np.full(len(B), 2.6), steps=60)
            smooth /= (area * smooth).sum()
            shaped = k * shaped + (1 - k) * smooth
        return fat_blur(vol * shaped, self.W, T)

    def grow(self, B, dL, L, T=None):
        dT = self.increment(B, dL, self.T0 if T is None else T, L)
        D = gm.growth_dirs(B, self.D0, self.cut)
        # 方向沒有正對表面時，同樣的位移撐出的體積較少；補回來，體積才照規律
        area = gf.areas(B, self.F)
        cos = np.clip((D * gm.vertex_normals(B, self.F)).sum(1), 0.2, 1)
        dT *= (area * dT).sum() / (area * dT * cos).sum()
        B = B + dT[:, None] * D
        # 兩邊（臀縫兩壁、兩腿內側）最多貼到正中
        side = np.sign(self.V0n[:, 0])
        B[:, 0] = side * np.maximum(B[:, 0] * side, 0.0)
        return B

    def base(self, L, T=None, states=None):
        """去脂 L 時的底層。從中性用同樣的步長一步步走過去，結果只由 L 決定。
        T：蓋在上面、把肌肉的形抹平的脂肪厚度（預設中性；組成線傳入當下的厚度，states 另外存）。"""
        states = self._states if T is None else ({} if states is None else states)
        n = int(round(abs(L - L0) / STEP_L * 1e6)) // 1000000
        sgn = 1 if L >= L0 else -1
        key = lambda j: sgn * j
        k = max([j for j in range(n + 1) if key(j) in states], default=0)
        B = states[key(k)].copy() if k else self.base0.copy()
        for j in range(k, n):
            B = self.grow(B, sgn * STEP_L, L0 + sgn * (j + 0.5) * STEP_L, T)
            states[key(j + 1)] = B.copy()
        rest = abs(L - L0) - n * STEP_L
        if rest > 1e-9:
            B = self.grow(B, sgn * rest, L0 + sgn * (n * STEP_L + rest / 2), T)
        return B

    def target(self, L):
        """規則算出來的形（底層＋蓋回去的脂肪），還沒處理皮膚的接觸。"""
        return self.cover(self.base(L))

    def shape(self, L):
        """去脂 L 時的控制籠：從中性型每 CONTACT_STEP kg 一步走向 target，皮膚相碰處兩邊一起讓開。結果只由 L 決定。"""
        if not hasattr(self, 'walk'):
            self.walk = gc.Walk(self.fat.V0, self.F, L0, self.target, CONTACT_STEP)
        return self.walk(L)


if __name__ == '__main__':
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    ml = MuscleLine()
    assert np.abs(ml.shape(L0) - ml.fat.V0).max() < 1e-6, '中性去脂要還原中性型'
    Ls = np.arange(LMIN, LMAX + 0.01, 1.0)
    rows, cages = [], []
    fold = (gm.control_weights(ml.V0n, ml.N0n)['fold'] > 0.5) & (np.abs(ml.V0n[:, 0]) < 5)
    for L in Ls:
        V = ml.shape(L)
        P, _ = gm.preview(V, ml.F, 2)
        m = gf.measure(P)
        # 自我檢查：翻過來的面（和中性比轉了 84° 以上）、臀溝內段的高度變化
        m['flipped'] = int((gm.face_turn(V, ml.fat.V0, ml.F) < 0.1).sum())
        m['foldDy'] = round(float((V - ml.fat.V0)[fold, 1].mean()), 2)
        rows.append(dict(L=float(L), **m))
        cages.append(V.astype(np.float32))
        if L % 5 == 0 or L in (LMIN, LMAX):
            print(f'L {L:5.1f}  臀圍 {m["hipCirc"]:6.2f}  寬 {m["hipBreadth"]:5.2f}  厚 {m["buttockDepth"]:5.2f}  大腿圍 {m["thighCirc"]:5.2f}'
                  f'  翻面 {m["flipped"]}  臀溝內段高度 {m["foldDy"]:+.2f}')
    hip = np.array([r['hipCirc'] for r in rows])
    slope = np.gradient(hip, Ls)
    i0 = int(np.argmin(np.abs(Ls - L0)))
    print('中性附近臀圍斜率（公分/kg 全身去脂）', round(float(slope[i0]), 3),
          '對照：R19 每 kg 女性型區去脂 +3.9 公分 × R24 0.16～0.18 ≈ 0.62～0.70')
    (out / 'muscle_line.json').write_text(json.dumps(dict(L0=L0, rows=rows, depots=MUSCLES), ensure_ascii=False, indent=1))
    np.savez_compressed(out / 'muscle_line.npz', L=Ls, cages=np.stack(cages), quads=ml.F)
    if 'viewer' in sys.argv:
        sel = [i for i, L in enumerate(Ls) if (L - LMIN) % 4 == 0]
        meshes = [gm.preview(cages[i].astype(float), ml.F, 2) for i in sel]
        Q = meshes[0][1]
        tris = np.r_[Q[:, [0, 1, 2]], Q[:, [0, 2, 3]]].astype(np.uint32)
        Pn, _ = gm.preview(ml.fat.V0, ml.F, 2)
        Nn = gm.vertex_normals(Pn, Q)
        zone = np.where(gm.zone_weights(Pn, Nn)['belly'] > 0.5, 1, np.where(Pn[:, 1] < 73.0, 2, 0)).astype(np.uint8)
        np.savez_compressed(out / 'fat_viewer.npz', F=Ls[sel], positions=np.stack([m[0] for m in meshes]).astype(np.float32),
                            tris=tris, F0=L0, hip=hip[sel], thigh=np.array([r['thighCirc'] for r in rows])[sel], zone=zone,
                            title='臀・純肌肉線', axis='全身去脂')
        print('viewer frames', len(sel))
