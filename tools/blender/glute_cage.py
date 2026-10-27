"""臀的獨立模：控制籠的幾何（DECISIONS #57、#59、#60）。只用 numpy，不需要 Blender。

範圍：髂嵴（下腰）到臀溝下方約 6 公分的大腿根，前後左右一整圈；不含腰背、不到大腿中段。
1. 只建左半邊的低面數控制籠（cage），由一層層的水平截面組成。先定外側、正前、正後三條側影曲線，
   每層截面從曲線取值，形狀參數也沿高度平滑內插（PROFILE、SHAPE、FRONT、LEGS）。
   上半是一個圈（骨盆），到胯下分成兩條腿的圈；兩腿之間用一串正中頂點（會陰）接起來。
2. cage() 回傳的是「設計點」：細分後的曲面要通過的位置。實際的籠由 glute_scene.fit_cage 反推。
3. 骨點（LANDMARKS）是之後骨架線和素體控制共用的座標框架。

尺寸：台灣年輕女性中位數 160 cm、臀圍約 92.5（research-taiwan.md），各部位的高度與寬厚
用 ANSUR II 女性對身高、臀圍的迴歸推到這個體型，再依 #60 放寬（見 01-glute.md）。
座標用素體的慣例：公分、y 向上（離地高度）、z 向前、x 向左；Blender 裡是 (x, −z, y)。
"""
import math

import numpy as np

# ---------- 尺寸目標（ANSUR II 女性迴歸到 160 cm、臀圍 92.5） ----------
TARGET = dict(hip=92.5, hipY=81.6, hipBreadth=32.2, buttockDepth=20.6, thigh=55.0,
              iliocristale=97.5, trochanter=82.9, crotch=77.0)

