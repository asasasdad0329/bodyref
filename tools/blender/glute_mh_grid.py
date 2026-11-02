"""③ 格子（DECISIONS #80、#84）：預設骨架、預設的型（沿路徑），一欄去脂 L，脂肪 FMIN～FMAX 每 1 kg 一個形。
glute_mh_control 從這些形找共用的變形方向、擬合曲線；glute_mh_export 再打包給網站。

python3 tools/blender/glute_mh_grid.py <輸出資料夾> <L>
  寫出 <輸出資料夾>/L<L>.npz（F、L、cages、quads）、L<L>.json（每個形的量測）與 hipP_L<L>.npy（每個形最翹處的
  臀圍與高度，glute_mh_fat.hip_prominent；glute_mh_export 的臀圍表用它）。
python3 tools/blender/glute_mh_grid.py <輸出資料夾> <L> hip
  只從已有的 L<L>.npz 重算 hipP_L<L>.npy。每欄約 22～25 分鐘（單核）；
  記憶體約 2 GB，4 欄同時跑會不夠。目前的 15 欄：29、34、35.3、39、44、49、54、59、64、69、74、79、84、89、91。
  另外每 8 kg 抽查一次穿面（需要 trimesh，只在這個檢查用）。只用 numpy、scipy、ipctk、trimesh。
"""
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glute_mh as gm  # noqa: E402
import glute_mh_fat as gf  # noqa: E402
import glute_mh_frame as gfr  # noqa: E402
import glute_mh_mix as gx  # noqa: E402


def self_intersections(V, F, levels=1):
    """細分 levels 次後，哪些邊穿過不相鄰的三角形（回傳穿過那段邊的中點）。"""
    import trimesh
    P, Q = gm.preview(V, F, levels)
    T = np.r_[Q[:, [0, 1, 2]], Q[:, [0, 2, 3]]]
    mesh = trimesh.Trimesh(P, T, process=False)
    E = np.unique(np.sort(np.r_[Q[:, [0, 1]], Q[:, [1, 2]], Q[:, [2, 3]], Q[:, [3, 0]]], axis=1), axis=0)
    d = P[E[:, 1]] - P[E[:, 0]]
    L = np.linalg.norm(d, axis=1)
    loc, ir, itri = trimesh.ray.ray_triangle.RayMeshIntersector(mesh).intersects_location(
        P[E[:, 0]], d / L[:, None], multiple_hits=True)
    dist = np.einsum('ij,ij->i', loc - P[E[ir, 0]], d[ir] / L[ir, None])
    tv = T[itri]
    adj = (tv == E[ir, 0][:, None]).any(1) | (tv == E[ir, 1][:, None]).any(1)
    bad = np.unique(ir[(dist > 1e-4) & (dist < L[ir] - 1e-4) & ~adj])
    return (P[E[bad, 0]] + P[E[bad, 1]]) / 2


def column(out, L):
    t0 = time.time()
    N = gfr.Frame().default()
    mx = gx.MixLine(frame=N, type='default')
    Q = mx.F
    Fs = np.arange(gf.FMIN, gf.FMAX + 0.01, 1.0)
    cages, rows = {}, {}
    for F in sorted(Fs, key=lambda f: abs(f - gf.F0)):          # 從中性往兩邊走
        V = mx.shape(float(F), L)
        m = gf.measure(gm.preview(V, Q, 2)[0])
        cages[F] = V.astype(np.float32)
        rows[F] = dict(F=float(F), L=L, t=gf.default_type(F, L), **m)
        if F % 10 == 0 or F in (Fs[0], Fs[-1]):
            print(f'L {L:g} F {F:g} 型 {rows[F]["t"]:.2f} 臀圍 {m["hipCirc"]:.1f} 大腿圍 {m["thighCirc"]:.1f} {time.time() - t0:.0f}s',
                  flush=True)
    print('穿面抽查', {int(F): len(self_intersections(cages[F].astype(float), Q)) for F in Fs[::8]}, flush=True)
    np.savez_compressed(f'{out}/L{L:g}.npz', F=Fs, L=L, cages=np.stack([cages[F] for F in Fs]), quads=Q)
    json.dump([rows[F] for F in Fs], open(f'{out}/L{L:g}.json', 'w'), ensure_ascii=False)
    hips(out, L)
    print('完成', round(time.time() - t0), '秒', flush=True)


def hips(out, L):
    d = np.load(f'{out}/L{L:g}.npz')
    np.save(f'{out}/hipP_L{L:g}.npy', np.array([gf.hip_prominent(gm.preview(V.astype(float), d['quads'], 2)[0]) for V in d['cages']]))


if __name__ == '__main__':
    if len(sys.argv) > 3 and sys.argv[3] == 'hip':
        hips(sys.argv[1], float(sys.argv[2]))
    else:
        column(sys.argv[1], float(sys.argv[2]))
