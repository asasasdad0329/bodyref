"""通用的接觸（DECISIONS #73）：皮膚任何兩片相碰，兩邊一起讓開、不互相穿過。用 IPC Toolkit（MIT，ipctk）。

做法：從一個沒有穿面的形出發，往目標形（規則算出來、可能互相穿過）一步步走。每一步解
    min  ½ Σ w (x − y)²  ＋  ½ k_s |L (x − y)|²  ＋  B(x)
  第一項：盡量貼近目標；第二項：被擋住時，讓開的量平順地分給四周（不是只有碰到的那一點凹進去）；
  B：IPC 的屏障位能，兩片面靠近到 dhat 以內才有，距離趨近 0 時趨近無限大。
用牛頓法，每一步的長度用連續碰撞檢查（CCD）限制在不會穿過的範圍內，所以整條路徑都沒有穿面。
兩邊對稱的接觸（臀縫、兩腿內側）自然停在正中，不需要另外的擋板；換姿勢時同一套照樣能用。
"""
import numpy as np
import ipctk
from scipy.sparse import csr_matrix, identity, kron, diags
from scipy.sparse.linalg import spsolve


class Contact:
    def __init__(self, V0, quads, fixed, dhat=0.15, k_track=1.0, k_smooth=8.0, kappa=None, levels=1, k_fixed=30.0,
                 mirror=True):
        """V0：沒有穿面的起點（中性型）；quads：四邊形；fixed：切口上的點（身體在那裡接著，盡量照目標，貼近目標的權重 k_fixed 倍；
        但一樣受接觸約束：兩腿內側的切口碰在一起時也要讓開，不然切口會穿過去）。
        接觸算在細分 levels 次之後的曲面上（看得到的是細分後的面；只在控制籠上不穿過，細分後仍可能穿過）。"""
        from scipy.sparse import identity as sp_eye
        S = sp_eye(len(V0), format='csr')
        Fq = quads
        for _ in range(levels):
            Sk, Fq = subdivision_matrix(Fq, S.shape[0])
            S = Sk @ S
        self.S = S.tocsr()
        self.S3 = kron(self.S, identity(3), format='csr')
        self.tris = np.ascontiguousarray(np.r_[Fq[:, [0, 1, 2]], Fq[:, [0, 2, 3]]].astype(np.int32))
        E = ipctk.edges(self.tris)
        P0 = np.asfortranarray(self.S @ V0, dtype=np.float64)
        self.mesh = ipctk.CollisionMesh(P0, np.asfortranarray(E), np.asfortranarray(self.tris))
        self.n = len(V0)
        self.dhat = dhat
        self.k_track, self.k_smooth = k_track, k_smooth
        self.free = np.ones(len(V0), bool)
        self.fidx = np.arange(3 * len(V0))
        wt = np.where(fixed, k_fixed, 1.0) * k_track
        # 鄰點平均的拉普拉斯（控制籠上）
        from collections import defaultdict
        nb = defaultdict(set)
        for q in quads:
            for k in range(4):
                a, b = q[k], q[(k + 1) % 4]
                nb[a].add(b)
                nb[b].add(a)
        rows, cols, vals = [], [], []
        for i in range(self.n):
            js = sorted(nb[i])
            rows += [i] * (len(js) + 1)
            cols += [i] + js
            vals += [1.0] + [-1.0 / len(js)] * len(js)
        L = csr_matrix((vals, (rows, cols)), shape=(self.n, self.n))
        self.Q = kron(diags(wt) + k_smooth * (L.T @ L), identity(3), format='csr')
        self.kappa = kappa if kappa is not None else 10.0 * k_track
        self.barrier = ipctk.BarrierPotential(dhat, self.kappa)
        assert not ipctk.has_intersections(self.mesh, P0), '起點不能有穿面'
        # 左右鏡像對稱：只解左半（和正中的點），右半照鏡像。身體左右對稱時，兩邊相碰（臀縫、兩腿內側）的接觸面就落在正中，
        # 不會因為數值上的小差異變成一邊推過去
        self.R = self._mirror_map(V0) if mirror else identity(3 * self.n, format='csr')

    def _mirror_map(self, V0):
        from scipy.spatial import cKDTree
        from scipy.sparse import coo_matrix
        x = V0[:, 0]
        mid = np.abs(x) < 1e-6
        left = np.nonzero(x > 1e-6)[0]
        tree = cKDTree(V0)
        d, partner = tree.query(np.c_[-V0[:, 0], V0[:, 1], V0[:, 2]])
        assert d[~mid].max() < 1e-4, '中性型左右不對稱，不能用鏡像'
        cols_of = {}
        rows, cols, vals = [], [], []
        m = 0
        for v in np.r_[left, np.nonzero(mid)[0]]:
            for c in range(3):
                if mid[v] and c == 0:
                    continue                      # 正中的點 x 固定為 0
                cols_of[(v, c)] = m
                rows.append(3 * v + c); cols.append(m); vals.append(1.0)
                if not mid[v]:
                    r = partner[v]
                    rows.append(3 * r + c); cols.append(m); vals.append(-1.0 if c == 0 else 1.0)
                m += 1
        return coo_matrix((vals, (rows, cols)), shape=(3 * self.n, m)).tocsr()

    def fine(self, x):
        return np.asfortranarray(self.S @ x)

    def _barrier_hessian(self, col, X):
        """屏障的二次近似（投影成半正定）。貼得極近時投影可能失敗，就改用絕對值投影，再不行就只留對角。"""
        for m in (ipctk.PSDProjectionMethod.CLAMP, ipctk.PSDProjectionMethod.ABS):
            try:
                return self.barrier.hessian(col, self.mesh, X, project_hessian_to_psd=m)
            except RuntimeError:
                continue
        H = self.barrier.hessian(col, self.mesh, X)
        return diags(np.abs(H.diagonal()))

    def _energy(self, x, y, col):
        d = (x - y).ravel()
        return 0.5 * d @ (self.Q @ d) + self.barrier(col, self.mesh, self.fine(x))

    def resolve(self, x0, y, iters=40, tol=1e-4):
        """從沒有穿面的 x0 走向目標 y，回傳沒有穿面、盡量貼近 y 的形。"""
        x = x0.copy()
        info = dict(iters=0, contacts=0)
        for it in range(iters):
            X = self.fine(x)
            col = ipctk.NormalCollisions()
            col.build(self.mesh, X, self.dhat)
            d = (x - y).ravel()
            g = self.Q @ d + self.S3.T @ self.barrier.gradient(col, self.mesh, X)
            gf = self.R.T @ g
            if np.abs(gf).max() < tol:
                break
            H = self.Q + self.S3.T @ self._barrier_hessian(col, X) @ self.S3
            Hf = (self.R.T @ H @ self.R).tocsc()
            p = self.R @ (-spsolve(Hf, gf))
            P = p.reshape(-1, 3)
            amax = ipctk.compute_collision_free_stepsize(self.mesh, X, self.fine(x + P))
            a = min(1.0, 0.9 * amax)
            e0 = self._energy(x, y, col)
            while a > 1e-8:
                xn = x + a * P
                coln = ipctk.NormalCollisions()
                coln.build(self.mesh, self.fine(xn), self.dhat)
                if self._energy(xn, y, coln) <= e0 + 1e-4 * a * (g @ p):
                    break
                a *= 0.5
            x = x + a * P
            info = dict(iters=it + 1, contacts=len(col), step=a)
            if np.abs(a * P).max() < 1e-5:
                break
        self.last = info
        return x


