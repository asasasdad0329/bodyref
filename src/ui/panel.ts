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
import { RATIOS, type RatioId, ratiosOf, displayRatio, storedRatio } from '../core/proportions';
import { CUP_TABLE } from '../core/reference';
import type { AppState } from '../core/state';

// 右側輸入面板。每個數值不是「手動」（你填的）就是「推算」（依你填的數值與體型算出）。
// 推算值旁邊顯示常見範圍；手動的數值如果在實測資料中很少見，會標上「少見」。
// 外層只放常用的數值（三圍、腿圍、比例），其他量測收在「細部調整」裡。

export interface PanelCallbacks {
  onSex(sex: Sex): void;
  /** value 為 null 表示改回推算值 */
  onLock(id: VarId, value: number | null): void;
  onRatio(id: RatioId, value: number | null): void;
  onCup(cup: string | null): void;
  onFocusMeasure(id: MeasureId | null): void;
}

/** 外層的圍度；其餘量測放在「細部調整」 */
const MAIN_GIRTHS: MeasureId[] = ['bust', 'underbust', 'waist', 'hip', 'thigh', 'calf'];
const DETAIL: MeasureId[] = ['neck', 'upperArm', 'wrist', 'ankle', 'shoulder', 'upperArmLen', 'forearmLen', 'thighLen', 'calfLen'];

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
  if (!Number.isFinite(v)) return;
  if (document.activeElement !== f.num) f.num.value = v.toFixed(digits);
  if (document.activeElement !== f.range || Math.abs(Number(f.range.value) - v) > 1e-6) f.range.value = String(v);
}

const fmt = (v: number) => v.toFixed(1);

export class Panel {
  private rows = new Map<string, Row>();
  private height!: NumberField;
  private sexInputs: HTMLInputElement[] = [];
  private cupSelect!: HTMLSelectElement;
  private cupRow!: HTMLElement;
  private cupNote!: HTMLElement;
  private detailCount!: HTMLElement;
  private ratioCount!: HTMLElement;
  private proportionNote!: HTMLElement;
  private hovered: MeasureId | null = null;
  private focused: MeasureId | null = null;

