"""臀的組成：任一全身脂肪 F × 全身去脂 L 的形（DECISIONS #58 的組成線，#72、#73）。只用 numpy、scipy、ipctk。

python3 tools/blender/glute_mh_mix.py <輸出資料夾> <L1,L2,...> [F1,F2,...]
  對每個去脂 L，算脂肪 F（預設 9～110 每 1 kg）的控制籠與量測，存成 mix_L<L>.npz / .json。

做法（兩條純線疊起來，各自的規律不變）：
  1. 肌肉：純肌肉線的底層長到 L（glute_mh_muscle）。肌肉的形被上面的脂肪抹平，抹的程度照當下的脂肪厚度
     （純肌肉線用中性厚度）：脂肪厚的人肌肉的形看不出來，薄的人看得清楚。
  2. 中性脂肪蓋回去（純肌肉線的 cover）：這是去脂 L、脂肪 F0 的皮膚，也是長脂肪的起點。
  3. 脂肪：照純脂肪線的規律從這個皮膚長（堆積點、範圍內每 kg 0.18 kg、長的方向用這個皮膚的抹平法線），
     重力的脂肪層在肌肉表面和皮膚之間（glute_mh_fat 的 unloaded、sag_of）。
  4. 接觸：從純肌肉線的形（L, F0）沿脂肪每 1 kg 一步走過去（glute_mh_contact.Walk）。純肌肉線本身是從中性沿去脂
     走過來的，所以整條路徑固定：先沿去脂、再沿脂肪，結果只由 (F, L) 決定。
  L = L0 時就是純脂肪線，F = F0 時就是純肌肉線（main 會檢查）。
組成線（固定臀圍，往肌肉或脂肪換）從這張 F × L 的表上取：同一個臀圍在不同 L 上對應的 F。
"""
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glute_mh as gm  # noqa: E402
import glute_mh_fat as gf  # noqa: E402
import glute_mh_muscle as gmu  # noqa: E402
import glute_mh_contact as gc  # noqa: E402

F0, L0 = gf.F0, gmu.L0


class MixLine:
    def __init__(self):
        self.ml = gmu.MuscleLine()
        self.fl = self.ml.fat
        self.F = self.fl.F
        self._T, self._start, self._sag, self._walk = {}, {}, {}, {}

    def fat_T(self, F):
        """F 時每個點的脂肪厚度（用來決定肌肉的形被抹平多少）；用純脂肪線的厚度。"""
        if F not in self._T:
            fl = self.fl
            if F <= F0:
                T = fl.T0 + (fl.thickness(F) - fl.T0) * (1 - (1 - gf.BELLY_FOLLOW) * fl.belly)
            else:
                T = fl.T0 + fl.unloaded(F)[1]
            self._T[F] = T
        return self._T[F]

    def start(self, F, L):
        """(皮膚, 肌肉表面)：去脂 L 的肌肉（形照 F 的脂肪厚度抹平）蓋上中性的脂肪。"""
        key = (F, L)
        if key not in self._start:
            if abs(F - F0) < 1e-9:
                B = self.ml.base(L)
            else:
                B = self.ml.base(L, T=self.fat_T(F))
            self._start[key] = (self.ml.cover(B), B)
            if len(self._start) > 400:            # 只留最近的，記憶體不會一直漲
                self._start.pop(next(iter(self._start)))
        return self._start[key]

    def unloaded(self, F, L):
        if abs(L - L0) < 1e-9:
            return self.fl.unloaded(F)
        S, _ = self.start(F, L)
        return self.fl.unloaded(F, start=S, D0=self.fl.smooth_dirs(S), cache={})

    def sag(self, Fg, L):
        key = (Fg, L)
        if key not in self._sag:
            U, acc = self.unloaded(Fg, L)
            self._sag[key] = self.fl.sag_of(U, acc, self.start(Fg, L)[1])
        return self._sag[key]

    def target(self, F, L):
        """規則算出來的形（還沒處理接觸）。"""
        if abs(L - L0) < 1e-9:
            return self.fl.target(F)
        return self.fl.with_sag(self.unloaded(F, L)[0], F, lambda g: self.sag(g, L))

    def shape(self, F, L):
        """控制籠：先沿去脂走到 L（純肌肉線），再沿脂肪每 1 kg 一步做接觸。"""
        if abs(L - L0) < 1e-9:
            return self.fl.shape(F)
        if L not in self._walk:
            self._walk[L] = gc.Walk(self.ml.shape(L), self.F, F0, lambda F: self.target(F, L), gf.CONTACT_STEP)
        return self._walk[L](F)


if __name__ == '__main__':
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    Ls = [float(a) for a in sys.argv[2].split(',')]
    Fs = [float(a) for a in sys.argv[3].split(',')] if len(sys.argv) > 3 else list(np.arange(gf.FMIN, gf.FMAX + 0.01, 1.0))
    mx = MixLine()
    for L in Ls:
        rows, cages = [], []
        for F in sorted(Fs, key=lambda f: abs(f - F0)):            # 從中性往兩邊走，接觸的路徑才接得上
            V = mx.shape(F, L)
            if abs(F - F0) < 1e-9:
                assert np.abs(V - mx.ml.shape(L)).max() < 1e-9, '脂肪 F0 要是純肌肉線'
            P, _ = gm.preview(V, mx.F, 2)
            m = gf.measure(P)
            rows.append(dict(F=F, L=L, **m))
            cages.append(V.astype(np.float32))
            if F % 10 == 0 or F in (min(Fs), max(Fs)):
                print(f'L {L:5.1f}  F {F:5.1f}  臀圍 {m["hipCirc"]:6.2f}  寬 {m["hipBreadth"]:5.2f}  厚 {m["buttockDepth"]:5.2f}'
                      f'  大腿圍 {m["thighCirc"]:5.2f}', flush=True)
        order = np.argsort([r['F'] for r in rows])
        rows = [rows[i] for i in order]
        tag = f'{L:g}'
        (out / f'mix_L{tag}.json').write_text(json.dumps(dict(F0=F0, L0=L0, rows=rows), ensure_ascii=False, indent=1))
        np.savez_compressed(out / f'mix_L{tag}.npz', F=np.array([r['F'] for r in rows]), L=L,
                            cages=np.stack([cages[i] for i in order]), quads=mx.F)
        print('saved', tag, flush=True)