def subdivision_matrix(F, n):
    """Catmull-Clark 細分一次（和 glute_mh.subdivide 同一套規則）寫成稀疏矩陣 S：細分後的點 ＝ S @ 原本的點。
    回傳 S 與細分後的四邊形。"""
    from collections import defaultdict
    from scipy.sparse import coo_matrix
    ef = defaultdict(list)
    for fi, q in enumerate(F):
        for k in range(4):
            a, b = q[k], q[(k + 1) % 4]
            ef[(min(a, b), max(a, b))].append(fi)
    edges = np.array(sorted(ef))
    eidx = {e: i for i, e in enumerate(map(tuple, edges))}
    nf, ne = len(F), len(edges)
    rows, cols, vals = [], [], []

    def put(r, c, v):
        rows.append(r); cols.append(c); vals.append(v)
    face_row = lambda fi: [(v, 0.25) for v in F[fi]]
    # 面點
    for fi in range(nf):
        for v, w in face_row(fi):
            put(n + ne + fi, v, w)
    # 邊點
    bnd_e = np.zeros(ne, bool)
    for i, (a, b) in enumerate(edges):
        fs = ef[(a, b)]
        if len(fs) == 2:
            put(n + i, a, 0.25); put(n + i, b, 0.25)
            for f in fs:
                for v, w in face_row(f):
                    put(n + i, v, 0.25 * w)
        else:
            put(n + i, a, 0.5); put(n + i, b, 0.5)
            bnd_e[i] = True
    # 原本的點
    vf = [[] for _ in range(n)]
    for fi, q in enumerate(F):
        for v in q:
            vf[v].append(fi)
    ve = [[] for _ in range(n)]
    for i, (a, b) in enumerate(edges):
        ve[a].append(i); ve[b].append(i)
    for v in range(n):
        es = ve[v]
        be = [i for i in es if bnd_e[i]]
        if be:
            nbv = [edges[i][0] if edges[i][1] == v else edges[i][1] for i in be]
            if len(nbv) >= 2:
                put(v, v, 0.75); put(v, nbv[0], 0.125); put(v, nbv[-1], 0.125)
            else:
                put(v, v, 1.0)
        else:
            k = len(es)
            for f in vf[v]:
                for u, w in face_row(f):
                    put(v, u, w / len(vf[v]) / k)
            for i in es:
                put(v, edges[i][0], 2 * 0.5 / len(es) / k); put(v, edges[i][1], 2 * 0.5 / len(es) / k)
            put(v, v, (k - 3) / k)
    S = coo_matrix((vals, (rows, cols)), shape=(n + ne + nf, n)).tocsr()
    NF = []
    for fi, q in enumerate(F):
        e = [n + eidx[(min(q[k], q[(k + 1) % 4]), max(q[k], q[(k + 1) % 4]))] for k in range(4)]
        c = n + ne + fi
        for k in range(4):
            NF.append((q[k], e[k], c, e[k - 1]))
    return S, np.array(NF)
