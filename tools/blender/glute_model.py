"""臀的獨立模（DECISIONS #57、#59）：在 Blender 裡從零建臀部區，和素體無關。

blender -b -noaudio --python tools/blender/glute_model.py -- <輸出資料夾>

範圍：髂嵴（下腰）到臀溝下方約 6 公分的大腿根，前後左右一整圈；不含腰背、不到大腿中段。
做法（一般的角色建模流程）：
1. 只建左半邊的低面數控制籠（cage），由一層層的水平截面組成。先定外側、正前、正後三條側影曲線，
   每層截面從曲線取值，形狀參數也沿高度平滑內插（PROFILE、SHAPE、LEGS）。
   上半是一個圈（骨盆），到胯下分成兩條腿的圈；兩腿之間用一串正中頂點（會陰）接起來。
2. 鏡像修改器補右半邊（正中頂點合併），細分曲面修改器（Catmull-Clark）把籠變成平滑曲面。
   細分會把籠往內收，所以籠先反覆往外補差值，讓曲面接近設計的截面（fit_cage）。
   籠和修改器都保留在 .blend 裡，之後可以直接在 Blender 介面裡調點。
3. 中性型就是籠的基本形（形狀鍵 basis）；之後的變形線做成籠上的形狀鍵。
4. 骨點（髂嵴、髂前上棘、髂後上棘、大轉子、恥骨聯合、坐骨結節、尾骨、髖關節）另外記錄，
   是之後變形線（骨架線）和素體控制共用的座標框架。
5. 量臀圍、寬、厚與大腿圍，用 Eevee 算灰模多視圖。

尺寸：台灣年輕女性中位數 160 cm、臀圍約 92.5（research-taiwan.md），各部位的高度與寬厚
用 ANSUR II 女性對身高、臀圍的迴歸推到這個體型（見 01-glute.md 的「尺寸」）。
座標用素體的慣例：公分、y 向上（離地高度）、z 向前、x 向左；Blender 裡是 (x, −z, y)。
"""
import json
import math
from pathlib import Path
import sys

import bpy
import numpy as np

OUT = Path(sys.argv[sys.argv.index('--') + 1]) if '--' in sys.argv else Path('.')
OUT.mkdir(parents=True, exist_ok=True)

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
# 腿圈（左腿）：中心 (cx, cz)；外側、前、後由側影曲線決定，內側離正中 gap（往下漸寬，大腿內側是圓的）；
# bulge 臀下半往後的量；fold 臀溝：後內側往前、往上收（淺，只在內側）；torso 沿用骨盆截面外圈的比例；
# pfm 前內側的方圓程度（大於 2 就往正中填）。
LEGS = [
    dict(y=77.0, cx=8.0, cz=-1.3, bulge=0.6, fold=0.08, torso=0.75, gap=0.15, pfm=3.1),
    dict(y=75.0, cx=8.0, cz=-1.1, bulge=0.0, fold=0.3, torso=0.5, gap=0.25, pfm=2.9),
    dict(y=73.0, cx=7.9, cz=-0.9, bulge=0.0, fold=0.1, torso=0.2, gap=0.55, pfm=2.6),
    dict(y=69.5, cx=7.8, cz=-0.7, bulge=0.0, fold=0.0, torso=0.0, gap=0.8, pfm=2.4),
]
LEG_P = dict(pl=2.4, pfl=2.2, pbl=2.2, pm=2.3)
# 籠在骨盆圈上的取樣（左半 17 點）：正面用固定的 x 比例取 8 點（下腹、鼠蹊、恥丘需要較密），
# 外側到後方用角度取 6 點，臀縫兩側用固定的 x 取 3 點。
FRONT_U = [0.0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84]
TORSO_T = [72, 90, 106, 122, 138, 154]
BACK_X = [3.4, 1.1, 0.0]
# 胯下：最後一層的正前、正後換成會陰的位置；中間一串正中頂點（後 → 前）把左右腿分開。
CROTCH_FRONT = (79.0, 7.0)   # (y, z) 恥骨聯合下緣
CROTCH_BACK = (80.2, -5.2)   # 臀縫底
CHAIN = [(78.4, -3.0), (76.8, 1.2), (76.4, 5.3)]
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
    al, am = curve(PROFILE['W'], y0) - cx, cx - L['gap']
    bf = curve(PROFILE['F'], y0) - cz
    back = lambda phi: math.exp(-((phi - 200) / 25) ** 2)
    fold = lambda phi: math.exp(-((phi - 208) / 30) ** 2)  # 往外緩緩漸淡，不收成三角形
    # 正後（182°）落在側影曲線 B 上
    bb = cz - curve(PROFILE['B'], y0) - L['bulge'] * back(182) + L['fold'] * fold(182)
    pts = []
    for phi in LEG_PHI:
        s, c = math.sin(math.radians(phi)), math.cos(math.radians(phi))
        a, p = (al, LEG_P['pl']) if s >= 0 else (am, LEG_P['pm'])
        if s >= 0 and c < 0:
            p = LEG_P['pbl']  # 後外側較圓，臀下半才不會在外側鼓出一圈
        if s >= 0 and c >= 0:
            p = LEG_P['pfl']  # 前外側較圓，大腿前外側才不會比胯飽滿，正面不出橫溝
        if s < 0 and c >= 0:
            p = L['pfm']      # 前內側（內收肌）往正中填，兩腿在胯下會合成窄的尖角，不留平頂的拱
        x = cx + a * spow(s, 2 / p)
        z = cz + (bf if c >= 0 else bb) * spow(c, 2 / p)
        z += -L['bulge'] * back(phi) + L['fold'] * fold(phi)
        y = y0 + 0.5 * L['fold'] * fold(phi)
        pts.append((max(x, L['gap']), y, z))
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
    for L in LEGS:
        loops.append(list(range(len(V), len(V) + len(LEG_PHI))))
        V += leg_ring(L)
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
    for c, r in RELAX:
        w = 0.6 * np.clip(1 - np.linalg.norm(V - np.array(c), axis=1) / r, 0, 1)
        for _ in range(4):
            avg = np.array([V[n].mean(0) for n in nb])
            mid = V[:, 0] == 0
            V += w[:, None] * (avg - V)
            V[mid, 0] = 0
    return V, F


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

