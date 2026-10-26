"""臀的獨立模：中性型（DECISIONS #57 的第 1 個系統）。

python3 tools/glute/neutral.py <工作資料夾>
讀 sdf.py 產生的起點距離場（素體下半身的複本），疊上中性型的雕刻規則，輸出距離場、網格與輪廓數字。

雕刻規則用「解剖座標」描述：以髖關節、骨盆為原點，所以之後骨架線改變骨盆寬窄時，規則會跟著移動。
每條規則是一個平滑的隆起或凹陷：中心、三個方向的範圍、高度（公分，正值往外長），
以及只作用在朝某個方向的表面（例如只作用在後方）。
"""
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import body as bodymod  # noqa: E402
import sdf  # noqa: E402


def frame(b):
    """解剖座標框架（素體座標，公分）。"""
    J = b['joints']
    hip = J['l-upper-leg']
    return {
        'hipX': abs(hip[0]), 'hipY': hip[1], 'hipZ': hip[2],
        'pelvisY': J['pelvis'][1],
    }


def rules(F):
    """中性型：方形臀（A、B 點等突，C 點輕微凹陷），上臀飽滿，臀溝內側清楚往外漸淡，薦骨三角與腰窩輕微成形。"""
    hy, hx = F['hipY'], F['hipX']
    R = []
    for s in (1, -1):  # 左右對稱
        # 上臀（臀大肌上半）：補足後方體積，讓上臀圓起來
        R.append(dict(name='上臀', c=(s * 6.5, hy + 6.0, -6.0), r=(5.5, 4.2, 4.0), h=1.2, facing=(0, 0, -1)))
        # A 點：臀中肌的上外側飽滿
        R.append(dict(name='A 點', c=(s * (hx + 6.5), hy + 3.0, -1.5), r=(2.6, 4.2, 4.5), h=1.3, facing=(s, 0, -0.3)))
        # C 點：大轉子後上方的臀側凹陷（附著）
        R.append(dict(name='C 點', c=(s * (hx + 7.0), hy - 3.5, -3.5), r=(2.2, 2.6, 2.8), h=-0.5, facing=(s, 0, -0.5)))
        # B 點：大腿外側上段稍收，讓 A、B 等突
        R.append(dict(name='B 點', c=(s * (hx + 8.0), hy - 11.0, 1.5), r=(2.5, 5.0, 5.0), h=-0.4, facing=(s, 0, 0)))
        # 臀溝內側：沿臀下緣的細長凹，內側深、往外淡
        R.append(dict(name='臀溝內', c=(s * 4.5, hy - 8.6, -5.0), r=(2.8, 0.75, 2.5), h=-0.4, facing=(0, -0.4, -1)))
        R.append(dict(name='臀溝外', c=(s * 9.0, hy - 8.4, -4.0), r=(2.5, 0.9, 2.5), h=-0.15, facing=(0, -0.4, -1)))
        # 腰窩（髂後上棘）
        R.append(dict(name='腰窩', c=(s * 4.2, hy + 11.0, -2.6), r=(1.1, 1.1, 1.5), h=-0.25, facing=(0, 0, -1)))
    # 臀縫：中線稍微加寬、加深成柔和的溝（人台造型；也避免兩側表面貼在一起）
    R.append(dict(name='臀縫', c=(0.0, hy - 2.0, -6.5), r=(0.55, 6.5, 3.0), h=-0.3, facing=(0, 0, -1)))
    return R


def apply(field, base_field, R):
    """把規則疊到距離場上：f' = f − Σ h·G(p)·w(p)，w 是表面朝向的權重。"""
    X, Y, Z = field.coords()
    pts = np.stack([X, Y, Z], -1)
    # 朝向用起點距離場的梯度（表面法線）
    g = np.stack(np.gradient(base_field.v, base_field.step), -1)
    n = g / (np.linalg.norm(g, axis=-1, keepdims=True) + 1e-9)
    v = field.v.copy()
    for r in R:
        c, rad = np.array(r['c']), np.array(r['r'])
        q = (pts - c) / rad
        G = np.exp(-0.5 * (q ** 2).sum(-1))
        d = np.array(r['facing'], float)
        d /= np.linalg.norm(d)
        w = np.clip((n * d).sum(-1), 0, 1) ** 1.5
        v -= r['h'] * G * w
    return sdf.Field(v, field.origin, field.step)


def profiles(f):
    X, Y, Z = [f.origin[i] + f.step * np.arange(f.shape[i]) for i in range(3)]
    ix = (X > 3) & (X < 11)
    rows = []
    for y in np.arange(16, -24, -2.0):
        j = int(round((y - f.origin[1]) / f.step))
        inside = f.v[:, j, :] < 0
        zs = [Z[inside[i]].min() for i in np.where(ix)[0] if inside[i].any()]
        xs = [X[inside[:, k]].max() for k in range(len(Z)) if inside[:, k].any()]
        rows.append((y, min(zs) if zs else np.nan, max(xs) if xs else np.nan, sdf.girth(f, y)))
    return rows


if __name__ == '__main__':
    work = Path(sys.argv[1])
    b = bodymod.load()
    F = frame(b)
    base = sdf.load_field(work / 'base_field.npz')
    neu = apply(base, base, rules(F))
    sdf.save_field(work / 'neutral_field.npz', neu)
    v, fc = neu.mesh()
    sdf.save_mesh(work / 'neutral.mesh', v, fc)
    pb, pn = profiles(base), profiles(neu)
    print('   y   後突(起點→中性)   外側(起點→中性)   周長(起點→中性)')
    for (y, z0, x0, g0), (_, z1, x1, g1) in zip(pb, pn):
        print(f'{y:5.0f}   {z0:6.2f} → {z1:6.2f}     {x0:5.2f} → {x1:5.2f}     {g0:5.1f} → {g1:5.1f}')
