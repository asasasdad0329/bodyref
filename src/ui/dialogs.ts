import type { Summary } from '../core/analysis';
import type { Suggestion } from '../core/linkage';
import { MEASURES } from '../core/measurements';
import type { AppState } from '../core/state';
import { decodeShare, encodeShare, shareUrl } from '../core/state';
import { RULER_OFFSET, type Viewer } from '../view/viewer';

// 匯出（截圖、三視圖）與分享對話框

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

async function copyText(text: string, field: HTMLInputElement | HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    field.focus();
    field.select();
    return false;
  }
}

export class ExportDialog {
  private readonly dialog = document.getElementById('export-dialog') as HTMLDialogElement;
  private readonly img = document.getElementById('export-image') as HTMLImageElement;
  private readonly title = document.getElementById('export-title') as HTMLElement;
  private readonly download = document.getElementById('export-download') as HTMLAnchorElement;

  constructor() {
    document.getElementById('export-close')!.addEventListener('click', () => this.dialog.close());
  }

  show(title: string, dataUrl: string, filename: string): void {
    this.title.textContent = title;
    this.img.src = dataUrl;
    this.img.alt = title;
    this.download.href = dataUrl;
    this.download.download = filename;
    this.dialog.showModal();
  }
}

/** 正面、側面、背面三張正交圖，同一比例尺，下方附上量測數據 */
export function composeThreeView(viewer: Viewer, state: AppState, sug: Suggestion, summary: Summary, includeMeasurements = true): string {
  if (!includeMeasurements) {
    const canvas = document.createElement('canvas');
    canvas.width = 1560; canvas.height = 1000;
    const ctx = canvas.getContext('2d')!;
    for (const [i, view] of (['front', 'side', 'back'] as const).entries()) viewer.renderOrtho(view, 520, 1000, ctx, i * 520, 0, true);
    return canvas.toDataURL('image/png');
  }
  const panelW = 520;
  const panelH = 1000;
  const gap = 24;
  const pad = 40;
  const headH = 86;
  const tableRows = Math.ceil(MEASURES.length / 3) + 1;
  const tableH = 40 + tableRows * 34;
  const W = pad * 2 + panelW * 3 + gap * 2;
  const H = pad + headH + panelH + 50 + tableH + pad;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const ink = cssVar('--ink', '#18202a');
  const muted = cssVar('--muted', '#5b6878');
  const tape = cssVar('--tape', '#e8b01e');
  const sans = '"Noto Sans TC", system-ui, sans-serif';
  const mono = '"IBM Plex Mono", ui-monospace, monospace';

  ctx.fillStyle = `#${viewer.background.getHexString()}`;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = ink;
  ctx.font = `700 34px ${sans}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('三視圖', pad, pad + 36);
  ctx.font = `400 20px ${sans}`;
  ctx.fillStyle = muted;
  const sexText = state.sex === 'female' ? '女性' : '男性';
  ctx.fillText(
    `${sexText}・身高 ${summary.modelHeight.toFixed(1)} cm・體重 ${summary.weight.toFixed(1)} kg・體脂 ${(summary.bodyFat * 100).toFixed(1)}%${summary.braSize ? `・${summary.braSize}` : ''}・${summary.shape}`,
    pad,
    pad + 70,
  );

  const views = [
    ['front', '正面'],
    ['side', '側面（左）'],
    ['back', '背面'],
  ] as const;
  let pxPerCm = 1;
  const mh = summary.modelHeight;
  views.forEach(([view, label], i) => {
    const x = pad + i * (panelW + gap);
    const y = pad + headH;
    pxPerCm = viewer.renderOrtho(view, panelW, panelH, ctx, x, y).pxPerCm;
    // 身高尺的刻度數字（3D 畫面中的數字是網頁元素，不會出現在渲染結果裡）
    const rulerX = x + panelW / 2 - RULER_OFFSET * pxPerCm;
    const yAt = (cm: number) => y + panelH / 2 - (cm - mh / 2) * pxPerCm;
    ctx.font = `400 13px ${mono}`;
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let cm = 20; cm <= mh + 5; cm += 20) ctx.fillText(String(cm), rulerX - 6, yAt(cm));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = ink;
    ctx.font = `500 15px ${mono}`;
    ctx.fillText(`${mh.toFixed(1)} cm`, rulerX + 8, yAt(mh) - 8);
    ctx.font = `500 22px ${sans}`;
    ctx.fillText(label, x, y + panelH + 32);
  });

  // 10 cm 比例尺
  const barY = pad + headH + panelH + 24;
  const barX = W - pad - 10 * pxPerCm;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(barX, barY);
  ctx.lineTo(barX + 10 * pxPerCm, barY);
  ctx.moveTo(barX, barY - 6);
  ctx.lineTo(barX, barY + 6);
  ctx.moveTo(barX + 10 * pxPerCm, barY - 6);
  ctx.lineTo(barX + 10 * pxPerCm, barY + 6);
  ctx.stroke();
  ctx.font = `400 16px ${mono}`;
  ctx.fillStyle = muted;
  ctx.textAlign = 'right';
  ctx.fillText('10 cm', barX - 10, barY + 6);
  ctx.textAlign = 'left';

  // 量測表
  const tableY = pad + headH + panelH + 60;
  ctx.fillStyle = tape;
  ctx.fillRect(pad, tableY, W - pad * 2, 3);
  const colW = (W - pad * 2) / 3;
  MEASURES.forEach((d, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = pad + col * colW;
    const y = tableY + 40 + row * 34;
    const manual = sug.locked[d.id];
    ctx.font = `400 19px ${sans}`;
    ctx.fillStyle = muted;
    ctx.fillText(`${d.label}${manual ? '' : '（建議）'}`, x, y);
    ctx.font = `500 20px ${mono}`;
    ctx.fillStyle = ink;
    ctx.textAlign = 'right';
    ctx.fillText(`${sug.values[d.id].toFixed(1)} cm`, x + colW - 40, y);
    ctx.textAlign = 'left';
  });

  return canvas.toDataURL('image/png');
}

export class ShareDialog {
  private readonly dialog = document.getElementById('share-dialog') as HTMLDialogElement;
  private readonly link = document.getElementById('share-link') as HTMLInputElement;
  private readonly code = document.getElementById('share-code') as HTMLTextAreaElement;
  private readonly status = document.getElementById('share-status') as HTMLElement;
  private readonly importField = document.getElementById('share-import') as HTMLTextAreaElement;
  private readonly importStatus = document.getElementById('share-import-status') as HTMLElement;

  constructor(onImport: (s: AppState) => void) {
    document.getElementById('share-close')!.addEventListener('click', () => this.dialog.close());
    document.getElementById('share-copy-link')!.addEventListener('click', async () => {
      this.status.textContent = (await copyText(this.link.value, this.link)) ? '已複製連結' : '請按 Ctrl+C 複製已選取的連結';
    });
    document.getElementById('share-copy-code')!.addEventListener('click', async () => {
      this.status.textContent = (await copyText(this.code.value, this.code)) ? '已複製代碼' : '請按 Ctrl+C 複製已選取的代碼';
    });
    document.getElementById('share-load')!.addEventListener('click', () => {
      const raw = this.importField.value.trim();
      const code = raw.includes('b=') ? new URL(raw, window.location.href).searchParams.get('b') ?? '' : raw;
      const s = decodeShare(code);
      if (!s) {
        this.importStatus.textContent = '讀不出這段代碼，請確認是否完整貼上。';
        return;
      }
      onImport(s);
      this.importStatus.textContent = '';
      this.importField.value = '';
      this.dialog.close();
    });
  }

  show(state: AppState): void {
    // 網頁被嵌入其他頁面時，網址參數傳不進來，只提供代碼
    const embedded = window.self !== window.top;
    for (const node of document.querySelectorAll<HTMLElement>('[data-share-link]')) node.hidden = embedded;
    this.link.value = shareUrl(state);
    this.code.value = encodeShare(state);
    this.status.textContent = '';
    this.importStatus.textContent = '';
    this.dialog.showModal();
  }
}
