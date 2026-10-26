"""R19：臀圍變大時，臀區的脂肪與肌肉（去脂）各佔多少（NHANES 2017–2018，女性 20–59 歲）。

python3 tools/research/r19_glute_mix.py <NHANES 資料夾> <輸出資料夾>
DXA 的「女性型區」（DXXGYFM 脂肪、DXXGYLM 去脂）涵蓋臀與大腿上段；臀圍（BMXHIP）只有 2017–2018 一期有量。
輸出 r19.json 與圖；結論記在 docs/work/c1-lower-body/01-glute.md。
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
d = df[df.sex.eq('F') & df.cycle.eq('J') & df.ag_ok & df.BMXHIP.gt(0)].copy()
d['gf'] = d.DXXGYFM / 1000
d['gl'] = d.DXXGYLM / 1000
d['share'] = d.gf / (d.gf + d.gl)
w = d.w.to_numpy()

# 臀圍由身高、臀區脂肪、臀區去脂解釋多少；中位數附近每公斤讓臀圍變多少
X = np.column_stack([np.ones(len(d)), np.log(d.BMXHT / 160), np.log(d.gf), np.log(d.gl)])
beta, r2, sd, _ = wls(X, np.log(d.BMXHIP.to_numpy()), w)
med = {k: float(wquantile(d[k].to_numpy(), w, .5)) for k in ['gf', 'gl', 'BMXHIP']}
res = {'n': int(len(d)), 'r2': round(r2, 3), 'coef': [round(float(b), 3) for b in beta],
       'cmPerKgFat': round(med['BMXHIP'] * beta[2] / med['gf'], 2), 'cmPerKgLean': round(med['BMXHIP'] * beta[3] / med['gl'], 2),
       'bins': []}
for lo, hi in [(80, 90), (90, 95), (95, 100), (100, 105), (105, 110), (110, 115), (115, 120), (120, 130), (130, 160)]:
    m = ((d.BMXHIP >= lo) & (d.BMXHIP < hi)).to_numpy()
    q = wquantile(d.share.to_numpy()[m], w[m], [.1, .5, .9])
    res['bins'].append({'hip': f'{lo}-{hi}', 'hipMedian': round(float(wquantile(d.BMXHIP.to_numpy()[m], w[m], .5)), 1), 'n': int(m.sum()),
                        'fatKg': round(float(wquantile(d.gf.to_numpy()[m], w[m], .5)), 2),
                        'leanKg': round(float(wquantile(d.gl.to_numpy()[m], w[m], .5)), 2),
                        'fatShare': [round(float(x), 3) for x in q]})
b0, b1 = res['bins'][0], res['bins'][-1]
res['marginalFatShare'] = round((b1['fatKg'] - b0['fatKg']) / ((b1['fatKg'] - b0['fatKg']) + (b1['leanKg'] - b0['leanKg'])), 3)
(out / 'r19.json').write_text(json.dumps(res, indent=1, ensure_ascii=False))
print(json.dumps(res, indent=1, ensure_ascii=False))

import logging  # noqa: E402
import matplotlib  # noqa: E402
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
logging.getLogger('matplotlib.font_manager').setLevel(logging.ERROR)
plt.rcParams['font.family'] = 'WenQuanYi Zen Hei'
plt.rcParams['axes.unicode_minus'] = False
hips = [b['hipMedian'] for b in res['bins']]
fig, ax = plt.subplots(1, 2, figsize=(13, 4.8))
ax[0].plot(hips, [b['fatKg'] for b in res['bins']], 'o-', color='#d9822b', label='臀區脂肪（kg）')
ax[0].plot(hips, [b['leanKg'] for b in res['bins']], 'o-', color='#2a78b8', label='臀區去脂（kg，主要是肌肉）')
ax[0].set_xlabel('臀圍（公分）')
ax[0].set_ylabel('公斤（中位數）')
ax[0].set_title('臀圍變大時，脂肪與肌肉都增加，脂肪增加得較快')
ax[0].grid(alpha=.3)
ax[0].legend()
ax[1].fill_between(hips, [b['fatShare'][0] * 100 for b in res['bins']], [b['fatShare'][2] * 100 for b in res['bins']], color='#d9822b', alpha=.25, label='同臀圍的個人差（p10～p90）')
ax[1].plot(hips, [b['fatShare'][1] * 100 for b in res['bins']], 'o-', color='#d9822b', label='中位數')
ax[1].set_xlabel('臀圍（公分）')
ax[1].set_ylabel('脂肪 ÷（脂肪＋去脂）（%）')
ax[1].set_title('混合值：臀圍越大越偏脂肪；同臀圍的差＝組成線的範圍')
ax[1].grid(alpha=.3)
ax[1].legend(loc='lower right')
fig.suptitle(f'R19 臀區的脂肪與肌肉（NHANES 2017–2018 女性 20–59 歲，n={res["n"]}）', fontsize=13)
fig.tight_layout()
fig.savefig(out / 'r19_glute_mix.png', dpi=105)
