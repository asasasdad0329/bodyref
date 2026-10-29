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


# ---------- 控制線與區域（#71）----------
# 從中性型（MakeHuman 起點）的表面量出來的溝（素體座標，左半；右半鏡像）。每條是 (x, y) 折線，
# 加上沿線的強度（0～1）。權重在中性型上算一次就固定在頂點上，之後肉怎麼長，線都跟著組織走。
CONTROL_LINES = {
    # 臀溝：內側最深（x 1.5～4.5、高 74.5～76），往外變淺、往下斜，x 約 11 淡掉（R23：只有內側是臀壓在大腿上）
    'fold': dict(pts=[(0.8, 76.2), (2.5, 75.7), (4.5, 75.0), (6.5, 74.0), (8.5, 73.4), (10.5, 73.5), (12.0, 73.8)],
                 strength=[1.0, 1.0, 0.85, 0.6, 0.35, 0.12, 0.0], side='back', width=1.2),
    # 鼠蹊溝：胯下（大陰唇旁的摺）斜上到髂前上棘；下段深、上段淺（量到的溝深 1.3 → 0.1）
    'groin': dict(pts=[(2.0, 77.8), (2.3, 79.0), (3.0, 81.0), (4.5, 82.8), (6.5, 84.8), (8.5, 87.3), (10.5, 90.0),
                       (11.5, 92.0)],
                  strength=[1.0, 1.0, 0.9, 0.7, 0.5, 0.35, 0.2, 0.1], side='front', width=1.5),
    # 恥骨上橫摺：恥丘上緣，兩端接到鼠蹊（很胖時下腹蓋上來的深摺由腹部做，這裡只留淺的）
    'suprapubic': dict(pts=[(0.0, 83.6), (2.5, 83.5), (4.5, 83.3), (6.0, 84.2)], strength=[1, 1, 1, 0.5],
                       side='front', width=1.5),
    # 臀縫：正中後方，臀縫底（77.6）到臀縫淡掉的地方（約 91）
    'cleft': dict(pts=[(0.0, 77.6), (0.0, 84.0), (0.0, 89.0), (0.0, 91.0)], strength=[1, 1, 0.8, 0.0],
                  side='back', width=1.4),
    # 薦骨正中：臀縫上方，腰窩之間的平三角
    'sacrum': dict(pts=[(0.0, 89.0), (0.0, 93.0), (0.0, 97.0)], strength=[0.3, 0.7, 0.7], side='back', width=2.5),
}


def polyline_distance(x, y, pts, strength):
    """(x, y) 到折線的距離，和最近那一點沿線內插的強度。"""
    P = np.array(pts, float)
    s = np.array(strength, float)
    best = np.full(len(x), np.inf)
    st = np.zeros(len(x))
    Q = np.c_[x, y]
    for i in range(len(P) - 1):
        a, b = P[i], P[i + 1]
        d = b - a
        t = np.clip(((Q - a) @ d) / max(d @ d, 1e-12), 0, 1)
        dist = np.linalg.norm(Q - (a + t[:, None] * d), axis=1)
        better = dist < best
        best[better] = dist[better]
        st[better] = (s[i] + (s[i + 1] - s[i]) * t)[better]
    return best, st


def control_weights(V, N):
    """每條控制線在每個頂點上的權重（0～1：線上是強度、離線 width 公分平滑歸零）；只算法線朝 side 那一面。"""
    x, y = np.abs(V[:, 0]), V[:, 1]
    out = {}
    for name, c in CONTROL_LINES.items():
        d, s = polyline_distance(x, y, c['pts'], c['strength'])
        w = s * np.exp(-(d / c['width']) ** 2)
        face = np.clip(N[:, 2] if c['side'] == 'front' else -N[:, 2], 0, 1)
        out[name] = w * np.clip(face * 3, 0, 1)
    return out


def zone_weights(V, N, soft=4.0):
    """區域權重（0～1）：belly 上緣的肚子（只當連接，不長、不垂）、crotch 胯下（兩腿之間）、edge 上下切口附近。"""
    x, y, z = np.abs(V[:, 0]), V[:, 1], V[:, 2]
    # 肚子：正面、恥骨上橫摺以上、兩條鼠蹊之間
    gp = np.array(CONTROL_LINES['groin']['pts'])
    gx = np.interp(y, gp[:, 1], gp[:, 0]) + np.clip(y - gp[-1, 1], 0, None) * 0.3   # 髂前上棘以上往外斜
    above = np.clip((y - 84.0) / soft + 0.5, 0, 1)
    inside = np.clip((gx - x) / soft + 0.5, 0, 1)
    front = np.clip(N[:, 2] * 2.5, 0, 1)
    belly = above * inside * front
    # 胯下：兩腿之間朝下的那一條（大陰唇底面、會陰、臀縫底），不含兩側的大腿內側
    crotch = np.clip((79.0 - y) / 1.5, 0, 1) * np.clip((y - 74.5) / 1.0, 0, 1) * np.clip((3.0 - x) / 1.0, 0, 1) \
        * np.clip((-N[:, 1] - 0.3) / 0.3, 0, 1)
    edge = np.maximum(np.clip((y - 96.5) / 4.0, 0, 1), np.clip((72.0 - y) / 4.0, 0, 1))
    return dict(belly=belly, crotch=crotch, edge=edge)


