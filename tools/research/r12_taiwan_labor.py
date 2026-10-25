"""R12：勞安所「勞工健康體能常模－身體組成等級表」換算成平均值與標準差。

python3 tools/research/r12_taiwan_labor.py <等級表.csv>
資料來源：國網中心科學資料平台 best_wish40591（政府資料開放授權條款第 1 版）。
等級表把每個年齡層分成五級；「適當」一級的中點當作平均值，相鄰兩級的寬度當作一個標準差
（五級的切點相當於平均值 ±0.5、±1.5 個標準差）。結論記在 docs/work/00-foundation/research-taiwan.md。
"""
import re
import sys

import pandas as pd

d = pd.read_csv(sys.argv[1], dtype=str)


def band(s):
    nums = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', str(s))]
    return nums if len(nums) == 2 else None


rows = []
for (ind, age, sex, test), g in d.groupby(['行業別', '年齡層', '性別', '測試方式'], sort=False):
    b = {r.身材級別: band(r.量測值) for r in g.itertuples()}
    if not (b.get('適當') and b.get('略瘦') and b.get('略胖')):
        continue
    mean = sum(b['適當']) / 2
    sd = ((b['略胖'][1] - b['略瘦'][0]) / 3)  # 略瘦下緣到略胖上緣 = 3 個標準差
    rows.append({'行業': ind, '年齡': age, '性別': sex, '項目': test, '平均': round(mean, 2), '標準差': round(sd, 2)})
out = pd.DataFrame(rows)
print(out[out.年齡.isin(['≦24歲', '25-34歲', '35-44歲'])].pivot_table(index=['項目', '性別', '年齡'], columns='行業', values=['平均', '標準差']).round(2).to_string())
