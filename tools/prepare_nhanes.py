"""同一期 NHANES 成人放鬆上臂與粗分區組成校準；原始檔及個體資料不入庫。

python3 tools/prepare_nhanes.py /path/to/2017-2018
需要 numpy、pandas；輸入 DEMO_J.xpt、BMX_J.xpt、DXX_J.xpt。
只輸出係數、範圍、樣本數與確定的留出驗證，不輸出個體資料。
"""
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd

root = Path(sys.argv[1])
names = ['DEMO_J', 'BMX_J', 'DXX_J']
data = [pd.read_sas(root / (name + '.xpt')) for name in names]
# pandas 對部分 SAS IBM 浮點零解成極小非零值；只正規化機器零，不放寬品質碼。
for table in data:
    table.mask(table.abs().lt(1e-50), 0, inplace=True)
df = data[0].merge(data[1], on='SEQN', validate='one_to_one').merge(data[2], on='SEQN', validate='one_to_one')
flags = ['DXAHETV', 'DXALATV', 'DXARATV', 'DXALLTV', 'DXARLTV', 'DXATRTV']
valid = df.RIDAGEYR.between(20, 59) & df.WTMEC2YR.gt(0) & df.DXAEXSTS.eq(1)
valid &= df[flags].eq(0).all(axis=1)
valid &= df.BMXHT.gt(0) & df.BMXWT.gt(0) & df.BMXARMC.gt(0) & df.DXDTOPF.between(3, 65)
valid &= df.BMIARMC.fillna(0).eq(0) & df.BMIHT.fillna(0).eq(0) & df.BMIWT.fillna(0).eq(0)
df = df[valid].copy()


def design(d):
    return np.column_stack([np.ones(len(d)), np.log(d.BMXHT / 165), np.log(d.BMXWT / 65), d.DXDTOPF / 100 - .3])


def fit(x, y, w):
    s = np.sqrt(w / w.mean())
    return np.linalg.lstsq(x * s[:, None], y * s, rcond=None)[0]


output = {
    'version': 1, 'survey': 'NHANES 2017–2018', 'age': [20, 59],
    'features': ['intercept', 'log(height/165)', 'log(weight/65)', 'bodyFat-0.3'],
    'quality': 'DXAEXSTS=1; all head/arm/leg/trunk tissue flags=0; valid BMX; WTMEC2YR>0',
    'split': 'SEQN modulo 5 = 0 held out; coefficients fitted to remaining 80%',
    'sourceSha256': {n: hashlib.sha256((root / (n + '.xpt')).read_bytes()).hexdigest() for n in names},
    'notes': ['DXA lean soft tissue is not skeletal muscle.',
              'Whole arms/legs include forearms/calves: local allocation remains a surface-model prior.',
              'Weighted holdout errors describe prediction, not complex-survey confidence intervals.',
              'ANSUR subjects and estimated body fat are never merged with NHANES subjects.'],
}
for sex, code in [('female', 2), ('male', 1)]:
    d = df[df.RIAGENDR.eq(code)]
    train = d.SEQN.mod(5).ne(0).to_numpy()
    x, w = design(d), d.WTMEC2YR.to_numpy()
    y = np.log(d.BMXARMC.to_numpy())
    coef = fit(x[train], y[train], w[train])
    error = np.exp(x[~train] @ coef) - d.BMXARMC.to_numpy()[~train]
    log_error = x[~train] @ coef - y[~train]
    row = {
        'nTrain': int(train.sum()), 'nHoldout': int((~train).sum()), 'armCoef': coef.tolist(),
        'armHoldoutMaeCm': float(np.average(np.abs(error), weights=w[~train])),
        'armHoldoutLogRmse': float(np.sqrt(np.average(log_error ** 2, weights=w[~train]))),
        'domain': {k: [float(d[k].min()), float(d[k].max())] for k in ['BMXHT', 'BMXWT', 'DXDTOPF']},
    }
    fractions = {}
    for tissue, cols in [('fat', [('arm', ['DXXLAFAT', 'DXXRAFAT']), ('leg', ['DXXLLFAT', 'DXXRLFAT']), ('trunk', ['DXXTRFAT'])]),
                         ('lean', [('arm', ['DXDLALE', 'DXDRALE']), ('leg', ['DXDLLLE', 'DXDRLLE']), ('trunk', ['DXDTRLE'])])]:
        total = d[[c for _, cs in cols for c in cs]].sum(axis=1).to_numpy()
        fractions[tissue] = {}
        for region, cs in cols:
            target = d[cs].sum(axis=1).to_numpy() / total
            c = fit(x[train], target[train], w[train])
            err = x[~train] @ c - target[~train]
            fractions[tissue][region] = {'coef': c.tolist(), 'holdoutMae': float(np.average(np.abs(err), weights=w[~train]))}
    row['fractions'] = fractions
    output[sex] = row
dest = Path(__file__).resolve().parents[1] / 'src/core/nhanesModel.json'
dest.write_text(json.dumps(output, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({s: {k: output[s][k] for k in ['nTrain', 'nHoldout', 'armHoldoutMaeCm', 'armHoldoutLogRmse']} for s in ['female', 'male']}, indent=2))