# ---------- 切口（上緣軀幹、下緣兩腿）----------
# 這一區是從身體切下來的，切口外面身體還接著。切口附近長大時不能沿當下的法線長（開放邊的法線往外歪，
# 切口會往下、往外翻成裙擺）；要像「上下還接著同一截」那樣，只往切口平面的方向長。

def cut_frame(V, F, reach=3.0):
    """每個頂點離最近切口的權重（切口上 1，往內 reach 公分平順歸零）與那一截的軸。
    軸取切口附近表面法線最不沿著的方向（圓筒的軸），不取切口平面的法向：腿的切口是斜切的，
    但大腿往下接的方向是大腿的軸。"""
    from scipy.sparse.csgraph import dijkstra
    ef = edge_faces(F)
    adj = defaultdict(set)
    for (a, b), fs in ef.items():
        if len(fs) == 1:
            adj[a].add(b)
            adj[b].add(a)
    loop_of, n_loops, seen = {}, 0, set()
    for s in adj:
        if s in seen:
            continue
        stack = [s]
        seen.add(s)
        while stack:
            u = stack.pop()
            loop_of[u] = n_loops
            for w in adj[u] - seen:
                seen.add(w)
                stack.append(w)
        n_loops += 1
    rows, cols = zip(*ef.keys())
    w = np.linalg.norm(V[list(rows)] - V[list(cols)], axis=1)
    G = csr_matrix(coo_matrix((w, (rows, cols)), shape=(len(V),) * 2))
    bnd = np.array(sorted(loop_of))
    d, _, src = dijkstra(G, directed=False, indices=bnd, min_only=True, return_predecessors=True)
    which = np.array([loop_of[s] for s in src])
    N = vertex_normals(V, F)
    axes = []
    for k in range(n_loops):
        band = (which == k) & (d < reach)
        a = np.linalg.eigh(N[band].T @ N[band])[1][:, 0]
        axes.append(a * np.sign(a[1]))
    t = np.clip(1 - d / reach, 0, 1)
    return t * t * (3 - 2 * t), np.array(axes)[which]


def cut_normals(N, cut):
    """生長方向：切口附近把沿切口軸的分量拿掉（只往切口平面長），其他地方照法線。"""
    w, A = cut
    M = N - (w * (N * A).sum(1))[:, None] * A
    return M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-12)


def averaging_matrix(n, F):
    """鄰點平均的稀疏矩陣：(W @ f)[i] ＝ i 的相鄰頂點上 f 的平均。"""
    nb = neighbours(n, F)
    rows = np.concatenate([np.full(len(a), i) for i, a in enumerate(nb)])
    cols = np.concatenate(nb)
    vals = np.concatenate([np.full(len(a), 1.0 / len(a)) for a in nb])
    return csr_matrix(coo_matrix((vals, (rows, cols)), shape=(n, n)))


def growth_dirs(V, N, cut, reach=2.0):
    """長大的方向：照法線，但
    - 切口附近只往切口平面長（cut_normals）；
    - 正中附近朝正中的那一面（臀縫兩壁、兩腿內側）不往正中長：兩邊貼在一起後沿著接觸面往後、往下長，不互相穿過。"""
    N = cut_normals(N, cut)
    x = V[:, 0]
    t = np.clip(1 - np.abs(x) / reach, 0, 1)
    toward = np.clip(-np.sign(x) * N[:, 0] / 0.3, 0, 1)
    M = N.copy()
    M[:, 0] *= 1 - t * t * (3 - 2 * t) * toward
    return M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-12)


def face_turn(V, V0, F):
    """每個面的方向和中性比：1 沒轉、0 轉了 90°、負的是翻過來（皮膚互相穿過或摺過去）。"""
    def fn(X):
        n = np.cross(X[F[:, 2]] - X[F[:, 0]], X[F[:, 3]] - X[F[:, 1]])
        return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)
    return (fn(V) * fn(V0)).sum(1)
