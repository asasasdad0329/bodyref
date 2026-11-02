"""臀的輸入換算（③ 第 2 步，DECISIONS #80、研究 R31）：網站的全身數值 → 臀的模（160 公分）上的脂肪、去脂。只用 numpy。

1. 體重 W、體脂率 → 全身脂肪 F ＝ W × 體脂；骨礦物 BMC 照身高、體重（R31）；去脂軟組織 LST ＝ W − F − BMC。
2. 去脂拆成骨骼肌 SMM 與其他去脂（內臟、皮膚、結締組織、脂肪組織裡的水分）：其他去脂照身高、體重（R31，R² 0.86），
   骨骼肌 ＝ LST − 其他。使用者有填骨骼肌時用填的（體重、體脂、骨骼肌三個只能固定兩個，衝突的處理之後討論）。
3. 臀的肌肉線的軸是去脂：臀區去脂每 kg 骨骼肌 +0.208、每 kg 其他去脂 +0.147（R31；每 kg 去脂軟組織 +0.179），
   所以臀用的去脂 ＝（1.16 × 骨骼肌 ＋ 0.82 × 其他）。160 公分、50～60 kg 的女性約 35.0，對中性 35.3。
4. 骨架放大 s ＝ 身高 ／ 160 倍：同樣的公斤數攤在大的骨架上比較薄，換到 160 公分的模上 ÷ s³（純幾何，作者 2026-11-01）。
"""
import numpy as np

# R31（NHANES 2011–2018 DXA，女性 20–59 歲 4,940 人，加權最小平方；骨骼肌用 Kim 2002 從四肢去脂估）
OTHER_FIT = (-2.601, 0.576, 0.646)      # log 其他去脂 ＝ a ＋ b log 身高 ＋ c log 體重（R² 0.86、殘差 sd 0.067）
BMC_FIT = (-8.988, 1.703, 0.245)        # log 骨礦物 ＝ a ＋ b log 身高 ＋ c log 體重（R² 0.48）
GYN_SMM, GYN_OTHER, GYN_LST = 0.208, 0.147, 0.179
MODEL_HEIGHT = 160.0


def other_lean(height, weight):
    a, b, c = OTHER_FIT
    return float(np.exp(a + b * np.log(height) + c * np.log(weight)))


def bone_mineral(height, weight):
    a, b, c = BMC_FIT
    return float(np.exp(a + b * np.log(height) + c * np.log(weight)))


def to_model(height, weight, body_fat, muscle=None):
    """網站的全身數值 → 臀的模上的 (脂肪 F, 去脂 L) 與中間值。body_fat 是比例（0.3 ＝ 30%）。"""
    s = height / MODEL_HEIGHT
    fat = weight * body_fat
    bmc = bone_mineral(height, weight)
    lst = weight - fat - bmc
    other = other_lean(height, weight)
    smm = lst - other if muscle is None else float(muscle)
    lean = (GYN_SMM * smm + GYN_OTHER * other) / GYN_LST
    return dict(F=fat / s ** 3, L=lean / s ** 3, scale=s, fat=fat, lst=lst, bmc=bmc, other=other, muscle=smm,
                conflict=(muscle is not None and abs(smm + other - lst) > 0.5))


if __name__ == '__main__':
    for h, w, bf in ((160, 54.5, 0.31), (160, 40, 0.10), (160, 32, 0.06), (175, 70, 0.30), (150, 50, 0.30), (160, 120, 0.50)):
        r = to_model(h, w, bf)
        print(f'{h} cm {w} kg 體脂 {bf:.0%} → 模上 脂肪 {r["F"]:.1f}、去脂 {r["L"]:.1f}（骨骼肌 {r["muscle"]:.1f}、其他 {r["other"]:.1f}、骨 {r["bmc"]:.2f}）')
