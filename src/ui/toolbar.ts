import { LINE_STYLES, type ViewSettings } from '../core/state';

// 3D 畫面上方的顯示工具列：表面線條、輪廓線、量測線、手臂角度。
// 這些只影響畫面，不影響任何數值，所以放在畫面上而不是輸入面板裡。

export class DisplayToolbar {
  private readonly lineButtons: HTMLButtonElement[] = [];
  private readonly toggles: Record<'showOutline' | 'showMeasures', HTMLButtonElement>;
  private readonly arm: HTMLInputElement;
  private readonly armValue: HTMLElement;

  constructor(root: HTMLElement, onView: (patch: Partial<ViewSettings>) => void) {
    const lines = document.createElement('div');
    lines.className = 'tool-group';
    lines.setAttribute('role', 'group');
    lines.setAttribute('aria-label', '表面線條');
    for (const s of LINE_STYLES) {
      const b = button(s.label);
      b.dataset.value = s.id;
      b.addEventListener('click', () => onView({ lineStyle: s.id }));
      lines.append(b);
      this.lineButtons.push(b);
    }

    const toggles = document.createElement('div');
    toggles.className = 'tool-group';
    const outline = button('輪廓');
    const measures = button('量測線');
    outline.title = '人台外輪廓的深色描邊';
    measures.title = '顯示全部量測線（關閉時只顯示滑鼠指著的那一條）';
    toggles.append(outline, measures);
    this.toggles = { showOutline: outline, showMeasures: measures };
    for (const key of ['showOutline', 'showMeasures'] as const) {
      this.toggles[key].addEventListener('click', () => onView({ [key]: this.toggles[key].getAttribute('aria-pressed') !== 'true' }));
    }

    const arm = document.createElement('label');
    arm.className = 'tool-arm';
    arm.title = '手臂張開角度：只影響姿勢，不影響任何量測數值';
    this.arm = document.createElement('input');
    this.arm.type = 'range';
    this.arm.min = '0';
    this.arm.max = '45';
    this.arm.step = '1';
    this.arm.setAttribute('aria-label', '手臂張開角度');
    this.arm.addEventListener('input', () => onView({ armAngle: Number(this.arm.value) }));
    this.armValue = document.createElement('span');
    this.armValue.className = 'tool-arm-value';
    arm.append(document.createTextNode('手臂'), this.arm, this.armValue);

    root.append(lines, toggles, arm);
  }

  render(view: ViewSettings): void {
    for (const b of this.lineButtons) b.setAttribute('aria-pressed', String(b.dataset.value === view.lineStyle));
    this.toggles.showOutline.setAttribute('aria-pressed', String(view.showOutline));
    this.toggles.showMeasures.setAttribute('aria-pressed', String(view.showMeasures));
    if (document.activeElement !== this.arm) this.arm.value = String(view.armAngle);
    this.armValue.textContent = `${view.armAngle}°`;
  }
}

function button(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hud-btn';
  b.textContent = text;
  return b;
}
