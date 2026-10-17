"""把 MakeHuman 的人體資產（CC0）整理成網站使用的精簡二進位檔。

用法：
  git clone --depth 1 https://github.com/makehumancommunity/makehuman
  python3 tools/prepare_body.py <makehuman>/makehuman/data

輸出：
  public/body.bin            頂點、四邊形面、部位分區、手臂權重、形變目標
  src/body/mh/manifest.json  上述資料在二進位檔中的位置，以及量測用的標記點

只讀取 MakeHuman 的資產檔（網格、形變目標、骨架權重），這些檔案以 CC0 釋出；
不使用 MakeHuman 的程式碼（AGPL）。
"""

import collections
import json
import os
import struct
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_BIN = os.path.join(ROOT, 'public/body.bin')
OUT_JSON = os.path.join(ROOT, 'src/body/mh/manifest.json')

BODY_VERTS = 13380
DM_TO_CM = 10.0
DELTA_STEP = 0.002  # cm，形變量化單位

# 需要的關節輔助點（每個是 8 個頂點的小方塊，取中心）
JOINTS = [
    'l-shoulder', 'r-shoulder', 'l-elbow', 'r-elbow', 'l-hand', 'r-hand',
    'l-upper-leg', 'r-upper-leg', 'l-knee', 'r-knee', 'l-ankle', 'r-ankle',
    'neck', 'head', 'head-2', 'pelvis', 'spine-1', 'spine-2', 'spine-3',
]

# 部位分區：依每個頂點權重最大的骨頭歸類
REGIONS = [
    'torso', 'neck', 'head', 'face',
    'shoulderL', 'shoulderR', 'upperarmL', 'upperarmR', 'forearmL', 'forearmR', 'handL', 'handR',
    'thighL', 'thighR', 'calfL', 'calfR', 'footL', 'footR', 'breastL', 'breastR',
]
FACE_BONES = ('jaw', 'eye', 'levator', 'oculi', 'orbicularis', 'oris', 'risorius', 'special', 'tongue')


def region_of(bone):
    side = 'L' if bone.endswith('.L') else 'R' if bone.endswith('.R') else ''
    b = bone.split('.')[0]
    if b.startswith(FACE_BONES):
        return 'face'
    if b == 'head':
        return 'head'
    if b == 'breast':
        return 'breast' + side
    if b.startswith('neck'):
        return 'neck'
    if b.startswith('shoulder'):
        return 'shoulder' + side
    if b.startswith('upperarm'):
        return 'upperarm' + side
    if b.startswith('lowerarm'):
        return 'forearm' + side
    if b.startswith(('wrist', 'metacarpal', 'finger')):
        return 'hand' + side
    if b.startswith('upperleg'):
        return 'thigh' + side
    if b.startswith('lowerleg'):
        return 'calf' + side
    if b.startswith(('foot', 'toe')):
        return 'foot' + side
    return 'torso'


ARM_CHAIN = ('upperarm', 'lowerarm', 'wrist', 'metacarpal', 'finger')


def load_obj(data):
    verts, faces, groups = [], [], []
    group = None
    for line in open(os.path.join(data, '3dobjs/base.obj')):
        if line.startswith('v '):
            verts.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('g '):
            group = line.split()[1]
        elif line.startswith('f '):
            faces.append([int(t.split('/')[0]) - 1 for t in line.split()[1:]])
            groups.append(group)
    return np.array(verts), faces, groups


def load_target(data, rel):
    idx, delta = [], []
    for line in open(os.path.join(data, 'targets', rel)):
        if line.startswith('#') or not line.strip():
            continue
        p = line.split()
        idx.append(int(p[0]))
        delta.append([float(x) for x in p[1:4]])
    return np.array(idx, dtype=np.int64), np.array(delta).reshape(-1, 3)


def target_list():
    names = []
    for sex in ('female', 'male'):
        names.append(f'macrodetails/asian-{sex}-young.target')
        for m in ('min', 'average', 'max'):
            for w in ('min', 'average', 'max'):
                if m == 'average' and w == 'average':
                    continue  # 這個組合是空檔
                names.append(f'macrodetails/universal-{sex}-young-{m}muscle-{w}weight.target')
        if sex == 'male':
            continue  # 男性沒有罩杯目標，胸部由胸圍的量測目標調整
        for w in ('min', 'average', 'max'):
            for cup in ('min', 'average', 'max'):
                for firm in ('min', 'average', 'max'):
                    if cup == 'average' and firm == 'average':
                        continue
                    names.append(f'breast/{sex}-young-averagemuscle-{w}weight-{cup}cup-{firm}firmness.target')
    names += ['breast/nipple-point-decr.target', 'breast/nipple-size-decr.target']
    for f in sorted(os.listdir(os.path.join(sys.argv[1], 'targets/measure'))):
        if f.endswith('.target'):
            names.append('measure/' + f)
    return names


