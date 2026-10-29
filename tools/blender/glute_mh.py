"""臀的中性型（DECISIONS #68、#70）：從 MakeHuman 隨附網格（CC0）的臀部那一圈起胚，一筆一筆做形。

做法：
1. 從 public/body.bin（tools/prepare_body.py 由 MakeHuman 資產產生）讀女性起始形，切出臀這一圈：
   上緣是髂嵴稍上方的一整圈軀幹邊環，下緣是兩腿各一圈邊環（#62 的範圍再多一點當連接；肚子只當連接，不處理）。
2. 對齊骨架（胯下高度），兩腿繞髖關節轉成站姿。
3. 網格當控制籠（Catmull-Clark 細分後才是曲面），先細分一次加密。
4. 「雕塑動作」：每一筆是「這一區、往哪個方向、推多少」（推、鼓、順），有名字、可以重跑、可以調。
   不用截面公式、不讓程式自動調形去追數字（#68）；每一步都看圖。
只用 numpy、scipy，不需要 Blender。座標用素體慣例：公分、y 離地、z 向前、x 向左。
"""
import json
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix, csr_matrix
from scipy.sparse.linalg import spsolve

ROOT = Path(__file__).resolve().parents[2]
HEIGHT = 160.0                 # 台灣年輕女性中位數（#51）

# ---------- 讀 MakeHuman 女性起始形 ----------

def load_mh(height=HEIGHT):
    """MakeHuman 基礎網格加上「年輕女性」形變目標，換成素體座標並縮放到 height。回傳頂點、四邊形、關節中心。"""
    m = json.load(open(ROOT / 'src/body/mh/manifest.json'))
    buf = open(ROOT / 'public/body.bin', 'rb').read()
    n, nb = m['vertexCount'], m['bodyVertexCount']
    P = np.frombuffer(buf, np.float32, n * 3, m['positions']).reshape(-1, 3).astype(float).copy()
    Q = np.frombuffer(buf, np.uint16, m['faceCount'] * 4, m['quads']).reshape(-1, 4).astype(int)
    for t in m['targets']:
        if t['name'] == 'asian-female-young':
            idx = np.frombuffer(buf, np.uint16, t['count'], t['indices'])
            P[idx] += np.frombuffer(buf, np.int16, t['count'] * 3, t['deltas']).reshape(-1, 3) * m['deltaStep']
    joints = {k: P[v[0]:v[0] + v[1]].mean(0) for k, v in m['joints'].items()}
    P, Q = P[:nb], Q[(Q < nb).all(1)]
    y0 = P[:, 1].min()
    s = height / (P[:, 1].max() - y0)
    f = lambda A: np.c_[A[..., 0] * s, (A[..., 1] - y0) * s, A[..., 2] * s]
    return f(P), Q, {k: f(v[None])[0] for k, v in joints.items()}


# ---------- 四邊形網格的工具 ----------

def edge_faces(Q):
    ef = defaultdict(list)
    for fi, q in enumerate(Q):
        for k in range(len(q)):
            a, b = q[k], q[(k + 1) % len(q)]
            ef[(min(a, b), max(a, b))].append(fi)
    return ef


def neighbours(n, Q):
    nb = [set() for _ in range(n)]
    for q in Q:
        for k in range(len(q)):
            a, b = q[k], q[(k + 1) % len(q)]
            nb[a].add(b)
            nb[b].add(a)
    return [np.array(sorted(s)) for s in nb]


def edge_loops(Q):
    """所有封閉的邊環：從一條邊出發，每到四條邊的頂點就走對面那條邊。"""
    ef = edge_faces(Q)
    ve = defaultdict(set)
    for a, b in ef:
        ve[a].add(b)
        ve[b].add(a)
    seen, out = set(), []
    for a, b in list(ef):
        if (a, b) in seen:
            continue
        seq, closed = [a, b], False
        for _ in range(3000):
            u, v = seq[-2], seq[-1]
            if len(ve[v]) != 4:
                break
            fin = set(ef[(min(u, v), max(u, v))])
            nxt = [w for w in ve[v] if w != u and not (set(ef[(min(v, w), max(v, w))]) & fin)]
            if len(nxt) != 1:
                break
            if nxt[0] == seq[0]:
                closed = True
                break
            seq.append(nxt[0])
        if closed:
            for i in range(len(seq)):
                x, y = seq[i], seq[(i + 1) % len(seq)]
                seen.add((min(x, y), max(x, y)))
            out.append(seq)
        else:
            seen.add((a, b))
    return out