  constructor(root: HTMLElement, private readonly cb: PanelCallbacks) {
    root.append(
      this.buildBasic(),
      this.buildMeasures(MAIN_GIRTHS, '三圍與腿圍', 'GIRTH'),
      this.buildProportions(),
      this.buildDetails(),
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
      reset = el('button', 'field-reset', '改回推算');
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
      '填你知道的數值就好。沒填的項目會依實測資料與體型推算（例如把腰圍改粗，體重會跟著變重），並列出一般人的常見範圍。',
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

    const muscleRow = this.lockRow('muscleRate', '骨骼肌率', MUSCLE_RANGE, '%',
      '骨骼肌重 ÷ 體重，可獨立指定；其餘去脂組織保留在總重量內。',
      (v) => this.cb.onLock('muscleRate', v / 100), () => this.cb.onLock('muscleRate', null));

    this.cupRow = el('div', 'field');
    const cupTop = el('div', 'field-top');
    const cupLab = el('label', 'field-label', '罩杯');
    cupLab.htmlFor = 'cup';
    cupTop.append(cupLab);
    this.cupSelect = el('select', 'select');
    this.cupSelect.id = 'cup';
    this.cupSelect.append(new Option('推算（依其他數值）', ''));
    for (const c of CUP_TABLE) this.cupSelect.append(new Option(`${c.cup}（上下胸圍差 ${c.diff} cm）`, c.cup));
    this.cupSelect.addEventListener('change', () => this.cb.onCup(this.cupSelect.value || null));
    this.cupNote = el('p', 'hint');
    this.cupRow.append(cupTop, this.cupSelect, this.cupNote);

    g.append(sexRow, hRow, weight, fat, muscleRow, this.cupRow);
    return g;
  }

  private measureRow(d: MeasureDef): HTMLElement {
    const row = this.lockRow(d.id, d.label, d, 'cm', d.hint, (v) => this.cb.onLock(d.id, v), () => this.cb.onLock(d.id, null));
    row.addEventListener('pointerenter', () => this.setHover(d.id));
    row.addEventListener('pointerleave', () => this.setHover(null));
    row.addEventListener('focusin', () => this.setFocus(d.id));
    row.addEventListener('focusout', () => this.setFocus(null));
    return row;
  }

  private buildMeasures(ids: MeasureId[], title: string, eyebrow: string): HTMLElement {
    const g = this.group(title, eyebrow);
    for (const id of ids) g.append(this.measureRow(MEASURES.find((m) => m.id === id)!));
    return g;
  }

  /** 預設收合的群組；標題旁顯示裡面有幾項是手動的 */
  private collapsible(title: string, eyebrow: string, desc: string): { node: HTMLDetailsElement; count: HTMLElement } {
    const node = el('details', 'group details');
    const summary = el('summary', 'group-head details-head');
    const count = el('span', 'details-count');
    summary.append(el('span', 'eyebrow', eyebrow), el('h2', 'group-title', title), count);
    node.append(summary, el('p', 'group-desc', desc));
    return { node, count };
  }

  private buildProportions(): HTMLElement {
    const { node, count } = this.collapsible(
      '比例',
      'PROPORTION',
      '以 1 : 比值調整長度。右側越大，對應的腿、手臂或下段越長。改比例時長度跟著算，改長度時比例跟著變。',
    );
    this.ratioCount = count;
    for (const d of RATIOS) {
      const range = { min: d.reciprocal ? 1 / d.max : d.min, max: d.reciprocal ? 1 / d.min : d.max, step: d.step };
      const row = this.lockRow(d.id, d.label, range, d.unit, d.hint, (v) => this.cb.onRatio(d.id, storedRatio(d, v)), () => this.cb.onRatio(d.id, null));
      row.querySelector('.num')!.prepend(el('span', 'ratio-prefix', '1 :'));
      node.append(row);
    }
    this.proportionNote = el('p', 'hint proportion-note');
    node.append(this.proportionNote);
    return node;
  }

  private buildDetails(): HTMLElement {
    const { node, count } = this.collapsible('細部調整', 'DETAIL', '頸、臂、手腕、腳踝、肩寬與四肢長度。沒填的會依其他數值推算。');
    this.detailCount = count;
    for (const id of DETAIL) node.append(this.measureRow(MEASURES.find((m) => m.id === id)!));
    return node;
  }

  private setHover(id: MeasureId | null): void {
    this.hovered = id;
    this.cb.onFocusMeasure(this.hovered ?? this.focused);
  }

  private setFocus(id: MeasureId | null): void {
    this.focused = id;
    this.cb.onFocusMeasure(this.hovered ?? this.focused);
  }

  /**
   * @param sug 顯示用的數值（鎖定的是輸入值，其他是網格量到的數值）
   * @param derived 依比例推算的長度
   */
  render(state: AppState, sug: Suggestion, rarity: Partial<Record<VarId, number>>, braSize: string | null, derived: MeasureId[]): void {
    for (const input of this.sexInputs) input.checked = input.value === state.sex;
    setValue(this.height, state.locked.height);

    const female = state.sex === 'female';
    this.cupRow.hidden = !female;
    const bothLocked = sug.locked.bust && sug.locked.underbust;
    this.cupSelect.disabled = bothLocked;
    this.cupSelect.value = bothLocked ? '' : (state.cup ?? '');
    this.cupNote.textContent = bothLocked
      ? `上下胸圍都已手動填寫，罩杯為 ${braSize ?? ''}。`
      : `目前 ${braSize ?? ''}（台灣／日本尺寸：罩杯字母 + 下胸圍）。`;

    const mark = (r: Row, mode: 'manual' | 'rare' | 'auto' | 'derived') => {
      r.tag.textContent = { manual: '手動', rare: '手動・少見', auto: '推算', derived: '依比例' }[mode];
      r.tag.dataset.state = mode;
      if (r.reset) r.reset.hidden = mode === 'auto' || mode === 'derived';
      r.row.classList.toggle('is-manual', mode === 'manual' || mode === 'rare');
    };
    const show = (id: VarId, scale = 1) => {
      const r = this.rows.get(id);
      if (!r) return;
      const isDerived = derived.includes(id as MeasureId);
      const locked = sug.locked[id] && !isDerived;
      setValue(r.field, sug.values[id] * scale);
      const p = rarity[id];
      mark(r, isDerived ? 'derived' : locked ? (p !== undefined && (p < 0.05 || p > 0.95) ? 'rare' : 'manual') : 'auto');
      const [lo, hi] = sug.range[id];
      if (id === 'muscleRate') {
        r.note.textContent = '骨骼肌重 ÷ 體重，可獨立指定；未指定時以去脂體重的 55% 作分配起點。';
        return;
      }
      const hint = id === 'underbust' && state.sex === 'male' ? '胸肌下方的肋骨水平一圈' : MEASURES.find((m) => m.id === id)?.hint ?? '';
      r.note.textContent = locked || isDerived ? hint : `常見 ${fmt(lo * scale)}–${fmt(hi * scale)}${hint ? `・${hint}` : ''}`;
    };
    show('weight');
    show('bodyFat', 100);
    show('muscleRate', 100);
    for (const d of MEASURES) show(d.id);

    const ratios = ratiosOf(sug.values);
    for (const d of RATIOS) {
      const r = this.rows.get(d.id)!;
      const locked = state.ratios[d.id] !== undefined;
      setValue(r.field, displayRatio(d, state.ratios[d.id] ?? ratios[d.id]), d.digits);
      mark(r, locked ? 'manual' : 'auto');
      r.note.textContent = locked ? d.hint : `目前由長度算出・${d.hint}`;
    }
    const inseam = (ratios.legRatio * sug.values.height);
    this.proportionNote.textContent = `股下約 ${fmt(inseam)} cm，上身（頭頂到胯下）約 ${fmt(sug.values.height - inseam)} cm，上身：下身 ≈ 1 : ${(inseam / (sug.values.height - inseam)).toFixed(2)}。`;

    const detailLocked = DETAIL.filter((id) => sug.locked[id] && !derived.includes(id)).length;
    this.detailCount.textContent = detailLocked ? `${detailLocked} 項手動` : '';
    const ratioLocked = RATIOS.filter((d) => state.ratios[d.id] !== undefined).length;
    this.ratioCount.textContent = ratioLocked ? `${ratioLocked} 項手動` : '';
  }
}
