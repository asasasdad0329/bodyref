"""脂肪當成立體的體積來算重力下的形（作者 2026-10-29：做的時候要有體積的概念，記下來的只要表面）。只用 numpy、scipy。

肌肉表面（底層）到皮膚之間的脂肪層，沿厚度切成 K 層，每一格（籠的一個四邊形 × 一層）再切成 6 個四面體：
  - 每個四面體保持自己的體積（脂肪幾乎不可壓縮）；
  - 格子的邊是彈簧（纖維隔膜與淺筋膜），哪裡硬、哪裡鬆由呼叫的一方照解剖給；皮膚那層另有彎曲勁度（膜）；
  - 最內層黏在肌肉上；區域的切口接著身體其他部分，固定；附著區的點被彈簧拉回原位；
  - 接觸：兩邊不穿過正中；可選的高度場讓垂下來的部分不擠進大腿後面的表面（脂肪線已改用 glute_mh_contact
    做通用的接觸，不再傳高度場；留著給還沒改的地方對照）。
用線性彈性解（在不受重力的形上線性化）：形是平順的，不會因為皮膚受壓而一格一格起皺。
試過的非線性解法（L-BFGS、高斯–牛頓）在這個籠的解析度下皮膚會起皺、收斂慢，記在 01-glute「脂肪線：立體＋重力」。
"""
import numpy as np
from scipy.interpolate import RectBivariateSpline, griddata
from scipy.sparse import coo_matrix, csr_matrix, identity, kron
from scipy.sparse.linalg import spsolve

# 一格四邊形柱（底 0123、頂 4567，4 在 0 正上方）切成 6 個四面體，共用對角線 0–6
HEX_TETS = np.array([[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]])


def _blocks(rows, cols, B):
    """3×3 區塊（每列一個區塊，rows/cols 是點的編號）→ COO 的索引與值。"""
    r = (3 * rows[:, None, None] + np.arange(3)[None, :, None]).repeat(3, 2)
    c = (3 * cols[:, None, None] + np.arange(3)[None, None, :]).repeat(3, 1)
    return r.ravel(), c.ravel(), B.ravel()


def _layer_sel(k, n, N):
    """第 k 層的點：N 個點 → 這一層 n 個點的選取矩陣（n × N）。"""
    return csr_matrix(coo_matrix((np.ones(n), (np.arange(n), k * n + np.arange(n))), shape=(n, N)))


