"""臀的獨立模：控制籠的幾何（DECISIONS #57、#59、#60、#63）。只用 numpy，不需要 Blender。

範圍：髂嵴（下腰）到臀溝下方約 6 公分的大腿根，前後左右一整圈；不含腰背、不到大腿中段。
做法是「截面優先」（2026-10-28 重建）：
1. 每一層水平截面是一條畫好的平滑封閉曲線：骨盆層經過幾個有意義的控制點（正前、恥丘、鼠蹊、側面、
   臀峰、臀縫），臀的後半是一段圓弧（每一邊臀是一顆圓的）；腿層是繞著大腿軸的圓角截面。
   控制點的位置隨高度沿平滑曲線變（`curve`），所以縱向也是順的。只有臀縫、鼠蹊、臀溝、腿縫這幾處可以凹。
2. 每層曲線用同一組弧長比例取點，籠的縱列在各層對得上；點數比舊版密（半圈 25 點），
   胯下的小形狀不用再靠籠外的補丁。
3. cage() 回傳的是「設計點」：細分後的曲面要通過的位置。實際的籠由 glute_scene.fit_cage 反推。
4. 骨點（LANDMARKS）是之後骨架線和素體控制共用的座標框架。

尺寸：台灣年輕女性中位數 160 cm、臀圍約 92.5（research-taiwan.md）；造型以好看、渾圓為準，
可以比 ANSUR 平均飽滿（#60，作者 2026-10-28：這一步先塑形，還不跟數據掛鉤）。
座標用素體的慣例：公分、y 向上（離地高度）、z 向前、x 向左；Blender 裡是 (x, −z, y)。
"""
import math

import numpy as np

# ---------- 尺寸目標（ANSUR II 女性迴歸到 160 cm、臀圍 92.5） ----------
TARGET = dict(hip=92.5, hipY=81.6, hipBreadth=32.2, buttockDepth=20.6, thigh=55.0,
              iliocristale=97.5, trochanter=82.9, crotch=77.0)

# ---------- 0. 骨架（DECISIONS #63） ----------
# 胯寬決定腿的位置：大腿截面的中心落在「大腿軸」上，大腿軸從胯下高度、髖關節正下方略外的一點斜向膝蓋
# （股骨往內斜）。兩腿之間的縫 = 兩條大腿軸的距離 − 大腿寬，所以胯寬、胖瘦一改，縫自然跟著變；
# 臀寬也由骨架加軟組織推出來，不另外指定。作者 2026-10-27：預設胯寬取比較寬的一側（ANSUR 女性中位數）。
FRAME = dict(
    bicristal=27.3,           # 髂嵴寬（ANSUR II 女性中位數 27.3；160 cm、臀圍 92.5 的迴歸值 25.5）
    hip_joint=(9.0, 83.6),    # 髖關節中心 (x, y)：約 0.36 × 髂前上棘間距（Bell 法），寬胯取高一點
    thigh_top=(9.6, 77.0),    # 大腿軸在胯下高度的位置（軟組織中心，比髖關節略外）
    knee=(4.8, 46.0),         # 膝關節中心：站直、膝蓋不併攏
)


def thigh_cx(y):
    (x0, y0), (x1, y1) = FRAME['thigh_top'], FRAME['knee']
    return x1 + (x0 - x1) * (y - y1) / (y0 - y1)


