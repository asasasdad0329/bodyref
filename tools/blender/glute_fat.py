"""臀的純脂肪線（DECISIONS #58、#61；研究 R20）：任一全身脂肪量的形，由規律算出。

blender -b -noaudio --python tools/blender/glute_fat.py -- <輸出資料夾> [frames]

分層：設計點（中性型）＝ 底層（骨架＋肌肉）＋ 脂肪厚度 × 法線。
  厚度 T(點, F) ＝ 最薄厚度 ＋ Σ 堆積點的分布(點) × 堆積點的增長曲線(F) × 附著係數(點)
  中性型對應 F0；底層 ＝ 設計點 − T(點, F0) × 法線，所以 F0 時剛好還原中性型。
規律：
  1. 堆積點（DEPOTS）：位置（素體座標）、範圍、朝向，以及增長曲線（起始、飽和）。
     R20：分區重量隨全身脂肪接近直線但有截距，局部厚度先快後慢、各部位曲線不同
     （臀下半與大腿外側起步早、厚了變慢；腰側起步晚、一直長；下腹的比例隨變胖上升）。
  2. 附著線（ATTACH）：臀溝、臀縫、鼠蹊的厚度幾乎不長，兩邊堆起來，轉折自然變深。
  3. 下垂、柔化：之後加（見 01-glute.md）。
軸：全身脂肪量 F（公斤）。肌肉、骨架不動。

輸出：關鍵形的灰模多視圖、連續變化的影格（加上 frames 參數才算）、沿線的量測 fat_line.json、
每個取樣點的細分網格 fat_line.npz（之後給數值控制與素體控制用）。
"""
import json
import math
from pathlib import Path
import sys

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from glute_cage import cage, to_body  # noqa: E402
import glute_scene as gs  # noqa: E402

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['.']
OUT = Path(args[0])
OUT.mkdir(parents=True, exist_ok=True)
FRAMES = 'frames' in args
QUICK = 'quick' in args   # 只量測，不算圖（調參數用）
EXPORT = 'export' in args  # 另存給網頁檢視器用的網格（細分 2 次），不算圖

# ---------- 軸 ----------
# 中性型：160 cm、54.5 kg 的台灣年輕女性，DXA 體脂約 31%
F0 = 17.0
# 範圍：瘦端約 BMI 16.5（體脂約 21%）；胖端到全身體重約 204 公斤那一級（作者 2026-10-27）。
# R21：160 cm、204 kg 外推全身脂肪約 109 kg、去脂約 91 kg；純脂肪線做到 110 kg，其餘體重交給肌肉線
FMIN, FMAX = 9.0, 110.0
KEYS = [9.0, 17.0, 30.0, 50.0, 80.0, 110.0]
# 中性以上的體積規律（R20、R21）：範圍內（臀＋大腿根＋下腹、腰側的一部分）每 kg 全身脂肪多約 0.2 kg 脂肪，
# 到最胖都接近直線；每 STEP_F 公斤沿「當下」的表面法線充一次氣
REGION_SLOPE = 0.2
STEP_F = 0.5
SPREAD_REF = 33.0   # 堆積範圍外擴的速率：每 33 kg 擴 sp 倍（第一版 17～50 kg 的設定）
# 下垂：每次充氣時，厚的地方順便往下移 SAG × 這次加的厚度 × (已經比中性厚多少 ÷ 5 公分)；
# 附著線上（鼠蹊、臀溝、臀縫）不動，所以下腹垂到鼠蹊上、臀垂到臀溝上
SAG = 0.6
# 下腹前面另外加倍（腹部垂肉往下蓋過鼠蹊與恥丘）
SAG_BELLY = 2.0
# 邊界：模型上緣（98 cm 的切口）附近增長放緩到 55%，切口順著下面的趨勢延伸，之後才接得上腰
TOP_TAPER = (93.5, 98.0, 0.55)

