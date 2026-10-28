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
    # F 在 79 以上是正中（恥丘）的側影，和 CHAIN、CROTCH_FRONT 接成同一條弧；78 以下是大腿前側。
    'F': [(69.5, 7.2), (72, 7.3), (75, 7.4), (78, 7.6), (79.4, 7.66), (80.6, 8.0), (82, 8.36), (83, 8.5), (84.5, 8.6),
          (86, 8.6), (90, 8.1), (94, 7.6), (98, 6.9)],
    # 臀峰以下是一段圓弧（半徑約 8 公分）收到臀溝，不是飽滿到底再急轉：急轉會在臀底橫出一道硬摺
    'B': [(69.5, -9.5), (73, -10.0), (75, -10.5), (75.8, -10.75), (76.5, -11.05), (77.3, -11.8), (78.0, -12.3),
          (79.0, -12.9), (80.5, -13.45), (82.5, -13.7), (84.5, -13.35), (87, -12.15), (90, -10.6), (94, -8.6),
          (98, -7.4)],
}
# 骨盆截面的前半：zc 最寬處的前後位置；pf 前半的方圓程度（2 是橢圓）；belly 下腹弧面、groin 鼠蹊溝深度
FRONT = {
    'zc': [(79.2, -2.0), (83, -1.8), (90, -1.3), (98, -1.0)],
    'pf': [(79.2, 2.9), (82, 2.75), (86, 2.8), (90, 3.0), (94, 2.9), (98, 2.6)],
    'belly': [(77, 0.0), (79.5, 0.3), (82, 0.75), (86, 1.1), (90, 0.95), (93, 0.5), (96, 0.1), (98, 0.0)],
    'groin': [(76, 0.4), (79, 0.65), (84, 0.6), (89, 0.35), (92, 0.0)],
    # 恥丘下段溝底再加深一點：往下接大陰唇和大腿之間的摺（FOLD，約 0.7），溝深要一路漸增，
    # 不能在恥丘下緣突然變深（那會在大陰唇兩角勾一下）。只壓溝底附近，往恥丘那側收得窄，恥丘的弧不受影響。
    'groin_low': [(79.0, 0.42), (80.6, 0.22), (82.5, 0.05), (84.0, 0.0)],
    # 恥丘截面（鼠蹊溝以內）的方圓：2 是拋物線；下段稍飽，溝底加深（groin_low）時溝內側不會跟著塌
    'mons_p': [(79.0, 2.9), (80.6, 2.5), (82.5, 2.2), (84.0, 2.0)],
    # 恥丘正中的側影（往下接 CROTCH_FRONT、CHAIN）：每段斜率往下只增不減，是同一條同向彎的弧
    'mid': [(77.4, 6.5), (78.0, 7.0), (79.0, 7.5), (80.0, 7.88), (81.0, 8.17), (82.0, 8.38), (83.0, 8.52),
            (84.5, 8.6), (86.0, 8.6)],
}
# 骨盆截面的後半：每一邊臀是一段圓弧（圓心 (xk, B + R)、半徑 R），從臀縫旁（x_in）繞到外後方，
# 再順到側面；往上 R 變大、臀縫變淺，接到平的下背。cleft：臀縫從臀峰往前凹多深。
BACK = {
    'xk': [(76, 6.2), (79, 6.5), (83, 6.7), (87, 6.3), (91, 5.2), (95, 4.2), (98, 3.8)],
    'R': [(76, 5.5), (79, 6.6), (83, 7.2), (87, 8.0), (91, 10.5), (95, 14.0), (98, 16.0)],
    'x_in': [(77, 0.9), (85, 1.0), (92, 1.6), (98, 2.5)],
    'cleft': [(77.5, 6.0), (79, 5.0), (82, 4.2), (86, 3.2), (90, 1.8), (93, 0.7), (96, 0.0)],
    'dimple': (0.35, 94.5, 1.8, 4.2, 1.3),   # 腰窩（髂後上棘）：深度、高度、上下寬、離正中、左右寬
    'pl': [(76, 1.85), (79, 2.0), (83, 2.4), (90, 2.2), (98, 2.0)],   # 外側到臀峰那段的方圓（2 是橢圓，越大越飽）
}
# 大腿截面（繞著大腿軸 thigh_cx）：cz 中心的前後位置；mf、mb 前內側、後內側從大腿軸往內伸多遠
# （大腿本身的形；離正中的距離 = 大腿軸 − 這個量，由胯寬推出來，#63）；p* 各象限的方圓程度；
# torso：截面上段沿用骨盆截面外圈的比例（臀底在這幾層從臀的圓弧漸漸換成大腿）。
LEG = {
    'cz': [(69.5, -0.7), (73, -0.9), (75, -1.1), (78, -1.4)],
    # 大腿前側最前面的位置；鼠蹊溝外側的骨盆截面也用這個形（大腿往上捲進鼠蹊溝，不是在髖前面橫出一道凹）
    'front': [(69.5, 7.2), (72, 7.3), (75, 7.4), (78, 7.6), (81, 7.55), (84, 7.35), (87, 7.05), (90, 6.8)],
    'mf': [(69.5, 6.7), (73, 7.7), (75, 9.0), (78, 9.0)],
    'mb': [(69.5, 6.8), (73, 7.9), (75, 9.0), (76.5, 9.3), (78, 9.3)],
    'pfm': [(69.5, 2.2), (73, 2.3), (75, 2.6), (78, 2.7)],
    'torso': [(69.5, 0.0), (73.5, 0.0), (75.4, 0.12), (76.8, 0.45), (78.0, 0.85)],
    'torso_lat': [(69.5, 0.0), (72.0, 0.0), (73.8, 0.3), (75.4, 0.7), (76.8, 0.92), (78.0, 1.0)],
    'torso_front': [(69.5, 0.0), (76.8, 0.0), (78.0, 0.3)],
    # 後內側的方圓：臀縫正下方要方一點，兩腿後內側往正中靠，臀縫底下只露一個往下張開的小三角；
    # 太圓的話大腿後內側往前縮，臀縫底會張成一個圓的口（第十一版、重建版都看過）
    'pbm': [(69.5, 2.4), (73.0, 2.6), (75.4, 3.0), (76.8, 3.3), (78.0, 3.3)],
}
LEG_P = dict(pl=2.2, pfl=2.2, pbl=2.2, phi_f=-40.0, phi_b=235.0)

