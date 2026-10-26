"""曲率檢查：把細分後網格的平均曲率上色算圖，找出灰模不容易看到的小凸點、小凹點與條紋。

blender -b -noaudio --python tools/blender/curvature.py -- <glute_model.blend> <輸出前綴>

紅＝凸、藍＝凹、灰＝平。大面應該是平緩的漸層；一團一團的斑點或成排的條紋就是不平順的地方。
曲率用傘狀拉普拉斯沿法線估計（約為平均曲率的兩倍，單位 1/公分）。輸出各視角的圖與每個頂點的曲率（.npy）。
"""
import math
import sys

import bpy
import numpy as np

blend, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=blend)
obj = bpy.data.objects['glute']
dg = bpy.context.evaluated_depsgraph_get()
me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
P = np.array([v.co[:] for v in me.vertices])
N = np.array([v.normal[:] for v in me.vertices])
E = np.array([e.vertices[:] for e in me.edges])

acc, cnt = np.zeros_like(P), np.zeros(len(P))
for a, b in ((0, 1), (1, 0)):
    np.add.at(acc, E[:, a], P[E[:, b]])
    np.add.at(cnt, E[:, a], 1)
lap = acc / cnt[:, None] - P
edge = np.linalg.norm(P[E[:, 0]] - P[E[:, 1]], axis=1)
h = np.zeros(len(P))
np.add.at(h, E[:, 0], edge)
np.add.at(h, E[:, 1], edge)
h /= 2 * cnt
H = -(lap * N).sum(1) / (h * h)
np.save(out + '-H.npy', H)

SCALE = 0.25  # 這個曲率以上就是全紅或全藍
col = me.color_attributes.new('H', 'FLOAT_COLOR', 'POINT')
for i, c in enumerate(np.clip(H / SCALE, -1, 1)):
    col.data[i].color = (0.5 + 0.5 * max(c, 0), 0.5 - 0.35 * abs(c), 0.5 + 0.5 * max(-c, 0), 1)
diag = bpy.data.objects.new('curvature', me)
bpy.context.scene.collection.objects.link(diag)
obj.hide_render = True

scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'FLAT'
scene.display.shading.color_type = 'VERTEX'
scene.render.resolution_x = scene.render.resolution_y = 900
cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 46.0
cam_data.clip_end = 2000
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
# (dx, dy) 是 Blender 平面上相機所在的方向；素體的前方是 Blender 的 −y
views = {'front': (0, -1), 'quarter': (0.7, -0.7), 'side': (1, 0), 'back': (0, 1), 'rearQuarter': (0.7, 0.7)}
for name, (dx, dy) in views.items():
    cam.location = (dx * 300, dy * 300, 84.0)
    cam.rotation_euler = (math.pi / 2, 0, math.atan2(-dy, -dx) - math.pi / 2)
    scene.render.filepath = f'{out}-{name}.png'
    bpy.ops.render.render(write_still=True)