def cut_region(P, Q, top_y=100.5, leg_y=67.0):
    """切出臀這一圈：上緣最接近 top_y 的軀幹邊環、下緣兩腿最接近 leg_y 的邊環，中間照面的相鄰關係填滿。"""
    L = edge_loops(Q)

    def pick(cond, target):
        cands = [l for l in L if cond(P[l])]
        return min(cands, key=lambda l: abs(P[l][:, 1].mean() - target))
    top = pick(lambda V: V[:, 0].min() < -1 and V[:, 0].max() > 1 and 60 < V[:, 1].mean() < 115 and len(V) < 60, top_y)
    legl = pick(lambda V: V[:, 0].min() > 0 and V[:, 0].max() < 25 and 50 < V[:, 1].mean() < 90, leg_y)
    legr = pick(lambda V: V[:, 0].max() < 0 and V[:, 0].min() > -25 and 50 < V[:, 1].mean() < 90, leg_y)
    bnd = set()
    for l in (top, legl, legr):
        for i in range(len(l)):
            a, b = l[i], l[(i + 1) % len(l)]
            bnd.add((min(a, b), max(a, b)))
    ef = edge_faces(Q)
    cen = P[Q].mean(1)
    seed = int(np.argmin(np.linalg.norm(cen - [0, 86, cen[:, 2].max() - 1], axis=1)))
    keep, dq = {seed}, deque([seed])
    while dq:
        q = Q[dq.popleft()]
        for k in range(4):
            e = (min(q[k], q[(k + 1) % 4]), max(q[k], q[(k + 1) % 4]))
            if e in bnd:
                continue
            for g in ef[e]:
                if g not in keep:
                    keep.add(g)
                    dq.append(g)
    F = Q[sorted(keep)]
    used = np.unique(F)
    remap = -np.ones(len(P), int)
    remap[used] = np.arange(len(used))
    return P[used].copy(), remap[F]


def subdivide(V, F):
    """Catmull-Clark 細分一次（全是四邊形；邊界照折邊規則：邊界上的點只看邊界上的鄰點）。回傳新的頂點與四邊形。"""
    nv, nf = len(V), len(F)
    ef = edge_faces(F)
    edges = np.array(sorted(ef))
    eidx = {e: i for i, e in enumerate(map(tuple, edges))}
    fp = V[F].mean(1)
    ne = len(edges)
    ep = np.empty((ne, 3))
    bnd_e = np.zeros(ne, bool)
    for i, (a, b) in enumerate(edges):
        fs = ef[(a, b)]
        if len(fs) == 2:
            ep[i] = (V[a] + V[b] + fp[fs[0]] + fp[fs[1]]) / 4
        else:
            ep[i] = (V[a] + V[b]) / 2
            bnd_e[i] = True
    vf = [[] for _ in range(nv)]
    for fi, q in enumerate(F):
        for v in q:
            vf[v].append(fi)
    ve = [[] for _ in range(nv)]
    for i, (a, b) in enumerate(edges):
        ve[a].append(i)
        ve[b].append(i)
    vp = np.empty_like(V)
    for v in range(nv):
        es = ve[v]
        be = [i for i in es if bnd_e[i]]
        if be:
            nbv = [edges[i][0] if edges[i][1] == v else edges[i][1] for i in be]
            vp[v] = 0.75 * V[v] + 0.125 * (V[nbv[0]] + V[nbv[-1]]) if len(nbv) >= 2 else V[v]
        else:
            n = len(es)
            Fa = fp[vf[v]].mean(0)
            R = np.mean([(V[edges[i][0]] + V[edges[i][1]]) / 2 for i in es], axis=0)
            vp[v] = (Fa + 2 * R + (n - 3) * V[v]) / n
    NV = np.vstack([vp, ep, fp])
    NF = []
    for fi, q in enumerate(F):
        e = [nv + eidx[(min(q[k], q[(k + 1) % 4]), max(q[k], q[(k + 1) % 4]))] for k in range(4)]
        c = nv + ne + fi
        for k in range(4):
            NF.append((q[k], e[k], c, e[k - 1]))
    return NV, np.array(NF)


