"""匯出已完成的 C1 雕形與連續通道，不在匯出器重建造型。
執行：blender -b --python-exit-code 1 --python tools/export-lower-body-form.py
"""
import hashlib
import json
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/shapes/female-lower-body.blend'
bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
obj = bpy.context.active_object
mesh = obj.data
keys = mesh.shape_keys.key_blocks
channels = [{'id': 'pose', 'factors': []}] + json.loads(obj['c1_channels'])
def cm(p):
    return [p.x * 100, p.z * 100, -p.y * 100]
rows = []
for i in range(len(mesh.vertices)):
    ref = list(mesh.attributes['body_reference'].data[i].vector)
    point = cm(keys[0].data[i].co)
    fields = [[point[k] - ref[k] for k in range(3)]]
    fields += [cm(keys[ch['id']].data[i].co - keys[0].data[i].co) for ch in channels[1:]]
    if max(abs(v) for field in fields for v in field) < 1e-5:
        continue
    rows.append([mesh.attributes['body_vertex_id'].data[i].value,
                 *[round(v, 6) for v in ref],
                 *[round(v, 6) for field in fields for v in field]])
variables = sorted({v for ch in channels for v in ch['factors']})
state = {name: ((i % 5) - 2) * .23 for i, name in enumerate(variables)}
for name, value in state.items():
    obj[name] = value
obj.update_tag()
for modifier in obj.modifiers:
    if modifier.type == 'SUBSURF':
        modifier.show_viewport = False
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
result = evaluated.to_mesh()
sample = [[row[0], *[round(v, 6) for v in cm(result.vertices[row[0]].co)]] for row in rows]
evaluated.to_mesh_clear()
for modifier in obj.modifiers:
    if modifier.type == 'SUBSURF':
        modifier.show_viewport = True
        modifier.levels = 1
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
result = evaluated.to_mesh()
interior = [cm(v.co) for v in result.vertices
            if 2 < abs(v.co.x * 100) < 18 and -70 < v.co.z * 100 < 15]
surface_sample = [[round(v, 6) for v in point]
                  for point in interior[::max(1, len(interior) // 64)]]
evaluated.to_mesh_clear()
data = {'source': str(SOURCE.relative_to(ROOT)),
        'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        'bodyVertexCount': len(mesh.vertices), 'channels': channels, 'rows': rows,
        'sample': {'state': state, 'positions': sample, 'surface': surface_sample}}
(ROOT / 'src/body/mh/forms/femaleLowerBody.json').write_text(
    json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f"已匯出 {len(rows)} 頂點、{len(channels)} 通道")