# ---------- 2. 層與拓撲 ----------
N_HALF = 29          # 骨盆半圈的點數（含正前、正後兩個正中點）
PELVIS_Y = [98.0, 96.0, 94.0, 92.0, 90.0, 88.0, 86.5, 85.0, 83.5, 82.0, 80.6, 79.4]
LEG_Y = [78.0, 76.8, 75.4, 73.8, 71.8, 69.5]
# 胯下：最後一層骨盆的正前、正後換成胯下正中的兩端；中間一串正中點（後 → 前）是會陰與大陰唇下緣，
# 把左右腿分開。第一圈腿圈內側的點是大陰唇和大腿之間的摺。
CROTCH_FRONT = (79.0, 7.5)    # (y, z) 恥丘往下收成大陰唇的地方（正中，在 FRONT['mid'] 上）
CROTCH_BACK = (77.0, -6.4)    # 臀縫底：兩邊臀部一路貼到這裡才接會陰
# 正中側影（會陰 → 大陰唇下端 → 恥丘）是一條同向彎的弧：往上每段的斜率只增不減（作者 2026-10-27）
CHAIN = [(76.8, -4.4), (76.4, -2.0), (76.0, 0.4), (75.9, 2.8), (76.2, 4.9), (77.4, 6.5)]
# 第一圈腿圈的內弧（後 → 前）：大陰唇和大腿之間的摺，往前、往上接鼠蹊溝。和最後一層骨盆＋會陰串的對應：
#   FOLD[0] ↔ 臀縫底（CROTCH_BACK）；FOLD[1..] ↔ 會陰串各點；最後三點 ↔ CROTCH_FRONT、恥丘第 2、3 列。
# 所以恥丘的縱列往下是接到大陰唇和它旁邊的摺，不是扭到大腿上（那會在恥丘下緣橫出一道摺）；
# 腿圈的外弧從大腿前內側開始，對應骨盆的第 4 列（鼠蹊溝底）。
FOLD = [(0.25, 77.2, -6.9), (0.85, 76.95, -4.8), (1.3, 76.8, -2.2), (1.6, 76.4, 0.4), (1.9, 76.4, 2.8), (2.1, 76.8, 4.9),
        (2.25, 77.2, 5.5), (2.45, 77.7, 5.85), (2.6, 78.0, 6.0), (2.8, 78.4, 6.1)]