# ---------- 1. 側影曲線與截面參數 ----------
# 先定三條側影曲線（隨高度 y 平滑變化），每一層截面都從曲線取值，骨盆圈和腿圈接在同一條曲線上，
# 交界才不會凹一圈。W 外側（半寬）；F 正前（骨盆是正中，腿是大腿前側）；B 正後（臀峰、往下接大腿後側）。
PROFILE = {
    'W': [(69.5, 15.6), (72, 16.1), (75, 16.6), (78, 17.2), (80.5, 17.5), (83, 17.5), (86, 17.05), (90, 16.05),
          (94, 14.6), (98, 13.0)],
    'F': [(69.5, 7.2), (72, 7.3), (75, 7.4), (78, 7.5), (80, 7.8), (83, 8.45), (86, 8.6), (90, 8.1), (94, 7.6), (98, 6.9)],
    'B': [(69.5, -9.6), (73, -9.9), (75, -10.25), (76.5, -10.85), (78.5, -12.05), (80.5, -13.15), (82.5, -13.6),
          (84.5, -13.45), (87, -12.2), (90, -10.6), (94, -8.6), (98, -7.4)],
}
# 骨盆圈的截面形狀（也隨高度內插）：zc 最寬處的前後位置；pf、pb 前後半的方圓程度（2 是橢圓，越大越方）；
# lobe 臀峰比底弧多突的量，xl 臀峰離正中的距離，sl、slm 臀峰往外、往內的寬；cleft 臀縫往前凹。
SHAPE = {
    'zc': [(79.2, -2.0), (83, -1.8), (90, -1.3), (98, -1.0)],
    'pf': [(79.2, 2.9), (82, 2.75), (86, 2.5), (98, 2.4)],
    'pb': [(79.2, 2.3), (86, 2.4), (98, 2.5)],
    'lobe': [(79.2, 3.0), (81.5, 3.3), (85, 2.9), (89, 1.7), (92, 0.5), (95, 0.0), (98, 0.4)],
    'xl': [(79.2, 5.4), (84, 5.8), (90, 5.0), (94, 4.2), (98, 3.2)],
    'sl': [(79.2, 6.0), (84, 6.6), (90, 5.6), (94, 3.0), (98, 2.0)],
    'slm': [(79.2, 5.0), (88, 5.0), (94, 3.0), (98, 2.5)],
    'cleft': [(79.2, 3.0), (82, 2.5), (85, 2.0), (88, 1.3), (91, 0.4), (94, 0.0), (98, 0.0)],
}
# 正面造型（隨高度內插）：belly 下腹弧面比底弧多突的量；groin 鼠蹊溝的深度
FRONT = {
    'belly': [(77, 0.0), (79.5, 0.3), (82, 0.75), (86, 1.1), (90, 0.95), (93, 0.5), (96, 0.1), (98, 0.0)],
    'groin': [(76, 0.4), (79, 0.65), (84, 0.6), (89, 0.35), (92, 0.0)],
}
TORSO_Y = [98.0, 95.5, 93.0, 90.5, 88.0, 85.5, 83.0, 81.0, 79.2]
# 腿圈（左腿）：中心 (cx, cz)；外側、前、後由側影曲線決定；bulge 臀下半往後的量；
# fold 臀溝：後內側往前、往上收（淺，只在內側）；torso 沿用骨盆截面外圈的比例；pfm 前內側的方圓程度；
# 內側離正中的距離：gf 前內側、gb 後內側。胯下內側的幾點另外指定（LABIA_RING、FOLD_RING、THIGH_FRONT），
# 大腿內側不貼到正中，胯下留出大陰唇與會陰的位置；大陰唇下面兩腿之間留一個小三角空隙。
LEGS = [
    dict(y=77.0, cx=8.0, cz=-1.3, bulge=0.6, fold=0.08, torso=0.75, gf=2.0, gb=1.3, pfm=2.0),
    dict(y=75.0, cx=8.0, cz=-1.1, bulge=0.0, fold=0.3, torso=0.5, gf=1.8, gb=1.5, pfm=2.0),
    dict(y=73.0, cx=7.9, cz=-0.9, bulge=0.0, fold=0.1, torso=0.2, gf=1.0, gb=1.0, pfm=2.6),
    dict(y=69.5, cx=7.8, cz=-0.7, bulge=0.0, fold=0.0, torso=0.0, gf=1.1, gb=1.1, pfm=2.4),
]
LEG_P = dict(pl=2.4, pfl=2.2, pbl=2.2, pm=2.3)
# 籠在骨盆圈上的取樣（左半 17 點）：正面用固定的 x 比例取 8 點（下腹、鼠蹊、恥丘需要較密），
# 外側到後方用角度取 6 點，臀縫兩側用固定的 x 取 3 點。
FRONT_U = [0.0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84]
TORSO_T = [72, 90, 106, 122, 138, 154]
BACK_X = [3.4, 1.1, 0.0]
# 胯下：最後一層的正前、正後換成會陰的位置；中間一串正中頂點（後 → 前）把左右腿分開。
CROTCH_FRONT = (79.0, 7.0)   # (y, z) 恥丘下緣、縫的上端
CROTCH_BACK = (80.2, -5.2)   # 臀縫底
CHAIN = [(77.2, -3.2), (75.9, 1.6), (76.0, 6.0)]   # 會陰 → 大陰唇下緣最低處 → 大陰唇前下
# 胯下內側四個方位角（前內 −50°、內前 290°、正內 268°、內後 245°）的點另外指定，不用腿圈公式：
# 第一圈腿圈（高 77）的這幾點是大陰唇最鼓的地方，往下、往正中收，讓大陰唇是兩團飽滿的圓墊；
# 第二圈（高 75）的這幾點往上提到股生殖摺，比大陰唇下緣高，摺外面才是往下的大腿內側。
# 這樣不必多加一圈籠點（多一圈會在骨盆接大腿的地方留下一道橫向的明暗）。
LABIA_RING = {-50.0: (1.6, 77.4, 6.8), 290.0: (1.1, 76.2, 5.0), 268.0: (0.9, 76.2, 0.8), 245.0: (0.8, 77.0, -3.4)}
FOLD_RING = {-50.0: (2.3, 77.9, 6.1), 290.0: (1.4, 76.9, 4.0), 268.0: (1.2, 76.8, 0.0), 245.0: (1.1, 77.2, -4.0)}
# 大腿內前側：從腹股溝往後斜下去的內收肌斜面（作者 2026-10-27 範例圖），在大陰唇旁邊貼著它，只留一道摺；
# 大陰唇下面才是兩腿之間的空隙。不沿用骨盆截面平的正面，也不讓腿圈公式在這裡轉成方角，
# 不然正面看大陰唇兩側會露出一長條大腿內側的面，頂端是一圈拱門形的折線。{腿圈序號: {方位角: 座標}}
THIGH_FRONT = {0: {-37.1: (3.1, 77.6, 6.2)}, 1: {-37.1: (2.4, 75.6, 5.8)}}
# 局部鬆弛的中心與半徑（素體座標，公分）：胯下前方的會合點、臀縫底
RELAX = [((0.0, 77.0, 4.5), 6.0), ((0.0, 78.5, -4.5), 5.0)]