# ---------- 2. 建物件 ----------
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
Vc, Fc = cage()
me = bpy.data.meshes.new('glute_cage')
me.from_pydata(to_blender(Vc).tolist(), [], Fc)
me.update()
obj = bpy.data.objects.new('glute', me)
bpy.context.scene.collection.objects.link(obj)
# 法線朝外：籠的面向和「離中軸的方向」平均要同號，不然整個翻面
cen = np.array([p.center[:] for p in me.polygons])
nor = np.array([p.normal[:] for p in me.polygons])
axis = np.zeros_like(cen)
axis[:, 2] = cen[:, 2]
if ((cen - axis) * nor).sum(1).mean() < 0:
    for p in me.polygons:
        p.flip()
    me.update()
for p in me.polygons:
    p.use_smooth = True

mirror = obj.modifiers.new('mirror', 'MIRROR')
mirror.use_axis = (True, False, False)
mirror.use_clip = True
mirror.use_mirror_merge = True
mirror.merge_threshold = 0.01
subd = obj.modifiers.new('subd', 'SUBSURF')
subd.levels = subd.render_levels = 3
subd.boundary_smooth = 'PRESERVE_CORNERS'



def smooth(d, it=4):
    nb = [[] for _ in Vc]
    for f in Fc:
        for a, b in zip(f, f[1:] + f[:1]):
            nb[a].append(b)
            nb[b].append(a)
    for _ in range(it):
        d = np.array([0.5 * d[i] + 0.5 * d[n].mean(0) for i, n in enumerate(nb)])
    return d


def fit_cage(rounds=8):
    """細分會把凸的籠往內收（約 5%），所以反覆把籠往外補差值，讓曲面的尺寸接近設計的截面。
    差值先在籠上平滑過再補，只補大尺寸，不追細節，避免臀縫、臀溝附近起波紋。
    Blender 細分後的前 n 個頂點就是籠頂點的對應位置。"""
    dg = bpy.context.evaluated_depsgraph_get()
    C = Vc.copy()
    for _ in range(rounds):
        for v, co in zip(me.vertices, to_blender(C)):
            v.co = co
        me.update()
        dg.update()
        ev = obj.evaluated_get(dg)
        m = ev.to_mesh()
        S = to_body(np.array([v.co[:] for v in m.vertices[:len(Vc)]]))
        ev.to_mesh_clear()
        err = Vc - S
        C += smooth(err)
        C[np.abs(Vc[:, 0]) < 1e-6, 0] = 0  # 正中頂點留在正中，鏡像才會合併
    print('籠擬合殘差（公分）', round(float(np.abs(err).max()), 3))
    return C


Vc_cage = fit_cage()
obj.shape_key_add(name='basis')

for name, p in LANDMARKS.items():
    for s, tag in ((1, 'L'), (-1, 'R')):
        if p[0] == 0 and s < 0:
            continue
        e = bpy.data.objects.new(f'{name}{tag if p[0] else ""}', None)
        e.empty_display_size = 1.0
        e.location = to_blender((s * p[0], p[1], p[2]))
        bpy.context.scene.collection.objects.link(e)


# ---------- 3. 求值與量測 ----------
def evaluated():
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    m = ev.to_mesh()
    P = to_body(np.array([v.co[:] for v in m.vertices]))
    E = np.array([e.vertices[:] for e in m.edges])
    F = [p.vertices[:] for p in m.polygons]
    ev.to_mesh_clear()
    return P, E, F


def hull_perimeter(pts):
    pts = sorted(set(map(tuple, np.round(pts, 4))))
    if len(pts) < 3:
        return 0.0

    def half(seq):
        h = []
        for p in seq:
            while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (p[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0]) <= 0:
                h.pop()
            h.append(p)
        return h
    hull = half(pts)[:-1] + half(pts[::-1])[:-1]
    hull = np.array(hull + hull[:1])
    return float(np.linalg.norm(np.diff(hull, axis=0), axis=1).sum())