FRONT_COLS = 3   # 骨盆最後一層前面幾列對到 FOLD 的尾端（恥丘的拋物線佔 0～2 列，第 3 列是鼠蹊溝底）
N_OUTER = N_HALF - FRONT_COLS - 1
N_INNER = len(CHAIN) + FRONT_COLS + 1


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


def groin_x(y):
    """鼠蹊溝（恥丘與大腿的交界）在高度 y 離正中多遠：從髂前上棘斜下來，到胯下接大陰唇和大腿之間的摺。"""
    return 3.0 + 8.5 * min(max((y - 79.0) / 13.0, 0.0), 1.0)


def front_z(y, x):
    """骨盆截面前半在 (y, x) 的前後位置：下腹弧面、恥丘、鼠蹊溝（沿用已確認過的正面造型）。"""
    W, zf, zc, pf = curve(PROFILE['W'], y), curve(PROFILE['F'], y), curve(FRONT['zc'], y), curve(FRONT['pf'], y)
    belly, groin = curve(FRONT['belly'], y), curve(FRONT['groin'], y)
    mons = 0.35 * math.exp(-((y - 81.2) / 1.4) ** 2)
    gx = groin_x(y)
    base = zf - belly - mons

    def fz(x):
        u = min(x / W, 1.0)
        z = zc + (base - zc) * (1 - u ** pf) ** (1 / pf)
        z += belly * math.exp(-(x / (0.85 * gx)) ** 2) + mons * math.exp(-(x / 3.2) ** 2)
        return z - groin * math.exp(-((x - gx) / 1.3) ** 2)

    # 恥丘往下收（作者 2026-10-27）：鼠蹊溝以內的截面是一段拋物線，從正中 F 降到溝底，
    # 寬度跟著鼠蹊溝往下變窄。同一個 x 往下看，拋物線越來越窄、越降越快，所以縱向也一路同向彎，
    # 恥丘下緣不會先平一段再掉下去（那會在恥丘和大陰唇之間橫出一道摺）。
    gate = min(max((86.0 - y) / 2.5, 0.0), 1.0)
    low = curve(FRONT["groin_low"], y) * math.exp(-((x - gx) / (1.0 if x >= gx else 0.45)) ** 2)
    return front_z_base(y, x, fz, gx, gate, zf) - low


def front_z_base(y, x, fz, gx, gate, zf):
    """front_z 去掉溝底加深的部分：溝外是大腿往上的延伸，溝內是恥丘的拋物線。"""
    if x >= gx:
        # 鼠蹊溝外下方是大腿往上的延伸：前面至少鼓到大腿前側的圓弧那麼前（溝的上方是下腹，不動）。
        # 溝在這個 x 經過的高度 gy：groin_x 的反函數。
        gy = 79.0 + (x - 3.0) * 13.0 / 8.5
        wt = min(max((gy + 1.5 - y) / 2.5, 0.0), 1.0) * min(max((92.0 - y) / 5.0, 0.0), 1.0)
        return fz(x) + wt * max(thigh_front_z(y, x) - fz(x), 0.0)
    if gate == 0:
        return fz(x)
    zm = curve(FRONT['mid'], y)
    para = zm - (zm - fz(gx)) * (x / gx) ** curve(FRONT['mons_p'], y)
    return fz(x) + gate * (para - fz(x))


def thigh_front_z(y, x):
    """大腿截面（leg_curve）前半在 x 處的前後位置；x 在大腿前內側之內回傳 -inf。"""
    C = leg_curve(y, np.linspace(-60.0, 90.0, 151))
    if x < C[:, 0].min() or x > C[:, 0].max():
        return -math.inf
    return float(np.interp(x, C[:, 0], C[:, 1]))


