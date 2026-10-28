"""臀模的自動檢查（DECISIONS #64）。只用 numpy，不需要 Blender。

給作者看圖之前先跑這裡，把「看得出來的怪形狀」先用數字抓出來：
1. 水平截面在不該凹的地方凹（臀的圓弧、大腿、側面）；只有臀縫、鼠蹊溝、胯下和腿縫可以凹。
2. 正中側影（會陰 → 大陰唇 → 恥丘 → 下腹）要是一條同向彎的弧：曲率可以不平均，但不能反彎。
3. 兩腿之間要有縫：站直不夾腿時，胯下以下的大腿內側離正中要大於 0。
4. 臀圍、大腿圍（只回報，這一步先塑形，不設門檻）。

用法：glute_model.py 跑完會自動檢查一次；也可以單獨對它輸出的 glute_model.npz（或任何含 P、T 的 npz）跑：
    python3 tools/blender/glute_check.py 輸出資料夾/glute_model.npz
有任何一項不過就以非零結束。
"""
import sys

import numpy as np

# 允許凹的地方（素體座標，公分）：臀縫（後方正中附近）、鼠蹊溝與恥丘旁、胯下與腿縫（胯下以下的內側）
CHECK = dict(
    heights=np.arange(70.0, 97.01, 0.5),
    concave_tol=0.03,          # 局部凹深（chord_depth）超過這個值、又不在允許區，就算凹（公分）
    crotch_y=77.5,             # 這個高度以下是兩條腿（內側可以凹）
    cleft_x=3.2,               # 臀縫允許區：|x| 小於這個值的後半
    groin=(2.4, 92.0),         # 鼠蹊溝允許區：前半、離鼠蹊線（glute_cage 的 gx）這麼近、高度在第二個值以下
                               # （恥丘和大腿前側之間是一道寬的淺谷，谷壁也算）
    dimple=(2.5, 5.5, 92.5, 97.0),   # 腰窩（髂後上棘）：後半、|x| 與高度範圍
    fold=(75.0, 78.5, 9.0),    # 臀溝允許區：後半、這段高度、|x| 小於第三個值
    profile=(76.0, 84.5),      # 正中側影檢查的高度範圍（前半）：會陰往上到恥丘與下腹交界（恥骨上橫摺）
    profile_tol=0.04,          # 側影反彎的容許量（曲率，1/公分；0.04 = 半徑 25 公分的反彎，看不出來）
    gap_y=(70.0, 75.5),        # 檢查腿縫的高度範圍
    vertical_tol=0.08,         # 縱向側影的凹深容許量（弦長 3 公分；0.08 ≈ 半徑 14 公分的淺凹）
)


def edges_of(T):
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    return np.sort(E, axis=1)


