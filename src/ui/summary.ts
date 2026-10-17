import type { Summary } from '../core/analysis';
import type { AppState } from '../core/state';

// 摘要卡：關鍵數據與現實檢核

const f1 = (v: number) => v.toFixed(1);

export function renderSummary(root: HTMLElement, state: AppState, s: Summary): void {
  const female = state.sex === 'female';
  const weightGap = Math.abs(s.modelWeight - state.weight) > 0.3;
  const rows: [string, string, string?][] = [
    ['身高', `${f1(s.modelHeight)} cm`],
    ['體重', `${f1(state.weight)} kg`, weightGap ? `模型 ${f1(s.modelWeight)} kg` : '模型體積驗算相符'],
    ['BMI', f1(s.bmi), s.bmiLabel],
    ['體脂率', `${f1(s.bodyFat * 100)}%`, s.bodyFatAuto ? '依 BMI 估算' : undefined],
    ['骨骼肌率', `${f1(s.muscleRate * 100)}%`, `去脂體重 ${f1(s.leanMass)} kg`],
  ];
  if (female && s.braSize) rows.push(['罩杯', s.braSize, '台灣／日本尺寸']);
  rows.push(['腰臀比', s.whr.toFixed(2)], ['股下', `${f1(s.inseam)} cm`], ['體型', s.shape, '依三圍分類']);

  const dl = rows
    .map(([k, v, note]) => `<div class="stat"><dt>${k}</dt><dd><b>${v}</b>${note ? `<small>${note}</small>` : ''}</dd></div>`)
    .join('');
  const checks = s.checks.length
    ? `<ul class="checks">${s.checks.map((c) => `<li class="check" data-level="${c.level}"><span class="check-tag">${c.level === 'conflict' ? '數據矛盾' : '少見'}</span>${c.text}</li>`).join('')}</ul>`
    : `<p class="checks-ok">這組數據在現實中屬於常見範圍。</p>`;

  root.innerHTML = `
    <header class="summary-head"><span class="eyebrow">SUMMARY</span><h2 class="summary-title">數據摘要</h2></header>
    <dl class="stats">${dl}</dl>
    <section class="reality" aria-label="現實檢核">
      <h3 class="reality-title">現實檢核</h3>
      ${checks}
    </section>`;
}