# ---------- 1. 隨高度變的控制量 ----------
# 外側半寬 W、正前 F（骨盆是正中，腿是大腿前側）、正後 B（臀峰；往下接大腿後側）。
PROFILE = {
    'W': [(69.5, 16.6), (72, 16.9), (75, 17.25), (78, 17.65), (80.5, 17.9), (83, 17.9), (86, 17.45), (90, 16.5),
          (94, 15.2), (98, 13.9)],
    'F': [(69.5, 7.2), (72, 7.3), (75, 7.4), (78, 7.6), (80, 8.05), (83, 8.55), (86, 8.6), (90, 8.1), (94, 7.6), (98, 6.9)],
    'B': [(69.5, -9.5), (73, -10.0), (75, -10.5), (76.3, -11.2), (77.3, -12.3), (78.5, -13.1), (80.5, -13.6),
          (82.5, -13.7), (84.5, -13.35), (87, -12.15), (90, -10.6), (94, -8.6), (98, -7.4)],
}
# 骨盆截面的前半：zc 最寬處的前後位置；pf 前半的方圓程度（2 是橢圓）；belly 下腹弧面、groin 鼠蹊溝深度
FRONT = {
    'zc': [(79.2, -2.0), (83, -1.8), (90, -1.3), (98, -1.0)],
    'pf': [(79.2, 2.9), (82, 2.75), (86, 2.5), (98, 2.4)],
    'belly': [(77, 0.0), (79.5, 0.3), (82, 0.75), (86, 1.1), (90, 0.95), (93, 0.5), (96, 0.1), (98, 0.0)],
    'groin': [(76, 0.4), (79, 0.65), (84, 0.6), (89, 0.35), (92, 0.0)],
}
# 骨盆截面的後半：每一邊臀是一段圓弧（圓心 (xk, B + R)、半徑 R），從臀縫旁（x_in）繞到外後方，
# 再順到側面；往上 R 變大、臀縫變淺，接到平的下背。cleft：臀縫從臀峰往前凹多深。
BACK = {
    'xk': [(76, 6.2), (79, 6.5), (83, 6.7), (87, 6.3), (91, 5.2), (95, 4.2), (98, 3.8)],
    'R': [(76, 5.5), (79, 6.6), (83, 7.2), (87, 8.0), (91, 10.5), (95, 14.0), (98, 16.0)],
    'x_in': [(77, 0.9), (85, 1.0), (92, 1.6), (98, 2.5)],
    'cleft': [(77.5, 6.0), (79, 5.0), (82, 4.2), (86, 3.2), (90, 1.8), (93, 0.7), (96, 0.0)],
    'dimple': (0.35, 94.5, 1.8, 4.2, 1.3),   # 腰窩（髂後上棘）：深度、高度、上下寬、離正中、左右寬
}
# 大腿截面（繞著大腿軸 thigh_cx）：cz 中心的前後位置；mf、mb 前內側、後內側從大腿軸往內伸多遠
# （大腿本身的形；離正中的距離 = 大腿軸 − 這個量，由胯寬推出來，#63）；p* 各象限的方圓程度；
# torso：截面上段沿用骨盆截面外圈的比例（臀底在這幾層從臀的圓弧漸漸換成大腿）。
LEG = {
    'cz': [(69.5, -0.7), (73, -0.9), (75, -1.1), (78, -1.4)],
    'mf': [(69.5, 6.7), (73, 7.7), (75, 9.0), (78, 9.0)],
    'mb': [(69.5, 6.8), (73, 7.8), (75, 8.7), (78, 8.7)],
    'pfm': [(69.5, 2.4), (73, 2.4), (75, 3.0), (78, 2.6)],
    'torso': [(69.5, 0.0), (73.5, 0.0), (75.4, 0.12), (76.8, 0.45), (78.0, 0.85)],
}
LEG_P = dict(pl=2.2, pfl=2.2, pbl=2.2, pbm=3.0, phi_f=-40.0, phi_b=220.0)

# ---------- 2. 層與拓撲 ----------
N_HALF = 25          # 骨盆半圈的點數（含正前、正後兩個正中點）
PELVIS_Y = [98.0, 96.0, 94.0, 92.0, 90.0, 88.0, 86.5, 85.0, 83.5, 82.0, 80.6, 79.4]
LEG_Y = [78.0, 76.8, 75.4, 73.8, 71.8, 69.5]
# 胯下：最後一層骨盆的正前、正後換成胯下正中的兩端；中間一串正中點（後 → 前）是會陰與大陰唇下緣，
# 把左右腿分開。第一圈腿圈內側的點是大陰唇和大腿之間的摺。
CROTCH_FRONT = (79.0, 7.55)   # (y, z) 恥丘往大陰唇的過渡（正中）
CROTCH_BACK = (77.5, -6.0)    # 臀縫底：兩邊臀部一路貼到這裡才接會陰
CHAIN = [(77.0, -4.2), (76.4, -2.0), (76.0, 0.4), (76.0, 2.8), (76.5, 5.0)]
LABIA_EDGE = [(1.0, 77.3, -4.6), (1.3, 76.8, -2.2), (1.6, 76.4, 0.4), (1.9, 76.5, 3.0), (2.1, 77.2, 5.4)]


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


