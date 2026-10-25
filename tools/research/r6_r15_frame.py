"""第二批研究：骨架（R6、R7、R10、R11、R15），ANSUR II。R8 肩寬換算另見 r8_shoulder.test.ts。

python3 tools/research/r6_r15_frame.py <ANSUR 資料夾> <NHANES 資料夾> <輸出資料夾>
ANSUR 資料夾內需有 ANSUR_II_FEMALE_Public.csv、ANSUR_II_MALE_Public.csv（長度 mm、weightkg 為 0.1 kg）。
輸出 r6_r15.json（只有彙總統計）與圖；結論記在 docs/work/00-foundation/research-frame.md。

方法
- 軟組織敏感度：log(量測) = a + b·log(身高) + c·log(BMI)。c 是身高固定時對胖瘦的彈性，
  骨為主的量測 c 小、軟組織為主的 c 大。
- 骨架是否有單一因子：骨性寬度扣掉身高與 BMI 後的殘差相關。結果是沒有；肢端（手腕、腳踝、
  內外踝、手腳寬）會一起變，稱為「關節粗細因子」（殘差的第一主成分），肩寬、胸廓、骨盆各自獨立。
- 骨與軟的幅度：身高 p5→p95（BMI 固定）、BMI p5→p95（身高固定）、關節粗細 p5→p95 各讓量測變多少公分，
  另列身高與 BMI 都解釋不了的個人差（殘差標準差，公分）。
"""
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from nhanes_common import load as load_nhanes, wls, wquantile  # noqa: E402

ansur_dir, nhanes_dir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)


def load_ansur():
    frames = []
    for sex, name in [('F', 'FEMALE'), ('M', 'MALE')]:
        d = pd.read_csv(ansur_dir / f'ANSUR_II_{name}_Public.csv', encoding='latin1')
        d.columns = [c.lower() for c in d.columns]
        d['sex'] = sex
        frames.append(d)
    d = pd.concat(frames, ignore_index=True)
    d['weight'] = d.weightkg / 10
    d['h'] = d.stature / 10
    d['bmi'] = d.weight / (d.h / 100) ** 2
    return d


A = load_ansur()
ONES = lambda d: np.ones(len(d))

BONY = ['biacromialbreadth', 'bimalleolarbreadth', 'wristcircumference', 'anklecircumference',
        'handbreadth', 'footbreadthhorizontal', 'heelbreadth']
JOINT = BONY[1:]  # 肩寬不屬於肢端這一組
SKELETON = ['biacromialbreadth', 'chestbreadth', 'chestdepth', 'bicristalbreadth', 'hipbreadth', 'waistbacklength',
            'wristcircumference', 'anklecircumference', 'bimalleolarbreadth', 'handbreadth']
MIXED = ['chestbreadth', 'chestdepth', 'bicristalbreadth', 'hipbreadth', 'neckcircumference', 'neckcircumferencebase',
         'waistbreadth', 'waistdepth']
GIRTHS = ['wristcircumference', 'anklecircumference', 'neckcircumference', 'calfcircumference', 'lowerthighcircumference',
          'thighcircumference', 'forearmcircumferenceflexed', 'bicepscircumferenceflexed', 'chestcircumference',
          'waistcircumference', 'buttockcircumference']
NAMES = {
    'biacromialbreadth': '肩寬（骨點）', 'bimalleolarbreadth': '踝寬（內外踝）', 'wristcircumference': '手腕圍',
    'anklecircumference': '腳踝圍', 'handbreadth': '手掌寬', 'footbreadthhorizontal': '腳寬', 'heelbreadth': '腳跟寬',
    'chestbreadth': '胸廓寬', 'chestdepth': '胸廓深', 'bicristalbreadth': '胯寬（髂嵴）', 'hipbreadth': '臀寬',
    'neckcircumference': '頸圍', 'neckcircumferencebase': '頸根圍', 'waistbreadth': '腰寬（肚臍）', 'waistdepth': '腰深（肚臍）',
    'calfcircumference': '小腿圍', 'lowerthighcircumference': '膝上圍', 'thighcircumference': '大腿圍',
    'forearmcircumferenceflexed': '前臂圍', 'bicepscircumferenceflexed': '上臂圍（屈臂）', 'chestcircumference': '胸圍',
    'waistbacklength': '背長',
    'waistcircumference': '腰圍（肚臍）', 'buttockcircumference': '臀圍'}


