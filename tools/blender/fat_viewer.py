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
js = next(src.glob('*_line.json'), None)
info = json.loads(js.read_text()) if js else dict(depots={})

STEP = 0.002
ORIGIN = np.array([0.0, 84.0, 0.0])
P = d['positions'].astype(np.float64)
pair = 'positions2' in d.files            # 並排比較：第二組網格接在第一組後面
Pall = np.concatenate([P, d['positions2'].astype(np.float64)]) if pair else P
q = np.round((Pall - ORIGIN) / STEP)
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
# 褲管以下的大腿：顏色用平順的漸層（逐點硬分會在分界畫出一道鋸齒，看起來像一圈凸起）
yy = P0[:, 1]
u = np.clip((73.6 - yy) / 1.2, 0, 1)
zw = np.where(zone == 1, 0, np.round(255 * u * u * (3 - 2 * u))).astype(np.uint8)
zone = np.where(zone == 2, 0, zone).astype(np.uint8)


def boundary_loops(T):
    """開口（切口）的邊界環，各自照順序排好。"""
    from collections import Counter, defaultdict
    cnt = Counter(tuple(sorted(e)) for t in T for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])))
    adj = defaultdict(list)
    for (a, b), c in cnt.items():
        if c == 1:
            adj[a].append(b); adj[b].append(a)
    seen, loops = set(), []
    for s0 in adj:
        if s0 in seen:
            continue
        loop, prev, cur = [s0], None, s0
        seen.add(s0)
        while True:
            nxt = [v for v in adj[cur] if v != prev and v not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            loop.append(cur); seen.add(cur)
        loops.append(np.array(loop))
    return loops


# 切口封起來（只是顯示；另外著色）：不然從下面看得到大腿筒子的內面，看起來像一圈
nv0 = q.shape[1]
caps, cap_tris = [], []
base = nv0
for loop in boundary_loops(tris):
    k = len(loop)
    caps.append(loop)
    ring = base + np.arange(k)
    centre = base + k
    cap_tris += [[ring[i], ring[(i + 1) % k], centre] for i in range(k)]
    base += k + 1
if caps:
    ext = []
    for fr in Pall:
        add = []
        for loop in caps:
            add.append(fr[loop]); add.append(fr[loop].mean(0, keepdims=True))
        ext.append(np.concatenate([fr] + add))
    Pall = np.stack(ext)
    q = np.round((Pall - ORIGIN) / STEP)
    tris = np.concatenate([tris, np.array(cap_tris, np.uint32)]).astype(np.uint32)
    ncap = base - nv0
    zone = np.concatenate([zone, np.full(ncap, 3, np.uint8)])
    zw = np.concatenate([zw, np.zeros(ncap, np.uint8)])
assert np.abs(q).max() < 32767, '超出 int16 範圍'
frames = q.astype(np.int16).tobytes()
frames += b'\0' * (-len(frames) % 4)   # 三角形索引是 uint32，起點要對齊 4 位元組
data = frames + tris.tobytes() + zone.tobytes() + zw.tobytes()

# 堆積點開始長的位置（只列晚起步的，標在滑桿下）
LABELS = {'lowerBelly': '下腹', 'saddle': '大腿外側', 'flank': '腰側'}
onsets = sorted(({'F': v['on'], 'label': LABELS[k]} for k, v in info['depots'].items() if k in LABELS and v['on'] > 0),
                key=lambda t: t['F'])
F = d['F'].tolist()
meta = dict(nv=int(q.shape[1]), nt=int(len(tris)), nt_surface=int(len(tris) - (len(cap_tris) if caps else 0)), F=F, zw=True, step_F=F[1] - F[0], F0=float(d['F0']),
            hip=[round(float(v), 2) for v in d['hip']], thigh=[round(float(v), 2) for v in d['thigh']],
            step=STEP, origin=ORIGIN.tolist(), onsets=onsets, hem_y=ZONE['hem_y'],
            title=str(d['title']) if 'title' in d.files else None, axis=str(d['axis']) if 'axis' in d.files else None,
            extra=[str(t) for t in d['extra']] if 'extra' in d.files else None,
            hide_value=bool(d['hide_value']) if 'hide_value' in d.files else False,
            pair=[str(t) for t in d['pair']] if pair else None,
            hip2=[round(float(v), 2) for v in d['hip2']] if pair else None,
            sub=[[str(t) for t in row] for row in d['sub']] if 'sub' in d.files else None)
html = (Path(__file__).parent / 'fat_viewer.html').read_text()
if meta['title']:
    html = html.replace('<title>臀・純脂肪線</title>', f"<title>{meta['title']}</title>").replace('<h1>臀・純脂肪線</h1>', f"<h1>{meta['title']}</h1>")
html = html.replace('/*__META__*/null', json.dumps(meta, ensure_ascii=False))
(out / 'index.html').write_text(html.replace('/*__DATA__*/', base64.b64encode(data).decode()))
print(out / 'index.html', f'{(out / "index.html").stat().st_size / 1e6:.2f} MB')
