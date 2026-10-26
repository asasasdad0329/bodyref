"""素體控制（DECISIONS #57 的第 4 個系統）原型：讓素體貼合獨立模。

python3 tools/glute/basecontrol.py <工作資料夾> <獨立模距離場.npz> <輸出名稱>
素體臀區的頂點沿距離場的梯度投影到獨立模表面；離開臀區後位移在交界帶內平滑降到 0。
輸出貼合後的素體網格與誤差（貼合後頂點到獨立模表面的距離）。素體檔本身不改。
"""
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import body as bodymod  # noqa: E402
import sdf  # noqa: E402


def weights(P, F):
    """臀區權重：骨盆附近為 1，往腰上與大腿下半、往前方平滑降到 0。"""
    hy = F['hipY']
    y = P[:, 1]
    wy = np.clip((hy + 16 - y) / 4, 0, 1) * np.clip((y - (hy - 22)) / 6, 0, 1)
    wz = np.clip((6 - P[:, 2]) / 6, 0, 1)  # 後半側與側面
    return wy * wz


def fit(P, field, w, iters=4):
    Q = P.copy()
    for _ in range(iters):
        d = field.sample(Q)
        g = field.gradient(Q)
        g /= np.linalg.norm(g, axis=1, keepdims=True) + 1e-9
        Q -= (w * d)[:, None] * g
    return Q


if __name__ == '__main__':
    work, fieldfile, name = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    sys.path.insert(0, str(Path(__file__).parent))
    from neutral import frame
    b = bodymod.load()
    P = b['positions']
    field = sdf.load_field(fieldfile)
    F = frame(b)
    lo, hi = field.origin + 0.5, field.origin + field.step * (np.array(field.shape) - 1) - 0.5
    inbox = ((P > lo) & (P < hi)).all(axis=1)
    w = weights(P, F) * inbox
    Q = P.copy()
    Q[inbox] = fit(P[inbox], field, w[inbox])
    full = w > 0.999
    err = np.abs(field.sample(Q[full]))
    move = np.linalg.norm(Q - P, axis=1)
    print(f'臀區頂點 {full.sum()}；貼合誤差 中位數 {np.median(err):.3f} cm、最大 {err.max():.3f} cm；最大位移 {move.max():.2f} cm')
    sdf.save_mesh(work / f'{name}.mesh', Q, b['faces'])
