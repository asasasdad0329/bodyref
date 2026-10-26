"""臀的獨立模（DECISIONS #57、#59）：在 Blender 裡從零建臀部區，和素體無關。

blender -b -noaudio --python tools/blender/glute_model.py -- <輸出資料夾>

範圍：髂嵴（下腰）到臀溝下方約 6 公分的大腿根，前後左右一整圈；不含腰背、不到大腿中段。
做法（一般的角色建模流程）：
1. 只建左半邊的低面數控制籠（cage），由一層層的水平截面組成；截面形狀由下方 TORSO、LEGS 的參數決定。
   上半是一個圈（骨盆），到胯下分成兩條腿的圈；兩腿之間用一串正中頂點（會陰）接起來。
2. 鏡像修改器補右半邊（正中頂點合併），細分曲面修改器（Catmull-Clark）把籠變成平滑曲面。
   細分會把籠往內收，所以籠先反覆往外補差值，讓曲面接近設計的截面（fit_cage）。
   籠和修改器都保留在 .blend 裡，之後可以直接在 Blender 介面裡調點。
3. 中性型就是籠的基本形（形狀鍵 basis）；之後的變形線做成籠上的形狀鍵。
4. 骨點（髂嵴、髂前上棘、髂後上棘、大轉子、恥骨聯合、坐骨結節、尾骨、髖關節）另外記錄，
   是之後變形線（骨架線）和素體控制共用的座標框架。
5. 量臀圍、寬、厚與大腿圍，用 Eevee 算多視圖。

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

# ---------- 1. 截面參數 ----------
# 骨盆圈：每層一個水平截面（左半），從正前（t=0°）經外側（90°）到正後（180°）。
# w 半寬；zf 正前；zc 最寬處的前後位置；zb 正後（未加臀峰、臀縫前）；pf、pb 前後半的方圓程度（越大越方）。
# lobe 臀峰往後的量，xl 臀峰離正中的距離，sl、slm 臀峰往外、往內的寬；cleft 正中往前凹（下背是脊溝，往下是臀縫）。
# side 外側的凹（負）凸（正），sideT 位置（度），用來做臀側凹陷（C 點）；dimple 腰窩的深度。
TORSO = [
    dict(y=98.0, w=13.2, zf=6.8, zc=-1.0, zb=-7.4, pf=3.0, pb=2.8, lobe=0.6, xl=3.2, sl=2.0, slm=2.5, cleft=0.0),
    dict(y=94.0, w=14.8, zf=7.6, zc=-1.1, zb=-8.4, pf=3.3, pb=3.2, lobe=0.0, xl=4.2, sl=2.6, cleft=0.0, dimple=0.35),
    dict(y=90.0, w=15.8, zf=8.0, zc=-1.3, zb=-9.4, pf=3.7, pb=3.4, lobe=1.2, xl=4.8, sl=4.6, cleft=0.6),
    dict(y=86.0, w=16.4, zf=8.3, zc=-1.6, zb=-9.8, pf=4.0, pb=3.8, lobe=2.2, xl=5.0, sl=6.0, cleft=2.2,
         side=-0.35, sideT=112),
    dict(y=82.5, w=16.5, zf=8.1, zc=-1.8, zb=-9.9, pf=4.0, pb=3.8, lobe=2.8, xl=5.0, sl=6.0, cleft=3.0,
         side=-0.15, sideT=118),
    dict(y=79.2, w=16.0, zf=7.3, zc=-2.0, zb=-9.4, pf=3.8, pb=3.4, lobe=2.8, xl=4.8, sl=5.2, cleft=3.6),
]
# 籠在骨盆圈上的取樣角度（左半 10 點），加上臀縫兩側固定 x 的 3 點，共 13 點。
TORSO_T = [0, 18, 36, 54, 72, 90, 106, 122, 138, 154]
BACK_X = [3.4, 1.1, 0.0]
# 胯下：最後一層的正前、正後換成會陰的位置；中間一串正中頂點（後 → 前）把左右腿分開。
CROTCH_FRONT = (80.4, 6.2)   # (y, z) 恥骨聯合下緣
CROTCH_BACK = (80.2, -5.2)   # 臀縫底
CHAIN = [(78.4, -3.0), (77.0, 0.2), (78.6, 3.4)]
# 腿圈（左腿）：中心 cx、cz；外側半寬 al、內側半寬 am；前 bf、後 bb；外、內側的方圓程度 pl、pm。
# bulge 臀下半往後的量（腿圈後內側）；fold 臀溝：後內側往前、往上收。
LEGS = [
    dict(y=77.0, cx=8.1, cz=-1.2, al=7.8, am=7.6, bf=7.5, bb=9.0, pl=2.7, pm=3.0, pbl=2.3, bulge=1.4, fold=0.0),
    dict(y=75.0, cx=8.0, cz=-1.0, al=7.8, am=7.6, bf=7.8, bb=8.9, pl=2.8, pm=3.2, pbl=2.3, bulge=0.0, fold=1.0),
    dict(y=72.5, cx=7.9, cz=-0.8, al=7.7, am=7.5, bf=7.9, bb=8.9, pl=2.8, pm=3.2, pbl=2.3, bulge=0.0, fold=0.2),
    dict(y=69.5, cx=7.8, cz=-0.7, al=7.5, am=7.4, bf=7.8, bb=8.8, pl=2.7, pm=3.0, pbl=2.3, bulge=0.0, fold=0.0),
]
# 腿圈 16 點的方位角（0° 正前、90° 外側、180° 正後、270° 內側）：前 13 點對應骨盆圈左半，後 3 點對應會陰串。
LEG_PHI = [-40, -15, 10, 35, 62, 90, 115, 140, 162, 182, 198, 210, 222, 248, 275, 302]


def spow(v, e):
    return math.copysign(abs(v) ** e, v)


def back_z(L, x):
    """後半截面在 x 處的前後位置：方圓的弧，加臀峰、減臀縫。"""
    u = min(x / L['w'], 1.0)
    z = L['zc'] - (L['zc'] - L['zb']) * (1 - u ** L['pb']) ** (1 / L['pb'])
    # 臀峰：外側頂部較平（四次方），內側較圓，往臀縫收
    q = (x - L['xl']) / L['sl'] if x >= L['xl'] else (x - L['xl']) / L.get('slm', 4.5)
    z -= L['lobe'] * math.exp(-q ** (4 if x >= L['xl'] else 2))
    z += L.get('dimple', 0) * math.exp(-((x - 4.2) / 1.3) ** 2)  # 腰窩（髂後上棘）
    return z + L['cleft'] * math.exp(-(x / 0.6) ** 2)


def torso_half(L):
    pts = []
    for t in TORSO_T:
        s, c = math.sin(math.radians(t)), math.cos(math.radians(t))
        if c >= 0:
            x, z = L['w'] * abs(s) ** (2 / L['pf']), L['zc'] + (L['zf'] - L['zc']) * abs(c) ** (2 / L['pf'])
        else:
            x = L['w'] * abs(s) ** (2 / L['pb'])
            z = back_z(L, x)
        if 'side' in L:
            g = math.exp(-((t - L['sideT']) / 14) ** 2)
            x += L['side'] * g * s
            z += L['side'] * g * c
        pts.append((0.0 if t == 0 else x, L['y'], z))
    # 臀縫兩側：用固定的 x 取樣，讓臀縫窄而深，左右臀在正中幾乎貼合
    for x in BACK_X:
        pts.append((x, L['y'], back_z(L, x)))
    return pts


def leg_ring(L):
    pts = []
    for phi in LEG_PHI:
        s, c = math.sin(math.radians(phi)), math.cos(math.radians(phi))
        a, p = (L['al'], L['pl']) if s >= 0 else (L['am'], L['pm'])
        if s >= 0 and c < 0:
            p = L.get('pbl', p)  # 後外側較圓，臀下半才不會在外側鼓出一圈
        b = L['bf'] if c >= 0 else L['bb']
        x = L['cx'] + a * spow(s, 2 / p)
        z = L['cz'] + b * spow(c, 2 / p)
        y = L['y']
        back = math.exp(-((phi - 200) / 25) ** 2)
        z -= L['bulge'] * back
        fold = math.exp(-((phi - 205) / 16) ** 2)
        z += L['fold'] * fold
        y += 0.8 * L['fold'] * fold * (L['y'] > 74)
        pts.append((max(x, 0.35), y, z))
    return pts


def cage():
    """左半籠的頂點與四邊形面（頂點座標用素體慣例）。"""
    V, F, rings = [], [], []
    for L in TORSO:
        rings.append(list(range(len(V), len(V) + len(TORSO_T) + len(BACK_X))))
        V += torso_half(L)
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
    return np.array(V, float), F


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
# Eevee、霧面材質、斜上方的平行光（固定在每個視角的左上方），讓起伏讀得出來
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x, scene.render.resolution_y = 700, 700
world = scene.world or bpy.data.worlds.new('world')
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.25, 0.25, 0.25, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 0.6
mat = bpy.data.materials.new('clay')
mat.use_nodes = True
bsdf = mat.node_tree.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value = (0.6, 0.6, 0.58, 1)
bsdf.inputs['Roughness'].default_value = 0.85
obj.data.materials.append(mat)
sun = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
sun.data.energy = 3.5
sun.data.angle = math.radians(12)  # 柔和的投影，避免硬邊被誤看成稜線
scene.collection.objects.link(sun)

cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.clip_start, cam_data.clip_end = 1, 2000
cam_data.ortho_scale = 44.0
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
        sun.rotation_euler = (math.radians(50), 0, yaw - math.radians(40))
        scene.render.filepath = str(OUT / f'{tag}-{name}.png')
        bpy.ops.render.render(write_still=True)


shoot('neutral')
