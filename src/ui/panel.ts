import type { Summary } from '../core/analysis';
import type { BasicInputs, Estimate } from '../core/estimate';
import { BODY_FAT_RANGE, HEIGHT_RANGE, MEASURES, type MeasureDef, type MeasureId, WEIGHT_RANGE } from '../core/measurements';
import { CUP_TABLE, MUSCLE_OF_LEAN } from '../core/reference';
import { type AppState, LINE_STYLES, type ViewSettings } from '../core/state';

// 右側輸入面板：基本數據（推算全身）、圍度、長度、顯示設定。
// 每個量測欄位會標示目前是「推算」還是「手動」，手動的欄位可以一鍵改回推算。

export interface PanelCallbacks {
  onBasic(patch: Partial<BasicInputs>): void;
  /** value 為 null 表示改回推算值 */
  onMeasure(id: MeasureId, value: number | null): void;
  onView(patch: Partial<ViewSettings>): void;
  onFocusMeasure(id: MeasureId | null): void;
}

interface NumberField {
  range: HTMLInputElement;
  num: HTMLInputElement;
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

export class Panel {
  private basic: Record<'height' | 'weight' | 'bodyFat' | 'muscle', NumberField> = {} as never;
  private measureFields = new Map<MeasureId, { field: NumberField; tag: HTMLElement; reset: HTMLButtonElement; row: HTMLElement }>();
  private sexInputs: HTMLInputElement[] = [];
  private cupSelect!: HTMLSelectElement;
  private cupRow!: HTMLElement;
  private cupNote!: HTMLElement;
  private fatTag!: HTMLElement;
  private fatReset!: HTMLButtonElement;
  private view: Record<'outline' | 'measures', HTMLInputElement> = {} as never;
  private lineInputs: HTMLInputElement[] = [];
  private armAngle!: NumberField;
  private hovered: MeasureId | null = null;
  private focused: MeasureId | null = null;

  constructor(root: HTMLElement, private readonly cb: PanelCallbacks) {
    root.append(this.buildBasic(), this.buildMeasures('girth', '圍度', 'GIRTH'), this.buildMeasures('length', '長度', 'LENGTH'), this.buildDisplay());
  }

  private group(title: string, eyebrow: string, desc?: string): HTMLElement {
    const g = el('section', 'group');
    const head = el('header', 'group-head');
    head.append(el('span', 'eyebrow', eyebrow), el('h2', 'group-title', title));
    g.append(head);
    if (desc) g.append(el('p', 'group-desc', desc));
    return g;
  }

  private buildBasic(): HTMLElement {
    const g = this.group('基本數據', 'BASE', '先填身高、體重，系統會依人體統計推算出全身的圍度與長度。知道實際數值的項目，可以在下方逐項修改。');

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
      input.addEventListener('change', () => input.checked && this.cb.onBasic({ sex: value }));
      const lab = el('label', undefined, text);
      lab.htmlFor = id;
      fs.append(input, lab);
      this.sexInputs.push(input);
    }
    sexRow.append(fs);
    g.append(sexRow);

    const simple = (key: 'height' | 'weight', label: string, range: typeof HEIGHT_RANGE, unit: string) => {
      const row = el('div', 'field');
      const top = el('div', 'field-top');
      const lab = el('label', 'field-label', label);
      lab.htmlFor = `n-${key}`;
      top.append(lab);
      const ctl = numberControl(key, label, range, unit, (v) => this.cb.onBasic({ [key]: v }));
      row.append(top, ctl.node);
      this.basic[key] = ctl.field;
      return row;
    };
    g.append(simple('height', '身高', HEIGHT_RANGE, 'cm'), simple('weight', '體重', WEIGHT_RANGE, 'kg'));

    // 體脂率與骨骼肌率互相換算，改其中一個另一個會跟著變
    const fatRow = el('div', 'field');
    const fatTop = el('div', 'field-top');
    const fatLab = el('label', 'field-label', '體脂率');
    fatLab.htmlFor = 'n-bodyFat';
    this.fatTag = el('span', 'tag');
    this.fatReset = el('button', 'field-reset', '改回自動');
    this.fatReset.type = 'button';
    this.fatReset.addEventListener('click', () => this.cb.onBasic({ bodyFat: null }));
    fatTop.append(fatLab, this.fatTag, this.fatReset);
    const fat = numberControl('bodyFat', '體脂率', BODY_FAT_RANGE, '%', (v) => this.cb.onBasic({ bodyFat: v / 100 }));
    fatRow.append(fatTop, fat.node, el('p', 'hint', '不填時依 BMI 估算（以 25 歲計）。'));
    this.basic.bodyFat = fat.field;

