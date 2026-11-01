"""④ 素體控制（DECISIONS #80～#82）：網站素體（MakeHuman）整個細分一次，臀那一圈跟著臀的模走。

臀的控制籠是素體臀那一圈（738 點）切出來、對齊、細分一次做成的（glute_mh.build；站姿另外由
glute_mh_frame 張回 MakeHuman 原本的與肩同寬，#81）。素體整個細分一次之後（#82），臀那一圈的點
和控制籠一點對一點：
  頂點點 ↔ 原本的頂點、邊點 ↔ 原本的邊、面點 ↔ 原本的面（gm.subdivide 的編號規則）。
所以不用另外找對應。做法：
  1. 素體整個對齊到臀的模的空間（胯下高度，glute_mh.Glute.align），細分一次。
  2. 臀那一圈的點放到模在這個狀態的平滑曲面上（模再細分兩次後同一個編號的點，接近極限曲面）。
  3. 圈外 FADE 公分內照位移平順漸弱（拉普拉斯），之後由腰、大腿兩個部位接手。
控制數據就是臀那一圈 2873 個點的位置（或位移）；圈外的漸弱是固定的線性運算，網站自己算。
python3 tools/blender/glute_mh_bind.py <out.npz> 名稱=<npz>:<鍵或第幾個> ...
只用 numpy、scipy。
"""
import sys
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import splu
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glute_mh as gm  # noqa: E402

FADE = 12.0


def edge_index(F):
    """gm.subdivide 的邊編號：所有 (小, 大) 頂點對排序後的位置。"""
    ef = gm.edge_faces(F)
    return {e: i for i, e in enumerate(sorted(ef))}


class Binding:
    def __init__(self):
        P, Q, _ = gm.load_mh()
        g = gm.Glute()
        used = cKDTree(P).query(g.V)[1]
        assert np.abs(P[used] - g.V).max() < 1e-9
        Fr = g.F
        # 素體整個對齊（照 Glute.align 的式子）
        g.align()
        sh, cf, top, dz = 77.0 - 73.9, 73.9, 100.5, -3.8
        Pa = P.copy()
        Pa[:, 1] = Pa[:, 1] + sh * (1 - np.clip((Pa[:, 1] - cf) / (top - cf), 0, 1))
        Pa[:, 2] += dz
        assert np.abs(Pa[used] - g.V).max() < 1e-9
        # 細分一次：素體與臀那一圈
        self.B1, self.Q1 = gm.subdivide(Pa, Q)
        nv, nr = len(P), len(used)
        eg, er = edge_index(Q), edge_index(Fr)
        fg = {tuple(sorted(q)): i for i, q in enumerate(Q)}
        M = np.empty(nr + len(er) + len(Fr), int)
        M[:nr] = used
        for (a, b), i in er.items():
            u, v = sorted((used[a], used[b]))
            M[nr + i] = nv + eg[(u, v)]
        for fi, q in enumerate(Fr):
            M[nr + len(er) + fi] = nv + len(eg) + fg[tuple(sorted(used[q]))]
        self.M = M
        n1 = len(self.B1)
        inreg = np.zeros(n1, bool)
        inreg[M] = True
        self.inreg = inreg
        # 圈外漸弱：離臀那一圈 FADE 公分以上不動，中間解拉普拉斯
        r, c = [], []
        for q in self.Q1:
            for k in range(4):
                r += [q[k], q[(k + 1) % 4]]
                c += [q[(k + 1) % 4], q[k]]
        A = coo_matrix((np.ones(len(r)), (r, c)), shape=(n1, n1)).tocsr()
        A.data[:] = 1
        L = (coo_matrix((np.asarray(A.sum(1)).ravel(), (np.arange(n1), np.arange(n1))), shape=A.shape) - A).tocsr()
        dist = cKDTree(self.B1[M]).query(self.B1)[0]
        fixed = inreg | (dist > FADE)
        self.free, self.fix = np.nonzero(~fixed)[0], np.nonzero(fixed)[0]
        self.Lfx = L[self.free][:, self.fix]
        self.lu = splu(L[self.free][:, self.free].tocsc())

    def state(self, Vs, F):
        """模在狀態 Vs（控制籠）時的細分一次素體。"""
        S = gm.preview(Vs, F, 2)[0][:len(self.M)]          # 接近極限曲面的位置
        D = np.zeros_like(self.B1)
        D[self.M] = S - self.B1[self.M]
        rhs = -(self.Lfx @ D[self.fix])
        for k in range(3):
            D[self.free, k] = self.lu.solve(rhs[:, k])
        return self.B1 + D


if __name__ == '__main__':
    out = sys.argv[1]
    bd = Binding()
    Fc = gm.build().F
    frames_b, frames_m, labels = [], [], []
    for spec in sys.argv[2:]:
        lab, path = spec.split('=')
        f, key = path.split(':')
        d = np.load(f)
        Vs = (d[key] if key in d.files else d['cages'][int(key)]).astype(float)
        frames_b.append(bd.state(Vs, Fc))
        frames_m.append(gm.preview(Vs, Fc, 2)[0])
        labels.append(lab)
    B = np.stack(frames_b)
    keep = (np.abs(bd.B1[:, 0]) < 26) & (bd.B1[:, 1] > 60) & (bd.B1[:, 1] < 106)
    Qk = bd.Q1[keep[bd.Q1].all(1)]
    used = np.unique(Qk)
    remap = -np.ones(len(bd.B1), int)
    remap[used] = np.arange(len(used))
    Qk = remap[Qk]
    np.savez_compressed(out, base=B[:, used].astype(np.float32), model=np.stack(frames_m).astype(np.float32),
                        tris=np.r_[Qk[:, [0, 1, 2]], Qk[:, [0, 2, 3]]].astype(np.uint32), labels=np.array(labels))
    print('素體細分一次', len(bd.B1), '點；臀那一圈', len(bd.M), '點；畫的範圍', len(used), '點')