def front_handles(y):
    """骨盆截面前半的控制點（正前 → 側面）。前四點固定是 0、gx/3、2gx/3、gx（pelvis_section 讓籠的
    前四縱列正好落在這裡：溝底永遠在第 4 列上，不會斜斜穿過好幾列，細分後才不會在溝旁起伏）。"""
    W, zc, gx = curve(PROFILE['W'], y), curve(FRONT['zc'], y), groin_x(y)
    xs = [0.0, gx / 3, 2 * gx / 3, gx]
    xs += [x for x in sorted({gx + 1.0} | {u * W for u in (0.28, 0.42, 0.56, 0.7, 0.82, 0.91)}) if x > gx + 0.45]
    xs = [x for i, x in enumerate(xs) if i < 4 or x - xs[i - 1] > 0.45]
    return [(x, front_z(y, x)) for x in xs] + [(W, zc)]


def back_handles(y):
    """骨盆截面後半的控制點（側面 → 臀縫）。外側到臀峰是一段圓角的四分之一（超橢圓，指數 pl），
    臀峰往內是半徑 R 的圓弧捲進臀縫；兩段在臀峰都是水平切線，接起來整條都往外凸，只有臀縫凹。"""
    W, zc, B = curve(PROFILE['W'], y), curve(FRONT['zc'], y), curve(PROFILE['B'], y)
    xk, R, x_in, dc = curve(BACK['xk'], y), curve(BACK['R'], y), curve(BACK['x_in'], y), curve(BACK['cleft'], y)
    pl = curve(BACK['pl'], y)
    lat = []
    for t in np.radians([22.0, 40.0, 56.0, 70.0, 82.0]):          # 0 = 側面、90 = 臀峰
        lat.append((xk + (W - xk) * math.cos(t) ** (2 / pl), zc - (zc - B) * math.sin(t) ** (2 / pl)))
    a_in = math.asin(min((xk - x_in) / R, 0.99))
    arc = [(xk - R * math.sin(a), B + R - R * math.cos(a)) for a in np.linspace(0.0, a_in, 5)]
    zin, zcl = arc[-1][1], B + dc
    cleft = [(0.4 * x_in, zin + 0.3 * (zcl - zin)), (0.0, zcl)]
    return lat + arc + cleft


def pelvis_curve(y):
    """骨盆層左半的密集截面曲線（正前 → 正後），(x, z)。"""
    half = front_handles(y) + back_handles(y)
    full = half + [(-x, z) for x, z in half[-2:0:-1]]          # 鏡像補右半，正中兩點共用
    C = catmull_rom_closed(full)
    k = len(half) - 1                                           # 正後（臀縫）在密集曲線上的位置
    return C[: k * 40 + 1]


def pelvis_section(y):
    """骨盆層的左半截面（正前 → 正後），N_HALF 點，回傳 (x, z)。"""
    C = pelvis_curve(y)
    # 前四列在恥丘與鼠蹊溝的控制點上（front_handles），其餘依弧長分佈、溝外側與臀縫兩端較密
    rest = resample(C[120:], fractions(N_HALF - 3, 0.5))
    S = np.vstack([C[[0, 40, 80]], rest])
    S[0, 0] = S[-1, 0] = 0.0
    d, yd, wd, xd, sd = BACK['dimple']
    back = S[:, 1] < curve(FRONT['zc'], y)
    S[back, 1] += d * math.exp(-((y - yd) / wd) ** 2) * np.exp(-((S[back, 0] - xd) / sd) ** 2)
    return S


def ray_hit(C, c, d):
    """從 c 沿方向 d 的射線打到折線 C 的距離（打不到回傳 None）。"""
    A, B = C[:-1], C[1:]
    e = B - A
    den = d[0] * e[:, 1] - d[1] * e[:, 0]
    ok = np.abs(den) > 1e-12
    w = A - c
    t = np.where(ok, (w[:, 0] * e[:, 1] - w[:, 1] * e[:, 0]) / np.where(ok, den, 1), -1)
    u = np.where(ok, (w[:, 0] * d[1] - w[:, 1] * d[0]) / np.where(ok, den, 1), -1)
    hit = ok & (t > 0) & (u >= 0) & (u <= 1)
    return float(t[hit].min()) if hit.any() else None


