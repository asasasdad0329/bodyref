"""④ 素體控制的小試驗（DECISIONS #80）：網站素體（MakeHuman，約 13,000 點，網站不細分）的臀那一圈跟著臀的模走。

臀的控制籠是素體臀那一圈切出來、對齊、轉成站姿、細分一次做成的（glute_mh.build），所以素體上臀那一圈的
每一點（738 點）都對應到控制籠的一個點（細分時的「頂點點」，編號相同），不用另外找對應。
  1. 素體整個轉到臀的模的空間：對齊（胯下高度）＋站姿（兩腿往內 5°，臀那一圈照 pose_legs，圈外的腿整條轉）。
  2. 臀那一圈的點加上對應點的位移（模在這個狀態細分兩次後的位置 − 中性時的位置）。
  3. 圈外 FADE 公分內照位移平順漸弱（拉普拉斯），之後由腰、大腿兩個部位接手。
python3 tools/blender/glute_mh_bind.py <out.npz> 名稱=<npz>:<鍵或第幾個> ...
只用 numpy、scipy。
"""
import sys, json, numpy as np
sys.path.insert(0, '/home/user/bodyref/tools/blender')
import glute_mh as gm, glute_mh_contact as gc
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve

ROOT = '/home/user/bodyref'
P, Q, J = gm.load_mh()
m = json.load(open(f'{ROOT}/src/body/mh/manifest.json'))
buf = open(f'{ROOT}/public/body.bin', 'rb').read()
reg = np.frombuffer(buf, np.uint8, m['vertexCount'], m['region'])[:len(P)]
names = m['regions']
leg = np.isin(reg, [names.index(k) for k in ('thighL', 'thighR', 'calfL', 'calfR', 'footL', 'footR')])

g = gm.Glute()
used = cKDTree(P).query(g.V)[1]
assert np.abs(P[used] - g.V).max() < 1e-9
nr = len(used)
inreg = np.zeros(len(P), bool); inreg[used] = True
# 對齊（照 Glute.align 的式子套到整個素體）
sh, cf, top, dz = 77.0 - 73.9, 73.9, 100.5, -3.8
Pb = P.copy()
Pb[:, 1] = Pb[:, 1] + sh * (1 - np.clip((Pb[:, 1] - cf) / (top - cf), 0, 1)); Pb[:, 2] += dz
g.align(); V_al = g.V.copy(); g.pose_legs()
# 站姿：臀那一圈用 pose_legs 的結果；圈外的腿整條轉（權重 1）
Jl = g.J
for side, sgn in (('l-upper-leg', 1), ('r-upper-leg', -1)):
    mm = leg & ~inreg & (np.sign(Pb[:, 0]) == sgn)
    c = Jl[side]; a = -sgn * np.radians(5.0)
    d = Pb[mm][:, :2] - c[:2]
    Pb[mm, 0] = c[0] + np.cos(a) * d[:, 0] - np.sin(a) * d[:, 1]
    Pb[mm, 1] = c[1] + np.sin(a) * d[:, 0] + np.cos(a) * d[:, 1]
Pb[used] = g.V
g.densify()
Fc = g.F

def neighbours(n, Q):
    r, c = [], []
    for q in Q:
        for k in range(4):
            r += [q[k], q[(k + 1) % 4]]; c += [q[(k + 1) % 4], q[k]]
    A = coo_matrix((np.ones(len(r)), (r, c)), shape=(n, n)).tocsr(); A.data[:] = 1
    return A

A = neighbours(len(P), Q)
deg = np.asarray(A.sum(1)).ravel()
# 圈外：離臀那一圈 FADE 公分以上不動，中間解拉普拉斯（平順漸弱）
FADE = 12.0
dist = cKDTree(Pb[used]).query(Pb)[0]
fixed = inreg | (dist > FADE)
free = np.nonzero(~fixed)[0]
L = (coo_matrix((deg, (np.arange(len(P)), np.arange(len(P)))), shape=A.shape) - A).tocsr()
Lff = L[free][:, free].tocsc()

def base_state(Vs, V0):
    Ps = gm.preview(Vs, Fc, 2)[0][:nr]; P0 = gm.preview(V0, Fc, 2)[0][:nr]
    D = np.zeros((len(P), 3)); D[used] = Ps - P0
    rhs = -(L[free][:, np.nonzero(fixed)[0]] @ D[fixed])
    for k in range(3):
        D[free, k] = spsolve(Lff, rhs[:, k])
    return Pb + D

if __name__ == '__main__':
    out = sys.argv[1]
    V0 = gm.build().V
    states = [l.split('=') for l in sys.argv[2:]]
    keep = (np.abs(Pb[:, 0]) < 26) & (Pb[:, 1] > 55) & (Pb[:, 1] < 112) & ~((~leg) & (np.abs(Pb[:, 0]) > 18) & (Pb[:, 1] < 100))
    Qk = Q[keep[Q].all(1)]
    idx = -np.ones(len(P), int); idx[np.nonzero(keep)[0]] = np.arange(keep.sum())
    res = {'tris': np.r_[idx[Qk][:, [0, 1, 2]], idx[Qk][:, [0, 2, 3]]].astype(np.uint32)}
    frames_b, frames_m = [], []
    for lab, path in states:
        f, key = path.split(':')
        d = np.load(f)
        Vs = (d[key] if key in d.files else d['cages'][int(key)]).astype(float)
        frames_b.append(base_state(Vs, V0)[keep]); frames_m.append(gm.preview(Vs, Fc, 2)[0])
    np.savez_compressed(out, base=np.stack(frames_b).astype(np.float32), model=np.stack(frames_m).astype(np.float32),
                        labels=np.array([s[0] for s in states]), **res)
    print('region verts', nr, 'base kept', keep.sum(), 'tris', len(res['tris']))