def fit(d, y, cols):
    X = np.column_stack([ONES(d)] + cols)
    return wls(X, y, ONES(d))


res = {'source': 'ANSUR II public data (F 1,986, M 4,082)'}
for sex in ['F', 'M']:
    d = A[A.sex.eq(sex)].copy()
    lh, lb = np.log(d.h.to_numpy()), np.log(d.bmi.to_numpy())
    g = {'n': int(len(d))}

    # ---- 軟組織敏感度 ----
    sens = {}
    resid = {}
    for c in BONY + MIXED + GIRTHS:
        if c in sens:
            continue
        y = np.log(d[c].to_numpy())
        beta, r2, sd, r = fit(d, y, [lh, lb])
        beta_h, r2_h, _, _ = fit(d, y, [lh])
        sens[c] = {'name': NAMES[c], 'mean': round(float(d[c].mean() / 10), 1), 'eH': round(float(beta[1]), 2),
                   'eBMI': round(float(beta[2]), 2), 'r2HeightOnly': round(r2_h, 2), 'r2': round(r2, 2), 'residSd': round(sd, 4)}
        resid[c] = r
    g['sensitivity'] = sens

    # ---- 骨架是否有單一因子 ----
    for c in SKELETON:
        if c not in resid:
            resid[c] = fit(d, np.log(d[c].to_numpy()), [lh, lb])[3]
    C = np.corrcoef(np.column_stack([resid[c] for c in SKELETON]).T)
    g['skeletonResidCorr'] = {'order': [NAMES[c] for c in SKELETON], 'matrix': np.round(C, 2).tolist()}
    R = np.column_stack([resid[c] / resid[c].std() for c in JOINT])
    Cj = np.corrcoef(R.T)
    vals, vecs = np.linalg.eigh(Cj)
    v = vecs[:, -1] * np.sign(vecs[:, -1].sum())
    joint = R @ v
    joint = (joint - joint.mean()) / joint.std()
    g['joint'] = {'loadings': {NAMES[c]: round(float(x), 2) for c, x in zip(JOINT, v)},
                  'varianceExplained': round(float(vals[-1] / vals.sum()), 2),
                  'corrWithShoulderResid': round(float(np.corrcoef(joint, resid['biacromialbreadth'])[0, 1]), 2)}
    g['jointFromInputs'] = {}
    for k, cols in {'手腕': ['wristcircumference'], '腳踝': ['anklecircumference'],
                    '手腕＋腳踝': ['wristcircumference', 'anklecircumference']}.items():
        beta, r2, _, _ = fit(d, joint, [resid[c] for c in cols])
        g['jointFromInputs'][k] = {'r2': round(r2, 2)}

    # ---- 骨與軟的幅度（公分） ----
    q = lambda x: np.percentile(x, [5, 95])
    (h5, h95), (b5, b95), (j5, j95) = q(lh), q(lb), q(joint)
    split = {}
    for c in SKELETON + MIXED + GIRTHS:
        if NAMES[c] in split:
            continue
        y = np.log(d[c].to_numpy())
        beta, r2, sd, _ = fit(d, y, [lh, lb, joint])
        mid = beta[0] + beta[1] * np.median(lh) + beta[2] * np.median(lb)
        cm = lambda dz: float(np.exp(mid) / 10 * (np.exp(dz) - 1))
        split[NAMES[c]] = {'heightRangeCm': round(cm(beta[1] * (h95 - h5)), 1), 'bmiRangeCm': round(cm(beta[2] * (b95 - b5)), 1),
                           'jointRangeCm': round(cm(beta[3] * (j95 - j5)), 1), 'residSdCm': round(float(np.exp(mid) / 10 * sd), 1),
                           'atMedianCm': round(float(np.exp(mid) / 10), 1), 'r2': round(r2, 2)}
    g['ranges'] = split
    g['p5p95'] = {'height': [round(float(np.exp(h5)), 1), round(float(np.exp(h95)), 1)], 'bmi': [round(float(np.exp(b5)), 1), round(float(np.exp(b95)), 1)]}

    # ---- R7 基礎圍度：偏瘦（BMI 19）、中位身高、關節粗細 p5／p50／p95 ----
    base = {}
    for c in ['wristcircumference', 'anklecircumference', 'neckcircumference', 'forearmcircumferenceflexed', 'calfcircumference',
              'lowerthighcircumference', 'bicepscircumferenceflexed', 'thighcircumference']:
        y = np.log(d[c].to_numpy())
        beta, _, _, _ = fit(d, y, [lh, lb, joint])
        z = beta[0] + beta[1] * np.median(lh) + beta[2] * np.log(19)
        base[NAMES[c]] = {'eBMI': round(float(beta[2]), 2),
                          'bmi19': [round(float(np.exp(z + beta[3] * jj) / 10), 1) for jj in (j5, 0, j95)],
                          'bmi19to27Cm': round(float(np.exp(z) / 10 * ((27 / 19) ** beta[2] - 1)), 1)}
    g['R7baseGirth'] = {'heightCm': round(float(np.exp(np.median(lh))), 1), 'rows': base}

    # ---- 胸廓：作者的提案（肩寬＋軀幹長度）----
    torso = np.log(d.waistbacklength.to_numpy())
    sh = np.log(d.biacromialbreadth.to_numpy())
    rib = {}
    for c in ['chestbreadth', 'chestdepth']:
        y = np.log(d[c].to_numpy())
        rows = {}
        for label, cols in [('身高', [lh]), ('身高＋肩寬＋背長', [lh, sh, torso]), ('身高＋關節粗細', [lh, joint]),
                            ('身高＋肩寬＋背長＋BMI', [lh, sh, torso, lb]), ('身高＋肩寬＋背長＋胯寬＋BMI', [lh, sh, torso, np.log(d.bicristalbreadth.to_numpy()), lb])]:
            beta, r2, _, _ = fit(d, y, cols)
            rows[label] = {'r2': round(r2, 2), 'coef': [round(float(b), 3) for b in beta[1:]]}
        rib[NAMES[c]] = rows
    g['ribcage'] = rib

    # ---- R15 胯寬 ----
    bc = d.bicristalbreadth.to_numpy() / 10
    wb = d.waistbreadth.to_numpy() / 10
    bins = [(0, 20), (20, 22.5), (22.5, 25), (25, 27.5), (27.5, 30), (30, 35), (35, 60)]
    g['R15'] = {
        'meanSdCm': [round(float(bc.mean()), 1), round(float(bc.std()), 1)],
        'p5p50p95Cm': [round(float(x), 1) for x in np.percentile(bc, [5, 50, 95])],
        'waistMinusCrestByBmi': [{'bmi': f'{lo}-{hi}', 'n': int(((d.bmi >= lo) & (d.bmi < hi)).sum()),
                                  'waistBreadthMinusBicristalCm': round(float(np.median((wb - bc)[(d.bmi >= lo) & (d.bmi < hi)])), 1)}
                                 for lo, hi in bins if ((d.bmi >= lo) & (d.bmi < hi)).sum() >= 20],
        'corr': {k: round(float(np.corrcoef(np.log(bc), np.log(d[c]))[0, 1]), 2)
                 for k, c in [('臀寬', 'hipbreadth'), ('臀圍', 'buttockcircumference'), ('肩寬', 'biacromialbreadth'), ('身高', 'stature')]},
    }
    beta, r2, _, _ = fit(d, np.log(d.hipbreadth.to_numpy()), [lh, lb, np.log(bc)])
    g['R15']['hipBreadth~h+bmi+bicristal'] = {'r2': round(r2, 2), 'coef': [round(float(b), 3) for b in beta[1:]]}
    beta, r2, _, _ = fit(d, np.log(d.buttockcircumference.to_numpy()), [lh, lb, np.log(bc)])
    g['R15']['buttock~h+bmi+bicristal'] = {'r2': round(r2, 2), 'coef': [round(float(b), 3) for b in beta[1:]]}

    # ---- R11 肢長 × 組成 ----
    leg = np.log((d.crotchheight / d.stature).to_numpy())
    lower = np.log((d.kneeheightmidpatella / d.stature).to_numpy())
    arm = np.log(((d.acromionradialelength + d.radialestylionlength) / d.stature).to_numpy())
    lw = np.log(d.weight.to_numpy())
    r11 = {}
    for c, lenv, lname in [('thighcircumference', leg, '腿長比'), ('lowerthighcircumference', leg, '腿長比'),
                           ('calfcircumference', lower, '膝高比'), ('anklecircumference', lower, '膝高比'),
                           ('bicepscircumferenceflexed', arm, '臂長比'), ('forearmcircumferenceflexed', arm, '臂長比'),
                           ('wristcircumference', arm, '臂長比'), ('buttockcircumference', leg, '腿長比'),
                           ('waistcircumference', leg, '腿長比'), ('chestcircumference', leg, '腿長比')]:
        y = np.log(d[c].to_numpy())
        beta, r2, _, _ = fit(d, y, [lh, lw, lenv])
        p5, p95 = np.percentile(lenv, [5, 95])
        base = float(np.exp(np.mean(y)) / 10)
        r11[NAMES[c]] = {'by': lname, 'eLength': round(float(beta[3]), 2), 'p5toP95Cm': round(base * (np.exp(beta[3] * (p95 - p5)) - 1), 1)}
    g['R11'] = r11
    g['R11lengthSpread'] = {'腿長比 p5–p95 倍率': round(float(np.exp(np.diff(np.percentile(leg, [5, 95]))[0])), 3),
                            '臂長比 p5–p95 倍率': round(float(np.exp(np.diff(np.percentile(arm, [5, 95]))[0])), 3)}
    res[sex] = g

