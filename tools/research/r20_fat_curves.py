"""R20：女性臀區與附近的脂肪，隨全身變胖是怎麼變的（是不是線性）。

python3 tools/research/r20_fat_curves.py <NHANES 2011–2018 資料夾> <NHANES III exam.dat> <輸出資料夾>

A. NHANES 2011–2018 DXA（女性 20–59 歲）：各分區脂肪（女性型區、腿、軀幹、男性型區）隨全身脂肪量的變化。
   看「分區佔全身的比例」會不會隨變胖而改變、每多 1 kg 全身脂肪分到各區多少（邊際比例）、臀圍每 kg 多幾公分。
B. NHANES III 1988–1994（女性 20–59 歲）：皮脂厚（大腿、髂嵴上、三頭肌、肩胛下）、臀圍、大腿圍隨 BMI 的變化。
   皮脂厚是局部皮下脂肪「厚度」的直接指標（捏起來是兩層皮加皮下脂肪）。
輸出 r20.json 與圖；結論記在 docs/work/c1-lower-body/01-glute.md。原始資料不進倉庫。
"""
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from nhanes_common import load, wls, wquantile  # noqa: E402

root, exam, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
res = {}


def binned(x, cols, w, n=10):
    """依 x 的加權十分位分組，回傳每組 x 與各欄的加權中位數。"""
    edges = wquantile(x, w, np.linspace(0, 1, n + 1))
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (x >= lo) & (x <= hi)
        rows.append({'x': float(wquantile(x[m], w[m], .5)), 'n': int(m.sum()),
                     **{k: float(wquantile(v[m], w[m], .5)) for k, v in cols.items()}})
    return rows


def curvature(x, y, w):
    """y = a + b·x + c·x²：在 x 的 p10、p50、p90 處的斜率，以及加二次項後 R² 增加多少。"""
    X1 = np.column_stack([np.ones_like(x), x])
    X2 = np.column_stack([X1, x * x])
    b1, r1, _, _ = wls(X1, y, w)
    b2, r2, _, _ = wls(X2, y, w)
    q = wquantile(x, w, [.1, .5, .9])
    return {'slope_p10_p50_p90': [round(float(b2[1] + 2 * b2[2] * v), 3) for v in q],
            'linearSlope': round(float(b1[1]), 3), 'r2_linear': round(r1, 3), 'r2_quadratic': round(r2, 3)}


# ---------- A. DXA ----------
df = load(root)
d = df[df.sex.eq('F') & df.ag_ok].copy()
w = d.w.to_numpy()
F = d.fat_total.to_numpy()
regions = {'gynoid': d.fat_gynoid.to_numpy(), 'leg': d.fat_leg.to_numpy(), 'trunk': d.fat_trunk.to_numpy(),
           'android': d.fat_android.to_numpy(), 'arm': d.fat_arm.to_numpy()}
A = {'n': int(len(d)), 'bins': binned(F, {**regions, **{k + 'Share': v / F for k, v in regions.items()}}, w)}
for k, v in regions.items():
    # 冪次：分區 = k·全身^β。β = 1 是等比例；β < 1 表示越胖、這區佔的比例越小
    beta, r2, _, _ = wls(np.column_stack([np.ones_like(F), np.log(F)]), np.log(v), w)
    A[k] = {'beta': round(float(beta[1]), 3), 'r2_log': round(r2, 3), **curvature(F, v, w)}
# 臀圍（只有 2017–2018 量）與全身脂肪、女性型區脂肪
j = d.cycle.eq('J').to_numpy() & d.BMXHIP.gt(0).to_numpy()
hip = d.BMXHIP.to_numpy()
A['hip_vs_totalFat'] = curvature(F[j], hip[j], w[j])
A['hip_vs_gynoidFat'] = curvature(regions['gynoid'][j], hip[j], w[j])
A['hipBins'] = binned(F[j], {'hip': hip[j], 'gynoid': regions['gynoid'][j]}, w[j], 8)
# 亞裔女性（人數少，分五組）：比例的走向是否一樣
a = d.asian.to_numpy()
A['asian'] = {'n': int(a.sum()), 'bins': binned(F[a], {k + 'Share': v[a] / F[a] for k, v in regions.items()}, w[a], 5)}
res['A_dxa'] = A

# ---------- B. NHANES III ----------
cols = {'SEQN': (1, 5), 'HSSEX': (15, 15), 'HSAGEIR': (16, 17), 'WTPFEX6': (59, 67), 'BMPWT': (1508, 1513),
        'BMPHT': (1528, 1532), 'BMPBMI': (1524, 1527), 'BMPBIIL': (1569, 1573), 'BMPWAIST': (1590, 1594),
        'BMPBUTTO': (1595, 1599), 'BMPTHICI': (1604, 1608), 'BMPTRI': (1609, 1612), 'BMPSUB': (1613, 1616),
        'BMPSUP': (1617, 1620), 'BMPTHI': (1621, 1624), 'PEPPREG': (1625, 1625)}
