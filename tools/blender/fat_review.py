"""脂肪線的覆核圖：把 glute_fat.py 的輸出排成關鍵形對照表、連續變化動畫（GIF、MP4）與量測曲線。

python3 tools/blender/fat_review.py <glute_fat.py 的輸出資料夾>

需要 Pillow、matplotlib；MP4 需要 ffmpeg。產物寫在同一個資料夾，不進倉庫。
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

d = Path(sys.argv[1])
info = json.loads((d / 'fat_line.json').read_text())
rows = info['rows']
Fs = np.array([r['F'] for r in rows])
font_path = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
font = ImageFont.truetype(font_path, 26)
small = ImageFont.truetype(font_path, 20)


def value(key, F):
    return float(np.interp(F, Fs, [r[key] for r in rows]))


def label(F):
    return f'全身脂肪 {F:4.1f} kg　臀圍 {value("hipCirc", F):5.1f}　大腿圍 {value("thighCirc", F):4.1f}'


# ---------- 關鍵形對照表：列＝脂肪量，欄＝視角 ----------
keys = sorted({float(p.name.split('-')[1]) for p in d.glob('key-*-front.png')})
views = [('front', '正面'), ('side', '側面'), ('back', '背面'), ('rearQuarter', '斜後方')]
cell = 300
sheet = Image.new('RGB', (cell * len(views), (cell + 40) * len(keys) + 40), (60, 60, 60))
draw = ImageDraw.Draw(sheet)
for j, (_, name) in enumerate(views):
    draw.text((j * cell + 10, 6), name, font=font, fill=(235, 235, 235))
for i, F in enumerate(keys):
    y = 40 + i * (cell + 40)
    tag = '（中性）' if abs(F - info['F0']) < 1e-6 else ''
    draw.text((10, y + 6), label(F) + tag, font=small, fill=(235, 235, 235))
    for j, (v, _) in enumerate(views):
        im = Image.open(d / f'key-{F:04.1f}-{v}.png').crop((40, 60, 860, 880)).resize((cell, cell))
        sheet.paste(im, (j * cell, y + 34))
sheet.save(d / 'review-keys.png')

# ---------- 動畫：每格 2×2 視角，瘦 → 胖 → 瘦 ----------
frames = sorted({int(p.name.split('-')[0]) for p in (d / 'frames').glob('*-front.png')}) if (d / 'frames').exists() else []
if frames:
    Ff = np.arange(len(frames)) * 1.0 + Fs[0]
    out_dir = d / 'anim'
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir()
    imgs = []
    for i in frames:
        canvas = Image.new('RGB', (900, 940), (45, 45, 45))
        dr = ImageDraw.Draw(canvas)
        for k, v in enumerate(['front', 'side', 'back', 'rearQuarter']):
            im = Image.open(d / 'frames' / f'{i:03d}-{v}.png').crop((20, 30, 430, 440)).resize((450, 450))
            canvas.paste(im, (450 * (k % 2), 40 + 450 * (k // 2)))
        dr.text((12, 6), label(Ff[i]), font=font, fill=(240, 240, 240))
        # 進度條
        x = 900 * (Ff[i] - Fs[0]) / (Fs[-1] - Fs[0])
        dr.rectangle([0, 936, x, 940], fill=(217, 130, 43))
        canvas.save(out_dir / f'{i:03d}.png')
        imgs.append(canvas.resize((600, 627)))
    seq = imgs + imgs[::-1]
    seq[0].save(d / 'review-fat.gif', save_all=True, append_images=seq[1:], duration=120, loop=0, optimize=True)
    if shutil.which('ffmpeg'):
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '8', '-i', str(out_dir / '%03d.png'),
                        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', str(d / 'review-fat.mp4')], check=True)

# ---------- 量測曲線 ----------
import logging  # noqa: E402
import matplotlib  # noqa: E402
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
logging.getLogger('matplotlib.font_manager').setLevel(logging.ERROR)
plt.rcParams['font.family'] = 'WenQuanYi Zen Hei'
plt.rcParams['axes.unicode_minus'] = False
fig, ax = plt.subplots(1, 2, figsize=(13, 4.6))
ax[0].plot(Fs, [r['hipCirc'] for r in rows], '-', color='#d9822b', label='臀圍')
ax[0].plot(Fs, [r['thighCirc'] for r in rows], '-', color='#2a78b8', label='大腿圍')
ref = np.array(Fs)
ax[0].plot(ref, value('hipCirc', info['F0']) + 0.69 * (ref - info['F0']), ':', color='#d9822b', alpha=.6,
           label='參考：每 kg +0.69（R19×R20）')
ax[0].axvline(info['F0'], color='#888', lw=.8)
ax[0].set(xlabel='全身脂肪（kg）', ylabel='公分', title='沿脂肪線的圍度')
ax[0].grid(alpha=.3)
ax[0].legend()
ax[1].plot(Fs, [r['fatKg'] for r in rows], '-', color='#d9822b', label='範圍內脂肪層的增減（kg）')
ax[1].plot(ref, 0.2 * (ref - info['F0']), ':', color='#888', label='參考：每 kg 全身脂肪約 0.2 kg 在這一段（R20）')
ax[1].axvline(info['F0'], color='#888', lw=.8)
ax[1].set(xlabel='全身脂肪（kg）', ylabel='公斤', title='範圍內脂肪量')
ax[1].grid(alpha=.3)
ax[1].legend()
fig.tight_layout()
fig.savefig(d / 'review-curves.png', dpi=100)
print('完成', d)