def leg_phi():
    """腿圈各點的方位角（0° 正前、90° 外側、180° 正後、270° 內側），和骨盆圈左半一一對應，最後 3 點對應會陰串。
    點要大致平均分布在一圈上，擠在一起的地方細分後會出現硬折線。"""
    front = list(np.linspace(-50, 40, len(FRONT_U)))
    return front + [62, 90, 115, 140, 162, 182, 198, 210, 222, 245, 268, 290]


LEG_PHI = leg_phi()


def curve(pts, y):
    """單調三次內插（Fritsch–Carlson），曲線不會在控制點之間多出起伏。"""
    xs, ys = np.array([p[0] for p in pts], float), np.array([p[1] for p in pts], float)
    if y <= xs[0]:
        return float(ys[0])
    if y >= xs[-1]:
        return float(ys[-1])
    h, d = np.diff(xs), np.diff(ys) / np.diff(xs)
    m = np.zeros(len(xs))
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, len(xs) - 1):
        if d[i - 1] * d[i] > 0:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    i = int(np.searchsorted(xs, y) - 1)
    t = (y - xs[i]) / h[i]
    h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
    return float(h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1])


def spow(v, e):
    return math.copysign(abs(v) ** e, v)


def torso_level(y):
    L = {k: curve(v, y) for k, v in SHAPE.items()}
    L.update(y=y, w=curve(PROFILE['W'], y), zf=curve(PROFILE['F'], y))
    # 讓臀峰（x = xl）剛好落在側影曲線 B 上：反推正中的底弧深度 zb
    g = (1 - (L['xl'] / L['w']) ** L['pb']) ** (1 / L['pb'])
    L['zb'] = L['zc'] - (L['zc'] - curve(PROFILE['B'], y) - L['lobe']) / g
    L['dimple'] = 0.35 * math.exp(-((y - 94.5) / 1.8) ** 2)   # 腰窩（髂後上棘）
    L['side'] = -0.12 * math.exp(-((y - 85.5) / 2.5) ** 2)    # 臀側凹陷（C 點），中性型幾乎看不出
    # 正面：下腹是一個圓的弧面，往下收進鼠蹊的 V 字；鼠蹊從髂前上棘（約 x 11、y 92）斜到胯下（約 x 3、y 79）
    L['groinX'] = 3.0 + 8.5 * min(max((y - 79.0) / 13.0, 0.0), 1.0)
    L['groin'] = curve(FRONT['groin'], y)
    L['belly'] = curve(FRONT['belly'], y)
    L['mons'] = 0.35 * math.exp(-((y - 81.2) / 1.4) ** 2)
    return L


def back_z(L, x):
    """後半截面在 x 處的前後位置：圓弧，加臀峰、減臀縫。"""
    u = min(x / L['w'], 1.0)
    z = L['zc'] - (L['zc'] - L['zb']) * (1 - u ** L['pb']) ** (1 / L['pb'])
    # 臀峰：往外、往內都是緩的圓（高斯），外側才不會在大轉子後方收出凹面
    q = (x - L['xl']) / (L['sl'] if x >= L['xl'] else L['slm'])
    z -= L['lobe'] * math.exp(-q * q)
    z += L['dimple'] * math.exp(-((x - 4.2) / 1.3) ** 2)
    return z + L['cleft'] * math.exp(-(x / 0.6) ** 2)


def front_z(L, x):
    """前半截面在 x 處的前後位置：圓弧，加下腹弧面、恥丘，減鼠蹊溝。正中剛好落在側影曲線 F 上。"""
    u = min(x / L['w'], 1.0)
    xb = 0.85 * L['groinX']                       # 下腹弧面的寬度跟著鼠蹊往下收
    zf = L['zf'] - L['belly'] - L['mons']         # 底弧的正中，加上弧面後回到 F
    z = L['zc'] + (zf - L['zc']) * (1 - u ** L['pf']) ** (1 / L['pf'])
    z += L['belly'] * math.exp(-(x / xb) ** 2) + L['mons'] * math.exp(-(x / 3.2) ** 2)
    return z - L['groin'] * math.exp(-((x - L['groinX']) / 1.3) ** 2)


