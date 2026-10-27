"""R21：很胖的一端（體重 100～200 公斤）女性的脂肪、去脂、分配與臀圍（NHANES，女性 20–59 歲）。

python3 tools/research/r21_extreme_tail.py <NHANES 2011–2018 資料夾> <輸出資料夾>

作者決定體型先做到全身體重約 204 公斤（NHANES DXA 能掃的上限附近）。這裡看：
- DXA（2011–2018）：各體重組的全身脂肪、去脂、體脂率，以及各分區佔全身脂肪的比例在極端尾端是否還穩定；
- 外推到 204 公斤時的脂肪與去脂（用體重 ≥ 100 公斤的人做直線迴歸）；
- 臀圍（只有 2017–2018）：各體重組的中位數，以及很胖的人（臀圍 ≥ 115）每 kg 女性型區脂肪、去脂讓臀圍變多少。
輸出 r21.json；結論記在 docs/work/c1-lower-body/01-glute.md。
"""
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from nhanes_common import load, wls, wquantile  # noqa: E402

root, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
df = load(root)
d = df[df.sex.eq('F')].copy()
w = d.w.to_numpy()
res = {'n': int(len(d)), 'maxWeight': float(d.BMXWT.max()), 'maxFat': round(float(d.fat_total.max()), 1), 'weightBins': []}
for lo, hi in [(60, 80), (80, 100), (100, 120), (120, 140), (140, 160), (160, 210)]:
    m = d.BMXWT.between(lo, hi).to_numpy()
    x = d[m]
    q = lambda v: round(float(wquantile(v.to_numpy(), w[m], .5)), 2)
    res['weightBins'].append({'weight': f'{lo}-{hi}', 'n': int(m.sum()), 'fatKg': q(x.fat_total), 'leanKg': q(x.lean_total),
                              'fatPct': q(x.pf * 100), 'height': q(x.BMXHT),
                              'share': {k: q(x[f'fat_{k}'] / x.fat_total * 100) for k in ['gynoid', 'leg', 'trunk', 'android']}})
# 外推到 204 公斤：體重 ≥ 100 的人，脂肪、去脂對體重與身高的直線迴歸，代入 160 cm、204 kg
m = d.BMXWT.ge(100).to_numpy()
X = np.column_stack([np.ones(m.sum()), d.BMXWT[m], d.BMXHT[m]])
res['at204kg_160cm'] = {}
for k in ['fat_total', 'lean_total']:
    beta, r2, _, _ = wls(X, d[k].to_numpy()[m], w[m])
    res['at204kg_160cm'][k] = {'value': round(float(beta @ [1, 204, 160]), 1), 'perKgWeight': round(float(beta[1]), 3), 'r2': round(r2, 3)}
# 女性型區脂肪對全身脂肪：整段與極端尾端（全身脂肪 ≥ 50）的邊際比例
for name, mm in [('all', np.ones(len(d), bool)), ('fat50plus', d.fat_total.ge(50).to_numpy())]:
    beta, r2, _, _ = wls(np.column_stack([np.ones(mm.sum()), d.fat_total[mm]]), d.fat_gynoid.to_numpy()[mm], w[mm])
    res[f'gynoidPerKgFat_{name}'] = {'slope': round(float(beta[1]), 3), 'r2': round(r2, 3), 'n': int(mm.sum())}
# 臀圍（2017–2018）
j = (d.cycle.eq('J') & d.BMXHIP.gt(0)).to_numpy()
res['hipByWeight'] = []
for lo, hi in [(60, 80), (80, 100), (100, 120), (120, 140), (140, 160), (160, 210)]:
    m = j & d.BMXWT.between(lo, hi).to_numpy()
    if m.sum():
        res['hipByWeight'].append({'weight': f'{lo}-{hi}', 'n': int(m.sum()), 'hip': round(float(wquantile(d.BMXHIP.to_numpy()[m], w[m], .5)), 1)})
# 很胖的人：臀圍對女性型區脂肪、去脂（固定身高）的公分/kg；和全體的 R19（脂肪 4.7、去脂 3.9）比
for name, mm in [('all', j), ('hip115plus', j & d.BMXHIP.ge(115).to_numpy())]:
    X = np.column_stack([np.ones(mm.sum()), d.BMXHT[mm], d.fat_gynoid[mm], d.lean_total[mm] * 0 + d.DXXGYLM[mm] / 1000])
    beta, r2, _, _ = wls(X, d.BMXHIP.to_numpy()[mm], w[mm])
    res[f'hipCmPerKg_{name}'] = {'gynoidFat': round(float(beta[2]), 2), 'gynoidLean': round(float(beta[3]), 2), 'r2': round(r2, 3), 'n': int(mm.sum())}
(out / 'r21.json').write_text(json.dumps(res, indent=1, ensure_ascii=False))
print(json.dumps(res, indent=1, ensure_ascii=False))
