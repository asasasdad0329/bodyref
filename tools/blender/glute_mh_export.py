"""把臀的控制數據打包給網站（③ ④，DECISIONS #80～#84）：public/glute.bin ＋ src/body/mh/glute.json（位置表）。

網站拿 (脂肪 F, 去脂 L) 算 60 個方向各動多少（glute_mh_control），得到臀那一圈 2873 個點在 MakeHuman 空間的位移，
再照網站骨架放上整個細分一次的素體（glute_mh_bind 的做法）。這裡把網站要用、但不必在網站上重算的東西先算好：
  - 方向（modes）先換成網站要的形式：控制籠的位移 → 細分兩次後同一個點（接近極限曲面）的位移 → 還原胯下對齊
    （Glute.align 的反函數在每一點的斜率）。網站只要「位移 ＝ Σ 方向 × 量」。
  - 臀那一圈在細分一次的素體上的編號（M）。
  - 網站骨架的平滑曲面：細分一次的骨架再細分兩次，臀那一圈的點只跟附近的點有關，存成稀疏的係數。
  - 每一點的局部縮放（MakeHuman 160 公分 → 網站骨架）：鄰點的邊用最小平方，預先算好 A，網站上 J ＝ 邊ᵀ A。
  - 切口外漸弱的範圍（離臀那一圈 12 公分內、不含手臂），網站上用鄰點平均反覆做（拉普拉斯）。
  - 每一欄去脂的臀圍表（最翹處，glute_mh_fat.hip_prominent），臀圍有鎖時反查脂肪用。
python3 tools/blender/glute_mh_export.py <control.npz> <格子資料夾>
  全部重做的順序：glute_mh_grid（每欄去脂一次）→ glute_mh_control（找方向、擬合曲線）→ 這支。
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glute_mh as gm  # noqa: E402
import glute_mh_bind as gb  # noqa: E402
import glute_mh_contact as gc  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def main(ctl_path, grid_dir):
    d = np.load(ctl_path)
    modes = d['modes'].astype(float) * d['scale'][:, None, None]          # (K, 2873, 3) 控制籠的位移
    K, n, _ = modes.shape
    bd = gb.Binding()
    Fc = bd.Fc
    # 1. 方向：控制籠 → 細分兩次的同一點（線性）→ 還原胯下對齊的斜率
    S1, Q1 = gc.subdivision_matrix(Fc, n)
    S2, _ = gc.subdivision_matrix(Q1, S1.shape[0])
    L2 = (S2 @ S1)[:n]
    ref_model = gm.preview(bd_ref(bd), Fc, 2)[0][:n]                      # 模的空間的參考（中性）
    sh, cf, top = gb.ALIGN['sh'], gb.ALIGN['cf'], gb.ALIGN['top']
    y = ref_model[:, 1]
    k = 1 - sh / (top - cf)
    jy = np.where((y >= cf + sh) & (y < top), 1 / k, 1.0)
    out_modes = np.stack([(L2 @ modes[i]) * np.c_[np.ones(n), jy, np.ones(n)] for i in range(K)])
    scale = np.abs(out_modes).reshape(K, -1).max(1) / 32767.0
    q = np.round(out_modes / scale[:, None, None]).astype(np.int16)
    # 2. 對應、平滑曲面的係數
    P, Q, _ = gm.load_mh()
    n0 = len(P)
    B1, Q1b = gm.subdivide(P, Q)
    n1 = len(B1)
    T1, Q2b = gc.subdivision_matrix(Q1b, n1)
    T2, _ = gc.subdivision_matrix(Q2b, T1.shape[0])
    Lim = (T2 @ T1)[:n1][bd.M].tocsr()
    assert np.abs(Lim @ B1 - gb.limit_points(B1, Q1b, n1)[bd.M]).max() < 1e-6
    # 3. 局部縮放：切平面的最小平方係數 A 與法向 n0（MakeHuman 160 公分細分一次）
    nb = gm.neighbours(n1, Q1b)
    A, nrm = gb.tangent_maps(B1, Q1b, bd.M, nb)
    ptr, nbr = [0], []
    for i in bd.M:
        nbr += list(nb[i])
        ptr.append(len(nbr))
    A = np.concatenate(A)
    # 4. 切口外漸弱：離臀那一圈 12 公分內、不在臀那一圈、不是手臂
    m = json.load(open(ROOT / 'src/body/mh/manifest.json'))
    buf = open(ROOT / 'public/body.bin', 'rb').read()
    reg = np.frombuffer(buf, np.uint8, m['vertexCount'], m['region'])[:n0]
    arm0 = np.isin(reg, [m['regions'].index(r) for r in ('upperarmL', 'upperarmR', 'forearmL', 'forearmR', 'handL', 'handR')])
    arm1 = gm.subdivide(np.c_[arm0.astype(float), np.zeros(n0), np.zeros(n0)], Q)[0][:, 0] > 0.01
    inreg = np.zeros(n1, bool)
    inreg[bd.M] = True
    dist = cKDTree(B1[bd.M]).query(B1)[0]
    free = np.nonzero(~inreg & (dist <= gb.FADE) & ~arm1)[0]
    # 5. 臀圍表（最翹處）
    hips = []
    for L in d['Ls']:
        hips.append(np.maximum.accumulate(np.load(f'{grid_dir}/hipP_L{float(L):g}.npy')[:, 0]))
    hipF = np.load(f'{grid_dir}/L{float(d["Ls"][0]):g}.npz')['F']
    blobs, man = [], dict(source='glute_mh_export.py（臀的控制數據，DECISIONS #84）', modes=K, points=n,
                          level1Vertices=n1, degree=int(d['degree']))

    def put(name, arr):
        off = sum(len(b) for b in blobs)
        b = np.ascontiguousarray(arr).tobytes()
        b += b'\0' * (-len(b) % 4)
        blobs.append(b)
        man[name] = dict(offset=off, count=int(np.size(arr)), dtype=str(arr.dtype), shape=list(np.shape(arr)))
    put('Ls', d['Ls'].astype(np.float32))
    put('knots', d['knots'].astype(np.float32))
    put('coef', d['coef'].astype(np.float32))                 # (欄, 係數, 方向)
    put('modes', q)                                          # (方向, 點, 3) int16
    put('scale', scale.astype(np.float32))
    put('region', np.asarray(bd.M, np.int32))
    put('limPtr', Lim.indptr.astype(np.int32))
    put('limCol', Lim.indices.astype(np.int32))
    put('limVal', Lim.data.astype(np.float32))
    put('nbrPtr', np.asarray(ptr, np.int32))
    put('nbr', np.asarray(nbr, np.int32))
    put('nbrA', A.astype(np.float32))                         # (Σ鄰點, 3)
    put('normal0', nrm.astype(np.float32))                    # (點, 3)
    put('fade', free.astype(np.int32))
    put('hipF', hipF.astype(np.float32))
    put('hip', np.stack(hips).astype(np.float32))           # (欄, F)
    blob = b''.join(blobs)
    man['version'] = hashlib.sha256(blob).hexdigest()[:12]                # 網站下載時的快取版本
    (ROOT / 'public/glute.bin').write_bytes(blob)
    (ROOT / 'src/body/mh/glute.json').write_text(json.dumps(man, ensure_ascii=False, indent=1))
    print('glute.bin', round(sum(len(b) for b in blobs) / 1e6, 2), 'MB；漸弱', len(free), '點；平滑曲面係數', Lim.nnz)


def bd_ref(bd):
    import glute_mh_frame as gfr
    return gfr.Frame().default()


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
