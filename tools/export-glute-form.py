"""將已雕好的臀部造型轉成結構骨材料；不在匯出時重新設計形狀。

執行：blender -b --python tools/export-glute-form.py
來源曲面、連續進程與頂點對應都保存在 Blender 資產內。
"""
import hashlib
import json
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/shapes/female-glute.blend'
bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
obj = bpy.context.active_object
mesh = obj.data
keys = mesh.shape_keys.key_blocks
ids = mesh.attributes['body_vertex_id'].data
reference = mesh.attributes['body_reference'].data
channels = ['pose', 'muscle', 'muscleCurve', 'fat', 'fatCurve', 'coupling']
labels = ['臀大肌體量', '臀大肌曲率', '皮下脂肪覆蓋', '脂肪下極分布', '肌脂共同承接']


def cm(point):
    # Blender z 向上、公尺；產品 y 向上、公分。
    return [point.x * 100, point.z * 100, -point.y * 100]


rows = []
for i, vertex in enumerate(mesh.vertices):
    if ids[i].value < 0:
        continue
    p = cm(keys[0].data[i].co)
    ref = list(reference[i].vector)
    fields = [[p[k] - ref[k] for k in range(3)]]
    fields += [cm(keys[name].data[i].co - keys[0].data[i].co) for name in labels]
    if max(abs(v) for field in fields for v in field) < 1e-4:
        continue
    rows.append([ids[i].value, *[round(v, 6) for v in ref],
                 *[round(v, 6) for field in fields for v in field]])
rows.sort(key=lambda row: row[0])

# Blender 實際求值的中間狀態：供結構骨重現核對，不從匯出的係數計算答案。
obj['muscle_form'] = .35
obj['fat_form'] = -.6
obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
surface = evaluated.to_mesh()
interior = [cm(v.co) for v in surface.vertices
            if 3 < abs(v.co.x * 100) < 17 and -17 < v.co.z * 100 < 7 and -v.co.y * 100 < 0]
surface_sample = [[round(v, 6) for v in point] for point in interior[::max(1, len(interior) // 48)]]
evaluated.to_mesh_clear()
subdivision = next(mod for mod in obj.modifiers if mod.type == 'SUBSURF')
subdivision.show_viewport = False
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
result = evaluated.to_mesh()
result_ids = result.attributes['body_vertex_id'].data
positions = {result_ids[i].value: cm(v.co) for i, v in enumerate(result.vertices)}
sample = [[row[0], *[round(v, 6) for v in positions[row[0]]]] for row in rows]
evaluated.to_mesh_clear()

asset = {
    'source': 'assets/shapes/female-glute.blend',
    'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'bodyVertexCount': 13380,
    'channels': channels,
    'rows': rows,
    'sample': {'muscle': .35, 'fat': -.6, 'positions': sample, 'surface': surface_sample},
}
destination = ROOT / 'src/body/mh/forms/femaleGlute.json'
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(asset, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f'已匯出 {len(rows)} 個有作用的頂點、{len(channels)} 個造型通道')