def main():
    data = sys.argv[1]
    V, F, G = load_obj(data)

    # 頂點集合：身體 + 需要的關節輔助點
    joint_verts = collections.defaultdict(set)
    for f, g in zip(F, G):
        if g and g.startswith('joint-'):
            joint_verts[g[6:]].update(f)
    keep = list(range(BODY_VERTS))
    joints = {}
    for j in JOINTS:
        ids = sorted(joint_verts[j])
        joints[j] = [len(keep), len(ids)]
        keep += ids
    remap = np.full(len(V), -1, dtype=np.int64)
    remap[keep] = np.arange(len(keep))
    n = len(keep)
    pos = V[keep] * DM_TO_CM

    quads = np.array([f for f, g in zip(F, G) if g == 'body'], dtype=np.int64)
    assert quads.shape[1] == 4 and quads.max() < BODY_VERTS

    # 部位分區與手臂權重
    weights = json.load(open(os.path.join(data, 'rigs/default_weights.mhw')))['weights']
    best = np.zeros(BODY_VERTS)
    region = np.zeros(n, dtype=np.uint8)
    arm = {'L': np.zeros(n), 'R': np.zeros(n)}
    for bone, pairs in weights.items():
        r = REGIONS.index(region_of(bone))
        b = bone.split('.')[0]
        side = 'L' if bone.endswith('.L') else 'R' if bone.endswith('.R') else ''
        for i, w in pairs:
            if i >= BODY_VERTS:
                continue
            if w > best[i]:
                best[i] = w
                region[i] = r
            if side and b.startswith(ARM_CHAIN):
                arm[side][i] += w
            elif side and b.startswith('shoulder'):
                arm[side][i] += 0.5 * w
    for s in arm:
        arm[s] = np.clip(arm[s], 0, 1)

    # 形變目標
    targets = []
    for rel in target_list():
        idx, delta = load_target(data, rel)
        if len(idx):
            m = remap[idx] >= 0
            idx, delta = remap[idx[m]], delta[m] * DM_TO_CM
            nz = np.abs(delta).max(axis=1) > DELTA_STEP / 2
            idx, delta = idx[nz], delta[nz]
        q = np.round(delta / DELTA_STEP)
        assert np.abs(q).max(initial=0) < 32767, rel
        name = os.path.splitext(os.path.basename(rel))[0]
        targets.append((name, idx.astype(np.uint16), q.astype(np.int16)))

    # 標記點（以女性亞洲體型為準挑選頂點編號）
    shape = pos.copy()
    for name, idx, q in targets:
        if name == 'asian-female-young':
            shape[idx] += q * DELTA_STEP
    def joint(name):
        s, c = joints[name]
        return shape[s:s + c].mean(axis=0)
    body = shape[:BODY_VERTS]
    landmarks = {}
    for side, sign in (('L', 1), ('R', -1)):
        # 肩峰：肩關節中心外側約 2 cm 的正上方表面
        sh = joint(f'{side.lower()}-shoulder')
        cand = np.where((np.abs(body[:, 0] - (sh[0] + 2.0 * sign)) < 1.0) & (np.abs(body[:, 2] - sh[2]) < 2.5) & (body[:, 1] > sh[1]))[0]
        landmarks['acromion' + side] = int(cand[np.argmax(body[cand, 1])])
        breast_w = np.zeros(BODY_VERTS)
        for i, w in weights[f'breast.{side}']:
            if i < BODY_VERTS:
                breast_w[i] = w
        bv = np.where(breast_w > 0.3)[0]
        apex = bv[np.argmax(body[bv, 2])]
        landmarks['bustApex' + side] = int(apex)
        below = bv[np.abs(body[bv, 0] - body[apex, 0]) < 1.5]
        landmarks['underbust' + side] = int(below[np.argmin(body[below, 1])])
    nk = joint('neck')
    back = np.where((np.abs(body[:, 0]) < 0.3) & (np.abs(body[:, 1] - (nk[1] - 1.0)) < 1.0) & (body[:, 2] < nk[2]))[0]
    landmarks['nape'] = int(back[np.argmin(body[back, 2])])

    # 寫出二進位檔
    blob = bytearray()
    def put(arr):
        off = len(blob)
        blob.extend(arr.tobytes())
        while len(blob) % 4:
            blob.append(0)
        return off
    manifest = {
        'source': 'MakeHuman 1.x assets (CC0 1.0), https://github.com/makehumancommunity/makehuman',
        'vertexCount': n,
        'bodyVertexCount': BODY_VERTS,
        'faceCount': len(quads),
        'deltaStep': DELTA_STEP,
        'regions': REGIONS,
        'joints': joints,
        'landmarks': landmarks,
        'positions': put(pos.astype(np.float32)),
        'quads': put(quads.astype(np.uint16)),
        'region': put(region),
        'armWeightL': put(np.round(arm['L'] * 255).astype(np.uint8)),
        'armWeightR': put(np.round(arm['R'] * 255).astype(np.uint8)),
        'targets': [],
    }
    for name, idx, q in targets:
        manifest['targets'].append({'name': name, 'count': int(len(idx)), 'indices': put(idx), 'deltas': put(q)})
    os.makedirs(os.path.dirname(OUT_BIN), exist_ok=True)
    with open(OUT_BIN, 'wb') as f:
        f.write(blob)
    with open(OUT_JSON, 'w') as f:
        json.dump(manifest, f, indent=1)
    print(f'{len(blob) / 1024:.0f} KB, {len(targets)} targets, landmarks {landmarks}')


if __name__ == '__main__':
    main()