e = pd.read_fwf(exam, colspecs=[(a - 1, b) for a, b in cols.values()], names=list(cols), dtype=str)
e = e.apply(pd.to_numeric, errors='coerce')
# 888… 是「應答但未量到」；懷孕者排除（PEPPREG = 1）
for c in ['BMPWT', 'BMPHT', 'BMPBMI', 'BMPBIIL', 'BMPWAIST', 'BMPBUTTO', 'BMPTHICI', 'BMPTRI', 'BMPSUB', 'BMPSUP', 'BMPTHI']:
    e.loc[e[c] >= 888, c] = np.nan
e = e[e.HSSEX.eq(2) & e.HSAGEIR.between(20, 59) & e.WTPFEX6.gt(0) & ~e.PEPPREG.eq(1)]
need = ['BMPBMI', 'BMPBUTTO', 'BMPTHICI', 'BMPTHI', 'BMPSUP', 'BMPTRI', 'BMPSUB']
e = e.dropna(subset=need)
we, bmi = e.WTPFEX6.to_numpy(), e.BMPBMI.to_numpy()
skin = {'thigh': e.BMPTHI.to_numpy(), 'suprailiac': e.BMPSUP.to_numpy(), 'triceps': e.BMPTRI.to_numpy(),
        'subscapular': e.BMPSUB.to_numpy()}
B = {'n': int(len(e)), 'bins': binned(bmi, {**skin, 'buttocks': e.BMPBUTTO.to_numpy(), 'thighCirc': e.BMPTHICI.to_numpy()}, we)}
for k, v in {**skin, 'buttocks': e.BMPBUTTO.to_numpy(), 'thighCirc': e.BMPTHICI.to_numpy()}.items():
    B[k] = curvature(bmi, v, we)
# 卡尺上限附近的比例（上限約 45～50 mm），太多表示高 BMI 端的厚度被低估
B['thighAtCeiling'] = round(float(np.average(skin['thigh'] >= 44, weights=we)), 3)
B['bmiQuantiles_p5_p50_p95'] = [round(float(v), 1) for v in wquantile(bmi, we, [.05, .5, .95])]
res['B_nhanes3'] = B

(out / 'r20.json').write_text(json.dumps(res, indent=1, ensure_ascii=False))
print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk not in ('bins', 'hipBins')} for k, v in res.items()}, indent=1, ensure_ascii=False))

# ---------- 圖 ----------
import logging  # noqa: E402
import matplotlib  # noqa: E402
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
logging.getLogger('matplotlib.font_manager').setLevel(logging.ERROR)
plt.rcParams['font.family'] = 'WenQuanYi Zen Hei'
plt.rcParams['axes.unicode_minus'] = False
fig, ax = plt.subplots(2, 2, figsize=(14, 10))
names = {'gynoid': '女性型區（臀＋大腿上段）', 'leg': '雙腿', 'trunk': '軀幹', 'android': '男性型區（腹）'}
colors = {'gynoid': '#d9822b', 'leg': '#2a78b8', 'trunk': '#6a9a3a', 'android': '#a04a8a'}
xb = [b['x'] for b in A['bins']]
for k in names:
    yb = [b[k] for b in A['bins']]
    ax[0, 0].plot(xb, yb, 'o-', color=colors[k], label=names[k])
    ax[0, 0].plot([0, xb[-1]], [0, yb[-1] / xb[-1] * xb[-1]], ':', color=colors[k], alpha=.4)
    ax[0, 1].plot(xb, [b[k + 'Share'] * 100 for b in A['bins']], 'o-', color=colors[k], label=names[k])
ax[0, 0].set(xlabel='全身脂肪（kg）', ylabel='分區脂肪（kg，十分位中位數）', title='A1 分區脂肪隨全身脂肪（虛線＝等比例）')
ax[0, 1].set(xlabel='全身脂肪（kg）', ylabel='佔全身脂肪（%）', title='A2 分區比例：水平＝等比例增加')
for a in ax[0]:
    a.grid(alpha=.3)
    a.legend()
xb3 = [b['x'] for b in B['bins']]
for k, lab, c in [('thigh', '大腿皮脂厚', '#2a78b8'), ('suprailiac', '髂嵴上皮脂厚', '#6a9a3a'),
                  ('triceps', '三頭肌皮脂厚', '#999999'), ('subscapular', '肩胛下皮脂厚', '#a04a8a')]:
    ax[1, 0].plot(xb3, [b[k] for b in B['bins']], 'o-', color=c, label=lab)
ax[1, 0].set(xlabel='BMI', ylabel='皮脂厚（mm，十分位中位數）', title=f'B1 局部厚度隨 BMI（NHANES III 女性 20–59，n={B["n"]}）')
ax[1, 0].grid(alpha=.3)
ax[1, 0].legend()
ax2 = ax[1, 1]
ax2.plot(xb3, [b['buttocks'] for b in B['bins']], 'o-', color='#d9822b', label='臀圍（NHANES III）')
ax2.plot(xb3, [b['thighCirc'] for b in B['bins']], 's-', color='#2a78b8', label='大腿圍（NHANES III）')
ax2.set(xlabel='BMI', ylabel='公分', title='B2 圍度隨 BMI')
ax2.grid(alpha=.3)
ax2.legend()
fig.suptitle('R20 女性臀區脂肪隨變胖怎麼變', fontsize=14)
fig.tight_layout()
fig.savefig(out / 'r20_fat_curves.png', dpi=100)
