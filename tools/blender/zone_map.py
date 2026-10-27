"""分區對照圖：原本的分區規則（PR #15 的 shapeBlocks，src/body/mh/shapeBlocks.ts 在該分支）套在素體與臀的獨立模上，
加上臀圍線與褲型範圍線（平口褲腰頭、褲管；寬鬆三角褲褲口）。供分區討論（基礎軌第 1 節、DECISIONS #62）。

blender -b -noaudio --python tools/blender/zone_map.py -- <glute_fat 輸出> <glute_model 輸出> <無用> <輸出前綴>
素體的肚臍、臀、胯下高度是近似值（臀用最寬處），只為了著色比對。產物不進倉庫。
"""
import sys, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np, bpy
import body as body_loader
import glute_scene as gs
from glute_cage import to_blender
OUT = sys.argv[-1]
COL = {'abdomen.lower': (0.93, 0.72, 0.30), 'pelvis.front': (0.85, 0.45, 0.55), 'glute.side': (0.45, 0.62, 0.85),
       'glute.upper': (0.35, 0.50, 0.80), 'glute.rear': (0.25, 0.40, 0.75), 'glute.lower': (0.20, 0.30, 0.62),
       'thigh.root.outer': (0.45, 0.75, 0.45), 'thigh.root.front': (0.60, 0.82, 0.55), 'thigh.root.inner': (0.75, 0.88, 0.60),
       'thigh.root.back': (0.35, 0.62, 0.40), 'thigh.body': (0.80, 0.80, 0.78), 'waist': (0.78, 0.65, 0.85),
       'lumbar': (0.65, 0.55, 0.78), 'other': (0.85, 0.85, 0.83), 'hip': (0.85, 0.10, 0.10), 'boy': (0.10, 0.25, 0.90), 'brief': (0.05, 0.45, 0.10)}

def classify(P, region, regions, navel, hipY, crotchY, kneeY, centerZ):
    ids = []
    for (x, y, z), r in zip(P, region):
        r = regions[r] if regions else r
        if r == 'torso':
            dz = z - centerZ(y); lateral = abs(x) > 1.25 * abs(dz)
            if y >= navel: ids.append('waist' if lateral else ('other' if dz >= 0 else 'lumbar'))
            elif dz >= 0 and not lateral: ids.append('pelvis.front' if y < hipY else 'abdomen.lower')
            elif lateral: ids.append('glute.side')
            else: ids.append('glute.' + ('upper' if y > hipY else 'rear' if y > crotchY + (hipY - crotchY) * 0.35 else 'lower'))
        elif r.startswith('thigh'):
            ids.append('thigh.root' if y > crotchY - (crotchY - kneeY) * 0.15 else 'thigh.body')
        else: ids.append('other')
    return ids

def thigh_dir(P, ids, hip):
    out = []
    for p, i in zip(P, ids):
        if i != 'thigh.root': out.append(i); continue
        dx = (abs(p[0]) - abs(hip[0])); dz = p[2] - hip[2]
        out.append('thigh.root.' + (('outer' if dx > 0 else 'inner') if abs(dx) > abs(dz) else ('front' if dz > 0 else 'back')))
    return out

def mesh(name, P, faces, ids, lines=None):
    me = bpy.data.meshes.new(name); me.from_pydata(to_blender(P).tolist(), [], [tuple(f) for f in faces]); me.update()
    for p in me.polygons: p.use_smooth = True
    c = me.color_attributes.new('c', 'FLOAT_COLOR', 'POINT')
    for k, i in enumerate(ids):
        col = COL[lines[k]] if lines is not None and lines[k] else COL[i]
        c.data[k].color = (*col, 1)
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); return o

for o in list(bpy.data.objects): bpy.data.objects.remove(o)
sc = bpy.context.scene; sc.render.engine = 'BLENDER_WORKBENCH'
sh = sc.display.shading; sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; sh.show_specular_highlight = False
sc.render.resolution_x = sc.render.resolution_y = 700
cd = bpy.data.cameras.new('c'); cd.type = 'ORTHO'; cd.clip_end = 3000
cam = bpy.data.objects.new('c', cd); sc.collection.objects.link(cam); sc.camera = cam
def shoot(obj, path, view, h, scale):
    for o in bpy.data.objects:
        if o.type == 'MESH': o.hide_render = o is not obj
    dx, dy = gs.VIEWS[view]; cd.ortho_scale = scale
    cam.location = (dx * 400, dy * 400, h); cam.rotation_euler = (math.pi / 2, 0, math.atan2(-dy, -dx) - math.pi / 2)
    sc.render.filepath = path; bpy.ops.render.render(write_still=True)

