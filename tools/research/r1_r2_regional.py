"""R1、R2：分區脂肪與分區去脂隨總量的變化（NHANES 2011–2018 DXA，20–59 歲）。

python3 tools/research/r1_r2_regional.py <NHANES 資料夾> <輸出資料夾>
輸出 r1_r2.json（只有彙總統計）與圖；結論記在 docs/work/00-foundation/README.md。

方法
- 異速指數 b：log(分區量) = a + b·log(總量)，加權。b > 1 表示總量增加時這區長得比平均快。
- 邊際分配：把樣本依總量分 8 個等權重區間，相鄰區間平均值的差 → 每多 1 kg 總量各區分到多少。
  這是橫斷面的比較（較胖的人 vs 較瘦的人），不是同一人增重的追蹤，先後順序要用文獻（R1b）確認。
- 一起變／各自變：扣掉總量的影響後，各區殘差的相關係數。
"""
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from nhanes_common import load, wls, wcorr, wquantile  # noqa: E402

root, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
df = load(root)

FAT = ['arm', 'leg', 'trunk', 'head']          # 互不重疊，加總 = 全身
FAT_AG = ['android', 'gynoid', 'vat', 'sat']   # DXXAG 的區，和上面重疊
LEAN = ['arm', 'leg', 'trunk', 'head']
GROUPS = [('F', False), ('M', False), ('F', True), ('M', True)]
NBINS = 8


def group(sex, asian, need_ag=False):
    d = df[df.sex.eq(sex)]
    if asian:
        d = d[d.asian]
    if need_ag:
        d = d[d.ag_ok & d.fat_vat.gt(0) & d.fat_sat.gt(0)]
    return d


def allometry(d, total, regions, prefix):
    w = d.w.to_numpy()
    x = np.log(d[total].to_numpy())
    X = np.column_stack([np.ones_like(x), x])
    res = {}
    for r in regions:
        y = np.log(d[f'{prefix}_{r}'].to_numpy())
        beta, r2, sd, resid = wls(X, y, w)
        res[r] = {'b': round(float(beta[1]), 3), 'r2': round(float(r2), 3), 'residSd': round(sd, 3), '_resid': resid}
    return res


def marginal(d, total, regions, prefix):
    w = d.w.to_numpy()
    t = d[total].to_numpy()
    edges = wquantile(t, w, np.linspace(0, 1, NBINS + 1))
    idx = np.clip(np.searchsorted(edges, t, side='right') - 1, 0, NBINS - 1)
    rows = []
    for k in range(NBINS):
        m = idx == k
        row = {'total': float(np.average(t[m], weights=w[m])), 'pf': float(np.average(d.pf.to_numpy()[m], weights=w[m])),
               'n': int(m.sum())}
        for r in regions:
            row[r] = float(np.average(d[f'{prefix}_{r}'].to_numpy()[m], weights=w[m]))
        rows.append(row)
    steps = []
    for a, b in zip(rows[:-1], rows[1:]):
        dt = b['total'] - a['total']
        steps.append({'from': round(a['total'], 1), 'to': round(b['total'], 1),
                      **{r: round((b[r] - a[r]) / dt, 3) for r in regions}})
    shares = [{'total': round(r['total'], 1), 'pf': round(r['pf'], 3), 'n': r['n'],
               **{k: round(r[k] / r['total'], 3) for k in regions}} for r in rows]
    return shares, steps


def resid_corr(al, regions, w):
    return {f'{a}~{b}': round(float(wcorr(al[a]['_resid'], al[b]['_resid'], w)), 2)
            for i, a in enumerate(regions) for b in regions[i + 1:]}