def leg_curve(y, phis):
    """大腿截面上，方位角 phis（0° 正前、90° 外側、180° 正後、270° 內側）處的點 (x, z)。"""
    cx, cz = thigh_cx(y), curve(LEG['cz'], y)
    al = curve(PROFILE['W'], y) - cx
    bf = curve(LEG['front'], y) - cz
    bb = cz - curve(PROFILE['B'], y)
    mf, mb, pfm = curve(LEG['mf'], y), curve(LEG['mb'], y), curve(LEG['pfm'], y)
    out = []
    for phi in phis:
        s, c = math.sin(math.radians(phi)), math.cos(math.radians(phi))
        if s >= 0:
            a, p = al, (LEG_P['pfl'] if c >= 0 else LEG_P['pbl'])
        else:
            m = mb + (mf - mb) * min(max(0.5 + c, 0.0), 1.0)
            a, p = m, (pfm if c >= 0 else curve(LEG['pbm'], y))
        x = cx + a * spow(s, 2 / p)
        z = cz + (bf if c >= 0 else bb) * spow(c, 2 / p)
        out.append((max(x, 0.1), z))
    return np.array(out)


def toward_pelvis(y, pts, wts):
    """把大腿截面上的點沿「大腿軸 → 點」的方向，按權重往骨盆截面移（上段腿圈的臀底還是臀的圓弧）。
    沿射線混合而不是按順序混合：兩條曲線的取點方式不同，按順序混合會在臀底內側擠出一道凹。"""
    if not np.any(wts > 0):
        return pts
    C = pelvis_curve(y)
    c = np.array([thigh_cx(y), curve(LEG['cz'], y)])
    out = np.array(pts, float)
    for i, (p, w) in enumerate(zip(out, wts)):
        if w <= 0:
            continue
        d = p - c
        r = np.linalg.norm(d)
        hit = ray_hit(C, c, d / r)
        if hit is not None:
            out[i] = c + d / r * (r + w * (hit - r))
    return out


def leg_ring(y, k):
    """第 k 圈腿圈：外弧（大腿前內 → 外側 → 後內）N_OUTER 點，對應骨盆最後一層第 3 列到臀縫前一列；
    內弧（後 → 內側 → 前）N_INNER 點，第一圈是 FOLD，之後是大腿內側。上段腿圈依 torso 權重往骨盆截面靠，
    臀底才是從臀的圓弧換成大腿。"""
    f, b = LEG_P['phi_f'], LEG_P['phi_b']
    w = curve(LEG['torso'], y)
    phis = np.linspace(f, b, 400)
    outer = resample(np.c_[leg_curve(y, phis), phis], fractions(N_OUTER))
    outer, phi = outer[:, :2], outer[:, 2]
    # 外側（大轉子那一面）比前後更早換成骨盆的形：臀溝只在後面、往外側漸淡，不橫切整個臀底
    # 前內側（恥丘旁）反過來比較晚換：大腿前內側要往正中後縮，大陰唇和大腿的交界才是斜下的 V，
    # 不然骨盆截面的寬平前面會一路延到胯下，交界變成一條橫線。
    wl, wf = curve(LEG['torso_lat'], y), curve(LEG['torso_front'], y)
    ramp = lambda t: (lambda c: c * c * (3 - 2 * c))(np.clip(t, 0, 1))
    side = ramp((phi - 20.0) / 30.0) * ramp((170.0 - phi) / 60.0)
    front = 1 - ramp((phi + 10.0) / 50.0)
    wts = w + (max(wl, w) - w) * side
    wts = wts + (min(wf, w) - wts) * front
    outer = toward_pelvis(y, outer, wts)
    if k == 0:
        inner = [(x, z) for x, _, z in FOLD]
        ys = [yy for _, yy, _ in FOLD]
    else:
        inner = resample(leg_curve(y, np.linspace(b, f + 360, 200)), np.linspace(0, 1, N_INNER + 2))[1:-1]
        taper = np.cos(np.linspace(0, np.pi, N_INNER + 2)[1:-1]) ** 2     # 兩端接外弧，正內側不動
        inner = toward_pelvis(y, inner, w * taper)
        ys = [y] * N_INNER
    return [(x, y, z) for x, z in outer] + [(x, yy, z) for (x, z), yy in zip(inner, ys)]


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
    for i, (a, b) in enumerate(zip(loops, loops[1:])):
        n = len(a)
        s = FRONT_COLS if i == 0 else 0      # 骨盆＋會陰串那一圈和第一圈腿圈錯開 FRONT_COLS 個對應（見 FOLD）
        for k in range(n):
            F.append((a[k], a[(k + 1) % n], b[(k + 1 - s) % n], b[(k - s) % n]))
    return np.array(V, float), F


