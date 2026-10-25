"""R9：肚子的組成（內臟、皮下）由哪些因素推得，以及兩者各自讓腰圍變多少（NHANES 2011–2018 DXA）。

python3 tools/research/r9_belly.py <NHANES 資料夾> <輸出資料夾>
輸出 r9.json（只有彙總統計）；結論記在 docs/work/00-foundation/research-belly.md。

- 內臟、皮下脂肪是 DXA 在 L4–L5 一段量的（DXXVFATM、DXXSATM）。
- NHANES 的腰圍量在髂嵴上緣（BMXWAIST），臀圍只有 2017–2018 有（BMXHIP）。
- 最細腰沒有資料集量，換算用文獻（見研究檔）。
"""
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from nhanes_common import load, wls, wquantile, wcorr  # noqa: E402

root, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
df = load(root)
df = df[df.ag_ok & df.fat_vat.gt(0) & df.fat_sat.gt(0)].copy()


def X(d, *cols):
    return np.column_stack([np.ones(len(d))] + list(cols))


res = {}
for sex in ['F', 'M']:
    d = df[df.sex.eq(sex)]
    w = d.w.to_numpy()
    lh, lw = np.log(d.BMXHT / 165).to_numpy(), np.log(d.BMXWT / 65).to_numpy()
    pf = d.pf.to_numpy()
    age = ((d.RIDAGEYR - 40) / 10).to_numpy().astype(float)
    g = {'n': int(len(d))}
    # 內臟、皮下由網站有的輸入推得多少
    pred = {}
    for name, y in [('vat', np.log(d.fat_vat.to_numpy())), ('sat', np.log(d.fat_sat.to_numpy())),
                    ('vatShare', (d.fat_vat / (d.fat_vat + d.fat_sat)).to_numpy())]:
        rows = {}
        for label, cols in [('身高＋體重', [lh, lw]), ('身高＋體重＋體脂', [lh, lw, pf]), ('＋年齡', [lh, lw, pf, age])]:
            beta, r2, sd, _ = wls(X(d, *cols), y, w)
            rows[label] = {'r2': round(r2, 2), 'residSd': round(sd, 3), 'coef': [round(float(b), 3) for b in beta]}
        dd = d[d.BMXWAIST.gt(0)]
        ww = dd.w.to_numpy()
        yy = y[d.BMXWAIST.gt(0).to_numpy()]
        cols = [np.log(dd.BMXHT / 165), np.log(dd.BMXWT / 65), dd.pf, np.log(dd.BMXWAIST / 90)]
        beta, r2, sd, _ = wls(X(dd, *cols), yy, ww)
        rows['身高＋體重＋體脂＋腰圍'] = {'r2': round(r2, 2), 'residSd': round(sd, 3)}
        dj = d[d.cycle.eq('J') & d.BMXHIP.gt(0) & d.BMXWAIST.gt(0)]
        yj = y[(d.cycle.eq('J') & d.BMXHIP.gt(0) & d.BMXWAIST.gt(0)).to_numpy()]
        cols = [np.log(dj.BMXHT / 165), np.log(dj.BMXWT / 65), dj.pf, np.log(dj.BMXWAIST / 90), np.log(dj.BMXHIP / 100)]
        beta, r2, sd, _ = wls(X(dj, *cols), yj, dj.w.to_numpy())
        rows['＋腰圍＋臀圍（2017–18）'] = {'r2': round(r2, 2), 'residSd': round(sd, 3), 'n': int(len(dj))}
        pred[name] = rows
    g['predict'] = pred
    # 內臟占比的分布（扣掉身高、體重、體脂後）：肚子的「型」有多大
    share = (d.fat_vat / (d.fat_vat + d.fat_sat)).to_numpy()
    g['vatShareQuantiles'] = [round(float(v), 3) for v in wquantile(share, w, [.1, .25, .5, .75, .9])]
    g['vatShareByPf'] = []
    for lo, hi in ([(0, .30), (.30, .35), (.35, .40), (.40, .45), (.45, 1)] if sex == 'F' else [(0, .18), (.18, .23), (.23, .28), (.28, .33), (.33, 1)]):
        m = (pf >= lo) & (pf < hi)
        q = wquantile(share[m], w[m], [.1, .5, .9])
        g['vatShareByPf'].append({'pf': f'{lo:.2f}-{hi:.2f}', 'n': int(m.sum()), 'p10': round(float(q[0]), 3), 'p50': round(float(q[1]), 3), 'p90': round(float(q[2]), 3)})
    g['vatShareCorrAge'] = round(float(wcorr(share, age, w)), 2)
    # 腰圍（髂嵴）由內臟、皮下、其他脂肪各解釋多少
    dd = d[d.BMXWAIST.gt(0)]
    ww = dd.w.to_numpy()
    cols = [np.log(dd.BMXHT / 165), np.log(dd.fat_vat), np.log(dd.fat_sat), np.log(dd.fat_total - dd.fat_vat - dd.fat_sat), np.log(dd.lean_trunk)]
    beta, r2, sd, _ = wls(X(dd, *cols), np.log(dd.BMXWAIST.to_numpy()), ww)
    med = {k: float(wquantile(v.to_numpy(), ww, .5)) for k, v in [('vat', dd.fat_vat), ('sat', dd.fat_sat), ('waist', dd.BMXWAIST)]}
    q = {k: wquantile(v.to_numpy(), ww, [.1, .9]) for k, v in [('vat', dd.fat_vat), ('sat', dd.fat_sat)]}
    g['waistDecomposition'] = {
        'r2': round(r2, 2), 'elasticity': {'height': round(float(beta[1]), 3), 'vat': round(float(beta[2]), 3), 'sat': round(float(beta[3]), 3),
                                           'otherFat': round(float(beta[4]), 3), 'trunkLean': round(float(beta[5]), 3)},
        'medianWaistCm': round(med['waist'], 1),
        'vatP10toP90Cm': round(med['waist'] * (np.exp(beta[2] * np.log(q['vat'][1] / q['vat'][0])) - 1), 1),
        'satP10toP90Cm': round(med['waist'] * (np.exp(beta[3] * np.log(q['sat'][1] / q['sat'][0])) - 1), 1),
        'vatP10P90Kg': [round(float(x), 2) for x in q['vat']], 'satP10P90Kg': [round(float(x), 2) for x in q['sat']]}
    res[sex] = g
(out / 'r9.json').write_text(json.dumps(res, indent=1, ensure_ascii=False))
print(json.dumps(res, indent=1, ensure_ascii=False))
