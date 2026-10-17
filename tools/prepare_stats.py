"""由 ANSUR II（美國陸軍 2012 年人體計測，公有領域）計算各量測項目之間的共變異數。

用法：
  python3 tools/prepare_stats.py <ANSUR II FEMALE Public.csv> <ANSUR II MALE Public.csv>

輸出 src/core/statsModel.json：每個性別一個共變異數矩陣（在轉換後的空間：長度與重量取對數，體脂率維持比例）。
網站只用這份資料的「連動關係」（共變異數）；平均值改用 src/core/reference.ts 裡台灣／東亞年輕成人的參考體型。

ANSUR II 沒有量的項目用模型補上，並在 notes 裡記錄：
- 體脂率：以 Deurenberg 公式由 BMI 估算（年齡固定 25 歲），再依腰、臀、二頭肌圍相對於身高體重的偏差調整。
- 下胸圍：由胸圍減去上下胸圍差，胸圍差與體脂率相關。
"""

import csv
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src/core/statsModel.json')

VARS = [
    'height', 'weight', 'bodyFat', 'neck', 'bust', 'underbust', 'waist', 'hip', 'upperArm', 'wrist',
    'thigh', 'calf', 'ankle', 'shoulder', 'upperArmLen', 'forearmLen', 'thighLen', 'calfLen',
]
REPLICAS = 20


def load(path):
    rows = list(csv.DictReader(open(path, encoding='latin-1')))
    col = lambda k: np.array([float(r[k]) for r in rows])
    mm = lambda k: col(k) / 10.0
    d = {
        'height': mm('stature'),
        'weight': col('weightkg') / 10.0,
        'neck': mm('neckcircumference'),
        'bust': mm('chestcircumference'),
        'waist': mm('waistcircumference'),
        'hip': mm('buttockcircumference'),
        'upperArm': mm('bicepscircumferenceflexed'),
        'wrist': mm('wristcircumference'),
        'thigh': mm('thighcircumference'),
        'calf': mm('calfcircumference'),
        'ankle': mm('anklecircumference'),
        'shoulder': mm('biacromialbreadth'),
        'upperArmLen': mm('acromionradialelength'),
        'forearmLen': mm('radialestylionlength'),
        'thighLen': mm('crotchheight') - mm('lateralfemoralepicondyleheight'),
        'calfLen': mm('lateralfemoralepicondyleheight') - mm('lateralmalleolusheight'),
    }
    d['race'] = col('DODRace')
    return d


def residual_z(y, X):
    """y 對 X 做線性迴歸後的標準化殘差"""
    A = np.column_stack([np.ones(len(y)), X])
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    r = y - A @ coef
    return r / r.std()


def build(d, male, rng):
    n = len(d['height'])
    bmi = d['weight'] / (d['height'] / 100) ** 2
    base = np.column_stack([np.log(d['height']), np.log(d['weight'])])
    zw = residual_z(np.log(d['waist']), base)
    zh = residual_z(np.log(d['hip']), base)
    za = residual_z(np.log(d['upperArm']), base)
    rows = []
    for _ in range(REPLICAS):
        bf = 1.2 * bmi + 0.23 * 25 - 10.8 * male - 5.4
        bf = bf + 1.6 * zw + (0.6 if male else 1.2) * zh - 1.0 * za + rng.normal(0, 2.5, n)
        bf = np.clip(bf, 4, 60)
        # 胸圍差 = 隨體脂變化的部分 + 個人差異。個人差異大多加在上胸圍（胸部本身），
        # 只有一小部分算在下胸圍（骨架），否則指定大罩杯時模型會以「骨架變小」來解釋。
        if male:
            mean_diff, noise = 6 + 0.15 * (bf - 20), rng.normal(0, 1.8, n)
        else:
            mean_diff, noise = 13 + 0.25 * (bf - 30), rng.normal(0, 3.2, n)
        ub = d['bust'] - mean_diff - 0.3 * noise
        bust = d['bust'] + 0.7 * noise
        cols = []
        for v in VARS:
            if v == 'bodyFat':
                cols.append(bf / 100)
            elif v == 'underbust':
                cols.append(np.log(np.maximum(ub, 40)))
            elif v == 'bust':
                cols.append(np.log(np.maximum(bust, ub + 1)))
            else:
                cols.append(np.log(d[v]))
        rows.append(np.column_stack(cols))
    Z = np.vstack(rows)
    return Z.mean(axis=0), np.cov(Z, rowvar=False)


def main():
    rng = np.random.default_rng(7)
    out = {
        'source': 'ANSUR II (U.S. Army Anthropometric Survey 2012), public domain; 1,986 women and 4,082 men.',
        'notes': [
            'Lengths and weight are log-transformed; bodyFat is a fraction.',
            'bodyFat is synthetic: Deurenberg (age 25) from BMI, adjusted by waist, hip and flexed biceps residuals.',
            'underbust is synthetic: chest minus a bust difference that rises with body fat; '
            '70% of the individual bust difference is added to the bust and 30% subtracted from the underbust.',
            'waist in ANSUR II is measured at the navel; upperArm is flexed biceps; shoulder is biacromial breadth; '
            'upperArmLen is acromion-radiale; forearmLen is radiale-stylion.',
            'Only the covariance is used. Means come from src/core/reference.ts.',
        ],
        'variables': VARS,
        'transform': ['linear' if v == 'bodyFat' else 'log' for v in VARS],
    }
    for sex, path, male in (('female', sys.argv[1], 0), ('male', sys.argv[2], 1)):
        d = load(path)
        mean, cov = build(d, male, rng)
        asian = d['race'] == 4
        out[sex] = {
            'n': int(len(d['height'])),
            'ansurMean': [round(float(x), 5) for x in mean],
            'cov': [[round(float(x), 8) for x in row] for row in cov],
            'asianMeanCm': {v: round(float(np.mean(d[v][asian])), 1) for v in VARS if v in d},
            'asianN': int(asian.sum()),
        }
        corr = cov / np.sqrt(np.outer(np.diag(cov), np.diag(cov)))
        i = VARS.index
        print(sex, 'n', len(d['height']), 'asian', int(asian.sum()))
        for a, b in (('hip', 'thigh'), ('weight', 'waist'), ('bust', 'underbust'), ('height', 'thighLen'), ('waist', 'bodyFat'), ('weight', 'bodyFat')):
            print(f'  corr {a}-{b}: {corr[i(a), i(b)]:.2f}')
    with open(OUT, 'w') as f:
        json.dump(out, f)
    print('wrote', OUT)


if __name__ == '__main__':
    main()
