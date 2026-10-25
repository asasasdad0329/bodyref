"""R3～R5：體脂、骨骼肌五等級、基礎去脂隨身高（NHANES 2011–2018 DXA，20–59 歲）。

python3 tools/research/r3_r5_composition.py <NHANES 資料夾> <輸出資料夾>
輸出 r3_r5.json（只有係數與彙總）與圖；結論記在 docs/work/00-foundation/README.md。

- R3：體脂率 = f(身高, 體重)，再看加上臂圍、男性腰圍能改善多少；亞裔另外擬合比較。
  和目前網站用的 Deurenberg（25 歲）公式對照。
- R4：骨骼肌 = 1.12 × 四肢去脂 − 0.63（McCarthy 2023，Hologic）。條件於身高、體重（DECISIONS #37）
  算 10/50/75/90/97 百分位的倍率。
- R5：基礎去脂（全身去脂＋骨礦物 − 骨骼肌）隨身高、體重的冪次。
- 組成鏈檢查：身高＋體重＋肌肉「一般」→ 骨骼肌 → 基礎去脂 → 脂肪，和 R3 的體脂比對。
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
LEVELS = [('偏少', .10), ('一般', .50), ('有運動', .75), ('健身', .90), ('壯碩', .97)]
GRID = {'F': [(158, 48), (158, 55), (158, 65), (158, 80), (165, 58), (170, 62)],
        'M': [(170, 60), (172, 70), (172, 85), (172, 100), (178, 75), (185, 85)]}


def deurenberg(sex, h, w):
    bmi = w / (h / 100) ** 2
    return (1.2 * bmi + 0.23 * 25 - 10.8 * (sex == 'M') - 5.4) / 100


def feats(d, extra=()):
    lw, lh = np.log(d.BMXWT / 65), np.log(d.BMXHT / 165)
    cols = [np.ones(len(d)), lw, lw ** 2, lh]
    for e in extra:
        cols.append(np.log(d[e] / {'BMXARMC': 30, 'BMXWAIST': 90}[e]))
    return np.column_stack(cols)


def holdout(d, X, y):
    w = d.w.to_numpy()
    tr = (d.SEQN % 5 != 0).to_numpy()
    beta, r2, sd, _ = wls(X[tr], y[tr], w[tr])
    e = X[~tr] @ beta - y[~tr]
    return beta, r2, float(np.sqrt(np.average(e ** 2, weights=w[~tr])))


res = {'source': 'NHANES 2011–2018 DXX, age 20–59, MEC weight/4',
       'smmEquation': 'SMM = 1.12 × ALM − 0.63 (McCarthy et al. 2023, Sci Rep 13:2590, Hologic)'}
for sex in ['F', 'M']:
    d0 = df[df.sex.eq(sex)]
    g = {}
    # ---------- R3 體脂 ----------
    r3 = {}
    variants = [('hw', ()), ('hw+arm', ('BMXARMC',))] + ([('hw+waist', ('BMXWAIST',)), ('hw+arm+waist', ('BMXARMC', 'BMXWAIST'))] if sex == 'M' else [('hw+waist', ('BMXWAIST',))])
    for name, extra in variants:
        d = d0.dropna(subset=list(extra))
        d = d[(d[list(extra)] > 0).all(axis=1)] if extra else d
        beta, r2, rmse = holdout(d, feats(d, extra), d.pf.to_numpy())
        r3[name] = {'n': int(len(d)), 'coef': [round(float(b), 5) for b in beta], 'r2': round(r2, 3), 'holdoutRmsePct': round(100 * rmse, 2)}
    # 亞裔：同一組特徵加上亞裔截距差，以及亞裔單獨擬合
    d = d0
    X = np.column_stack([feats(d), d.asian.astype(float)])
    beta, r2, rmse = holdout(d, X, d.pf.to_numpy())
    r3['hw+asianOffset'] = {'coef': [round(float(b), 5) for b in beta], 'asianOffsetPct': round(100 * float(beta[-1]), 2), 'r2': round(r2, 3)}
    da = d0[d0.asian]
    beta_a, r2a, rmsea = holdout(da, feats(da), da.pf.to_numpy())
    r3['asianOnly'] = {'n': int(len(da)), 'coef': [round(float(b), 5) for b in beta_a], 'r2': round(r2a, 3), 'holdoutRmsePct': round(100 * rmsea, 2)}
    # 年齡的影響大小（網站沒有年齡欄；只記錄它造成多少差）
    Xa = np.column_stack([feats(d0), (d0.RIDAGEYR - 40) / 10])
    beta_age, _, _, _ = wls(Xa, d0.pf.to_numpy(), d0.w.to_numpy())
    r3['agePer10yPct'] = round(100 * float(beta_age[-1]), 2)
    b_all = np.array(r3['hw']['coef'])
    table = []
    for h, w in GRID[sex]:
        x = np.array([1, np.log(w / 65), np.log(w / 65) ** 2, np.log(h / 165)])
        table.append({'h': h, 'w': w, 'bmi': round(w / (h / 100) ** 2, 1), 'nhanesAll': round(float(x @ b_all), 3),
                      'nhanesAsian': round(float(x @ beta_a), 3), 'deurenberg25': round(deurenberg(sex, h, w), 3)})
    r3['grid'] = table
    g['R3'] = r3

    # ---------- R4 骨骼肌等級 ----------
    d = d0
    w = d.w.to_numpy()
    lh, lw = np.log(d.BMXHT / 165).to_numpy(), np.log(d.BMXWT / 65).to_numpy()
    X = np.column_stack([np.ones(len(d)), lh, lw, lw ** 2])
    y = np.log(d.smm.to_numpy())
    beta, r2, sd, resid = wls(X, y, w)
    qs = wquantile(resid, w, [q for _, q in LEVELS])
    # 殘差寬度是否隨 BMI 改變（檢查等級倍率能不能全範圍共用）
    bmi = d.bmi.to_numpy()
    spread = []
    for lo, hi in [(15, 22), (22, 27), (27, 32), (32, 60)]:
        m = (bmi >= lo) & (bmi < hi)
        q = wquantile(resid[m], w[m], [.1, .5, .9, .97])
        spread.append({'bmi': f'{lo}-{hi}', 'n': int(m.sum()), 'p10': round(float(np.exp(q[0] - q[1])), 3),
                       'p90': round(float(np.exp(q[2] - q[1])), 3), 'p97': round(float(np.exp(q[3] - q[1])), 3)})
    table = []
    for h, wt in GRID[sex]:
        x = np.array([1, np.log(h / 165), np.log(wt / 65), np.log(wt / 65) ** 2])
        mu = float(x @ beta)
        table.append({'h': h, 'w': wt, **{name: round(float(np.exp(mu + qv)), 1) for (name, _), qv in zip(LEVELS, qs)}})
    g['R4'] = {'coef': [round(float(b), 4) for b in beta], 'r2': round(r2, 3), 'residSdLog': round(sd, 4),
               'levelFactors': {name: round(float(np.exp(qv - qs[1])), 3) for (name, _), qv in zip(LEVELS, qs)},
               'spreadByBmi': spread, 'grid': table,
               'smmOverWeightMedian': round(float(wquantile((d.smm / d.BMXWT).to_numpy(), w, .5)), 3)}
    # 只用身高（不鎖體重時的參考）
    beta_h, r2h, sdh, resh = wls(np.column_stack([np.ones(len(d)), lh]), y, w)
    qh = wquantile(resh, w, [q for _, q in LEVELS])
    g['R4']['heightOnly'] = {'coef': [round(float(b), 4) for b in beta_h], 'r2': round(r2h, 3),
                             'at': {str(h): {name: round(float(np.exp(beta_h[0] + beta_h[1] * np.log(h / 165) + qv)), 1)
                                             for (name, _), qv in zip(LEVELS, qh)} for h in ([155, 160, 165, 170] if sex == 'F' else [165, 170, 175, 180, 185])}}

    # ---------- R5 基礎去脂 ----------
    yb = np.log(d.base_lean.to_numpy())
    b1, r2_1, sd1, _ = wls(np.column_stack([np.ones(len(d)), lh]), yb, w)
    b2, r2_2, sd2, _ = wls(np.column_stack([np.ones(len(d)), lh, lw]), yb, w)
    b3, r2_3, sd3, _ = wls(np.column_stack([np.ones(len(d)), lh, np.log(d.smm / 25).to_numpy(), np.log(d.fat_total / 20).to_numpy()]), yb, w)
    yl = np.log(d.lean_total.to_numpy())
    bl, r2l, _, _ = wls(np.column_stack([np.ones(len(d)), lh]), yl, w)
    ys = np.log(d.smm.to_numpy())
    bs, r2s, _, _ = wls(np.column_stack([np.ones(len(d)), lh]), ys, w)
    g['R5'] = {'baseLean~height': {'coef': [round(float(b), 4) for b in b1], 'r2': round(r2_1, 3), 'residSd': round(sd1, 4)},
               'baseLean~height+weight': {'coef': [round(float(b), 4) for b in b2], 'r2': round(r2_2, 3), 'residSd': round(sd2, 4)},
               'baseLean~height+smm+fat': {'coef': [round(float(b), 4) for b in b3], 'r2': round(r2_3, 3), 'residSd': round(sd3, 4)},
               'totalLean~height': {'exponent': round(float(bl[1]), 3), 'r2': round(r2l, 3)},
               'smm~height': {'exponent': round(float(bs[1]), 3), 'r2': round(r2s, 3)},
               'baseLeanAt': {str(h): round(float(np.exp(b1[0] + b1[1] * np.log(h / 165))), 1) for h in [150, 160, 170, 180, 190]}}

    # ---------- 組成鏈檢查 ----------
    # 身高、體重 → 骨骼肌（一般）→ 基礎去脂（身高＋骨骼肌＋脂肪，迭代）→ 脂肪 = 體重 − 骨骼肌 − 基礎去脂
    chain = []
    for h, wt in GRID[sex]:
        x = np.array([1, np.log(h / 165), np.log(wt / 65), np.log(wt / 65) ** 2])
        row = {'h': h, 'w': wt}
        for name, q in LEVELS:
            smm = float(np.exp(x @ beta + wquantile(resid, w, q)))
            fat = wt * .3
            for _ in range(30):
                base = float(np.exp(b3[0] + b3[1] * np.log(h / 165) + b3[2] * np.log(smm / 25) + b3[3] * np.log(max(fat, 1) / 20)))
                fat = wt - smm - base
            row[name] = round(fat / wt, 3)
        row['R3'] = next(t['nhanesAll'] for t in g['R3']['grid'] if t['h'] == h and t['w'] == wt)
        chain.append(row)
    g['chainCheck'] = chain
    res[sex] = g

(out / 'r3_r5.json').write_text(json.dumps(res, indent=1, ensure_ascii=False))

import matplotlib  # noqa: E402
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402

fig, axes = plt.subplots(1, 3, figsize=(17, 4.8))
for sex, color in [('F', '#c0392b'), ('M', '#2a78b8')]:
    d0 = df[df.sex.eq(sex)]
    b = np.array(res[sex]['R3']['hw']['coef'])
    ba = np.array(res[sex]['R3']['asianOnly']['coef'])
    h = 160 if sex == 'F' else 172
    ws = np.linspace(42, 110, 60)
    bmis = ws / (h / 100) ** 2
    f = lambda c: [c @ np.array([1, np.log(x / 65), np.log(x / 65) ** 2, np.log(h / 165)]) for x in ws]
    ax = axes[0]
    sub = d0.sample(1200, random_state=1)
    ax.scatter(sub.bmi, sub.pf, s=3, alpha=.15, color=color)
    ax.plot(bmis, f(b), color=color, label=f'{sex} NHANES all (h={h})')
    ax.plot(bmis, f(ba), '--', color=color, label=f'{sex} NHANES Asian')
    ax.plot(bmis, [deurenberg(sex, h, x) for x in ws], ':', color=color, label=f'{sex} current (Deurenberg 25y)')
    ax.set_xlabel('BMI')
    ax.set_ylabel('body fat (DXA)')
    ax.set_xlim(15, 45)
    ax.legend(fontsize=7)
    ax.set_title('R3 body fat vs BMI')
    ax = axes[1]
    for name, _ in LEVELS:
        grid = [t for t in res[sex]['R4']['grid']]
    hs = sorted(res[sex]['R4']['heightOnly']['at'])
    for i, (name, _) in enumerate(LEVELS):
        ax.plot([int(x) for x in hs], [res[sex]['R4']['heightOnly']['at'][x][name] for x in hs], 'o-', color=color, alpha=.35 + .13 * i)
    ax.set_title('R4 SMM levels by height (height only; p10/50/75/90/97)')
    ax.set_xlabel('height (cm)')
    ax.set_ylabel('skeletal muscle (kg)')
    ax = axes[2]
    ax.scatter(sub.BMXHT, sub.base_lean, s=3, alpha=.15, color=color)
    hh = np.linspace(145, 195, 30)
    c = res[sex]['R5']['baseLean~height']['coef']
    ax.plot(hh, np.exp(c[0] + c[1] * np.log(hh / 165)), color=color, label=f'{sex}: base lean ∝ h^{c[1]:.2f}')
    ax.set_xlabel('height (cm)')
    ax.set_ylabel('base lean = lean+BMC−SMM (kg)')
    ax.legend(fontsize=8)
    ax.set_title('R5 base lean vs height')
fig.tight_layout()
fig.savefig(out / 'r3_r5.png', dpi=110)
print(json.dumps(res, indent=1, ensure_ascii=False))