TMIN = 0.25   # 最瘦時的皮膚加最薄皮下脂肪（公分）
GAIN = 0.9    # 全部堆積點的共同倍率；用「臀圍每 kg 全身脂肪 +0.7 公分」校準（見下方）

# ---------- 1. 堆積點 ----------
# c 中心、r 半徑（x、y、z，公分，素體座標，左側）；face 朝向（表面法線朝這個方向才長）；
# amax 最多長多厚（公分）、on 從多少 kg 全身脂肪開始長、k 飽和的快慢（越小越快飽和）；
# sp 範圍隨變胖往外擴的程度：局部厚度會飽和，但堆積的範圍越來越大（R20：分區重量仍接近直線增加）。
DEPOTS = {
    'everywhere':  dict(c=None, amax=2.2, on=0.0, k=30.0),
    'buttock':     dict(c=(6.0, 81.0, -11.0), r=(7.0, 7.0, 7.0), face=(0, 0, -1), amax=4.5, on=0.0, k=28.0, sp=0.6),
    'lowerButtock': dict(c=(6.5, 77.5, -9.5), r=(6.0, 3.5, 6.0), face=(0, -0.6, -1), amax=2.5, on=0.0, k=18.0, sp=0.5),
    'hipDip':      dict(c=(15.5, 86.5, -4.5), r=(3.0, 3.0, 3.5), face=(1, 0, -0.6), amax=1.4, on=0.0, k=7.0, sp=0.0),
    'saddle':      dict(c=(15.5, 78.0, -1.0), r=(4.0, 4.5, 6.0), face=(1, 0, 0), amax=5.0, on=14.0, k=24.0, sp=0.7),
    'flank':       dict(c=(13.5, 100.5, -2.0), r=(5.0, 3.0, 6.0), face=(1, 0, 0), amax=6.0, on=18.0, k=45.0, sp=0.8),
    'lowerBelly':  dict(c=(0.0, 88.0, 8.0), r=(8.0, 5.0, 5.0), face=(0, 0, 1), amax=4.5, on=10.0, k=35.0, sp=0.8),
    'mons':        dict(c=(0.0, 81.0, 7.0), r=(3.5, 2.0, 3.0), face=(0, 0, 1), amax=1.8, on=0.0, k=25.0, sp=0.3),
    'innerThigh':  dict(c=(3.5, 73.0, 1.0), r=(3.0, 4.0, 5.0), face=(-1, 0, 0), amax=2.2, on=8.0, k=25.0, sp=0.4),
    'backThigh':   dict(c=(8.0, 73.5, -9.0), r=(5.0, 3.0, 4.0), face=(0, 0, -1), amax=1.8, on=15.0, k=25.0, sp=0.5),
}

# ---------- 2. 附著線 ----------
# 每條線：在線上的點，厚度增長乘上 (1 − s)，離線 w 公分內平滑恢復


def attach(V, N):
    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    a = np.ones(len(V))
    back = np.clip(-N[:, 2], 0, 1)
    front = np.clip(N[:, 2], 0, 1)
    # 臀溝：臀下內側，高度約 75.5，外端略往上、漸淡
    yf = 75.5 + 0.12 * np.clip(x - 3, 0, None)
    a *= 1 - 0.85 * np.exp(-((y - yf) / 1.1) ** 2) * np.exp(-(np.clip(x - 6, 0, None) / 4) ** 2) * (z < -3)
    # 臀縫：正中後方，79～90
    a *= 1 - 0.9 * np.exp(-(x / 1.4) ** 2) * (z < -3) * np.clip((90.5 - y) / 2, 0, 1) * np.clip((y - 76) / 2, 0, 1)
    # 薦骨正中：上背正中的薄區
    a *= 1 - 0.6 * np.exp(-(x / 2.5) ** 2) * back * np.clip((y - 89) / 3, 0, 1)
    # 鼠蹊：髂前上棘（11.5, 92）斜到胯下（3, 79）
    p0, p1 = np.array([11.5, 92.0]), np.array([3.0, 79.0])
    d = p1 - p0
    t = np.clip(((np.stack([x, y], 1) - p0) @ d) / (d @ d), 0, 1)
    dist = np.linalg.norm(np.stack([x, y], 1) - (p0 + t[:, None] * d), axis=1)
    # 下段（胯下、大腿根）最強，往髂前上棘漸弱：很胖時深摺在下段，上段的脂肪連續披到兩側
    a *= 1 - 0.45 * np.exp(-(dist / 1.8) ** 2) * front * np.clip((90.0 - y) / 6.0, 0, 1)
    return a


