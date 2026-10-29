"""臀的純肌肉線，在 MakeHuman 起胚的中性型上（DECISIONS #58、#71；研究 R2、R2b、R24）。只用 numpy、scipy。

python3 tools/blender/glute_mh_muscle.py <輸出資料夾> [viewer]

在中性型上只加減肌肉（去脂），脂肪層的厚度不變：
  中性型 ＝ 底層（骨架＋肌肉）＋ 中性脂肪厚度 × 法線（和純脂肪線同一個拆法，glute_mh_fat.FatLine）。
  底層照體積規律一步步沿當下的法線鼓起（或收）；每一步之後，脂肪層照原厚度蓋回去（沿新底層的法線）。
規律：
  1. 軸：全身去脂軟組織 L（DXA，公斤，不含骨礦物）。中性 L0 ＝ 54.5 − 17（脂肪）− 2.2（骨礦物）≈ 35.3。
  2. 範圍內的去脂隨全身去脂直線增加（R24：NHANES 女性型區去脂每 kg 全身去脂 +0.16～0.18，佔比 15.3% → 16.7%，
     到最高也接近直線）。範圍比 DXA 的女性型區大一點，取 0.18。
  3. 分布：各肌肉整塊均勻增厚，最厚在肌腹，不做近端、遠端的偏向（R2b）。臀大肌整塊飽滿，臀的上半部也跟著圓
     （肌肉臀與脂肪臀形狀上的主要差別：脂肪多在臀下半與外側）；臀中肌撐出上外側；大腿是股四頭（前、外）、
     內收肌群（內）、膕繩肌（後）。
  4. 附著：骨頭貼著皮的地方不長（薦骨、髂嵴、恥骨上的恥丘、胯下的大陰唇與會陰）；臀溝、鼠蹊是脂肪與筋膜的摺，
     少長一點。肚子只跟著變（腹肌之後由腹部做）。
範圍：L 29（160 cm 女性約第 1 百分位）到 91（R21：160 cm、204 kg 外推的去脂）。高的一端在一般人口裡是
大體重帶來的去脂，也涵蓋運動員；組成線再處理同臀圍下肌肉與脂肪的互換。
"""
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glute_mh as gm  # noqa: E402
import glute_mh_fat as gf  # noqa: E402

L0 = 35.3
LMIN, LMAX = 29.0, 91.0
REGION_SLOPE = 0.18           # 範圍內每 kg 全身去脂多 0.18 kg（R24）
DENSITY = 1.06                # 肌肉密度（公克／公分³）
STEP_L = 0.5

# 肌肉：中心、半徑（素體座標，左半）、朝向、相對厚度（肌腹）
MUSCLES = {
    # 臀區的去脂大半是大腿根的肌肉（股四頭、內收肌群、膕繩肌比臀大肌重），臀大肌整塊飽滿但不能吃掉大部分的量，
    # 否則臀會鼓成一顆球（第一版：臀厚 31 對臀寬 39）
    'gluteusMaximus': dict(c=(7.0, 80.5, -11.0), r=(7.5, 8.5, 6.5), face=(0.3, 0.0, -1), amt=0.6),
    'gluteusMedius':  dict(c=(12.5, 90.5, -5.5), r=(5.5, 4.0, 6.0), face=(1, 0.2, -0.5), amt=0.35),
    'tensorFasciae':  dict(c=(13.5, 85.5, 2.5), r=(3.0, 4.0, 3.0), face=(1, 0, 0.6), amt=0.25),
    'quadriceps':     dict(c=(10.0, 70.0, 5.0), r=(5.5, 8.0, 4.5), face=(0.4, 0, 1), amt=1.0),
    'vastusLateralis': dict(c=(16.0, 69.0, 0.5), r=(4.0, 8.0, 5.0), face=(1, 0, 0.2), amt=0.8),
    'adductors':      dict(c=(4.0, 71.0, 0.5), r=(3.5, 7.0, 5.0), face=(-1, 0, 0.2), amt=0.85),
    'hamstrings':     dict(c=(9.5, 68.0, -5.5), r=(5.0, 7.0, 4.5), face=(0, 0, -1), amt=0.8),
}
# 附著：每條控制線上，增厚乘上 (1 − 比例 × 權重)
ATTACH = dict(fold=0.5, cleft=0.95, sacrum=0.9, suprapubic=0.7, groin=0.6)


