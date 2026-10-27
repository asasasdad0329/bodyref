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


# ---------- 1. 側影曲線與截面參數 ----------
# 先定三條側影曲線（隨高度 y 平滑變化），每一層截面都從曲線取值，骨盆圈和腿圈接在同一條曲線上，
# 交界才不會凹一圈。W 外側（半寬）；F 正前（骨盆是正中，腿是大腿前側）；B 正後（臀峰、往下接大腿後側）。
PROFILE = {
    'W': [(69.5, 17.1), (72, 17.45), (75, 17.8), (78, 17.85), (80.5, 17.85), (83, 17.8), (86, 17.4), (90, 16.5),
          (94, 15.2), (98, 13.9)],
    'F': [(69.5, 7.2), (72, 7.3), (75, 7.4), (78, 7.6), (80, 8.05), (83, 8.55), (86, 8.6), (90, 8.1), (94, 7.6), (98, 6.9)],
    'B': [(69.5, -9.5), (73, -10.0), (75, -10.7), (76.5, -11.6), (78.5, -12.75), (80.5, -13.3), (82.5, -13.55),
          (84.5, -13.35), (87, -12.15), (90, -10.6), (94, -8.6), (98, -7.4)],
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
# 腿圈（左腿）：中心 (cx, cz)，cx 是 None 時落在大腿軸上（thigh_cx）；外側、前、後由側影曲線決定；bulge 臀下半往後的量；
# fold 臀溝：後內側往前、往上收（淺，只在內側）；torso 沿用骨盆截面外圈的比例；pfm 前內側的方圓程度；
# 內側：mf 前內側、mb 後內側從大腿軸往內伸多遠（大腿本身的形）；離正中的距離 = 大腿軸 − 這個量，由胯寬推出來。胯下內側的幾點另外指定（LABIA_RING、FOLD_RING、THIGH_FRONT），
# 大腿內側不貼到正中：大陰唇下方先貼著，往下漸漸張開成倒 V 的空隙（站直、腿不夾時；作者 2026-10-27）。
# 第二圈（高 75）前內側較方（pfm 大）：大陰唇正下方的大腿前內側要飽滿，大陰唇下緣兩側才不會露出往後退的暗角。
LEGS = [
    dict(y=77.0, cx=None, cz=-1.3, bulge=0.3, fold=0.08, torso=0.75, mf=8.6, mb=8.7, pfm=2.6),
    dict(y=75.0, cx=None, cz=-1.1, bulge=0.0, fold=0.0, torso=0.5, mf=9.0, mb=8.7, pfm=3.0),
    dict(y=73.0, cx=None, cz=-0.9, bulge=0.0, fold=0.0, torso=0.2, mf=7.7, mb=7.8, pfm=2.4),
    dict(y=69.5, cx=None, cz=-0.7, bulge=0.0, fold=0.0, torso=0.0, mf=6.7, mb=6.8, pfm=2.0),
]
LEG_P = dict(pl=2.4, pfl=2.2, pbl=2.2, pm=2.3, pbm=3.0)
TORSO_BLEND_POW = 1.0   # 腿圈上段沿用骨盆截面的比例，往前內、後內兩端漸弱的快慢（大，胯下兩側才不會出方角）
# 籠在骨盆圈上的取樣（左半 17 點）：正面用固定的 x 比例取 8 點（下腹、鼠蹊、恥丘需要較密），
# 外側到後方用角度取 6 點，臀縫兩側用固定的 x 取 3 點。
FRONT_U = [0.0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84]
TORSO_T = [72, 90, 106, 122, 138, 154]
BACK_X = [3.4, 1.1, 0.0]
# 胯下：最後一層的正前、正後換成會陰的位置；中間一串正中頂點（後 → 前）把左右腿分開。
CROTCH_FRONT = (79.0, 7.55)   # (y, z) 恥丘往大陰唇的過渡（正中）
CROTCH_BACK = (77.5, -6.0)   # 臀縫底（肛門附近）：兩邊臀部一路貼到這裡才接會陰
CROTCH_CHEEK = (0.6, 78.3, -11.2)   # 最後一圈臀縫旁的點：兩邊臀部往正中貼，不在臀縫底下留一個凹洞
CHAIN = [(76.5, -3.4), (75.8, 1.5), (76.1, 5.1)]   # 會陰 → 大陰唇下緣最低處 → 大陰唇前下
# 胯下內側四個方位角（前內 −50°、內前 290°、正內 268°、內後 245°）的點另外指定，不用腿圈公式（LABIA_RING）：
# 這幾點是大陰唇和大腿之間的摺（腹股溝往下的延伸），大陰唇本身由正中的點（恥丘下緣、會陰串）撐起來，
# 所以大陰唇是恥丘往下收窄的一整塊（作者 2026-10-27：兩片貼合、不是加上去的一塊、直接接在恥丘上），
# 中間的縫由細部層刻。試過讓這幾點本身當大陰唇：大陰唇和大腿之間只剩一條籠邊，做不出摺，正面看是一圈拱門。
# 試過把第二圈（高 75）的同幾點往上提成股生殖摺（FOLD_RING）：兩側上端出現鉤角，所以目前不用（留空）。
LABIA_RING = {-50.0: (2.1, 77.3, 5.6), 290.0: (1.6, 76.4, 3.8), 268.0: (1.3, 76.1, 0.8), 245.0: (0.9, 76.8, -2.6)}
FOLD_RING = {}
# 第二圈（高 75）這幾個方位角的點也直接補差值：大陰唇正下方的大腿前內側要飽滿，平滑過的差值會把它收回去，
# 正面看大陰唇下緣兩側就會露出一條往後退的暗帶
SHARP_RING1 = (-50.0, -37.1)
# 其他腿圈點的個別指定 {腿圈序號: {方位角: 座標}}：第一圈的後內側（222°、210°）往正中收、往後，
# 兩邊臀部的下內側一路貼到會陰（作者：屁股會接合回會陰），臀縫底下只露出小三角，不是一大片橫向的暗區；
# 臀的下內側也要垂得夠低，臀溝從正中往外是先往下再往上的弧，不是從臀縫底往外往上斜的一片暗。
# 大腿內前側不另外指定：腿圈公式在 pfm 約 2 時接近橢圓，本身是圓的；另外指定反而做出一道角。
THIGH_FRONT = {0: {222.0: (1.6, 76.5, -10.6), 210.0: (3.5, 76.7, -11.5)}}
# 腹股溝往下收成 V 字（作者 2026-10-27 參考圖）：恥丘下段往下收窄成大陰唇，兩側的腹股溝斜斜收到大陰唇旁，
# 中間沒有橫向的界線。{骨盆圈高度: {正面取樣序號: 前後位移}}，序號 2 約在離正中 4 公分。
GROIN_DZ = {79.2: {2: -0.6}, 81.0: {2: -0.3}}
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
    y0, cz = L['y'], L['cz']
    cx = thigh_cx(y0) if L['cx'] is None else L['cx']
    al = curve(PROFILE['W'], y0) - cx
    bf = curve(PROFILE['F'], y0) - cz
    back = lambda phi: math.exp(-((phi - 200) / 25) ** 2)
    fold = lambda phi: math.exp(-((phi - 208) / 30) ** 2)  # 往外緩緩漸淡，不收成三角形
    # 正後（182°）落在側影曲線 B 上
    bb = cz - curve(PROFILE['B'], y0) - L['bulge'] * back(182) + L['fold'] * fold(182)
    pts = []
    for phi in LEG_PHI:
        s, c = math.sin(math.radians(phi)), math.cos(math.radians(phi))
        m = L['mb'] + (L['mf'] - L['mb']) * min(max(0.5 + c, 0.0), 1.0)   # 往內側伸多遠（大腿本身的形）
        gap = max(cx - m, 0.1)                                         # 離正中的距離由胯寬推出來
        a, p = (al, LEG_P['pl']) if s >= 0 else (cx - gap, LEG_P['pm'])
        if s >= 0 and c < 0:
            p = LEG_P['pbl']  # 後外側較圓，臀下半才不會在外側鼓出一圈
        if s >= 0 and c >= 0:
            p = LEG_P['pfl']  # 前外側較圓，大腿前外側才不會比胯飽滿，正面不出橫溝
        if s < 0 and c >= 0:
            p = L['pfm']      # 前內側（內收肌）往正中填
        if s < 0 and c < 0:
            p = LEG_P['pbm']  # 後內側較方：大腿後內側在臀縫正下方要飽滿，不然兩腿之間的臀下會凹一個口
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
            w = L['torso'] * math.sin(math.pi * j / n) ** TORSO_BLEND_POW
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
    if CROTCH_CHEEK:
        V[last[-2]] = CROTCH_CHEEK
    for a, b in zip(rings, rings[1:]):
        for k in range(len(a) - 1):
            F.append((a[k], a[k + 1], b[k + 1], b[k]))
    chain = list(range(len(V), len(V) + len(CHAIN)))
    V += [(0.0, y, z) for y, z in CHAIN]
    loops = [last + chain]
    legs = [leg_ring(L) for L in LEGS]
    for k, phi in enumerate(LEG_PHI):
        if round(phi, 1) in LABIA_RING:
            legs[0][k] = LABIA_RING[round(phi, 1)]
        if round(phi, 1) in FOLD_RING:
            legs[1][k] = FOLD_RING[round(phi, 1)]
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
    # 腹股溝在骨盆最下兩圈的位置：恥丘兩側往內凹（籠點的 x 取樣跨過溝，截面公式的溝深會被抹平）
    for r, pts in GROIN_DZ.items():
        for j, dz in pts.items():
            V[rings[TORSO_Y.index(r)][j], 2] += dz
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
    keep[last[0]] = True   # 恥丘下緣（正中）：恥丘到大陰唇的側影是一條同向的弧，不能被鬆弛拉凹
    keep[[loops[1][k] for k, phi in enumerate(LEG_PHI) if round(phi, 1) in LABIA_RING]] = True
    keep[[loops[2][k] for k, phi in enumerate(LEG_PHI) if round(phi, 1) in FOLD_RING]] = True
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
    """擬合籠時差值不平滑、直接補的點（glute_scene.fit_cage 的 sharp）：會陰串、第一圈腿圈的大陰唇點、第二圈的 SHARP_RING1。
    股生殖摺的點不用：直接補會在摺的前端出尖角。
    這幾點是刻意做的小起伏，平滑過的差值補不到。索引和 cage() 的頂點順序一致。"""
    start = (len(FRONT_U) + len(TORSO_T) + len(BACK_X)) * len(TORSO_Y)
    ring = start + len(CHAIN)
    n = len(LEG_PHI)
    return np.array(list(range(start, ring)) + [ring + k for k, phi in enumerate(LEG_PHI) if round(phi, 1) in LABIA_RING]
                    + [ring + n + k for k, phi in enumerate(LEG_PHI) if round(phi, 1) in SHARP_RING1])


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
            spots=[((2.4, 77.0, 5.3), 2.0, 60), ((1.9, 76.4, 3.8), 1.5, 40),
                   ((4.2, 75.9, -10.0), 2.2, 60), ((1.3, 77.6, -8.6), 1.6, 40)],
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