# ---------- 規律 ----------
def growth(F, on, k):
    """增長曲線：從 on 公斤開始（平滑起步），先快後慢，k 越小越快飽和。值在 0～1。"""
    u = 2.0 * np.log1p(np.exp((F - on) / 2.0))
    return 1 - np.exp(-u / k)


def normals(V, Fc):
    """設計點的法線（左半網格的面法線平均）；正中的點只留 y、z 分量。"""
    N = np.zeros_like(V)
    for f in Fc:
        p = V[list(f)]
        n = np.cross(p[2] - p[0], p[3] - p[1])
        for i in f:
            N[i] += n
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    # 朝外：和「離身體中軸的水平方向」平均要同號
    out = V - [0.0, 0.0, V[:, 2].mean()]
    out[:, 1] = 0
    if (np.einsum('ij,ij->i', N, out) < 0).mean() > 0.5:
        N = -N
    N[np.abs(V[:, 0]) < 1e-6, 0] = 0
    return N / np.linalg.norm(N, axis=1, keepdims=True)


def maps(V, N, F):
    """每個堆積點在每個設計點上的分布（0～1）。範圍隨脂肪量擴大（中性時是原本的半徑）。"""
    M = {}
    for name, d in DEPOTS.items():
        if d['c'] is None:
            M[name] = np.ones(len(V))
            continue
        c, r, f = np.array(d['c']), np.array(d['r']), np.array(d['face'], float)
        f /= np.linalg.norm(f)
        q = (V - c) / (r * (1 + d['sp'] * (F - F0) / SPREAD_REF))
        M[name] = np.exp(-0.5 * (q ** 2).sum(1)) * np.clip(N @ f, 0, 1)
    return M


def thickness(F, V, N, A):
    M = maps(V, N, F)
    T = np.full(len(A), TMIN)
    for name, d in DEPOTS.items():
        T += GAIN * d['amax'] * growth(F, d['on'], d['k']) * M[name] * A
    return T


def areas(V, Fc):
    """每個設計點分到的表面積（左半網格，每個四邊形面積平均分給四個角）。"""
    a = np.zeros(len(V))
    for f in Fc:
        p = V[list(f)]
        a[list(f)] += 0.25 * 0.5 * np.linalg.norm(np.cross(p[2] - p[0], p[3] - p[1]))
    return a


def constrain(V, mid, leg):
    V[:, 1] = np.maximum(V[:, 1], 69.5)  # 下垂不能越過大腿下緣的切口
    V[mid, 0] = 0
    V[leg, 0] = np.maximum(V[leg, 0], 0.1)  # 大腿內側最多貼合，不穿過正中
    return V


def closed_form(F, base, N, A, mid, leg):
    """中性以下（變瘦）：底層＋厚度 × 中性法線。"""
    return constrain(base + thickness(F, V0, N, A)[:, None] * N, mid, leg)


def distribution(F, A):
    """此刻新增的脂肪往哪裡去：各堆積點增長曲線的斜率 × 分布（用中性位置算，堆積點跟著組織走）。"""
    M = maps(V0, N0, F)
    w = np.zeros(len(A))
    for name, d in DEPOTS.items():
        w += d['amax'] * (growth(F + 0.25, d['on'], d['k']) - growth(F - 0.25, d['on'], d['k'])) / 0.5 * M[name]
    y0, y1, keep = TOP_TAPER
    w *= 1 - (1 - keep) * np.clip((V0[:, 1] - y0) / (y1 - y0), 0, 1)
    return w * A


