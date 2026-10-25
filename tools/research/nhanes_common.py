"""NHANES 2011–2018 成人 DXA 資料的共用載入與加權統計（研究用，不產生網站資料）。

原始 .xpt 檔與個體資料不進倉庫；這裡只放可重現的處理步驟。
資料夾內需有 DEMO_{G,H,I,J}、BMX_*、DXX_*、DXXAG_* 四期共 16 個檔。
"""
from pathlib import Path
import warnings

import numpy as np
import pandas as pd

# 合併時的欄位插入警告只影響速度
warnings.simplefilter('ignore', pd.errors.PerformanceWarning)

CYCLES = 'GHIJ'
TISSUE_FLAGS = ['DXAHETV', 'DXALATV', 'DXARATV', 'DXALLTV', 'DXARLTV', 'DXATRTV']


def load(root, age=(20, 59)):
    """合併四期，回傳品質合格的成人資料（g 換成 kg），加上四期合併權重 w。"""
    frames = []
    for c in CYCLES:
        parts = [pd.read_sas(Path(root) / f'{n}_{c}.xpt', format='xport') for n in ['DEMO', 'BMX', 'DXX', 'DXXAG']]
        for t in parts:
            # pandas 對部分 SAS 浮點零解成極小非零值；只正規化機器零。
            num = t.select_dtypes('number')
            t[num.columns] = num.mask(num.abs().lt(1e-50), 0)
        d = parts[0]
        for t in parts[1:]:
            d = d.merge(t, on='SEQN', how='left', validate='one_to_one')
        frames.append(d.assign(cycle=c))
    df = pd.concat(frames, ignore_index=True)
    ok = df.RIDAGEYR.between(*age) & df.WTMEC2YR.gt(0) & df.DXAEXSTS.eq(1)
    ok &= df[TISSUE_FLAGS].eq(0).all(axis=1)
    ok &= df.BMXHT.gt(0) & df.BMXWT.gt(0) & df.DXDTOPF.between(3, 65)
    ok &= df.BMIHT.fillna(0).eq(0) & df.BMIWT.fillna(0).eq(0)
    ok &= df[['DXDTOLE', 'DXDTOBMC', 'DXDTOFAT']].notna().all(axis=1)
    df = df[ok].copy()
    df['w'] = df.WTMEC2YR / len(CYCLES)  # NCHS：合併 n 期時 MEC 權重除以 n
    df['sex'] = np.where(df.RIAGENDR.eq(2), 'F', 'M')
    df['asian'] = df.RIDRETH3.eq(6)
    df['ag_ok'] = df.DXXAGST.eq(1)
    kg = lambda cols: df[cols].sum(axis=1) / 1000
    df['fat_total'] = df.DXDTOFAT / 1000
    df['fat_arm'] = kg(['DXXLAFAT', 'DXXRAFAT'])
    df['fat_leg'] = kg(['DXXLLFAT', 'DXXRLFAT'])
    df['fat_trunk'] = df.DXXTRFAT / 1000
    df['fat_head'] = df.DXXHEFAT / 1000
    df['fat_android'] = df.DXXANFM / 1000
    df['fat_gynoid'] = df.DXXGYFM / 1000
    df['fat_vat'] = df.DXXVFATM / 1000   # 腹部 L4–L5 附近一段的內臟脂肪，不是全身內臟脂肪
    df['fat_sat'] = df.DXXSATM / 1000    # 同一段的皮下脂肪
    df['lean_total'] = df.DXDTOLE / 1000  # 去脂軟組織，不含骨礦物
    df['lean_arm'] = kg(['DXDLALE', 'DXDRALE'])
    df['lean_leg'] = kg(['DXDLLLE', 'DXDRLLE'])
    df['lean_trunk'] = df.DXDTRLE / 1000
    df['lean_head'] = df.DXDHELE / 1000
    df['bmc_total'] = df.DXDTOBMC / 1000
    df['alm'] = df.lean_arm + df.lean_leg
    # McCarthy et al. 2023（Sci Rep 13:2590）：Hologic 機型、MRI 為參考。NHANES 2011–2018 同為 Hologic。
    df['smm'] = 1.12 * df.alm - 0.63
    df['base_lean'] = df.lean_total + df.bmc_total - df.smm  # 骨、內臟、皮膚等非骨骼肌去脂
    df['bmi'] = df.BMXWT / (df.BMXHT / 100) ** 2
    df['pf'] = df.DXDTOPF / 100
    return df


def wls(X, y, w):
    """加權最小平方；回傳係數、加權 R²、加權殘差標準差。"""
    s = np.sqrt(w / w.mean())
    beta = np.linalg.lstsq(X * s[:, None], y * s, rcond=None)[0]
    r = y - X @ beta
    ybar = np.average(y, weights=w)
    r2 = 1 - np.average(r ** 2, weights=w) / np.average((y - ybar) ** 2, weights=w)
    return beta, r2, float(np.sqrt(np.average(r ** 2, weights=w))), r


def wquantile(x, w, q):
    o = np.argsort(x)
    x, w = np.asarray(x)[o], np.asarray(w)[o]
    c = (np.cumsum(w) - 0.5 * w) / w.sum()
    return np.interp(q, c, x)


def wcorr(a, b, w):
    am, bm = np.average(a, weights=w), np.average(b, weights=w)
    return np.average((a - am) * (b - bm), weights=w) / np.sqrt(
        np.average((a - am) ** 2, weights=w) * np.average((b - bm) ** 2, weights=w))
