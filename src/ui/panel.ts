import type { Suggestion, VarId } from '../core/linkage';
import {
  BODY_FAT_RANGE,
  HEIGHT_RANGE,
  MEASURES,
  type MeasureDef,
  type MeasureId,
  type Sex,
  WEIGHT_RANGE,
} from '../core/measurements';
import { CUP_TABLE, MUSCLE_OF_LEAN } from '../core/reference';
import { type AppState, LINE_STYLES, type ViewSettings } from '../core/state';

// 右側輸入面板。每個數值不是「手動」（你填的）就是「建議」（依你填的數值連動推算）。
// 建議值旁邊顯示常見範圍；手動的數值如果在實測資料中很少見，會標上「少見」。

export interface PanelCallbacks {
  onSex(sex: Sex): void;
  /** value 為 null 表示改回建議值 */
  onLock(id: VarId, value: number | null): void;
  onCup(cup: string | null): void;
  onView(patch: Partial<ViewSettings>): void;
  onFocusMeasure(id: MeasureId | null): void;
}

interface NumberField {
  range: HTMLInputElement;
  num: HTMLInputElement;
}

interface Row {
  field: NumberField;
  tag: HTMLElement;
  reset: HTMLButtonElement | null;
  note: HTMLElement;
  row: HTMLElement;
}

const MUSCLE_RANGE = { min: 24, max: 52, step: 0.5 };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** 滑桿 + 數字輸入框，兩者同步；數字框輸入完整數值後才套用 */
function numberControl(
  id: string,
  label: string,
  range: { min: number; max: number; step: number },
  unit: string,
  apply: (v: number) => void,
): { node: HTMLElement; field: NumberField } {
  const wrap = el('div', 'field-input');
  const r = el('input');
  r.type = 'range';
  r.id = `r-${id}`;
  r.min = String(range.min);
  r.max = String(range.max);
  r.step = String(range.step);
  r.setAttribute('aria-label', label);
  const numWrap = el('div', 'num');
  const n = el('input');
  n.type = 'number';
  n.id = `n-${id}`;
  n.min = String(range.min);
  n.max = String(range.max);
  n.step = String(range.step);
  n.inputMode = 'decimal';
  numWrap.append(n, el('span', 'unit', unit));
  wrap.append(r, numWrap);
  r.addEventListener('input', () => apply(Number(r.value)));
  n.addEventListener('input', () => {
    const v = Number(n.value);
    if (n.value !== '' && v >= range.min && v <= range.max) apply(v);
  });
  n.addEventListener('change', () => {
    if (n.value === '') return;
    apply(Math.min(range.max, Math.max(range.min, Number(n.value))));
  });
  return { node: wrap, field: { range: r, num: n } };
}

function setValue(f: NumberField, v: number, digits = 1): void {
  if (document.activeElement !== f.num) f.num.value = v.toFixed(digits);
  if (document.activeElement !== f.range || Math.abs(Number(f.range.value) - v) > 1e-6) f.range.value = String(v);
}

const fmt = (v: number) => v.toFixed(1);

export class Panel {
  private rows = new Map<string, Row>();
  private height!: NumberField;
  private muscle!: NumberField;
  private sexInputs: HTMLInputElement[] = [];
  private lineInputs: HTMLInputElement[] = [];
  private cupSelect!: HTMLSelectElement;
  private cupRow!: HTMLElement;
  private cupNote!: HTMLElement;
  private view: Record<'outline' | 'measures', HTMLInputElement> = {} as never;
  private armAngle!: NumberField;
  private hovered: MeasureId | null = null;
  private focused: MeasureId | null = null;

  constructor(root: HTMLElement, private readonly cb: PanelCallbacks) {
    root.append(
      this.buildBasic(),
      this.buildMeasures('girth', '圍度', 'GIRTH'),
      this.buildMeasures('length', '長度', 'LENGTH'),
      this.buildDisplay(),
      el(
        'footer',
        'credits',
        '人體網格與形變：<a href="https://github.com/makehumancommunity/makehuman" target="_blank" rel="noopener">MakeHuman</a>（CC0）・數值連動：ANSUR II 美軍人體計測（公有領域）',
      ),
    );
  }

  private group(title: string, eyebrow: string, desc?: string): HTMLElement {
    const g = el('section', 'group');
    const head = el('header', 'group-head');
    head.append(el('span', 'eyebrow', eyebrow), el('h2', 'group-title', title));
    g.append(head);
    if (desc) g.append(el('p', 'group-desc', desc));
    return g;
  }