_states = {}


def shape(F, base, N, A, mid, leg):
    """任一全身脂肪量 F 的設計點。中性以下用公式；中性以上從中性一步步充氣：
    每 STEP_F 公斤加 REGION_SLOPE × STEP_F 公斤的脂肪體積，照堆積點的分布沿當下的法線往外推。
    結果只由 F 決定（每次都從中性、用同樣的步長走到 F）。"""
    if F <= F0:
        return closed_form(F, base, N, A, mid, leg)
    n = int(round((F - F0) / STEP_F * 1e6)) // 1000000
    k = max([j for j in _states if j <= n], default=0)
    V = _states[k].copy() if k else V0.copy()
    for j in range(k, n):
        Fj = F0 + (j + 0.5) * STEP_F
        V = inflate(V, Fj, STEP_F, A, mid, leg)
        _states[j + 1] = V.copy()
    rest = F - (F0 + n * STEP_F)
    if rest > 1e-9:
        V = inflate(V, F0 + n * STEP_F + rest / 2, rest, A, mid, leg)
    return V


def inflate(V, F, dF, A, mid, leg):
    w = distribution(F, A)
    area = areas(V, Fc)
    vol = REGION_SLOPE * dF / 0.9 * 1000          # 公分³（脂肪密度 0.9）
    dT = vol * w / (2 * (area * w).sum())         # 左右兩半
    V = V + dT[:, None] * normals(V, Fc)
    excess = np.linalg.norm(V - V0, axis=1)       # 已經比中性厚了多少（中性以上只有脂肪在變）
    V[:, 1] -= SAG * dT * excess / 5.0 * A * SAG_MAP
    return constrain(V, mid, leg)


# ---------- 中性型拆層 ----------
V0, Fc = cage()
N0 = normals(V0, Fc)
A0 = attach(V0, N0)
mid = np.abs(V0[:, 0]) < 1e-6
leg = (V0[:, 1] < 77.6) & ~mid
T0 = thickness(F0, V0, N0, A0)
AREA = areas(V0, Fc)
base = V0 - T0[:, None] * N0
# 下垂的分布：下腹前面加倍；越靠近上下邊界（98、69.5 cm 的切口）越小，邊界本身不動，之後才接得上腰和大腿
SAG_MAP = 1 + (SAG_BELLY - 1) * np.clip(N0[:, 2], 0, 1) * np.exp(-((V0[:, 1] - 87.0) / 5.0) ** 2) * np.exp(-(V0[:, 0] / 9.0) ** 2)
SAG_MAP *= np.clip((98.0 - V0[:, 1]) / 3.0, 0, 1) * np.clip((V0[:, 1] - 69.5) / 4.0, 0, 1)
print('中性脂肪厚度（公分）：最薄', round(float(T0.min()), 2), '最厚', round(float(T0.max()), 2))
assert np.abs(shape(F0, base, N0, A0, mid, leg) - V0).max() < 1e-9, '底層＋中性厚度要還原中性型'

obj = gs.build(V0, Fc)
studio = gs.Studio(obj)


def solve(F):
    """每個脂肪量都從設計點重新擬合（不接續上一個），結果只由 F 決定，和計算順序無關。"""
    V = shape(F, base, N0, A0, mid, leg)
    C, err = gs.fit_cage(obj, V, Fc)
    P, E, _ = gs.evaluated(obj)
    m, prof = gs.measure(P, E)
    return C, P, m, prof


# ---------- 沿線量測（每 1 kg） ----------
Fs = np.arange(FMIN, FMAX + 0.01, 1.0)