def torso_half(L):
    pts = [(u * L['w'], L['y'], front_z(L, u * L['w'])) for u in FRONT_U]
    for t in TORSO_T:
        s, c = math.sin(math.radians(t)), math.cos(math.radians(t))
        if c >= 0:
            x, z = L['w'] * abs(s) ** (2 / L['pf']), L['zc'] + (L['zf'] - L['belly'] - L['mons'] - L['zc']) * abs(c) ** (2 / L['pf'])
        else:
            x = L['w'] * abs(s) ** (2 / L['pb'])
            z = back_z(L, x)
        g = math.exp(-((t - 114) / 14) ** 2)
        x += L['side'] * g * s
        z += L['side'] * g * c
        pts.append((x, L['y'], z))
    # 臀縫兩側：用固定的 x 取樣，讓臀縫窄而深，左右臀在正中幾乎貼合
    for x in BACK_X:
        pts.append((x, L['y'], back_z(L, x)))
    return pts


def leg_ring(L):
    y0, cx, cz = L['y'], L['cx'], L['cz']
    al = curve(PROFILE['W'], y0) - cx
    bf = curve(PROFILE['F'], y0) - cz
    back = lambda phi: math.exp(-((phi - 200) / 25) ** 2)
    fold = lambda phi: math.exp(-((phi - 208) / 30) ** 2)  # 往外緩緩漸淡，不收成三角形
    # 正後（182°）落在側影曲線 B 上
    bb = cz - curve(PROFILE['B'], y0) - L['bulge'] * back(182) + L['fold'] * fold(182)
    pts = []
    for phi in LEG_PHI:
        s, c = math.sin(math.radians(phi)), math.cos(math.radians(phi))
        gap = L['gb'] + (L['gf'] - L['gb']) * min(max(0.5 + c, 0.0), 1.0)
        a, p = (al, LEG_P['pl']) if s >= 0 else (cx - gap, LEG_P['pm'])
        if s >= 0 and c < 0:
            p = LEG_P['pbl']  # 後外側較圓，臀下半才不會在外側鼓出一圈
        if s >= 0 and c >= 0:
            p = LEG_P['pfl']  # 前外側較圓，大腿前外側才不會比胯飽滿，正面不出橫溝
        if s < 0 and c >= 0:
            p = L['pfm']      # 前內側（內收肌）往正中填
        x = cx + a * spow(s, 2 / p)
        z = cz + (bf if c >= 0 else bb) * spow(c, 2 / p)
        z += -L['bulge'] * back(phi) + L['fold'] * fold(phi)
        y = y0 + 0.5 * L['fold'] * fold(phi)
        pts.append((max(x, gap), y, z))
    # 腿圈上段先沿用骨盆截面的外圈（斜前、外側、斜後），往下才漸漸變成大腿的形；
    # 不然骨盆截面飽滿的斜角接到較收的腿圈，交界會往內凹一圈。內側與臀縫附近維持腿的形。
    if L['torso'] > 0:
        T = torso_half(torso_level(y0))
        n = len(FRONT_U) + len(TORSO_T)
        for j in range(1, n):
            w = L['torso'] * math.sin(math.pi * j / n) ** 0.5
            pts[j] = tuple(w * np.array(T[j]) + (1 - w) * np.array(pts[j]))
    return pts