class FatVolume:
    def __init__(self, F, n, K=1):
        self.F, self.n, self.K = F, n, K
        node = lambda k, i: k * n + i
        self.tets = np.concatenate([np.c_[node(k, F), node(k + 1, F)][:, HEX_TETS].reshape(-1, 4) for k in range(K)])
        qe = np.unique(np.sort(np.r_[F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 3]], F[:, [3, 0]]], axis=1), axis=0)
        qd = np.r_[F[:, [0, 2]], F[:, [1, 3]]]
        E, skin = [], []
        for k in range(1, K + 1):                                # 層內：四邊與兩條對角
            E += [node(k, qe), node(k, qd)]
            skin += [np.full(len(qe), k == K), np.full(len(qd), k == K)]
        for k in range(K):                                       # 層間：垂直、側面斜撐
            E += [np.c_[node(k, np.arange(n)), node(k + 1, np.arange(n))],
                  np.c_[node(k, qe[:, 0]), node(k + 1, qe[:, 1])], np.c_[node(k, qe[:, 1]), node(k + 1, qe[:, 0])]]
            skin += [np.zeros(n, bool), np.zeros(len(qe), bool), np.zeros(len(qe), bool)]
        self.E = np.concatenate(E)
        self.skin_edge = np.concatenate(skin)                    # True：皮膚那一層的邊（膜）

    def layers(self, base, skin):
        """底層到皮膚之間平均分 K 層。"""
        return np.concatenate([base + (k / self.K) * (skin - base) for k in range(self.K + 1)])

    def stiffness(self, X, k_edge, k_vol, k_anchor, lap, k_bend):
        """在形 X 上的線性勁度矩陣（3N × 3N）：彈簧取軸向、體積取梯度外積、各層彎曲、附著。"""
        E, T = self.E, self.tets
        N = len(X)
        R, C, V = [], [], []
        d = X[E[:, 0]] - X[E[:, 1]]
        l0 = np.linalg.norm(d, axis=1) + 1e-12
        u = d / l0[:, None]
        H = (2 * k_edge / l0)[:, None, None] * (u[:, :, None] * u[:, None, :])
        for a, b, sg in ((0, 0, 1), (1, 1, 1), (0, 1, -1), (1, 0, -1)):
            r, c, v = _blocks(E[:, a], E[:, b], sg * H)
            R.append(r); C.append(c); V.append(v)
        a, b, c_, d_ = (X[T[:, i]] for i in range(4))
        ba, ca, da = b - a, c_ - a, d_ - a
        v0 = np.abs(np.einsum('ij,ij->i', np.cross(ba, ca), da) / 6)
        gb, gc, gd = np.cross(ca, da) / 6, np.cross(da, ba) / 6, np.cross(ba, ca) / 6
        Gt = np.stack([-(gb + gc + gd), gb, gc, gd], 1)
        w = 2 * k_vol / np.maximum(v0, 1e-2)                    # 很扁的四面體不要讓分母太小
        for i in range(4):
            for j in range(4):
                r, c, v = _blocks(T[:, i], T[:, j], w[:, None, None] * Gt[:, i, :, None] * Gt[:, j, None, :])
                R.append(r); C.append(c); V.append(v)
        R.append(np.arange(3 * N)); C.append(np.arange(3 * N)); V.append(np.repeat(2 * k_anchor, 3).astype(float))
        K = coo_matrix((np.concatenate(V), (np.concatenate(R), np.concatenate(C))), shape=(3 * N, 3 * N)).tocsr()
        for k, kb in enumerate(k_bend):
            if kb > 0:
                S = _layer_sel(k, self.n, N)
                K = K + 2 * kb * kron(S.T @ (lap.T @ lap) @ S, identity(3))
        return K

    def solve_linear(self, X_rest, free, k_edge, k_anchor, load, side, contact=None, lap=None, k_bend=(),
                     k_vol=60.0, k_pen=400.0, rounds=6):
        """重力下的平衡（線性彈性）。X_rest：不受重力的形（所有點）；free：可以動的點；load：每個點往下的力；
        side：每個點在左（+1）右（−1）或正中（0）；contact：(大腿後面的表面 (|x|, y) → (z, ∂z/∂|x|, ∂z/∂y), 要檢查的點)。
        接觸用「逐次加入」：解一次、找出違反的點、加上懲罰再解，最多 rounds 輪。"""
        N = len(X_rest)
        idx = np.nonzero(free)[0]
        fidx = (3 * idx[:, None] + np.arange(3)).ravel()
        K = self.stiffness(X_rest, k_edge, k_vol, k_anchor, lap, k_bend)
        f = np.zeros((N, 3))
        f[:, 1] = -load
        mid = side == 0
        act_mid, act_c = np.zeros(N, bool), np.zeros(N, bool)
        U = np.zeros((N, 3))
        for _ in range(rounds):
            Kp, b = K.copy(), f.copy()
            m = mid | act_mid                                    # 正中的點 x＝0；兩邊被擋在正中
            mi = 3 * np.nonzero(m)[0]
            Kp = Kp + coo_matrix((np.full(len(mi), 2 * k_pen), (mi, mi)), shape=(3 * N, 3 * N))
            b[m, 0] += -2 * k_pen * X_rest[m, 0]
            if contact is not None and act_c.any():              # 大腿：z ≤ 表面 − 0.2（在目前位置線性化）
                zf, _ = contact
                ii = np.nonzero(act_c)[0]
                P = X_rest[ii] + U[ii]
                zt, dzx, dzy = zf(np.c_[np.abs(P[:, 0]), P[:, 1]])
                g = np.c_[-dzx * np.sign(P[:, 0]), -dzy, np.ones(len(ii))]
                h = P[:, 2] - (zt - 0.2) - (g * U[ii]).sum(1)
                r, c, v = _blocks(ii, ii, 2 * k_pen * g[:, :, None] * g[:, None, :])
                Kp = Kp + coo_matrix((v, (r, c)), shape=(3 * N, 3 * N))
                b[ii] += -2 * k_pen * g * h[:, None]
            Kf = Kp.tocsr()[fidx][:, fidx] + 1e-8 * identity(len(fidx))
            U = np.zeros((N, 3))
            U[idx] = spsolve(Kf.tocsc(), b.ravel()[fidx]).reshape(-1, 3)
            X = X_rest + U
            new_mid = ~mid & (side * X[:, 0] < 0)
            new_c = np.zeros(N, bool)
            if contact is not None:
                zf, check = contact
                ii = np.nonzero(check)[0]
                zt, _, _ = zf(np.c_[np.abs(X[ii, 0]), X[ii, 1]])
                new_c[ii[X[ii, 2] > zt - 0.2 + 1e-3]] = True
            if not ((new_mid & ~act_mid).any() or (new_c & ~act_c).any()):
                break
            act_mid |= new_mid
            act_c |= new_c
        self.last = dict(contact=int(act_c.sum()), midline=int(act_mid.sum()))
        return X


def height_field(P, y_top, lo=(0.0, 60.0), hi=(26.0, 82.0), h=0.25):
    """大腿後面的表面：點雲 P（|x|, y, z）→ 規則格點上的 z(|x|, y)。點雲外面用最近的值補；
    臀溝線 y_top(|x|) 下 0.8 公分以上，表面急速往後退（那裡沒有大腿，臀溝上的點本來就貼著，不檢查）。
    用三次樣條：值和斜率是同一個平順的函式。回傳 (|x|,y) → (z, ∂z/∂|x|, ∂z/∂y)。"""
    gx = np.arange(lo[0], hi[0] + h, h)
    gy = np.arange(lo[1], hi[1] + h, h)
    GX, GY = np.meshgrid(gx, gy, indexing='ij')
    Z = griddata(P[:, :2], P[:, 2], (GX, GY), method='linear')
    Z = np.where(np.isnan(Z), griddata(P[:, :2], P[:, 2], (GX, GY), method='nearest'), Z)
    Z = Z + 20.0 * np.clip(GY - (y_top(GX) - 0.8), 0, None) ** 2
    sp = RectBivariateSpline(gx, gy, Z, kx=3, ky=3)
    lo_, hi_ = np.array([gx[0], gy[0]]), np.array([gx[-1], gy[-1]])

    def f(p):
        q = np.clip(p, lo_, hi_)
        return sp.ev(q[:, 0], q[:, 1]), sp.ev(q[:, 0], q[:, 1], dx=1), sp.ev(q[:, 0], q[:, 1], dy=1)
    return f


def laplacian(F, n):
    """籠上的拉普拉斯（點減鄰點平均）。"""
    import glute_mh as gm
    return identity(n, format='csr') - gm.averaging_matrix(n, F)