class MuscleLine:
    def __init__(self):
        self.fat = gf.FatLine()
        fl = self.fat
        self.F, self.mid = fl.F, fl.mid
        V0, N0 = fl.V0, fl.N0
        C = gm.control_weights(V0, N0)
        Z = gm.zone_weights(V0, N0)
        A = np.ones(len(V0))
        for name, s in ATTACH.items():
            A *= 1 - s * C[name]
        # 恥丘、胯下沒有肌肉
        x, y, z = np.abs(V0[:, 0]), V0[:, 1], V0[:, 2]
        mons = np.exp(-((x / 4.0) ** 2 + ((y - 81.0) / 2.5) ** 2)) * np.clip(N0[:, 2] * 2, 0, 1)
        A *= (1 - mons) * (1 - Z['crotch'])
        # 髂嵴（上緣外側）貼骨
        A *= 1 - 0.8 * np.clip((y - 96.5) / 3.0, 0, 1) * np.clip((x - 9.0) / 3.0, 0, 1)
        self.A = A
        Nm = gf.mirrored(N0, V0)
        Vm = np.c_[x, y, z]
        w = np.zeros(len(V0))
        for d in MUSCLES.values():
            c, r = np.array(d['c']), np.array(d['r'])
            f = np.array(d['face'], float)
            f /= np.linalg.norm(f)
            q = (Vm - c) / r
            w += d['amt'] * np.exp(-0.5 * (q ** 2).sum(1)) * np.clip(Nm @ f, 0, 1)
        w *= A * (1 - (1 - gf.BELLY_FOLLOW) * fl.belly) * fl.top
        self.w = w
        self.base0 = fl.base.copy()
        self.N_base0 = gm.vertex_normals(self.base0, self.F)
        self.T0 = fl.T0
        self._states = {}

    def cover(self, B):
        """底層蓋回中性厚度的脂肪層：脂肪層跟著底層的法線轉（中性時剛好還原中性型）。"""
        dN = gm.vertex_normals(B, self.F) - self.N_base0
        return self.fat.constrain(self.fat.V0 + (B - self.base0) + self.T0[:, None] * dN)

    def grow(self, B, dL):
        vol = REGION_SLOPE * dL / DENSITY * 1000     # 公分³，左右合計（dL 可以是負的）
        dT = vol * self.w / (gf.areas(B, self.F) * self.w).sum()
        B = B + dT[:, None] * gm.vertex_normals(B, self.F)
        B[self.mid, 0] = 0.0
        return B

    def base(self, L):
        """去脂 L 時的底層。從中性用同樣的步長一步步走過去，結果只由 L 決定。"""
        n = int(round(abs(L - L0) / STEP_L * 1e6)) // 1000000
        sgn = 1 if L >= L0 else -1
        key = lambda j: sgn * j
        k = max([j for j in range(n + 1) if key(j) in self._states], default=0)
        B = self._states[key(k)].copy() if k else self.base0.copy()
        for j in range(k, n):
            B = self.grow(B, sgn * STEP_L)
            self._states[key(j + 1)] = B.copy()
        rest = abs(L - L0) - n * STEP_L
        if rest > 1e-9:
            B = self.grow(B, sgn * rest)
        return B

    def shape(self, L):
        return self.cover(self.base(L))


if __name__ == '__main__':
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    ml = MuscleLine()
    assert np.abs(ml.shape(L0) - ml.fat.V0).max() < 1e-6, '中性去脂要還原中性型'
    Ls = np.arange(LMIN, LMAX + 0.01, 1.0)
    rows, cages = [], []
    for L in Ls:
        V = ml.shape(L)
        P, _ = gm.preview(V, ml.F, 2)
        m = gf.measure(P)
        rows.append(dict(L=float(L), **m))
        cages.append(V.astype(np.float32))
        if L % 5 == 0 or L in (LMIN, LMAX):
            print(f'L {L:5.1f}  臀圍 {m["hipCirc"]:6.2f}  寬 {m["hipBreadth"]:5.2f}  厚 {m["buttockDepth"]:5.2f}  大腿圍 {m["thighCirc"]:5.2f}')
    hip = np.array([r['hipCirc'] for r in rows])
    slope = np.gradient(hip, Ls)
    i0 = int(np.argmin(np.abs(Ls - L0)))
    print('中性附近臀圍斜率（公分/kg 全身去脂）', round(float(slope[i0]), 3),
          '對照：R19 每 kg 女性型區去脂 +3.9 公分 × R24 0.16～0.18 ≈ 0.62～0.70')
    (out / 'muscle_line.json').write_text(json.dumps(dict(L0=L0, rows=rows, depots=MUSCLES), ensure_ascii=False, indent=1))
    np.savez_compressed(out / 'muscle_line.npz', L=Ls, cages=np.stack(cages), quads=ml.F)
    if 'viewer' in sys.argv:
        sel = [i for i, L in enumerate(Ls) if (L - LMIN) % 4 == 0]
        meshes = [gm.preview(cages[i].astype(float), ml.F, 2) for i in sel]
        Q = meshes[0][1]
        tris = np.r_[Q[:, [0, 1, 2]], Q[:, [0, 2, 3]]].astype(np.uint32)
        Pn, _ = gm.preview(ml.fat.V0, ml.F, 2)
        Nn = gm.vertex_normals(Pn, Q)
        zone = np.where(gm.zone_weights(Pn, Nn)['belly'] > 0.5, 1, np.where(Pn[:, 1] < 73.0, 2, 0)).astype(np.uint8)
        np.savez_compressed(out / 'fat_viewer.npz', F=Ls[sel], positions=np.stack([m[0] for m in meshes]).astype(np.float32),
                            tris=tris, F0=L0, hip=hip[sel], thigh=np.array([r['thighCirc'] for r in rows])[sel], zone=zone,
                            title='臀・純肌肉線', axis='全身去脂')
        print('viewer frames', len(sel))