result = {'source': 'NHANES 2011–2018 DXX/DXXAG, age 20–59, MEC weight/4', 'groups': {}}
for sex, asian in GROUPS:
    key = sex + ('-asian' if asian else '-all')
    d = group(sex, asian)
    dag = group(sex, asian, need_ag=True)
    g = {'n': int(len(d)), 'nAg': int(len(dag))}
    al = allometry(d, 'fat_total', FAT, 'fat')
    g['fatAllometry'] = {k: {kk: v for kk, v in r.items() if not kk.startswith('_')} for k, r in al.items()}
    g['fatResidCorr'] = resid_corr(al, FAT, d.w.to_numpy())
    alag = allometry(dag, 'fat_total', FAT_AG, 'fat')
    g['fatAgAllometry'] = {k: {kk: v for kk, v in r.items() if not kk.startswith('_')} for k, r in alag.items()}
    g['fatAgResidCorr'] = resid_corr(alag, FAT_AG, dag.w.to_numpy())
    g['fatShares'], g['fatMarginal'] = marginal(d, 'fat_total', FAT, 'fat')
    g['fatAgShares'], g['fatAgMarginal'] = marginal(dag, 'fat_total', FAT_AG, 'fat')
    # 型：扣掉總脂肪後，軀幹對腿的偏向（蘋果／西洋梨）分布
    tl = np.log(d.fat_trunk / d.fat_leg).to_numpy()
    beta, r2, sd, resid = wls(np.column_stack([np.ones(len(d)), np.log(d.fat_total)]), tl, d.w.to_numpy())
    g['trunkLegType'] = {'slope': round(float(beta[1]), 3), 'r2': round(float(r2), 3), 'residSd': round(sd, 3),
                         'residQuantiles': [round(float(v), 3) for v in wquantile(resid, d.w.to_numpy(), [.1, .25, .5, .75, .9])],
                         'corrWithHeight': round(float(wcorr(resid, np.log(d.BMXHT.to_numpy()), d.w.to_numpy())), 2),
                         'corrWithAge': round(float(wcorr(resid, d.RIDAGEYR.to_numpy().astype(float), d.w.to_numpy())), 2)}
    al = allometry(d, 'lean_total', LEAN, 'lean')
    g['leanAllometry'] = {k: {kk: v for kk, v in r.items() if not kk.startswith('_')} for k, r in al.items()}
    g['leanResidCorr'] = resid_corr(al, LEAN, d.w.to_numpy())
    g['leanShares'], g['leanMarginal'] = marginal(d, 'lean_total', LEAN, 'lean')
    # 去脂的分區偏向（手臂、腿）是否和脂肪的分區偏向相關
    g['leanVsFatPattern'] = {
        'armLeanShare~armFatShare': round(float(wcorr((d.lean_arm / d.lean_total).to_numpy(), (d.fat_arm / d.fat_total).to_numpy(), d.w.to_numpy())), 2),
        'legLeanShare~legFatShare': round(float(wcorr((d.lean_leg / d.lean_total).to_numpy(), (d.fat_leg / d.fat_total).to_numpy(), d.w.to_numpy())), 2)}
    result['groups'][key] = g

(out / 'r1_r2.json').write_text(json.dumps(result, indent=1, ensure_ascii=False))

# 圖
import matplotlib  # noqa: E402
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402

colors = {'arm': '#2a78b8', 'leg': '#d9822b', 'trunk': '#3a9a5b', 'head': '#888888',
          'android': '#c0392b', 'gynoid': '#8e44ad', 'vat': '#7f5a2e', 'sat': '#e5a5b8'}
names = {'arm': 'arms', 'leg': 'legs', 'trunk': 'trunk', 'head': 'head', 'android': 'android',
         'gynoid': 'gynoid', 'vat': 'VAT (L4-5 band)', 'sat': 'SAT (L4-5 band)'}
fig, axes = plt.subplots(2, 4, figsize=(18, 8.5))
for col, (key, regs, field) in enumerate([('F-all', FAT, 'fatShares'), ('M-all', FAT, 'fatShares'),
                                          ('F-all', FAT_AG, 'fatAgShares'), ('M-all', FAT_AG, 'fatAgShares')]):
    for row, grp in enumerate([key, key.replace('all', 'asian')]):
        ax = axes[row, col]
        sh = result['groups'][grp][field]
        for r in regs:
            ax.plot([s['total'] for s in sh], [s[r] for s in sh], 'o-', color=colors[r], label=names[r])
        ax.set_title(f'{grp}: share of total fat')
        ax.set_xlabel('total fat (kg)')
        ax.grid(alpha=.3)
        ax.legend(fontsize=8)
fig.tight_layout()
fig.savefig(out / 'r1_fat_shares.png', dpi=110)

fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
for ax, key in zip(axes, ['F-all', 'M-all']):
    st = result['groups'][key]['fatMarginal']
    mids = [(s['from'] + s['to']) / 2 for s in st]
    bottom = np.zeros(len(st))
    for r in FAT:
        v = np.array([s[r] for s in st])
        ax.bar(range(len(st)), v, bottom=bottom, color=colors[r], label=names[r])
        bottom += v
    ax.set_xticks(range(len(st)), [f'{m:.0f}' for m in mids])
    ax.set_xlabel('total fat (kg, step midpoint)')
    ax.set_title(f'{key}: where each extra kg of fat goes')
    ax.legend(fontsize=8)
fig.tight_layout()
fig.savefig(out / 'r1_fat_marginal.png', dpi=110)

fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
for ax, key in zip(axes, ['F-all', 'M-all']):
    for grp, ls in [(key, '-'), (key.replace('all', 'asian'), '--')]:
        sh = result['groups'][grp]['leanShares']
        for r in ['arm', 'leg', 'trunk']:
            ax.plot([s['total'] for s in sh], [s[r] for s in sh], ls, marker='o', color=colors[r],
                    label=f'{names[r]} ({grp.split("-")[1]})')
    ax.set_title(f'{key[0]}: share of total lean')
    ax.set_xlabel('total lean (kg)')
    ax.grid(alpha=.3)
    ax.legend(fontsize=7)
fig.tight_layout()
fig.savefig(out / 'r2_lean_shares.png', dpi=110)
print(json.dumps({k: {kk: g[kk] for kk in ['n', 'nAg', 'fatAllometry', 'fatAgAllometry', 'fatResidCorr', 'fatAgResidCorr',
                                           'trunkLegType', 'leanAllometry', 'leanResidCorr', 'leanVsFatPattern']}
                  for k, g in result['groups'].items()}, indent=1))