# ---- R10 屈臂（ANSUR）↔ 放鬆（NHANES） ----
N = load_nhanes(nhanes_dir)
r10 = {}
for sex in ['F', 'M']:
    d = A[A.sex.eq(sex)]
    n = N[N.sex.eq(sex) & N.BMXARMC.gt(0)]
    ba, r2a, sda, _ = fit(d, np.log(d.bicepscircumferenceflexed.to_numpy() / 10), [np.log(d.h.to_numpy()), np.log(d.weight.to_numpy())])
    Xn = np.column_stack([np.ones(len(n)), np.log(n.BMXHT), np.log(n.BMXWT)])
    bn, r2n, sdn, _ = wls(Xn, np.log(n.BMXARMC.to_numpy()), n.w.to_numpy())
    grid = []
    for h, w in ([(158, 48), (158, 55), (158, 65), (165, 60), (165, 75)] if sex == 'F' else [(172, 60), (172, 70), (172, 85), (178, 80), (180, 95)]):
        x = np.array([1, np.log(h), np.log(w)])
        f, r = float(np.exp(x @ ba)), float(np.exp(x @ bn))
        grid.append({'h': h, 'w': w, 'flexedAnsur': round(f, 1), 'relaxedNhanes': round(r, 1), 'diff': round(f - r, 1), 'ratio': round(f / r, 3)})
    r10[sex] = {'ansur': {'coef': [round(float(b), 3) for b in ba], 'r2': round(r2a, 2), 'residSd': round(sda, 3)},
                'nhanes': {'coef': [round(float(b), 3) for b in bn], 'r2': round(r2n, 2), 'residSd': round(sdn, 3)}, 'grid': grid}
res['R10'] = r10
(out / 'r6_r15.json').write_text(json.dumps(res, indent=1, ensure_ascii=False))
print(json.dumps(res, indent=1, ensure_ascii=False))
