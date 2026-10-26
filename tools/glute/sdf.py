"""臀的獨立模：用符號距離場（SDF）表示的 3D 模。

- 起點：複製素體下半身的表面成為距離場（只複製，不改素體）。
- 之後的造型都在距離場上做：在解剖座標上疊加平滑的隆起、凹陷與附著（DECISIONS #57）。
- 輸出：等值面網格（給算圖）、截面周長（給數值控制）、表面投影（給素體控制）。
"""
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.spatial import cKDTree
import trimesh
from skimage.measure import marching_cubes

# 獨立模涵蓋的範圍（素體座標，公分）：腰到大腿中段，左右含兩腿
BOX = {'x': (-24.0, 24.0), 'y': (-36.0, 24.0), 'z': (-15.0, 17.0)}
STEP = 0.2


class Field:
    def __init__(self, values, origin, step):
        self.v = values
        self.origin = np.asarray(origin, float)
        self.step = step

    @property
    def shape(self):
        return self.v.shape

    def coords(self):
        """每個格點的座標（x, y, z 三個陣列）。"""
        axes = [self.origin[i] + self.step * np.arange(self.v.shape[i]) for i in range(3)]
        return np.meshgrid(*axes, indexing='ij')

    def sample(self, pts, order=1):
        idx = ((np.asarray(pts) - self.origin) / self.step).T
        return map_coordinates(self.v, idx, order=order, mode='nearest')

    def gradient(self, pts, h=None):
        h = h or self.step
        g = np.zeros((len(pts), 3))
        for a in range(3):
            e = np.zeros(3)
            e[a] = h
            g[:, a] = (self.sample(pts + e) - self.sample(pts - e)) / (2 * h)
        return g

    def mesh(self):
        verts, faces, _, _ = marching_cubes(self.v, 0.0, spacing=(self.step,) * 3)
        return verts + self.origin, faces


def from_base(body, box=BOX, step=STEP):
    """素體表面 → 距離場。符號由每條 z 方向射線與網格的交點區間決定（素體是封閉網格）。"""
    P, F = body['positions'], body['faces']
    # 素體面數不高，先細分兩次得到平滑曲面再轉距離場（只是複製起點，不改素體）
    arm0 = np.isin(body['region'], [body['regions'].index(r) for r in
                                     ['shoulderL', 'shoulderR', 'upperarmL', 'upperarmR', 'forearmL', 'forearmR', 'handL', 'handR']])
    mesh = trimesh.Trimesh(P, F, process=False).subdivide_loop(iterations=2)
    # 細分後的新頂點沿用最近原頂點的分區
    _, nearest = cKDTree(P).query(mesh.vertices)
    body = {**body, 'positions': mesh.vertices, 'faces': mesh.faces, 'region': body['region'][nearest]}
    P, F = mesh.vertices, mesh.faces
    del arm0
    xs = np.arange(box['x'][0], box['x'][1] + 1e-9, step)
    ys = np.arange(box['y'][0], box['y'][1] + 1e-9, step)
    zs = np.arange(box['z'][0], box['z'][1] + 1e-9, step)
    # 手臂不算進下半身的獨立模：最近點落在手臂上的格點當作外側
    arm = np.isin(body['region'], [body['regions'].index(r) for r in
                                    ['shoulderL', 'shoulderR', 'upperarmL', 'upperarmR', 'forearmL', 'forearmR', 'handL', 'handR']])
    # 下半身的表面（不含手臂）密集取樣，求無號距離；手臂完全不參與
    keep = ~arm[F].any(axis=1)
    lower = trimesh.Trimesh(P, F[keep], process=False)
    samples, _ = trimesh.sample.sample_surface_even(lower, 900000, radius=0.06, seed=1)
    tree = cKDTree(samples)
    X, Y, Z = np.meshgrid(xs, ys, zs, indexing='ij')
    pts = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1)
    dist, _ = tree.query(pts, workers=-1)
    # 符號：沿 +z 的射線算交點，區間內為內側
    inside = np.zeros(X.shape, bool)
    origins = np.stack(np.meshgrid(xs, ys, indexing='ij'), -1).reshape(-1, 2)
    ray_o = np.column_stack([origins, np.full(len(origins), zs[0] - 50)])
    ray_d = np.tile([0, 0, 1.0], (len(origins), 1))
    loc, ray_idx, tri_idx = mesh.ray.intersects_location(ray_o, ray_d, multiple_hits=True)
    hits = {}
    for p, r, t in zip(loc, ray_idx, tri_idx):
        if not arm[F[t]].any():
            hits.setdefault(r, []).append(p[2])
    nx, ny = len(xs), len(ys)
    for r, zz in hits.items():
        zz = np.sort(np.unique(np.round(zz, 6)))
        i, j = divmod(r, ny)
        for a, b in zip(zz[0::2], zz[1::2]):
            inside[i, j, (zs >= a) & (zs <= b)] = True
    # 表面附近（1.2 cm 內）改用到三角形的精確距離，避免取樣點造成的階梯
    band = dist < 1.2
    exact, _, _ = trimesh.proximity.closest_point(lower, pts[band])
    dist[band] = np.linalg.norm(exact - pts[band], axis=1)
    d = dist.reshape(X.shape)
    sdf = np.where(inside, -d, d)
    # 素體是平面三角形拼成的，輕微平滑讓獨立模成為連續曲面
    return smooth(Field(sdf, (xs[0], ys[0], zs[0]), step), 0.25)


def smooth(field, sigma_cm):
    """在距離場上做輕微平滑（只用於造型操作之後去除格點痕跡）。"""
    return Field(gaussian_filter(field.v, sigma_cm / field.step), field.origin, field.step)


def girth(field, y, convex=True):
    """在高度 y 的水平截面量周長；convex=True 時模擬皮尺（凸包），分左右腿時取軀幹整圈。"""
    from skimage.measure import find_contours
    j = int(round((y - field.origin[1]) / field.step))
    sl = field.v[:, j, :]
    cs = find_contours(sl, 0.0)
    if not cs:
        return 0.0
    pts = np.concatenate(cs) * field.step + field.origin[[0, 2]]
    if convex:
        from scipy.spatial import ConvexHull
        h = ConvexHull(pts)
        ring = pts[h.vertices]
    else:
        ring = max(cs, key=len) * field.step
    return float(np.linalg.norm(np.diff(np.vstack([ring, ring[:1]]), axis=0), axis=1).sum())


def save_mesh(path, verts, faces):
    """給算圖工具的網格檔：int32 頂點數、int32 三角形數、float32 頂點、uint32 索引。"""
    with open(path, 'wb') as f:
        f.write(np.array([len(verts), len(faces)], np.int32).tobytes())
        f.write(np.asarray(verts, np.float32).tobytes())
        f.write(np.asarray(faces, np.uint32).tobytes())


def save_field(path, field):
    np.savez_compressed(path, v=field.v.astype(np.float32), origin=field.origin, step=field.step)


def load_field(path):
    z = np.load(path)
    return Field(z['v'].astype(np.float64), z['origin'], float(z['step']))


if __name__ == '__main__':
    import sys
    import time
    sys.path.insert(0, str(Path(__file__).parent))
    import body as bodymod
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    t = time.time()
    f = from_base(bodymod.load())
    print('field', f.shape, f'{time.time() - t:.1f}s')
    save_field(out / 'base_field.npz', f)
    v, fc = f.mesh()
    save_mesh(out / 'base_copy.mesh', v, fc)
    for y in [10, 0, -5, -10, -15, -20]:
        print('y', y, 'girth', round(girth(f, y), 1))