  /** 一列可鎖定的數值：名稱、狀態標籤、改回建議、滑桿、說明 */
  private lockRow(
    id: string,
    label: string,
    range: { min: number; max: number; step: number },
    unit: string,
    hint: string,
    apply: (v: number) => void,
    unlock: (() => void) | null,
  ): HTMLElement {
    const row = el('div', 'field measure');
    row.dataset.var = id;
    const top = el('div', 'field-top');
    const lab = el('label', 'field-label', label);
    lab.htmlFor = `n-${id}`;
    const tag = el('span', 'tag');
    let reset: HTMLButtonElement | null = null;
    top.append(lab, tag);
    if (unlock) {
      reset = el('button', 'field-reset', '改回建議');
      reset.type = 'button';
      reset.addEventListener('click', unlock);
      top.append(reset);
    }
    const ctl = numberControl(id, label, range, unit, apply);
    const note = el('p', 'hint');
    note.textContent = hint;
    row.append(top, ctl.node, note);
    this.rows.set(id, { field: ctl.field, tag, reset, note, row });
    return row;
  }

  private buildBasic(): HTMLElement {
    const g = this.group(
      '基本數據',
      'BASE',
      '填你知道的數值就好。沒填的項目會依實測資料，跟著你填的數值連動出建議值，並列出一般人的常見範圍。',
    );

    const sexRow = el('div', 'field');
    const fs = el('fieldset', 'segmented');
    fs.append(el('legend', 'field-label', '性別'));
    for (const [value, text] of [['female', '女性'], ['male', '男性']] as const) {
      const id = `sex-${value}`;
      const input = el('input');
      input.type = 'radio';
      input.name = 'sex';
      input.id = id;
      input.value = value;
      input.addEventListener('change', () => input.checked && this.cb.onSex(value));
      const lab = el('label', undefined, text);
      lab.htmlFor = id;
      fs.append(input, lab);
      this.sexInputs.push(input);
    }
    sexRow.append(fs);

    const hRow = el('div', 'field');
    const hTop = el('div', 'field-top');
    const hLab = el('label', 'field-label', '身高');
    hLab.htmlFor = 'n-height';
    hTop.append(hLab);
    const h = numberControl('height', '身高', HEIGHT_RANGE, 'cm', (v) => this.cb.onLock('height', v));
    hRow.append(hTop, h.node);
    this.height = h.field;

    const weight = this.lockRow('weight', '體重', WEIGHT_RANGE, 'kg', '', (v) => this.cb.onLock('weight', v), () => this.cb.onLock('weight', null));
    const fat = this.lockRow(
      'bodyFat',
      '體脂率',
      BODY_FAT_RANGE,
      '%',
      '',
      (v) => this.cb.onLock('bodyFat', v / 100),
      () => this.cb.onLock('bodyFat', null),
    );

    const muscleRow = el('div', 'field');
    const muscleTop = el('div', 'field-top');
    const muscleLab = el('label', 'field-label', '骨骼肌率');
    muscleLab.htmlFor = 'n-muscle';
    muscleTop.append(muscleLab);
    const muscle = numberControl('muscle', '骨骼肌率', MUSCLE_RANGE, '%', (v) =>
      this.cb.onLock('bodyFat', Math.min(0.55, Math.max(0.05, 1 - v / 100 / MUSCLE_OF_LEAN))),
    );
    muscleRow.append(muscleTop, muscle.node, el('p', 'hint', '骨骼肌重 ÷ 體重，和體脂率連動（以骨骼肌約占去脂體重 55% 換算）。'));
    this.muscle = muscle.field;

    this.cupRow = el('div', 'field');
    const cupTop = el('div', 'field-top');
    const cupLab = el('label', 'field-label', '罩杯');
    cupLab.htmlFor = 'cup';
    cupTop.append(cupLab);
    this.cupSelect = el('select', 'select');
    this.cupSelect.id = 'cup';
    this.cupSelect.append(new Option('建議（依其他數值連動）', ''));
    for (const c of CUP_TABLE) this.cupSelect.append(new Option(`${c.cup}（上下胸圍差 ${c.diff} cm）`, c.cup));
    this.cupSelect.addEventListener('change', () => this.cb.onCup(this.cupSelect.value || null));
    this.cupNote = el('p', 'hint');
    this.cupRow.append(cupTop, this.cupSelect, this.cupNote);

    g.append(sexRow, hRow, weight, fat, muscleRow, this.cupRow);
    return g;
  }

  private buildMeasures(group: MeasureDef['group'], title: string, eyebrow: string): HTMLElement {
    const g = this.group(title, eyebrow);
    for (const d of MEASURES.filter((m) => m.group === group)) {
      const row = this.lockRow(d.id, d.label, d, 'cm', d.hint, (v) => this.cb.onLock(d.id, v), () => this.cb.onLock(d.id, null));
      row.addEventListener('pointerenter', () => this.setHover(d.id));
      row.addEventListener('pointerleave', () => this.setHover(null));
      row.addEventListener('focusin', () => this.setFocus(d.id));
      row.addEventListener('focusout', () => this.setFocus(null));
      g.append(row);
    }
    return g;
  }