    const muscleRow = el('div', 'field');
    const muscleTop = el('div', 'field-top');
    const muscleLab = el('label', 'field-label', '骨骼肌率');
    muscleLab.htmlFor = 'n-muscle';
    muscleTop.append(muscleLab);
    const muscle = numberControl('muscle', '骨骼肌率', MUSCLE_RANGE, '%', (v) =>
      this.cb.onBasic({ bodyFat: Math.min(0.55, Math.max(0.05, 1 - v / 100 / MUSCLE_OF_LEAN)) }),
    );
    muscleRow.append(muscleTop, muscle.node, el('p', 'hint', '骨骼肌重 ÷ 體重。以骨骼肌約占去脂體重 55% 換算，和體脂率連動。'));
    this.basic.muscle = muscle.field;
    g.append(fatRow, muscleRow);

    this.cupRow = el('div', 'field');
    const cupTop = el('div', 'field-top');
    const cupLab = el('label', 'field-label', '罩杯');
    cupLab.htmlFor = 'cup';
    cupTop.append(cupLab);
    this.cupSelect = el('select', 'select');
    this.cupSelect.id = 'cup';
    this.cupSelect.append(new Option('自動（依體脂推算）', ''));
    for (const c of CUP_TABLE) this.cupSelect.append(new Option(`${c.cup}（上下胸圍差 ${c.diff} cm）`, c.cup));
    this.cupSelect.addEventListener('change', () => this.cb.onBasic({ cup: this.cupSelect.value || null }));
    this.cupNote = el('p', 'hint');
    this.cupRow.append(cupTop, this.cupSelect, this.cupNote);
    g.append(this.cupRow);
    return g;
  }

  private buildMeasures(group: MeasureDef['group'], title: string, eyebrow: string): HTMLElement {
    const g = this.group(title, eyebrow);
    for (const d of MEASURES.filter((m) => m.group === group)) {
      const row = el('div', 'field measure');
      row.dataset.measure = d.id;
      const top = el('div', 'field-top');
      const lab = el('label', 'field-label', d.label);
      lab.htmlFor = `n-${d.id}`;
      const tag = el('span', 'tag');
      const reset = el('button', 'field-reset', '改回推算');
      reset.type = 'button';
      reset.addEventListener('click', () => this.cb.onMeasure(d.id, null));
      top.append(lab, tag, reset);
      const ctl = numberControl(d.id, d.label, d, 'cm', (v) => this.cb.onMeasure(d.id, v));
      row.append(top, ctl.node, el('p', 'hint', d.hint));
      row.addEventListener('pointerenter', () => this.setHover(d.id));
      row.addEventListener('pointerleave', () => this.setHover(null));
      row.addEventListener('focusin', () => this.setFocus(d.id));
      row.addEventListener('focusout', () => this.setFocus(null));
      g.append(row);
      this.measureFields.set(d.id, { field: ctl.field, tag, reset, row });
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
    g.append(styleRow);
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
    g.append(toggles);
    const armRow = el('div', 'field');
    const top = el('div', 'field-top');
    const lab = el('label', 'field-label', '手臂張開角度');
    lab.htmlFor = 'n-armAngle';
    top.append(lab);
    const ctl = numberControl('armAngle', '手臂張開角度', { min: 0, max: 60, step: 1 }, '°', (v) => this.cb.onView({ armAngle: v }));
    armRow.append(top, ctl.node, el('p', 'hint', '只影響姿勢，不影響任何量測數值。'));
    this.armAngle = ctl.field;
    g.append(armRow);
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

  render(state: AppState, est: Estimate, summary: Summary): void {
    for (const input of this.sexInputs) input.checked = input.value === state.sex;
    setValue(this.basic.height, state.height);
    setValue(this.basic.weight, state.weight);
    setValue(this.basic.bodyFat, est.bodyFat * 100);
    setValue(this.basic.muscle, summary.muscleRate * 100);
    this.fatTag.textContent = est.bodyFatAuto ? '自動' : '手動';
    this.fatTag.dataset.state = est.bodyFatAuto ? 'auto' : 'manual';
    this.fatReset.hidden = est.bodyFatAuto;

    const female = state.sex === 'female';
    this.cupRow.hidden = !female;
    this.cupSelect.value = state.cup ?? '';
    const bustManual = state.overrides.bust !== undefined;
    this.cupNote.textContent = bustManual
      ? '上胸圍已手動指定，罩杯由上下胸圍差決定。'
      : `目前 ${summary.braSize ?? ''}（台灣／日本尺寸，罩杯字母 + 下胸圍）。`;
    this.cupSelect.disabled = bustManual;

    for (const d of MEASURES) {
      const f = this.measureFields.get(d.id)!;
      setValue(f.field, est.measurements[d.id]);
      const manual = est.source[d.id] === 'manual';
      f.tag.textContent = manual ? '手動' : '推算';
      f.tag.dataset.state = manual ? 'manual' : 'auto';
      f.reset.hidden = !manual;
      f.row.classList.toggle('is-manual', manual);
    }

    for (const input of this.lineInputs) input.checked = input.value === state.view.lineStyle;
    this.view.outline.checked = state.view.showOutline;
    this.view.measures.checked = state.view.showMeasures;
    setValue(this.armAngle, state.view.armAngle, 0);
  }
}