def viewer_mesh():
    """目前形狀細分 2 次的網格（頂點、三角形），給網頁檢視器；細分 3 次的檔太大，手機載入慢。"""
    subd = obj.modifiers['subd']
    subd.levels = 2
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    ev = obj.evaluated_get(dg)
    m = ev.to_mesh()
    P = to_body(np.array([v.co[:] for v in m.vertices]))
    tris = [(p[0], p[i], p[i + 1]) for p in (q.vertices[:] for q in m.polygons) for i in range(1, len(p) - 1)]
    ev.to_mesh_clear()
    subd.levels = 3
    dg.update()
    return P.astype(np.float32), np.array(tris, np.uint32)


rows, meshes, view_meshes = [], [], []
for F in Fs:
    C, P, m, prof = solve(F)
    if EXPORT:
        view_meshes.append(viewer_mesh())
    meshes.append(P.astype(np.float32))
    # 範圍內脂肪層多了多少公斤（左右兩半；脂肪密度 0.9）。中性以上照體積規律，是設定值
    m['fatKg'] = round(float(2 * (AREA * (thickness(F, V0, N0, A0) - T0)).sum() * 0.9 / 1000), 3) if F <= F0 \
        else round(REGION_SLOPE * (F - F0), 3)
    rows.append(dict(F=float(F), **m))
    print(f'F {F:4.1f} kg  範圍內脂肪 {m["fatKg"]:+6.2f}  臀圍 {m["hipCirc"]:6.2f}  寬 {m["hipBreadth"]:5.2f}  厚 {m["buttockDepth"]:5.2f}  大腿圍 {m["thighCirc"]:5.2f}')
hip = np.array([r['hipCirc'] for r in rows])
slope = np.gradient(hip, Fs)
i0 = int(np.argmin(np.abs(Fs - F0)))
print('中性附近臀圍斜率（公分/kg）', round(float(slope[i0]), 3), '目標約 0.7（R19×R20）')
# 內插檢查：每 1 kg 之間的中點，用相鄰兩點直線內插和實際算出的形差多少
mid_err = []
for k in (0, len(Fs) // 2, len(Fs) - 2):
    Fm = (Fs[k] + Fs[k + 1]) / 2
    _, Pm, _, _ = solve(Fm)
    mid_err.append(float(np.abs(Pm - (meshes[k] + meshes[k + 1]) / 2).max()))
print('每 1 kg 取樣的中點內插誤差（公分）', [round(e, 3) for e in mid_err])
(OUT / 'fat_line.json').write_text(json.dumps(dict(F0=F0, rows=rows, hipSlope=[round(float(s), 3) for s in slope],
                                                   midpointError=mid_err, depots=DEPOTS), ensure_ascii=False, indent=1))
np.savez_compressed(OUT / 'fat_line.npz', F=Fs, positions=np.stack(meshes), base=base, design=V0, normals=N0,
                    thickness0=T0)

# ---------- 關鍵形與影格 ----------
if EXPORT:
    np.savez_compressed(OUT / 'fat_viewer.npz', F=Fs, positions=np.stack([v[0] for v in view_meshes]),
                        tris=view_meshes[0][1], F0=F0, hip=hip, thigh=np.array([r['thighCirc'] for r in rows]))
if QUICK or EXPORT:
    sys.exit(0)
# 所有關鍵形用同一個比例尺（放得下最胖的形），大小才能互相比較
studio.cam.data.ortho_scale = max(46.0, max(r['hipBreadth'] for r in rows) + 14)
for F in KEYS:
    solve(F)
    for view in gs.VIEWS:
        studio.shoot(OUT / f'key-{F:04.1f}-{view}.png', view)
if FRAMES:
    studio.scene.render.resolution_x = studio.scene.render.resolution_y = 450
    studio.scene.eevee.taa_render_samples = 12
    for i, F in enumerate(np.arange(FMIN, FMAX + 0.01, 1.0)):
        solve(F)
        for view in ('front', 'side', 'back', 'rearQuarter'):
            studio.shoot(OUT / 'frames' / f'{i:03d}-{view}.png', view)