def catmull_rom_closed(P, per=40):
    """封閉的向心 Catmull–Rom 曲線（不會在控制點之間打結、過衝），回傳密集取樣的點。"""
    P = np.asarray(P, float)
    n = len(P)
    out = []
    for i in range(n):
        p0, p1, p2, p3 = P[(i - 1) % n], P[i], P[(i + 1) % n], P[(i + 2) % n]
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5
        t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5
        t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5
        for t in np.linspace(t1, t2, per, endpoint=False):
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    return np.array(out)


def fractions(n, a=0.55):
    """各縱列在半圈上的弧長位置：兩端（正中的恥丘、臀縫）較密。"""
    u = np.linspace(0, 1, n)
    return u - a * np.sin(2 * np.pi * u) / (2 * np.pi)


def resample(C, f):
    """沿折線 C 依弧長比例 f 取點。"""
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(C, axis=0), axis=1))]
    s /= s[-1]
    return np.stack([np.interp(f, s, C[:, k]) for k in range(C.shape[1])], 1)


def front_handles(y):
    """骨盆截面前半的控制點（正前 → 側面），沿用已確認過的正面造型：下腹弧面、恥丘、鼠蹊溝。"""
    W, zf, zc, pf = curve(PROFILE['W'], y), curve(PROFILE['F'], y), curve(FRONT['zc'], y), curve(FRONT['pf'], y)
    belly, groin = curve(FRONT['belly'], y), curve(FRONT['groin'], y)
    mons = 0.35 * math.exp(-((y - 81.2) / 1.4) ** 2)
    gx = 3.0 + 8.5 * min(max((y - 79.0) / 13.0, 0.0), 1.0)
    base = zf - belly - mons

    def fz(x):
        u = min(x / W, 1.0)
        z = zc + (base - zc) * (1 - u ** pf) ** (1 / pf)
        z += belly * math.exp(-(x / (0.85 * gx)) ** 2) + mons * math.exp(-(x / 3.2) ** 2)
        return z - groin * math.exp(-((x - gx) / 1.3) ** 2)
    pts = [(u * W, fz(u * W)) for u in (0.0, 0.14, 0.28, 0.42, 0.56, 0.7, 0.82, 0.91)]
    return pts + [(W, zc)]


def back_handles(y):
    """骨盆截面後半的控制點（側面 → 臀縫）：外後方、臀的圓弧、臀縫。"""
    W, zc, B = curve(PROFILE['W'], y), curve(FRONT['zc'], y), curve(PROFILE['B'], y)
    xk, R, x_in, dc = curve(BACK['xk'], y), curve(BACK['R'], y), curve(BACK['x_in'], y), curve(BACK['cleft'], y)
    z0 = B + R                                   # 圓心；圓弧最後面的點剛好在 B
    a_in = -math.asin(min((xk - x_in) / R, 0.99))
    a_out = math.asin(min((0.78 * W - xk) / R, 0.97))
    arc = [(xk + R * math.sin(a), z0 - R * math.cos(a)) for a in np.linspace(a_out, a_in, 7)]
    lat = (0.5 * (W + arc[0][0]) + 0.35, 0.5 * (zc + arc[0][1]) - 0.6)   # 外後方：臀弧順到側面
    zin, zcl = arc[-1][1], B + dc
    cleft = [(0.4 * x_in, zin + 0.3 * (zcl - zin)), (0.0, zcl)]
    return [lat] + arc + cleft


def pelvis_section(y):
    """骨盆層的左半截面（正前 → 正後），N_HALF 點，回傳 (x, z)。"""
    half = front_handles(y) + back_handles(y)
    full = half + [(-x, z) for x, z in half[-2:0:-1]]          # 鏡像補右半，正中兩點共用
    C = catmull_rom_closed(full)
    k = len(half) - 1                                           # 正後（臀縫）在密集曲線上的位置
    C = C[: k * 40 + 1]
    S = resample(C, fractions(N_HALF))
    S[0, 0] = S[-1, 0] = 0.0
    d, yd, wd, xd, sd = BACK['dimple']
    back = S[:, 1] < curve(FRONT['zc'], y)
    S[back, 1] += d * math.exp(-((y - yd) / wd) ** 2) * np.exp(-((S[back, 0] - xd) / sd) ** 2)
    return S