def cage():
    """左半籠的頂點與四邊形面（頂點座標用素體慣例）。"""
    V, F, rings = [], [], []
    for y in TORSO_Y:
        rings.append(list(range(len(V), len(V) + len(FRONT_U) + len(TORSO_T) + len(BACK_X))))
        V += torso_half(torso_level(y))
    last = rings[-1]
    V[last[0]] = (0.0, *CROTCH_FRONT)
    V[last[-1]] = (0.0, *CROTCH_BACK)
    for a, b in zip(rings, rings[1:]):
        for k in range(len(a) - 1):
            F.append((a[k], a[k + 1], b[k + 1], b[k]))
    chain = list(range(len(V), len(V) + len(CHAIN)))
    V += [(0.0, y, z) for y, z in CHAIN]
    loops = [last + chain]
    legs = [leg_ring(L) for L in LEGS]
    for k, phi in enumerate(LEG_PHI):
        if round(phi, 1) in LABIA_RING:
            legs[0][k], legs[1][k] = LABIA_RING[round(phi, 1)], FOLD_RING[round(phi, 1)]
    for r, pts in THIGH_FRONT.items():
        for k, phi in enumerate(LEG_PHI):
            if round(phi, 1) in pts:
                legs[r][k] = pts[round(phi, 1)]
    for ring in legs:
        loops.append(list(range(len(V), len(V) + len(LEG_PHI))))
        V += ring
    for a, b in zip(loops, loops[1:]):
        n = len(a)
        for k in range(n):
            F.append((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    V = np.array(V, float)
    # 縱向平滑：同一縱列（骨盆圈接腿圈）上下相鄰的點取平均，消掉層與層之間的小起伏。
    # 只動正面、外側到後外側的點，只動前後位置；正中、臀縫與臀溝內側不動
    cols = rings[:-1] + loops
    for j in range(2, len(FRONT_U) + len(TORSO_T) - 1):
        col = [r[j] for r in cols]
        for _ in range(2):
            z = V[col, 2].copy()
            V[col[1:-1], 2] = 0.5 * z[1:-1] + 0.25 * (z[:-2] + z[2:])
    # 局部鬆弛：胯下前方的會合點與臀縫底，是骨盆一圈分成兩條腿的地方，籠點的連接數不規則，
    # 細分後容易出現小凸點、小凹點。附近的籠點往鄰點的平均移一些（越近中心移越多），正中的點留在正中
    nb = [set() for _ in V]
    for f in F:
        for a, b in zip(f, f[1:] + f[:1]):
            nb[a].add(b)
            nb[b].add(a)
    nb = [list(n) for n in nb]
    # 大陰唇（會陰串、第一圈腿圈的內側）、股生殖摺（第二圈的內側）與大腿內前側斜面是刻意做的起伏，不鬆弛
    keep = np.zeros(len(V), bool)
    keep[chain] = True
    keep[[r[k] for r in loops[1:3] for k, phi in enumerate(LEG_PHI) if round(phi, 1) in LABIA_RING]] = True
    keep[[loops[r + 1][k] for r, pts in THIGH_FRONT.items() for k, phi in enumerate(LEG_PHI) if round(phi, 1) in pts]] = True
    for c, r in RELAX:
        w = 0.6 * np.clip(1 - np.linalg.norm(V - np.array(c), axis=1) / r, 0, 1) * ~keep
        for _ in range(4):
            avg = np.array([V[n].mean(0) for n in nb])
            mid = V[:, 0] == 0
            V += w[:, None] * (avg - V)
            V[mid, 0] = 0
    return V, F


def sharp_points():
    """擬合籠時差值不平滑、直接補的點（glute_scene.fit_cage 的 sharp）：會陰串和第一圈腿圈的大陰唇點。
    股生殖摺的點不用：直接補會在摺的前端出尖角。
    這幾點是刻意做的小起伏，平滑過的差值補不到。索引和 cage() 的頂點順序一致。"""
    start = (len(FRONT_U) + len(TORSO_T) + len(BACK_X)) * len(TORSO_Y)
    ring = start + len(CHAIN)
    return np.array(list(range(start, ring)) + [ring + k for k, phi in enumerate(LEG_PHI) if round(phi, 1) in LABIA_RING])


def to_blender(p):
    p = np.asarray(p, float)
    return np.stack([p[..., 0], -p[..., 2], p[..., 1]], -1)


def to_body(p):
    p = np.asarray(p, float)
    return np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)


# ---------- 骨點（素體座標；左側，右側鏡像） ----------
LANDMARKS = {
    'iliacCrest': (13.2, TARGET['iliocristale'], -1.5),
    'asis': (11.0, 91.5, 6.4),
    'psis': (4.2, 93.8, -9.0),
    'greaterTrochanter': (15.4, TARGET['trochanter'], -1.6),
    'hipJoint': (8.6, 83.6, 0.4),
    'ischialTuberosity': (5.6, 79.0, -6.0),
    'pubicSymphysis': (0.0, 82.2, 5.2),
    'coccyx': (0.0, 83.5, -8.2),
}


# ---------- 細部層：大陰唇中間的縫 ----------
# 大陰唇的體積在籠裡（作者 2026-10-27：不是另外加一塊，是恥丘往下捲進兩腿之間的延伸）：
# 恥丘最下方往內捲，第一圈腿圈內側的點（LABIA_RING）是捲下去的那段，正中的會陰串是它的下緣，
# 兩側的股生殖摺（FOLD_RING）是腹股溝往下的延伸，是凹的溝。細部層只刻中間那道縫：
# 正面是一道淺凹痕，往下到胯下兩片緊貼、只剩一條線，往後到會陰前漸淡。不做小陰唇、陰蒂等裡面的形。
# 縫沿著一條路徑（正中平面上，(高 y, 前後 z, 深度)）走，往路徑的內側壓；scale 隨脂肪量。
CLEFT = dict(
    path=[(79.7, 6.0, 0.0), (79.2, 6.0, 0.25), (78.4, 5.9, 0.3), (77.5, 5.6, 0.28), (76.9, 5.0, 0.22),
          (76.6, 3.8, 0.18), (76.6, 2.0, 0.15), (76.8, 0.4, 0.1), (77.2, -1.0, 0.0)],
    w=0.25,   # 縫的半寬（公分）
)


def crotch_detail(P, faces=None, scale=1.0):
    P = np.array(P, float)
    pts = np.array(CLEFT['path'], float)
    t = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts[:, :2], axis=0), axis=1))]
    u = np.linspace(0, t[-1], 200)
    y, z, dep = (np.interp(u, t, pts[:, k]) for k in range(3))
    ty, tz = np.gradient(y), np.gradient(z)
    n = np.hypot(ty, tz)
    ny, nz = tz / n, -ty / n                   # 路徑朝外的法線（前段朝前、下段朝下）
    near = np.where((np.abs(P[:, 0]) < 4 * CLEFT['w']) & (P[:, 1] < y.max() + 0.5) & (P[:, 1] > y.min() - 2.0)
                    & (P[:, 2] > z.min() - 2.0))[0]
    Q = P[near]
    d2 = (Q[:, 1:2] - y[None]) ** 2 + (Q[:, 2:3] - z[None]) ** 2
    i = d2.argmin(1)
    # 只刻在路徑外側（表面那一側）約 2.5 公分以內的點
    out = (Q[:, 1] - y[i]) * ny[i] + (Q[:, 2] - z[i]) * nz[i]
    g = dep[i] * scale ** 0.35 * np.exp(-(Q[:, 0] / CLEFT['w']) ** 2) * ((out > -0.5) & (out < 2.5))
    P[near, 1] -= g * ny[i]
    P[near, 2] -= g * nz[i]
    return P


