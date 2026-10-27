"""臀的獨立模：Blender 端的共用步驟（建物件、擬合籠、量測、灰模算圖）。

glute_model.py（中性型）與 glute_fat.py（脂肪線）都用這裡的函式；幾何本身在 glute_cage.py。
"""
import math

import bpy
import numpy as np

from glute_cage import to_blender, to_body


def build(V, F):
    """由左半的設計點建物件：鏡像補右半（正中頂點合併）、細分 3 次（Catmull-Clark）。"""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    me = bpy.data.meshes.new('glute_cage')
    me.from_pydata(to_blender(V).tolist(), [], F)
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
    return obj


def neighbours(n, F):
    nb = [set() for _ in range(n)]
    for f in F:
        for a, b in zip(f, f[1:] + f[:1]):
            nb[a].add(b)
            nb[b].add(a)
    return [list(s) for s in nb]


def smooth(d, nb, it=4):
    for _ in range(it):
        d = np.array([0.5 * d[i] + 0.5 * d[n].mean(0) for i, n in enumerate(nb)])
    return d


def set_cage(obj, C):
    for v, co in zip(obj.data.vertices, to_blender(C)):
        v.co = co
    obj.data.update()


def fit_cage(obj, V, F, rounds=8, start=None, sharp=None):
    """細分會把凸的籠往內收（約 5%），所以反覆把籠往外補差值，讓曲面的尺寸接近設計點 V。
    差值先在籠上平滑過再補，只補大尺寸，不追細節，避免臀縫、臀溝附近起波紋。
    sharp：刻意做的小起伏（胯下的大陰唇、股生殖摺）上的點，差值不平滑、直接補，形才做得出來。
    Blender 細分後的前 n 個頂點就是籠頂點的對應位置。回傳籠的座標與最大殘差。"""
    nb = neighbours(len(V), F)
    dg = bpy.context.evaluated_depsgraph_get()
    C = (V if start is None else start).copy()
    mid = np.abs(V[:, 0]) < 1e-6
    for _ in range(rounds):
        set_cage(obj, C)
        dg.update()
        ev = obj.evaluated_get(dg)
        m = ev.to_mesh()
        S = to_body(np.array([v.co[:] for v in m.vertices[:len(V)]]))
        ev.to_mesh_clear()
        err = V - S
        corr = smooth(err, nb)
        if sharp is not None:
            corr[sharp] = err[sharp]
        C += corr
        C[mid, 0] = 0  # 正中頂點留在正中，鏡像才會合併
        C[~mid, 0] = np.maximum(C[~mid, 0], 0.02)  # 其他頂點不能碰到正中，否則會被鏡像合併，頂點數就變了
    set_cage(obj, C)
    dg.update()
    return C, float(np.abs(err).max())


def evaluated(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    m = ev.to_mesh()
    P = to_body(np.array([v.co[:] for v in m.vertices]))
    E = np.array([e.vertices[:] for e in m.edges])
    F = [p.vertices[:] for p in m.polygons]
    ev.to_mesh_clear()
    return P, E, F


def display_object(obj, P, F):
    """算圖用的物件：細分後的網格加上細部層（glute_cage.crotch_detail）。原本的籠物件不算圖。"""
    me = bpy.data.meshes.new('glute_display')
    me.from_pydata(to_blender(P).tolist(), [], F)
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    d = bpy.data.objects.new('glute_display', me)
    bpy.context.scene.collection.objects.link(d)
    obj.hide_render = True
    return d


def show(d, P):
    d.data.vertices.foreach_set('co', to_blender(P).astype(np.float32).ravel())
    d.data.update()


def hull_perimeter(pts):
    """截面點的凸包周長，等於皮尺繞一圈（會跨過臀縫）。"""
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
    s = section(P, E, 72.5)
    f = section(P, E, 75.0)   # ANSUR 的大腿圍量在臀溝最低點（中性型約 75 cm）
    res = dict(hipCirc=out[hipY]['circ'], hipCircY=hipY, hipBreadth=max(v['breadth'] for v in out.values()),
               buttockDepth=out[hipY]['depth'], mostPosteriorY=min(out, key=lambda y: out[y]['back']),
               thighCirc=hull_perimeter(s[s[:, 0] > 0]), thighFurrowCirc=hull_perimeter(f[f[:, 0] > 0]),
               topCirc=out[98.0]['circ'] if 98.0 in out else None)
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in res.items()}, out


# (dx, dy) 是 Blender 平面上相機所在的方向；素體的前方是 Blender 的 −y
VIEWS = {'back': (0, 1), 'side': (1, 0), 'rearQuarter': (0.7, 0.7), 'front': (0, -1), 'quarter': (0.7, -0.7)}


class Studio:
    """灰模：中灰霧面材質、相機看到深灰背景、環境光淺灰；主光是大面積柔光，從各視角的左上方來，
    另加對側補光。起伏靠柔和的明暗讀，不靠硬投影。"""

    def __init__(self, obj, size=900, scale=46.0):
        scene = self.scene = bpy.context.scene
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
        scene.render.resolution_x = scene.render.resolution_y = size
        scene.view_settings.view_transform = 'Standard'
        scene.eevee.taa_render_samples = 32
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
        self.sun = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
        self.sun.data.energy = 2.6
        self.sun.data.angle = math.radians(35)
        scene.collection.objects.link(self.sun)
        self.fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'SUN'))
        self.fill.data.energy = 0.7
        self.fill.data.use_shadow = False
        scene.collection.objects.link(self.fill)
        cam_data = bpy.data.cameras.new('cam')
        cam_data.type = 'ORTHO'
        cam_data.clip_start, cam_data.clip_end = 1, 2000
        cam_data.ortho_scale = scale
        self.cam = bpy.data.objects.new('cam', cam_data)
        scene.collection.objects.link(self.cam)
        scene.camera = self.cam

    def shoot(self, path, view, height=84.0):
        dx, dy = VIEWS[view]
        yaw = math.atan2(-dy, -dx) - math.pi / 2
        self.cam.location = (dx * 300, dy * 300, height)
        self.cam.rotation_euler = (math.pi / 2, 0, yaw)
        self.sun.rotation_euler = (math.radians(45), 0, yaw - math.radians(35))
        self.fill.rotation_euler = (math.radians(70), 0, yaw + math.radians(60))
        self.scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
