"""④ 素體控制（DECISIONS #80～#82）：網站素體（MakeHuman）整個細分一次，臀那一圈跟著臀的模走。

臀的控制籠是素體臀那一圈（738 點）切出來、對齊、細分一次做成的（glute_mh.build；站姿另外由
glute_mh_frame 張回 MakeHuman 原本的與肩同寬，#81）。素體整個細分一次之後（#82），臀那一圈的點
和控制籠一點對一點：
  頂點點 ↔ 原本的頂點、邊點 ↔ 原本的邊、面點 ↔ 原本的面（gm.subdivide 的編號規則）。
所以不用另外找對應。做法：
  1. 網站的骨架（四肢長度、縮放到身高、骨盆寬，還沒有軟組織）細分一次。骨盆寬由網站的骨架做（pelvis.ts，
     規則和 glute_mh_frame 相同），這裡的參考就用同一個骨盆寬的中性型，位移只剩軟組織。
  2. 模的變形量（這個狀態 − 參考，參考是模在 MakeHuman 站姿、還沒任何變形時）先轉回 MakeHuman 原本的空間
     （還原 Glute.align 的胯下對齊），再照網站骨架在每一點的局部縮放、拉長（鄰邊最小平方）加到網站骨架的平滑曲面上。
     網站 160 公分的骨架和 MakeHuman 起點差 0.25 公分內；身高、腿長變了，臀那一圈跟著平移、縮放、拉長。
  3. 圈外 FADE 公分內平順接回網站其他部位現在的形（拉普拉斯），之後由腰、大腿兩個部位接手。
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


ALIGN = dict(sh=77.0 - 73.9, cf=73.9, top=100.5, dz=-3.8)     # glute_mh.Glute.align 的參數


def unalign(V):
    """臀的模的空間（胯下對齊到 77、前後移 dz）→ MakeHuman 原本的空間（Glute.align 的反函數）。"""
    sh, cf, top, dz = ALIGN['sh'], ALIGN['cf'], ALIGN['top'], ALIGN['dz']
    out = V.copy()
    y = V[:, 1]
    k = 1 - sh / (top - cf)
    out[:, 1] = np.where(y >= top, y, np.where(y < cf + sh, y - sh, (y - sh * top / (top - cf)) / k))
    out[:, 2] = V[:, 2] - dz
    return out


def limit_points(P, Q, n):
    """細分兩次後前 n 個點（原本那些頂點的「頂點點」），接近極限曲面。"""
    V, F = gm.subdivide(P, Q)
    V, F = gm.subdivide(V, F)
    return V[:n]


class Binding:
    def __init__(self, skel=None, final=None, ref=None):
        """skel：網站的骨架（四肢長度、縮放到身高、骨盆寬，還沒有軟組織；13,380 點），預設 MakeHuman 起點（160 公分）。
        final：網站其他部位現在的形（切口外面接回去的對象），預設同 skel。
        ref：臀的模裡和 skel 同一副骨架的中性型（控制籠）。網站的骨架已經有骨盆寬（src/body/mh/pelvis.ts）時，
        傳那個骨盆寬的中性型（glute_mh_frame.Frame.neutral），位移就只剩軟組織；預設是 MakeHuman 站姿的起點。"""
        P, Q, _ = gm.load_mh()
        g = gm.Glute()
        used = cKDTree(P).query(g.V)[1]
        assert np.abs(P[used] - g.V).max() < 1e-9
        Fr = g.F
        skel = P.copy() if skel is None else np.asarray(skel, float)
        final = skel if final is None else np.asarray(final, float)
        self.B1, self.Q1 = gm.subdivide(skel, Q)
        self.F1 = gm.subdivide(final, Q)[0]
        mh1 = gm.subdivide(P, Q)[0]
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
        self.lim = limit_points(self.B1, self.Q1, n1)[M]          # 網站骨架在臀那一圈的平滑曲面
        # 每一點的局部縮放、拉長（MakeHuman 起點 → 網站骨架，鄰邊最小平方）
        nb = gm.neighbours(n1, self.Q1)
        self.J = np.empty((len(M), 3, 3))
        for k, i in enumerate(M):
            js = list(nb[i])
            E0, E1 = mh1[js] - mh1[i], self.B1[js] - self.B1[i]
            self.J[k] = np.linalg.lstsq(E0, E1, rcond=None)[0].T
        # 參考：臀的模在 MakeHuman 站姿、還沒有任何變形時（glute_mh_frame 張回 5°）
        import glute_mh_frame as gfr
        fr = gfr.Frame()
        self.Fc = fr.F
        ref = fr.stance(fr.V, gfr.STANCE_POSE) if ref is None else np.asarray(ref, float)
        self.ref = unalign(gm.preview(ref, fr.F, 2)[0][:len(M)])
        inreg = np.zeros(n1, bool)
        inreg[M] = True
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

    def region(self, Vs):
        """臀的模在狀態 Vs（控制籠）時，網站上臀那一圈 2873 點的位置。"""
        d = unalign(gm.preview(Vs, self.Fc, 2)[0][:len(self.M)]) - self.ref
        return self.lim + np.einsum('kij,kj->ki', self.J, d)

    def state(self, Vs):
        """細分一次的整個素體：臀那一圈照模，切口外面平順接回網站其他部位現在的形。"""
        R = self.region(Vs)
        D = np.zeros_like(self.F1)
        D[self.M] = R - self.F1[self.M]
        rhs = -(self.Lfx @ D[self.fix])
        for k in range(3):
            D[self.free, k] = self.lu.solve(rhs[:, k])
        return self.F1 + D


if __name__ == '__main__':
    out = sys.argv[1]
    bd = Binding()
    Fc = bd.Fc
    frames_b, frames_m, labels = [], [], []
    for spec in sys.argv[2:]:
        lab, path = spec.split('=')
        f, key = path.split(':')
        d = np.load(f)
        Vs = (d[key] if key in d.files else d['cages'][int(key)]).astype(float)
        frames_b.append(bd.state(Vs))
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
