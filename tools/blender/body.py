"""讀取素體（public/body.bin）給離線造型工具使用。素體只讀，不改。"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def load(weights=None):
    """回傳 dict：positions（nBody×3，公分）、faces（三角形）、region、regions、joints、landmarks。

    weights：形變目標權重，預設為亞洲年輕女性的平均（asian-female-young = 1）。
    """
    m = json.loads((ROOT / 'src/body/mh/manifest.json').read_text())
    buf = (ROOT / 'public/body.bin').read_bytes()
    n, nb = m['vertexCount'], m['bodyVertexCount']
    P = np.frombuffer(buf, np.float32, n * 3, m['positions']).reshape(n, 3).astype(np.float64).copy()
    for t in m['targets']:
        w = (weights or {'asian-female-young': 1.0}).get(t['name'], 0)
        if not w:
            continue
        idx = np.frombuffer(buf, np.uint16, t['count'], t['indices']).astype(np.int64)
        d = np.frombuffer(buf, np.int16, t['count'] * 3, t['deltas']).reshape(-1, 3) * m['deltaStep']
        np.add.at(P, idx, w * d)
    quads = np.frombuffer(buf, np.uint16, m['faceCount'] * 4, m['quads']).reshape(-1, 4).astype(np.int64)
    quads = quads[(quads < nb).all(axis=1)]
    faces = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    region = np.frombuffer(buf, np.uint8, n, m['region'])[:nb]
    joints = {k: P[s:s + c].mean(axis=0) for k, (s, c) in m['joints'].items()}
    return {'positions': P[:nb], 'faces': faces, 'region': region, 'regions': m['regions'],
            'joints': joints, 'landmarks': m['landmarks']}
