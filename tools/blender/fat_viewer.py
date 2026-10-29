"""把 glute_fat.py 匯出的網格（export 模式）或 glute_mh_fat.py 的 viewer 輸出，打包成可以旋轉的網頁檢視器。

python3 tools/blender/fat_viewer.py <glute_fat.py export 的輸出資料夾> <網頁輸出資料夾>

輸出單一檔案 index.html：範本 fat_viewer.html 加上量測、刻度，以及 base64 內嵌的網格資料
（int16 頂點：每組一個脂肪量（目前每 2 kg），(座標 − 原點) ÷ 0.002 公分；接著 uint32 三角形索引；
最後 uint8 每個頂點的分區，依中性型算，見 glute_cage.zones）。
網頁在相鄰兩組之間直線內插（內插誤差見 01-glute.md）。產物不進倉庫。
"""
import base64
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from glute_cage import ZONE, zones  # noqa: E402  （glute_mh_fat.py 的輸出自帶分區，不用這個）

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
d = np.load(src / 'fat_viewer.npz')
info = json.loads(next(src.glob('*_line.json')).read_text())

STEP = 0.002
ORIGIN = np.array([0.0, 84.0, 0.0])
P = d['positions'].astype(np.float64)
q = np.round((P - ORIGIN) / STEP)
assert np.abs(q).max() < 32767, '超出 int16 範圍'
tris = d['tris'].astype(np.uint32)
# 分區：中性型的頂點法線（三角形面法線平均）
k0 = int(np.argmin(np.abs(d['F'] - d['F0'])))
P0 = P[k0]
N = np.zeros_like(P0)
fn = np.cross(P0[tris[:, 1]] - P0[tris[:, 0]], P0[tris[:, 2]] - P0[tris[:, 0]])
for c in range(3):
    np.add.at(N, tris[:, c], fn)
N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
zone = d['zone'] if 'zone' in d.files else zones(P0, N)
frames = q.astype(np.int16).tobytes()
frames += b'\0' * (-len(frames) % 4)   # 三角形索引是 uint32，起點要對齊 4 位元組
data = frames + tris.tobytes() + zone.tobytes()

# 堆積點開始長的位置（只列晚起步的，標在滑桿下）
LABELS = {'lowerBelly': '下腹', 'saddle': '大腿外側', 'flank': '腰側'}
onsets = sorted(({'F': v['on'], 'label': LABELS[k]} for k, v in info['depots'].items() if k in LABELS and v['on'] > 0),
                key=lambda t: t['F'])
F = d['F'].tolist()
meta = dict(nv=int(P.shape[1]), nt=int(len(tris)), F=F, step_F=F[1] - F[0], F0=float(d['F0']),
            hip=[round(float(v), 2) for v in d['hip']], thigh=[round(float(v), 2) for v in d['thigh']],
            step=STEP, origin=ORIGIN.tolist(), onsets=onsets, hem_y=ZONE['hem_y'],
            title=str(d['title']) if 'title' in d.files else None, axis=str(d['axis']) if 'axis' in d.files else None)
html = (Path(__file__).parent / 'fat_viewer.html').read_text()
html = html.replace('/*__META__*/null', json.dumps(meta, ensure_ascii=False))
(out / 'index.html').write_text(html.replace('/*__DATA__*/', base64.b64encode(data).decode()))
print(out / 'index.html', f'{(out / "index.html").stat().st_size / 1e6:.2f} MB')