# ---------- 分區（作者 2026-10-27，DECISIONS #62） ----------
# 臀負責的範圍 ≈ 平口褲覆蓋：上緣是「肚子分開的那條線」——背面、側面沿髂嵴（模型上緣），
# 正面從髂前上棘沿鼠蹊往下，接到恥骨上的橫摺（高 84）；下緣是褲管（臀溝下 2～3 公分，高 73）。
# 這條線以上、以前是下腹（交給腹部）；褲管以下是大腿。分界和脂肪線的附著線（鼠蹊、恥骨上橫摺）一致。
ZONE = dict(fold_y=84.0, asis=(11.5, 92.0), crest=(13.5, 98.0), groin_low=(3.0, 79.0), hem_y=73.0)


def belly_line_x(y):
    """肚子分界線在高度 y 的正面外緣 x：橫摺高度以上，沿鼠蹊斜到髂前上棘、再到髂嵴。"""
    Z = ZONE
    gx = Z['groin_low'][0] + (Z['asis'][0] - Z['groin_low'][0]) * (y - Z['groin_low'][1]) / (Z['asis'][1] - Z['groin_low'][1])
    up = Z['asis'][0] + (Z['crest'][0] - Z['asis'][0]) * (y - Z['asis'][1]) / (Z['crest'][1] - Z['asis'][1])
    return np.where(y < Z['asis'][1], gx, up)


def zones(P, N, soft=0.0):
    """每個點屬於哪一區：0 臀（含恥丘、臀側、大腿根到褲管）、1 下腹（交給腹部）、2 褲管以下的大腿。
    soft > 0 時回傳下腹的平滑權重（0～1，邊界寬 soft 公分），給脂肪線用。"""
    x, y, z = np.abs(P[:, 0]), P[:, 1], P[:, 2]
    front = np.clip(N[:, 2] * 4, 0, 1) if soft else (N[:, 2] > 0.2)
    if soft:
        s = lambda d: np.clip(0.5 + d / soft, 0, 1)
        return s(y - ZONE['fold_y']) * s(belly_line_x(y) - x) * front
    belly = (y > ZONE['fold_y']) & (x < belly_line_x(y)) & front
    return np.where(belly, 1, np.where(y < ZONE['hem_y'], 2, 0)).astype(np.uint8)