def sharp_points():
    """擬合籠時差值不平滑、直接補的點（glute_scene.fit_cage 的 sharp）：胯下正中兩端、會陰串與第一圈腿圈的內弧
    （大陰唇和大腿之間的摺、往上接的鼠蹊溝）。這幾點是刻意做的小起伏，平滑過的差值補不到。索引和 cage() 的頂點順序一致。"""
    start = N_HALF * len(PELVIS_Y)
    ring0 = start + len(CHAIN)
    front, back = start - N_HALF, start - 1          # 最後一層骨盆換成胯下兩端的那兩點
    return np.array([front, back] + list(range(start, ring0)) + list(range(ring0 + N_OUTER, ring0 + N_OUTER + N_INNER)))


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
# 恥丘的拋物線截面往下收窄（front_z），正中的會陰串是它的下緣，FOLD 是它和大腿之間的摺。
# 細部層只刻中間那道縫：
# 正面是一道淺凹痕，往下到胯下兩片緊貼、只剩一條線，往後到會陰前漸淡。不做小陰唇、陰蒂等裡面的形。
# 縫沿著一條路徑（正中平面上，(高 y, 前後 z, 深度)）走，往路徑的內側壓；scale 隨脂肪量。
CLEFT = dict(
    path=[(80.6, 8.1, 0.0), (80.0, 7.9, 0.05), (79.5, 7.7, 0.14), (78.5, 7.2, 0.22), (77.5, 6.55, 0.25),
          (76.8, 5.85, 0.25), (76.4, 4.9, 0.22), (76.1, 3.5, 0.18), (76.0, 2.0, 0.1), (76.4, 0.3, 0.0)],
    # 縫的半寬隨深度：上端淺而寬，往下兩片貼緊、窄而清楚
    # 細分後大陰唇正面的頂點間距約 0.5～0.8 公分，縫要比這寬才刻得出一道順的凹，不會刻成一排排的線
    w=[(80.6, 1.2), (79.5, 1.15), (78.5, 1.1), (77.0, 1.0), (76.0, 0.9)],
)


def crotch_detail(P, scale=1.0):
    """在細分後的網格上刻大陰唇中間的縫。縫的截面是 (1 − |x|/w)²：正中最深，兩側是兩片圓鼓的大陰唇往中間收，
    不是在圓頂上刻一條細線；上端深度與寬度一起漸漸歸零，在恥丘上淡出。
    恥丘與大陰唇的體積、輪廓都在籠裡（front_z、CHAIN、FOLD），這裡不再另外變形或平滑。"""
    P = np.array(P, float)
    pts = np.array(CLEFT['path'], float)
    # 路徑先貼到網格的正中線上（籠改了，表面的位置跟著變，路徑不貼上去，縫的深淺就會隨位置亂跳）
    mid = P[(np.abs(P[:, 0]) < 1e-6) & (P[:, 1] < pts[:, 0].max() + 1.0) & (P[:, 2] > pts[:, 1].min() - 1.0)]
    for i, (py, pz, _) in enumerate(pts):
        j = np.argmin((mid[:, 1] - py) ** 2 + (mid[:, 2] - pz) ** 2)
        pts[i, :2] = mid[j, 1:]
    t = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts[:, :2], axis=0), axis=1))]
    u = np.linspace(0, t[-1], 300)
    y, z, dep = (np.interp(u, t, pts[:, k]) for k in range(3))
    for _ in range(20):                         # 貼上去的折線順一順
        y[1:-1] = 0.5 * y[1:-1] + 0.25 * (y[:-2] + y[2:])
        z[1:-1] = 0.5 * z[1:-1] + 0.25 * (z[:-2] + z[2:])
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
    near_path = np.clip(1.5 - np.abs(out) / 0.6, 0, 1)   # 離路徑（表面正中）越遠越淡，不是一刀切
    g = dep[i] * scale ** 0.35 * prof * near_path
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