def harmonic(n, nb, fixed, values):
    """在籠上解拉普拉斯方程：fixed 的點給定值，其餘是鄰點的平均（平順的權重）。"""
    free = np.setdiff1d(np.arange(n), fixed)
    idx = -np.ones(n, int)
    idx[free] = np.arange(len(free))
    val = np.zeros(n)
    val[fixed] = values
    rows, cols, vals, b = [], [], [], np.zeros(len(free))
    for i, v in enumerate(free):
        rows.append(i)
        cols.append(i)
        vals.append(len(nb[v]))
        for u in nb[v]:
            if idx[u] >= 0:
                rows.append(i)
                cols.append(idx[u])
                vals.append(-1.0)
            else:
                b[i] += val[u]
    A = csr_matrix(coo_matrix((vals, (rows, cols)), shape=(len(free),) * 2))
    val[free] = spsolve(A, b)
    return val


def vertex_normals(V, F):
    N = np.zeros_like(V)
    n = np.cross(V[F[:, 2]] - V[F[:, 0]], V[F[:, 3]] - V[F[:, 1]])
    for k in range(4):
        np.add.at(N, F[:, k], n)
    N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
    c = V.mean(0)
    if ((V - c) * N).sum(1).mean() < 0:
        N = -N
    return N


def falloff(d, r):
    """筆刷的衰減：中心 1、半徑 r 處 0，中間平順（smoothstep）。"""
    t = np.clip(1 - d / r, 0, 1)
    return t * t * (3 - 2 * t)


# ---------- 模型與動作 ----------