def leg_curve(y, phis):
    """大腿截面上，方位角 phis（0° 正前、90° 外側、180° 正後、270° 內側）處的點 (x, z)。"""
    cx, cz = thigh_cx(y), curve(LEG['cz'], y)
    al = curve(PROFILE['W'], y) - cx
    bf = curve(PROFILE['F'], y) - cz
    bb = cz - curve(PROFILE['B'], y)
    mf, mb, pfm = curve(LEG['mf'], y), curve(LEG['mb'], y), curve(LEG['pfm'], y)
    out = []
    for phi in phis:
        s, c = math.sin(math.radians(phi)), math.cos(math.radians(phi))
        if s >= 0:
            a, p = al, (LEG_P['pfl'] if c >= 0 else LEG_P['pbl'])
        else:
            m = mb + (mf - mb) * min(max(0.5 + c, 0.0), 1.0)
            a, p = m, (pfm if c >= 0 else LEG_P['pbm'])
        x = cx + a * spow(s, 2 / p)
        z = cz + (bf if c >= 0 else bb) * spow(c, 2 / p)
        out.append((max(x, 0.1), z))
    return np.array(out)


def leg_ring(y, k):
    """第 k 圈腿圈：外弧（前內 → 外側 → 後內）N_HALF 點，對應骨盆半圈；內弧（後內 → 內側 → 前內）
    len(CHAIN) 點，對應會陰串。外弧上段依 torso 沿用骨盆截面的外圈，臀底才是從臀的圓弧換成大腿。"""
    f, b = LEG_P['phi_f'], LEG_P['phi_b']
    outer = resample(leg_curve(y, np.linspace(f, b, 400)), fractions(N_HALF))
    w = curve(LEG['torso'], y)
    if w > 0:
        T = pelvis_section(y)
        j = np.linspace(0, 1, N_HALF)
        wj = w * np.sin(np.pi * j)
        outer = wj[:, None] * T + (1 - wj[:, None]) * outer
    if k == 0:
        inner = [(x, z) for x, _, z in LABIA_EDGE]
        ys = [yy for _, yy, _ in LABIA_EDGE]
    else:
        inner = resample(leg_curve(y, np.linspace(b, f + 360, 200)), np.linspace(0, 1, len(CHAIN) + 2))[1:-1]
        ys = [y] * len(CHAIN)
    pts = [(x, y, z) for x, z in outer] + [(x, yy, z) for (x, z), yy in zip(inner, ys)]
    return pts