  private buildDisplay(): HTMLElement {
    const g = this.group('顯示', 'VIEW');
    const styleRow = el('div', 'field');
    const fs = el('fieldset', 'segmented');
    fs.append(el('legend', 'field-label', '表面線條'));
    for (const s of LINE_STYLES) {
      const id = `line-${s.id}`;
      const input = el('input');
      input.type = 'radio';
      input.name = 'lineStyle';
      input.id = id;
      input.value = s.id;
      input.addEventListener('change', () => input.checked && this.cb.onView({ lineStyle: s.id }));
      const lab = el('label', undefined, s.label);
      lab.htmlFor = id;
      fs.append(input, lab);
      this.lineInputs.push(input);
    }
    styleRow.append(fs);
    const toggles = el('div', 'toggles');
    for (const [key, text] of [['outline', '輪廓線'], ['measures', '全部量測線']] as const) {
      const lab = el('label', 'toggle');
      const input = el('input');
      input.type = 'checkbox';
      input.id = `view-${key}`;
      input.addEventListener('change', () => {
        const map = { outline: 'showOutline', measures: 'showMeasures' } as const;
        this.cb.onView({ [map[key]]: input.checked });
      });
      lab.append(input, el('span', undefined, text));
      toggles.append(lab);
      this.view[key] = input;
    }
    const armRow = el('div', 'field');
    const top = el('div', 'field-top');
    const lab = el('label', 'field-label', '手臂張開角度');
    lab.htmlFor = 'n-armAngle';
    top.append(lab);
    const ctl = numberControl('armAngle', '手臂張開角度', { min: 0, max: 45, step: 1 }, '°', (v) => this.cb.onView({ armAngle: v }));
    armRow.append(top, ctl.node, el('p', 'hint', '只影響姿勢，不影響任何量測數值。'));
    this.armAngle = ctl.field;
    g.append(styleRow, toggles, armRow);
    return g;
  }

  private setHover(id: MeasureId | null): void {
    this.hovered = id;
    this.cb.onFocusMeasure(this.hovered ?? this.focused);
  }

  private setFocus(id: MeasureId | null): void {
    this.focused = id;
    this.cb.onFocusMeasure(this.hovered ?? this.focused);
  }

  render(state: AppState, sug: Suggestion, rarity: Partial<Record<VarId, number>>, braSize: string | null): void {
    for (const input of this.sexInputs) input.checked = input.value === state.sex;
    setValue(this.height, state.locked.height);
    setValue(this.muscle, MUSCLE_OF_LEAN * (1 - sug.values.bodyFat) * 100);

    const female = state.sex === 'female';
    this.cupRow.hidden = !female;
    const bothLocked = sug.locked.bust && sug.locked.underbust;
    this.cupSelect.disabled = bothLocked;
    this.cupSelect.value = bothLocked ? '' : (state.cup ?? '');
    this.cupNote.textContent = bothLocked
      ? `上下胸圍都已手動填寫，罩杯為 ${braSize ?? ''}。`
      : `目前 ${braSize ?? ''}（台灣／日本尺寸：罩杯字母 + 下胸圍）。`;

    const show = (id: VarId, scale = 1) => {
      const r = this.rows.get(id);
      if (!r) return;
      const locked = sug.locked[id];
      setValue(r.field, sug.values[id] * scale);
      const p = rarity[id];
      const rare = locked && p !== undefined && (p < 0.05 || p > 0.95);
      r.tag.textContent = locked ? (rare ? '手動・少見' : '手動') : '建議';
      r.tag.dataset.state = locked ? (rare ? 'rare' : 'manual') : 'auto';
      if (r.reset) r.reset.hidden = !locked;
      r.row.classList.toggle('is-manual', locked);
      const [lo, hi] = sug.range[id];
      const hint = MEASURES.find((m) => m.id === id)?.hint ?? '';
      r.note.textContent = locked ? hint : `常見 ${fmt(lo * scale)}–${fmt(hi * scale)}${hint ? `・${hint}` : ''}`;
    };
    show('weight');
    show('bodyFat', 100);
    for (const d of MEASURES) show(d.id);

    for (const input of this.lineInputs) input.checked = input.value === state.view.lineStyle;
    this.view.outline.checked = state.view.showOutline;
    this.view.measures.checked = state.view.showMeasures;
    setValue(this.armAngle, state.view.armAngle, 0);
  }
}