# ---- A. 素體（原本的分區規則）----
b = body_loader.load(); P = b['positions']; J = b['joints']
torso = np.array([b['regions'][r] == 'torso' for r in b['region']])
crotchY = P[torso & (np.abs(P[:, 0]) < 1.5)][:, 1].min()
navel = P[4121, 1]
ys = np.arange(crotchY + 1, navel, 0.5)
girth = [np.ptp(P[torso & (np.abs(P[:, 1] - y) < 0.3)][:, 0]) if (torso & (np.abs(P[:, 1] - y) < 0.3)).sum() > 3 else 0 for y in ys]   # 用寬度近似找臀最寬處
hipY = ys[int(np.argmax(girth))]
pel, sp = J['pelvis'], J['spine-1']
cz = lambda y: pel[2] + (sp[2] - pel[2]) * min(max((y - pel[1]) / (sp[1] - pel[1]), 0), 1)
ids = thigh_dir(P, classify(P, b['region'], b['regions'], navel, hipY, crotchY, J['l-knee'][1], cz), J['l-upper-leg'])
print('素體：肚臍', round(navel, 1), '臀', round(hipY, 1), '胯下', round(crotchY, 1))
base = mesh('base', P, b['faces'], ids)
mid = (hipY + crotchY) / 2
for v in ('front', 'side', 'back', 'rearQuarter'):
    shoot(base, f'{OUT}-base-{v}.png', v, mid, (navel - crotchY) * 2.6)

# ---- B. 臀的獨立模（同一套規則；肚臍、臀、胯下用這個體型的高度）+ 褲型範圍線 ----
M = np.load(sys.argv[-3] + '/glute_model.npz'); Q = M['positions']; faces = M['faces']
fat = np.load(sys.argv[-4] + '/fat_line.npz')
def zones_for(Q):
    navel, hipY, crotchY, knee = 96.6, 82.5, 76.8, 43.9
    x, y, z = np.abs(Q[:, 0]), Q[:, 1], Q[:, 2]
    # 獨立模沒有素體的「軀幹／大腿」標記：以臀溝與鼠蹊為界，界線以下是大腿
    fold = 75.5 + 0.12 * np.clip(x - 3, 0, None)
    groin_x = 3.0 + 8.5 * np.clip((y - 79.0) / 13.0, 0, 1)
    is_thigh = ((z < -2) & (y < fold + 0.5)) | ((z >= -2) & (y < 79.0) & (x > groin_x - 0.5) & (y < 80 - 0.25 * np.clip(x - 8, 0, None) * 0)) 
    is_thigh |= (y < 76.0)
    region = np.where(is_thigh, 'thigh', 'torso')
    ids = classify(Q, region, None, navel, hipY, crotchY, knee, lambda yy: -1.6)
    ids = thigh_dir(Q, ids, np.array([8.0, 83.6, -1.0]))
    # 線：臀圍（82.5，紅）、平口褲（腰頭 92、褲管 73，藍）、寬鬆三角褲褲口（綠：前面沿鼠蹊從胯下到側面約 84，後面沿臀溝往外上升到側面約 83）
    lab = np.array([''] * len(Q), dtype=object)
    lab[(np.abs(y - 92.0) < 0.25) | (np.abs(y - 73.0) < 0.25)] = 'boy'
    front_leg = (z > -2) & (np.abs(x - (2.2 + (y - 77.5) * 1.95)) < 0.3) & (y > 77.5) & (y < 84.2)
    back_leg = (z <= -2) & (np.abs(y - (75.3 + 0.62 * np.clip(x - 3, 0, None))) < 0.25) & (x < 16.5)
    lab[front_leg | back_leg] = 'brief'
    lab[np.abs(y - 82.5) < 0.25] = 'hip'
    return ids, lab
for tag, Qk in (('neutral', Q), ('fat50', fat['positions'][int(np.argmin(np.abs(fat['F'] - 50)))].astype(float))):
    ids, lab = zones_for(Qk)
    for kind, lines in (('briefs', lab),):
        o = mesh(f'{tag}-{kind}', Qk, faces, ids, lines)
        for v in ('front', 'side', 'back', 'rearQuarter'):
            shoot(o, f'{OUT}-{tag}-{kind}-{v}.png', v, 84.0, 52.0)
