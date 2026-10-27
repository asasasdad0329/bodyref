"""把 glute_fat.py 匯出的網格（export 模式）打包成可以旋轉的網頁檢視器。

python3 tools/blender/fat_viewer.py <glute_fat.py export 的輸出資料夾> <網頁輸出資料夾>

輸出單一檔案 index.html：範本 fat_viewer.html 加上量測、刻度，以及 base64 內嵌的網格資料
（int16 頂點：每組一個脂肪量（目前每 2 kg），(座標 − 原點) ÷ 0.002 公分；接著 uint32 三角形索引）。
網頁在相鄰兩組之間直線內插（內插誤差見 01-glute.md）。產物不進倉庫。
"""
import base64
import json
from pathlib import Path
import sys

import numpy as np

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
d = np.load(src / 'fat_viewer.npz')
info = json.loads((src / 'fat_line.json').read_text())

STEP = 0.002
ORIGIN = np.array([0.0, 84.0, 0.0])
P = d['positions'].astype(np.float64)
q = np.round((P - ORIGIN) / STEP)
assert np.abs(q).max() < 32767, '超出 int16 範圍'
tris = d['tris'].astype(np.uint32)
data = q.astype(np.int16).tobytes() + tris.tobytes()

# 堆積點開始長的位置（只列晚起步的，標在滑桿下）
LABELS = {'lowerBelly': '下腹', 'saddle': '大腿外側', 'flank': '腰側'}
onsets = sorted(({'F': v['on'], 'label': LABELS[k]} for k, v in info['depots'].items() if k in LABELS and v['on'] > 0),
                key=lambda t: t['F'])
F = d['F'].tolist()
meta = dict(nv=int(P.shape[1]), nt=int(len(tris)), F=F, step_F=F[1] - F[0], F0=float(d['F0']),
            hip=[round(float(v), 2) for v in d['hip']], thigh=[round(float(v), 2) for v in d['thigh']],
            step=STEP, origin=ORIGIN.tolist(), onsets=onsets)
html = (Path(__file__).parent / 'fat_viewer.html').read_text()
html = html.replace('/*__META__*/null', json.dumps(meta, ensure_ascii=False))
(out / 'index.html').write_text(html.replace('/*__DATA__*/', base64.b64encode(data).decode()))
print(out / 'index.html', f'{(out / "index.html").stat().st_size / 1e6:.2f} MB')