def section(P, E, y):
    a, b = P[E[:, 0]], P[E[:, 1]]
    m = (a[:, 1] - y) * (b[:, 1] - y) < 0
    t = (y - a[m, 1]) / (b[m, 1] - a[m, 1])
    q = a[m] + (b[m] - a[m]) * t[:, None]
    return q[:, [0, 2]]


def measure(P, E):
    out = {}
    for y in np.arange(70.0, 98.01, 0.5):
        s = section(P, E, y)
        if len(s):
            out[round(float(y), 1)] = dict(circ=hull_perimeter(s), breadth=float(np.ptp(s[:, 0])),
                                          depth=float(np.ptp(s[:, 1])), front=float(s[:, 1].max()), back=float(s[:, 1].min()))
    hipY = max(out, key=lambda y: out[y]['circ'] if 78 <= y <= 90 else 0)
    thighY = 72.5
    s = section(P, E, thighY)
    res = dict(hipCirc=out[hipY]['circ'], hipCircY=hipY, hipBreadth=max(v['breadth'] for v in out.values()),
               buttockDepth=out[hipY]['depth'], mostPosteriorY=min(out, key=lambda y: out[y]['back']),
               thighCirc=hull_perimeter(s[s[:, 0] > 0]), topCirc=out[98.0]['circ'] if 98.0 in out else None)
    return res, out


P, E, F = evaluated()
res, prof = measure(P, E)
res = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in res.items()}
print('量測', json.dumps(res, ensure_ascii=False))
print('目標', json.dumps(TARGET, ensure_ascii=False))
(OUT / 'glute_measure.json').write_text(json.dumps(dict(measure=res, target=TARGET, profile=prof), ensure_ascii=False, indent=1))
np.savez(OUT / 'glute_model.npz', design=Vc, cage=Vc_cage, positions=P, faces=np.array([f for f in F], dtype=np.int32),
         landmarks=json.dumps(LANDMARKS))
bpy.ops.wm.save_as_mainfile(filepath=str((OUT / 'glute_model.blend').resolve()))

# ---------- 4. 算圖 ----------
# 灰模：淺灰背景、中灰霧面材質、大面積柔光（主光在視角左上方，對側補光），加環境光遮蔽，
# 起伏靠柔和的明暗讀，不靠硬投影
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x, scene.render.resolution_y = 900, 900
scene.view_settings.view_transform = 'Standard'
if hasattr(scene.eevee, 'use_gtao'):
    scene.eevee.use_gtao = True
world = scene.world or bpy.data.worlds.new('world')
scene.world = world
world.use_nodes = True
# 環境光用淺灰；相機看到的背景另外用較深的灰，讓輪廓和背景分得開
nt = world.node_tree
amb = nt.nodes['Background']
amb.inputs[0].default_value = (0.62, 0.62, 0.62, 1)
amb.inputs[1].default_value = 0.55
bg = nt.nodes.new('ShaderNodeBackground')
bg.inputs[0].default_value = (0.16, 0.16, 0.16, 1)
path = nt.nodes.new('ShaderNodeLightPath')
mix = nt.nodes.new('ShaderNodeMixShader')
nt.links.new(path.outputs['Is Camera Ray'], mix.inputs[0])
nt.links.new(amb.outputs[0], mix.inputs[1])
nt.links.new(bg.outputs[0], mix.inputs[2])
nt.links.new(mix.outputs[0], nt.nodes['World Output'].inputs[0])
mat = bpy.data.materials.new('clay')
mat.use_nodes = True
bsdf = mat.node_tree.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value = (0.42, 0.42, 0.42, 1)
bsdf.inputs['Roughness'].default_value = 0.9
obj.data.materials.append(mat)
sun = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
sun.data.energy = 2.6
sun.data.angle = math.radians(35)
scene.collection.objects.link(sun)
fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'SUN'))
fill.data.energy = 0.7
fill.data.use_shadow = False
scene.collection.objects.link(fill)

cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.clip_start, cam_data.clip_end = 1, 2000
cam_data.ortho_scale = 46.0
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
# (dx, dy) 是 Blender 平面上相機所在的方向；素體的前方是 Blender 的 −y
views = {'back': (0, 1), 'side': (1, 0), 'rearQuarter': (0.7, 0.7), 'front': (0, -1), 'quarter': (0.7, -0.7)}


def shoot(tag):
    for name, (dx, dy) in views.items():
        yaw = math.atan2(-dy, -dx) - math.pi / 2
        cam.location = (dx * 300, dy * 300, 84.0)
        cam.rotation_euler = (math.pi / 2, 0, yaw)
        sun.rotation_euler = (math.radians(45), 0, yaw - math.radians(35))
        fill.rotation_euler = (math.radians(70), 0, yaw + math.radians(60))
        scene.render.filepath = str(OUT / f'{tag}-{name}.png')
        bpy.ops.render.render(write_still=True)


shoot('neutral')