class Glute:
    def __init__(self):
        P, Q, J = load_mh()
        self.V, self.F = cut_region(P, Q)
        self.J = {k: J[k].copy() for k in ('l-upper-leg', 'r-upper-leg', 'pelvis')}
        self.steps = []
        self._nb = None

    @property
    def nb(self):
        if self._nb is None:
            self._nb = neighbours(len(self.V), self.F)
        return self._nb

    def mid(self):
        return np.abs(self.V[:, 0]) < 1e-6

    def _sym(self):
        """左右對稱：正中的點留在正中。"""
        self.V[self.mid(), 0] = 0.0

    # 對齊與站姿
    def align(self, crotch_from=73.9, crotch_to=77.0, top=100.5, dz=-3.8):
        """高度對齊骨架（TARGET crotch 77）：胯下以下整段往上，往上漸減到上緣不動；整體前後移 dz（臀峰到前面的中心對齊舊模）。"""
        sh = crotch_to - crotch_from

        def f(y):
            return y + sh * (1 - np.clip((y - crotch_from) / (top - crotch_from), 0, 1))
        self.V[:, 1] = f(self.V[:, 1])
        self.V[:, 2] += dz
        for k in self.J:
            self.J[k][1] = f(np.array([self.J[k][1]]))[0]
            self.J[k][2] += dz
        self.steps.append(('align', dict(crotch_to=crotch_to, dz=dz)))

    def pose_legs(self, deg=5.0, top_off=1.5, low_off=-3.0, mid_x=0.6):
        """兩腿繞髖關節往內轉 deg 度（MakeHuman 是兩腿微張的 A 字站姿）。腿跟著轉的權重在籠上平順過渡：
        髖關節上方與胯下正中附近是 0（骨盆不動），胯下下方的腿是 1。轉多了兩腿會撞在一起（12° 時已交叉）。"""
        V = self.V
        hy = self.J['l-upper-leg'][1]
        mc = V[self.mid()][:, 1]
        cy = mc[(mc > 70) & (mc < 85)].min()
        zero = np.nonzero((V[:, 1] > hy + top_off) | ((np.abs(V[:, 0]) < mid_x) & (V[:, 1] > cy - 1)))[0]
        one = np.nonzero(V[:, 1] < cy + low_off)[0]
        w = harmonic(len(V), self.nb, np.r_[zero, one], np.r_[np.zeros(len(zero)), np.ones(len(one))])
        out = V.copy()
        for side, sgn in (('l-upper-leg', 1), ('r-upper-leg', -1)):
            m = np.sign(V[:, 0]) == sgn
            c = self.J[side]
            a = -sgn * np.radians(deg) * w[m]
            d = V[m][:, :2] - c[:2]
            out[m, 0] = c[0] + np.cos(a) * d[:, 0] - np.sin(a) * d[:, 1]
            out[m, 1] = c[1] + np.sin(a) * d[:, 0] + np.cos(a) * d[:, 1]
        self.V = out
        self._sym()
        self.steps.append(('pose_legs', dict(deg=deg)))

    def densify(self):
        """控制籠細分一次（格子變成四倍）：胯下那條兩格寬的帶變成四格，才做得出那一團、會陰與臀縫內壁（#67）。"""
        self.V, self.F = subdivide(self.V, self.F)
        self._nb = None
        self._sym()
        self.steps.append(('densify', {}))

    # 雕塑動作：中心、半徑都在左半（x ≥ 0），右半鏡像；左右同時做
    def _brush(self, center, radius, scale=(1, 1, 1), facing=None):
        """筆刷權重：中心在左半，右半鏡像；scale 把球拉成橢球；facing=(方向, 下限, 上限) 只作用在法線朝那個方向的面
        （方向的 x 在右半自動鏡像），用來分開貼在一起的兩面（例如胯下底面與大腿內側）。"""
        c = np.array(center, float)
        s = np.array(scale, float)
        d = np.linalg.norm((np.c_[np.abs(self.V[:, 0]), self.V[:, 1:]] - c) / s, axis=1)
        w = falloff(d, radius)
        if facing is not None:
            dirn, lo, hi = np.array(facing[0], float), facing[1], facing[2]
            N = vertex_normals(self.V, self.F)
            N = np.c_[N[:, 0] * np.where(self.V[:, 0] < 0, -1, 1), N[:, 1:]]
            t = np.clip(((N @ (dirn / np.linalg.norm(dirn))) - lo) / (hi - lo), 0, 1)
            w = w * t * t * (3 - 2 * t)
        return w

    def grab(self, name, center, radius, delta, scale=(1, 1, 1), facing=None):
        """把一區往 delta 推（像雕塑的抓取筆刷）。"""
        w = self._brush(center, radius, scale, facing)
        dv = np.array(delta, float)
        sgn = np.where(self.V[:, 0] < 0, -1.0, 1.0)
        self.V += w[:, None] * dv
        self.V[:, 0] += w * dv[0] * (sgn - 1)          # 右半 x 方向反過來
        self._sym()
        self.steps.append(('grab', dict(name=name, center=center, radius=radius, delta=delta)))

    def inflate(self, name, center, radius, amount, scale=(1, 1, 1), facing=None):
        """一區沿法線往外鼓（負的是往內收）。"""
        w = self._brush(center, radius, scale, facing)
        self.V += (w * amount)[:, None] * vertex_normals(self.V, self.F)
        self._sym()
        self.steps.append(('inflate', dict(name=name, center=center, radius=radius, amount=amount)))

    def relax(self, name, center, radius, strength=0.5, iters=4, scale=(1, 1, 1)):
        """一區往鄰點的平均靠（順掉摺或起伏）。"""
        w = self._brush(center, radius, scale) * strength
        bnd = np.zeros(len(self.V), bool)
        for e, fs in edge_faces(self.F).items():
            if len(fs) == 1:
                bnd[list(e)] = True
        w[bnd] = 0
        for _ in range(iters):
            avg = np.array([self.V[n].mean(0) for n in self.nb])
            self.V += w[:, None] * (avg - self.V)
        self._sym()
        self.steps.append(('relax', dict(name=name, center=center, radius=radius, strength=strength, iters=iters)))


def build():
    """中性型：起胚 → 對齊 → 站姿 → 加密。MakeHuman 起點的臀圍（81.6 cm 處）已是 92.7、臀寬 35.0、臀厚 20.5，
    和目標相同，尺寸不另外放大縮小。粗胚第一輪的兩筆（臀溝外側漸淡、恥丘往下鼓成一團）作者看了覺得反而變差，拿掉。"""
    g = Glute()
    g.align()
    g.pose_legs()
    g.densify()
    return g


def preview(V, F, levels=2):
    for _ in range(levels):
        V, F = subdivide(V, F)
    return V, F


if __name__ == '__main__':
    import sys
    g = build()
    P, Fs = preview(g.V, g.F, int(sys.argv[2]) if len(sys.argv) > 2 else 2)
    T = np.r_[Fs[:, [0, 1, 2]], Fs[:, [0, 2, 3]]]
    np.savez(sys.argv[1], V=g.V, F=g.F, P=P, T=T)
    print('cage', len(g.V), 'preview', len(P), [s[0] for s in g.steps])
