"""R24：女性型區（臀與大腿上段）的去脂隨全身去脂怎麼變（NHANES 2011–2018 DXA，女性 20–59 歲）。

python3 tools/research/r24_gynoid_lean.py <NHANES 資料夾>
給臀的純肌肉線：範圍內的去脂每 kg 全身去脂多多少、是不是直線；結論記在 docs/work/c1-lower-body/01-glute.md。
"""
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from nhanes_common import load, wls, wquantile  # noqa: E402

df = load(sys.argv[1])
d = df[df.sex.eq('F') & df.ag_ok].copy()
d['gl'] = d.DXXGYLM / 1000
w = d.w.to_numpy()
print('n', len(d))
X = np.column_stack([np.ones(len(d)), d.lean_total, d.fat_total, d.BMXHT / 100])
b, r2, _, _ = wls(X, d.gl.to_numpy(), w)
print('女性型區去脂 ~ 全身去脂 + 全身脂肪 + 身高（m）：', np.round(b, 4), 'r2', round(r2, 3))
b2, r22, _, _ = wls(np.column_stack([np.ones(len(d)), d.lean_total]), d.gl.to_numpy(), w)
print('女性型區去脂 ~ 全身去脂：', np.round(b2, 4), 'r2', round(r22, 3))
m = d.BMXHT.between(155, 165).to_numpy()
print('155～165 cm 的全身去脂 p1/p5/p50/p95/p99：',
      [round(float(wquantile(d.lean_total.to_numpy()[m], w[m], q)), 1) for q in (.01, .05, .5, .95, .99)])
for lo, hi in [(25, 32), (32, 36), (36, 40), (40, 45), (45, 52), (52, 60), (60, 80)]:
    k = d.lean_total.between(lo, hi).to_numpy()
    print(f'全身去脂 {lo}～{hi}：n {k.sum()}  女性型區佔比 {wquantile((d.gl / d.lean_total).to_numpy()[k], w[k], .5):.3f}'
          f'  女性型區去脂 {wquantile(d.gl.to_numpy()[k], w[k], .5):.2f} kg')