def cage():
    """左半籠的頂點與四邊形面（頂點座標用素體慣例）。"""
    V, F, rings = [], [], []
    for y in PELVIS_Y:
        rings.append(list(range(len(V), len(V) + N_HALF)))
        V += [(x, y, z) for x, z in pelvis_section(y)]
    last = rings[-1]
    V[last[0]] = (0.0, *CROTCH_FRONT)
    V[last[-1]] = (0.0, *CROTCH_BACK)
    for a, b in zip(rings, rings[1:]):
        for k in range(N_HALF - 1):
            F.append((a[k], a[k + 1], b[k + 1], b[k]))
    chain = list(range(len(V), len(V) + len(CHAIN)))
    V += [(0.0, y, z) for y, z in CHAIN]
    loops = [last + chain]
    for k, y in enumerate(LEG_Y):
        loops.append(list(range(len(V), len(V) + N_HALF + len(CHAIN))))
        V += leg_ring(y, k)
    for a, b in zip(loops, loops[1:]):
        n = len(a)
        for k in range(n):
            F.append((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    return np.array(V, float), F


def sharp_points():
    """擬合籠時差值不平滑、直接補的點（glute_scene.fit_cage 的 sharp）：會陰串與第一圈腿圈的內弧
    （大陰唇和大腿之間的摺）。這幾點是刻意做的小起伏，平滑過的差值補不到。索引和 cage() 的頂點順序一致。"""
    start = N_HALF * len(PELVIS_Y)
    ring0 = start + len(CHAIN)
    return np.array(list(range(start, ring0)) + list(range(ring0 + N_HALF, ring0 + N_HALF + len(CHAIN))))


def to_blender(p):
    p = np.asarray(p, float)
    return np.stack([p[..., 0], -p[..., 2], p[..., 1]], -1)


def to_body(p):
    p = np.asarray(p, float)
    return np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)


# ---------- 骨點（素體座標；左側，右側鏡像） ----------
LANDMARKS = {
    'iliacCrest': (FRAME['bicristal'] / 2, TARGET['iliocristale'], -1.5),
    'asis': (11.0, 91.5, 6.4),
    'psis': (4.2, 93.8, -9.0),
    'greaterTrochanter': (FRAME['hip_joint'][0] + 6.8, TARGET['trochanter'], -1.6),
    'hipJoint': (*FRAME['hip_joint'], 0.4),
    'ischialTuberosity': (5.6, 79.0, -6.0),
    'pubicSymphysis': (0.0, 82.2, 5.2),
    'coccyx': (0.0, 83.5, -8.2),
}


# ---------- 細部層：大陰唇中間的縫 ----------
# 大陰唇的體積在籠裡（作者 2026-10-27：不是另外加一塊，是恥丘往下捲進兩腿之間的延伸）：
# 恥丘最下方往內捲，第一圈腿圈內側的點（LABIA_RING）是捲下去的那段，正中的會陰串是它的下緣，
# 兩側直接順著接到大腿內側。細部層只刻中間那道縫：
# 正面是一道淺凹痕，往下到胯下兩片緊貼、只剩一條線，往後到會陰前漸淡。不做小陰唇、陰蒂等裡面的形。
# 縫沿著一條路徑（正中平面上，(高 y, 前後 z, 深度)）走，往路徑的內側壓；scale 隨脂肪量。
CLEFT = dict(
    path=[(80.6, 8.1, 0.0), (80.0, 7.9, 0.06), (79.5, 7.7, 0.18), (78.5, 7.2, 0.3), (77.5, 6.55, 0.32),
          (76.8, 5.85, 0.3), (76.4, 4.9, 0.25), (76.1, 3.5, 0.2), (76.0, 2.0, 0.12), (76.4, 0.3, 0.0)],
    # 縫的半寬隨深度：上端淺而寬，往下兩片貼緊、窄而清楚
    w=[(80.6, 0.8), (79.5, 0.7), (78.5, 0.6), (77.0, 0.5), (76.0, 0.45)],
)


# 恥丘與大陰唇的正面形（作者 2026-10-27）：從會陰繞過大陰唇下端、往上經過大陰唇和恥丘、到和下腹交界，
# 側影是「曲率不平均但同向」的一條弧，中間沒有凹進去再鼓出來的地方；正面看是一個往下收窄的圓三角，
# 兩側是腹股溝斜斜收過來的 V，下端是圓的（不是尖的），整塊是同一個東西。
# 參考：站姿正面看，大陰唇約 5 公分高、上寬約 5 公分、下端圓，縫幾乎貫穿；它是恥丘往下收窄的下端。
# 控制籠在這裡只有一兩個點寬，做不出這種形，所以在細分後的網格上直接「變形」成這個形（不是加一塊上去）：
# 正面朝前的點，前後位置換成下面描述的形，往範圍外漸漸接回原本的表面。
#   center：正中的側影 (高 y, 前後 z)；half：圓三角在各高度的半寬；drop：從正中到邊緣往後降多少；
#   groove：邊緣外腹股溝的深度。
# 目前 center 是中性型的絕對位置；脂肪線重跑前要改成相對於原本表面的位移，不然會把脂肪的增長壓回中性。
MOUND = dict(
    center=[(76.0, 4.7), (76.5, 5.55), (77.0, 6.15), (77.5, 6.6), (78.0, 7.0), (79.0, 7.5), (80.0, 7.88),
            (81.0, 8.17), (82.0, 8.38), (83.0, 8.52), (84.5, 8.6)],
    half=[(76.0, 1.7), (77.0, 1.9), (78.0, 2.5), (79.0, 3.2), (80.0, 4.0), (82.0, 5.4), (84.5, 7.5)],
    groove=[(76.0, 0.3), (78.0, 0.25), (80.0, 0.15), (82.0, 0.05), (83.0, 0.0)],
    top=84.0, bottom=77.6,   # bottom 以下（大陰唇往下、往後捲的那段）交給籠，隆起在這裡漸漸歸零
)


def mound(P, faces):
    """正面朝前的點變形成一個圓的隆起：每個高度的截面是 center − (center − 邊緣原本的高度)·u^2.2
    （u = |x| / half），正中剛好在 center 的側影上、邊緣剛好接回原本的表面（大腿與腹股溝），
    中間整片（含大陰唇兩側）都是同一個圓弧，不會只有正中鼓起。邊緣外再壓一道淺的腹股溝。"""
    P = np.array(P, float)
    M = MOUND
    N = vertex_normals(P, faces)
    x, y, z = np.abs(P[:, 0]), P[:, 1], P[:, 2]
    lo, hi = M['bottom'] - 1.2, M['top'] + 1.5
    sel = np.where((y > lo) & (y < hi) & (x < 10.0) & (z > 1.0) & (N[:, 2] > -0.3))[0]
    xs, ys, zs = x[sel], y[sel], z[sel]
    f = lambda k: np.array([curve(M[k], v) for v in ys])
    c, h, g = f('center'), f('half'), f('groove')
    # 各高度、離正中 half 處原本的前後位置（平滑的加權平均）
    yb = np.arange(lo - 0.2, hi + 0.21, 0.2)
    hb = np.array([curve(M['half'], v) for v in yb])
    front = (z > 1.0) & (N[:, 2] > 0.0)
    wb = np.exp(-((y[front][None, :] - yb[:, None]) / 0.6) ** 2 - ((x[front][None, :] - hb[:, None]) / 0.6) ** 2)
    eb = (wb * z[front][None, :]).sum(1) / np.maximum(wb.sum(1), 1e-9)
    for _ in range(4):   # 再沿高度平滑，網格一排排的取樣不在邊緣留下鋸齒
        eb[1:-1] = 0.25 * eb[:-2] + 0.5 * eb[1:-1] + 0.25 * eb[2:]
    edge = np.interp(ys, yb, eb)
    u = np.minimum(xs / h, 1.0)
    target = c - (c - edge) * u ** 2
    # 往邊緣漸漸換回原本的表面：(1 − u²)² 在 u = 1 時值與斜率都是 0，交界不出折線
    phi = (1 - u ** 2) ** 2
    ramp = lambda t: np.clip(t, 0, 1) ** 2 * (3 - 2 * np.clip(t, 0, 1))
    # 朝前的程度先在網格上平滑過再用：溝壁上相鄰頂點的法線一排排地跳動，直接用會在溝上留下鋸齒
    E = edges(faces)
    nz = N[:, 2].copy()
    for _ in range(15):
        acc, cnt = np.zeros(len(P)), np.zeros(len(P))
        np.add.at(acc, E[:, 0], nz[E[:, 1]]); np.add.at(acc, E[:, 1], nz[E[:, 0]])
        np.add.at(cnt, E[:, 0], 1); np.add.at(cnt, E[:, 1], 1)
        nz = 0.5 * nz + 0.5 * acc / np.maximum(cnt, 1)
    W = ramp((ys - lo) / 1.2) * ramp((hi - ys) / 1.5) * ramp((nz[sel] + 0.1) / 0.5)
    P[sel, 2] = zs + W * (phi * (target - zs) - g * np.exp(-((xs - h) / 0.9) ** 2))
    return P


def vertex_normals(P, faces):
    N = np.zeros_like(P)
    for f in faces:
        for i in range(1, len(f) - 1):
            n = np.cross(P[f[i]] - P[f[0]], P[f[i + 1]] - P[f[0]])
            N[[f[0], f[i], f[i + 1]]] += n
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


# 整體平滑（作者 2026-10-27：恥丘外移後和周圍的斷層、恥丘到大陰唇之間的凹、臀下的弧度都要順）：
# 胯下正面與臀下兩區，在細分後的網格上做 Taubin 平滑（一步往鄰點平均、一步往回推，體積不會一直縮），
# 消掉籠點與隆起層交界留下的小起伏；權重往區外漸漸歸零。中間的縫在平滑之後才刻，不會被抹掉。
FAIR = dict(iters=80, lam=0.5, mu=-0.53,
            # Taubin 套在整個模型上（只離上下切口遠一點），不畫方框：方框的邊會留下一圈明暗
            edge=(70.0, 97.0, 2.5),
            # 純拉普拉斯只在胯下與臀下：以中心往外平順地遞減（不是方框）
            relax_centers=[((0.0, 78.0, 4.0), 9.0), ((0.0, 77.5, -8.0), 10.0)],
            # 局部的小凹窩另外用純拉普拉斯平滑填平（會把凹的地方撐起來）：(|x|, y, z) 中心、半徑、次數
            spots=[],
            relax=dict(k=0.35, iters=25))


def edges(faces):
    E = set()
    for f in faces:
        for a, b in zip(f, list(f[1:]) + [f[0]]):
            E.add((min(a, b), max(a, b)))
    return np.array(sorted(E))


def fair(P, faces):
    P = np.array(P, float)
    F = FAIR
    E = edges(faces)
    cnt = np.zeros(len(P))
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    ramp = lambda t: np.clip(t, 0, 1) ** 2 * (3 - 2 * np.clip(t, 0, 1))
    x, y, z = np.abs(P[:, 0]), P[:, 1], P[:, 2]
    lo, hi, band = F['edge']
    w = ramp((y - lo) / band) * ramp((hi - y) / band)
    mid = np.abs(P[:, 0]) < 1e-6
    for _ in range(F['iters']):
        for k in (F['lam'], F['mu']):
            acc = np.zeros_like(P)
            np.add.at(acc, E[:, 0], P[E[:, 1]])
            np.add.at(acc, E[:, 1], P[E[:, 0]])
            P += (k * w)[:, None] * (acc / cnt[:, None] - P)
            P[mid, 0] = 0
    # 再用純拉普拉斯低權重平滑幾次：Taubin 保留中尺度的起伏（恥丘隆起邊緣的一圈、臀下的凹凸），這一步把它們抹順
    wr = np.zeros(len(P))
    for c, r in F['relax_centers']:
        d = np.linalg.norm(np.stack([x, y, z], 1) - np.array(c), axis=1)
        wr = np.maximum(wr, F['relax']['k'] * ramp(1 - d / r) * ramp((y - lo) / band))
    for _ in range(F['relax']['iters']):
        acc = np.zeros_like(P)
        np.add.at(acc, E[:, 0], P[E[:, 1]])
        np.add.at(acc, E[:, 1], P[E[:, 0]])
        P += wr[:, None] * (acc / cnt[:, None] - P)
        P[mid, 0] = 0
    for (cx, cy, cz), r, n in F['spots']:
        d = np.linalg.norm(np.stack([np.abs(P[:, 0]) - cx, P[:, 1] - cy, P[:, 2] - cz], 1), axis=1)
        ws = 0.5 * ramp(1 - d / r)
        for _ in range(n):
            acc = np.zeros_like(P)
            np.add.at(acc, E[:, 0], P[E[:, 1]])
            np.add.at(acc, E[:, 1], P[E[:, 0]])
            P += ws[:, None] * (acc / cnt[:, None] - P)
            P[mid, 0] = 0
    return P


def crotch_detail(P, faces=None, scale=1.0):
    """隆起與平滑之後刻縫。縫的截面是 (1 − |x|/w)²：正中最深，兩側是兩片圓鼓的大陰唇往中間收，
    不是在圓頂上刻一條細線；上端深度與寬度一起漸漸歸零，在恥丘上淡出。"""
    P = np.array(P, float)
    if faces is not None:
        P = fair(mound(P, faces), faces)
    pts = np.array(CLEFT['path'], float)
    t = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts[:, :2], axis=0), axis=1))]
    u = np.linspace(0, t[-1], 300)
    y, z, dep = (np.interp(u, t, pts[:, k]) for k in range(3))
    ty, tz = np.gradient(y), np.gradient(z)
    n = np.hypot(ty, tz)
    ny, nz = tz / n, -ty / n                   # 路徑朝外的法線（前段朝前、下段朝下）
    near = np.where((np.abs(P[:, 0]) < 1.2) & (P[:, 1] < y.max() + 0.5) & (P[:, 1] > y.min() - 2.0)
                    & (P[:, 2] > z.min() - 2.0))[0]
    Q = P[near]
    d2 = (Q[:, 1:2] - y[None]) ** 2 + (Q[:, 2:3] - z[None]) ** 2
    i = d2.argmin(1)
    out = (Q[:, 1] - y[i]) * ny[i] + (Q[:, 2] - z[i]) * nz[i]
    w = np.array([curve(CLEFT['w'], v) for v in y[i]])
    prof = np.clip(1 - np.abs(Q[:, 0]) / w, 0, None) ** 2
    g = dep[i] * scale ** 0.35 * prof * ((out > -0.5) & (out < 2.5))
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