def slice_loops(P, T, y):
    """水平面 y 切網格，回傳依序連好的截面折線（每條是 (n, 2) 的 (x, z)）。"""
    d = P[:, 1] - y
    d = np.where(np.abs(d) < 1e-9, 1e-9, d)
    seg = {}
    for tri in T:
        s = d[tri]
        if (s > 0).all() or (s < 0).all():
            continue
        keys = []
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            if d[a] * d[b] < 0:
                keys.append((min(a, b), max(a, b)))
        if len(keys) == 2:
            seg.setdefault(keys[0], []).append(keys[1])
            seg.setdefault(keys[1], []).append(keys[0])

    def point(k):
        a, b = P[k[0]], P[k[1]]
        t = (y - a[1]) / (b[1] - a[1])
        q = a + (b - a) * t
        return q[0], q[2]

    loops, seen = [], set()
    for start in seg:
        if start in seen:
            continue
        loop, prev, cur = [start], None, start
        seen.add(start)
        while True:
            nxt = [k for k in seg[cur] if k != prev and k not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        loops.append(np.array([point(k) for k in loop]))
    return [L for L in loops if len(L) > 8]


def hull_depth(L):
    """每個截面點到凸包邊界的距離（在凸包上 = 0，凹進去 > 0）。"""
    pts = sorted(set(map(tuple, np.round(L, 6))))

    def half(seq):
        h = []
        for q in seq:
            while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (q[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (q[0] - h[-2][0]) <= 0:
                h.pop()
            h.append(q)
        return h
    H = np.array(half(pts)[:-1] + half(pts[::-1])[:-1])
    A, B = H, np.roll(H, -1, axis=0)
    AB = B - A
    t = np.clip(((L[:, None, :] - A[None]) * AB[None]).sum(-1) / (AB * AB).sum(-1)[None], 0, 1)
    proj = A[None] + t[..., None] * AB[None]
    return np.linalg.norm(L[:, None, :] - proj, axis=-1).min(1), H


def allowed(x, z, y, zmid):
    c = CHECK
    ax = abs(x)
    if z < zmid and ax < c['cleft_x']:
        return True                                         # 臀縫
    if z > zmid and ax < 0.9 and y < 81.0:
        return True                                         # 大陰唇中間的縫（glute_cage.CLEFT）
    gw, gy = c['groin']
    gx = 3.0 + 8.5 * min(max((y - 79.0) / 13.0, 0.0), 1.0)
    if z > zmid and abs(ax - gx) < gw and y < gy:
        return True                                         # 鼠蹊溝
    d0, d1, dy0, dy1 = c['dimple']
    if z < zmid and d0 < ax < d1 and dy0 < y < dy1:
        return True                                         # 腰窩
    f0, f1, fx = c['fold']
    if z < zmid and f0 < y < f1 and ax < fx:
        return True                                         # 臀溝
    if y < c['crotch_y'] + 1.5 and ax < 4.0:
        return True                                         # 胯下、大陰唇與大腿之間的摺
    return False


def chord_depth(L, spans=(1.0, 2.5)):
    """局部凹深：每點到「前後各 span 公分弧長處兩點連線」的距離，凹進去為正。比凸包好：
    兩顆臀之間本來就是凹的，凸包會把整個臀後面都算成凹；這裡只抓寬度和 span 相當的小凹。"""
    seg = np.linalg.norm(np.diff(np.vstack([L, L[:1]]), axis=0), axis=1)
    s = np.r_[0, np.cumsum(seg)]
    total = s[-1]
    s = s[:-1]
    area = 0.5 * np.sum(L[:, 0] * np.roll(L[:, 1], -1) - np.roll(L[:, 0], -1) * L[:, 1])
    sign = 1.0 if area > 0 else -1.0              # 逆時針：外側在行進方向的右手邊
    out = np.zeros(len(L))
    for span in spans:
        def at(t):
            t = np.mod(t, total)
            return np.stack([np.interp(t, s, L[:, k], period=total) for k in (0, 1)], 1)
        A, B = at(s - span), at(s + span)
        AB = B - A
        n = np.stack([AB[:, 1], -AB[:, 0]], 1) * sign       # 朝外的法向
        n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
        out = np.maximum(out, -((L - A) * n).sum(1))         # 點在弦的內側 → 凹
    return out


def check_sections(P, T):
    bad = []
    for y in CHECK['heights']:
        for L in slice_loops(P, T, y):
            depth = chord_depth(L)
            zmid = 0.5 * (L[:, 1].max() + L[:, 1].min())
            for (x, z), dd in zip(L, depth):
                if dd > CHECK['concave_tol'] and not allowed(x, z, y, zmid):
                    bad.append((round(float(y), 1), round(float(x), 2), round(float(z), 2), round(float(dd), 3)))
    return bad


def midline_profile(P, T, x0=0.02):
    """x = x0 的縱切面裡、身體前半的側影（由下往上排）：(y, z)。"""
    d = P[:, 0] - x0
    E = np.unique(edges_of(T), axis=0)
    a, b = E[:, 0], E[:, 1]
    m = d[a] * d[b] < 0
    t = d[a[m]] / (d[a[m]] - d[b[m]])
    q = P[a[m]] + (P[b[m]] - P[a[m]]) * t[:, None]
    return q[:, [1, 2]]


def check_profile(P, T):
    """恥丘到大陰唇的縱向側影要同向彎：在恥丘寬度內取幾條縱切（x = 0.8、1.6、2.4），每條在
    「胯下 → 恥丘與下腹交界」這段，每個高度的最前點連成曲線，曲率不能反號。x = 0 是中間刻的縫，不看；
    越外側的縱切起點越高（大陰唇比恥丘窄，下面那段已經是大陰唇和大腿之間的摺）。"""
    y0, y1 = CHECK['profile']
    E = np.unique(edges_of(T), axis=0)
    rev = []
    for x0, ys0 in ((0.8, y0), (1.6, y0 + 1.0), (2.4, y0 + 2.0)):
        d = P[:, 0] - x0
        a, b = E[:, 0], E[:, 1]
        m = d[a] * d[b] < 0
        t = d[a[m]] / (d[a[m]] - d[b[m]])
        q = (P[a[m]] + (P[b[m]] - P[a[m]]) * t[:, None])[:, [1, 2]]
        q = q[q[:, 1] > 0]
        ys = np.arange(ys0, y1, 0.25)
        zs = np.array([q[np.abs(q[:, 0] - y) < 0.15, 1].max() if (np.abs(q[:, 0] - y) < 0.15).any() else np.nan
                       for y in ys])
        ok = ~np.isnan(zs)
        ys, zs = ys[ok], zs[ok]
        dz = np.gradient(zs, ys)
        k = np.gradient(dz, ys) / (1 + dz * dz) ** 1.5      # 身體前面往外凸：應該 ≤ 0
        k = np.convolve(k, np.ones(3) / 3, mode='same')
        rev += [(x0, round(float(y), 2), round(float(kk), 3)) for y, kk in zip(ys[1:-1], k[1:-1])
                if kk > CHECK['profile_tol']]
    return rev


def vertical_cut(P, E, x0):
    """x = x0 的縱切面上所有交點 (y, z)。"""
    d = P[:, 0] - x0
    a, b = E[:, 0], E[:, 1]
    m = d[a] * d[b] < 0
    t = d[a[m]] / (d[a[m]] - d[b[m]])
    return (P[a[m]] + (P[b[m]] - P[a[m]]) * t[:, None])[:, [1, 2]]


def check_vertical(P, T):
    """前、後的縱向側影（固定 x，每個高度的最前／最後點）不能有橫向的凹：水平截面抓不到「橫著一道」的凹，
    要用縱切看。允許：前面斜過去的鼠蹊溝（在這個 x 經過的高度附近），後面的臀溝。"""
    E = np.unique(edges_of(T), axis=0)
    ys = np.arange(72.0, 95.01, 0.25)
    bad = []
    for side, xs in ((1, (5.0, 7.0, 9.0, 11.0, 13.0)), (-1, (3.0, 5.0, 7.0, 9.0, 11.0, 13.0, 15.0))):
        for x0 in xs:
            q = vertical_cut(P, E, x0)
            q = q[q[:, 1] * side > 0]
            zs = np.array([side * (q[np.abs(q[:, 0] - y) < 0.15, 1] * side).max()
                           if (np.abs(q[:, 0] - y) < 0.15).any() else np.nan for y in ys])
            ok = ~np.isnan(zs)
            L = np.c_[ys[ok], zs[ok] * side]          # 朝外為正
            inside = (L[:, 0] - 1.5 >= L[0, 0]) & (L[:, 0] + 1.5 <= L[-1, 0])   # 弦兩端都在資料範圍內
            for (y, _), dd in zip(L[inside], chord_open(L)[inside]):
                gy = 79.0 + (x0 - 3.0) * 13.0 / 8.5
                if side > 0 and abs(y - gy) < 2.5:
                    continue                            # 鼠蹊溝
                if side < 0 and (73.0 < y < 79.0 or y > 86.0):
                    continue                            # 臀溝；臀峰以上是腰椎前凸，本來就往內彎
                if dd > CHECK['vertical_tol']:
                    bad.append(('前' if side > 0 else '後', x0, round(float(y), 2), round(float(dd), 3)))
    return bad


def chord_open(L, span=1.5):
    """開放折線（y 遞增、z 朝外為正）每點在前後 span 的弦以內多深（凹為正）。"""
    y, z = L[:, 0], L[:, 1]
    za, zb = np.interp(y - span, y, z), np.interp(y + span, y, z)
    return 0.5 * (za + zb) - z


def check_gap(P, T):
    out = []
    for y in np.arange(*CHECK['gap_y'], 0.5):
        loops = slice_loops(P, T, y)
        xs = np.concatenate([L[:, 0] for L in loops]) if loops else np.array([0.0])
        inner = np.abs(xs).min()
        out.append((round(float(y), 1), round(float(inner), 2)))
    return out


def girth(P, T, y, side=None):
    loops = slice_loops(P, T, y)
    pts = np.concatenate(loops)
    if side is not None:
        pts = pts[np.sign(pts[:, 0]) == side]
    _, H = hull_depth(pts)
    return float(np.linalg.norm(np.diff(np.vstack([H, H[:1]]), axis=0), axis=1).sum())


def main(path):
    d = np.load(path)
    if 'positions' in d:                 # glute_model.py 的輸出：四邊形面
        P, Q = d['positions'], d['faces']
        T = np.concatenate([Q[:, [0, 1, 2]], Q[:, [0, 2, 3]]])
    else:
        P, T = d['P'], d['T']
    ok = True
    bad = check_sections(P, T)
    print(f'截面凹處（允許區以外，深度 > {CHECK["concave_tol"]} cm）：{len(bad)} 點')
    for y in sorted({b[0] for b in bad}):
        rows = np.array([b[1:] for b in bad if b[0] == y and b[1] >= 0])   # 左右對稱，只列左半
        if len(rows):
            i = rows[:, 2].argmax()
            print(f'  y={y}: {len(rows)} 點，x {rows[:, 0].min():.1f}～{rows[:, 0].max():.1f}、'
                  f'z {rows[:, 1].min():.1f}～{rows[:, 1].max():.1f}，最深 {rows[i, 2]:.2f}（x={rows[i, 0]:.1f}, z={rows[i, 1]:.1f}）')
    ok &= not bad
    rev = check_profile(P, T)
    print(f'恥丘到大陰唇的縱向側影反彎：{len(rev)} 處' + ('' if not rev else '，' + '、'.join(f'x={x} y={y}（{k}）' for x, y, k in rev[:12])))
    ok &= not rev
    vb = check_vertical(P, T)
    print(f'縱向側影的橫凹：{len(vb)} 點')
    for key in sorted({(s, x) for s, x, _, _ in vb}):
        rows = [(y, d) for s, x, y, d in vb if (s, x) == key]
        runs, cur = [], [rows[0]]
        for r in rows[1:]:
            if r[0] - cur[-1][0] > 0.3:
                runs.append(cur)
                cur = []
            cur.append(r)
        runs.append(cur)
        print(f'  {key[0]} x={key[1]}：' + '、'.join(f'y {r[0][0]}～{r[-1][0]} 深 {max(d for _, d in r):.2f}' for r in runs))
    ok &= not vb
    gap = check_gap(P, T)
    print('腿縫（大腿內側離正中，cm）：' + '  '.join(f'{y}:{g}' for y, g in gap))
    ok &= all(g > 0.15 for y, g in gap if y < 75.0)
    print(f'臀圍（81.6）{girth(P, T, 81.6):.1f}  大腿圍（75，單腿）{girth(P, T, 75.0, side=1):.1f}')
    print('通過' if ok else '沒通過')
    return ok


if __name__ == '__main__':
    sys.exit(0 if main(sys.argv[1]) else 1)
