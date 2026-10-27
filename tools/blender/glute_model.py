"""臀的獨立模・中性型（DECISIONS #57、#59、#60）：在 Blender 裡從零建臀部區，和素體無關。

blender -b -noaudio --python tools/blender/glute_model.py -- <輸出資料夾>

幾何在 glute_cage.py；建物件、擬合、量測、算圖在 glute_scene.py。
輸出 .blend（籠與修改器都保留，可以在 Blender 介面裡直接調點）、glute_model.npz（設計點、擬合後的籠、
細分後的網格加細部層、骨點）、glute_measure.json（各高度的圍、寬、厚）與灰模多視圖。
"""
import json
from pathlib import Path
import sys

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from glute_cage import LANDMARKS, TARGET, cage, crotch_detail, to_blender  # noqa: E402
import glute_scene as gs  # noqa: E402

OUT = Path(sys.argv[sys.argv.index('--') + 1]) if '--' in sys.argv else Path('.')
OUT.mkdir(parents=True, exist_ok=True)

Vc, Fc = cage()
obj = gs.build(Vc, Fc)
Vc_cage, err = gs.fit_cage(obj, Vc, Fc)
print('籠擬合殘差（公分）', round(err, 3))
obj.shape_key_add(name='basis')
for name, p in LANDMARKS.items():
    for s, tag in ((1, 'L'), (-1, 'R')):
        if p[0] == 0 and s < 0:
            continue
        e = bpy.data.objects.new(f'{name}{tag if p[0] else ""}', None)
        e.empty_display_size = 1.0
        e.location = to_blender((s * p[0], p[1], p[2]))
        bpy.context.scene.collection.objects.link(e)

P, E, F = gs.evaluated(obj)
P = crotch_detail(P)
res, prof = gs.measure(P, E)
print('量測', json.dumps(res, ensure_ascii=False))
print('目標', json.dumps(TARGET, ensure_ascii=False))
(OUT / 'glute_measure.json').write_text(json.dumps(dict(measure=res, target=TARGET, profile=prof), ensure_ascii=False, indent=1))
np.savez(OUT / 'glute_model.npz', design=Vc, cage=Vc_cage, positions=P, faces=np.array(F, dtype=np.int32),
         landmarks=json.dumps(LANDMARKS))
bpy.ops.wm.save_as_mainfile(filepath=str((OUT / 'glute_model.blend').resolve()))

studio = gs.Studio(gs.display_object(obj, P, F))
for view in gs.VIEWS:
    studio.shoot(OUT / f'neutral-{view}.png', view)
