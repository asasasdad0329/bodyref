import './styles.css';
import { FINE, type BodyShape, generateBody } from './body/generate';
import { type Summary, summarize } from './core/analysis';
import { type Estimate, estimate } from './core/estimate';
import type { MeasureId } from './core/measurements';
import { type AppState, DEFAULT_STATE, PRESETS, loadSaved, presetState, save, stateFromUrl } from './core/state';
import { ExportDialog, ShareDialog, composeThreeView } from './ui/dialogs';
import { Panel } from './ui/panel';
import { renderSummary } from './ui/summary';
import { onThemeChange } from './view/theme';
import { type ViewName, Viewer } from './view/viewer';

// 資料流：狀態 → 推算 → 生成模型 → 更新 3D 與介面。
// 推算只在數據改變時重跑；只改顯示設定時沿用上一次的結果。

const viewer = new Viewer(document.getElementById('stage')!);
const summaryEl = document.getElementById('summary')!;
const presetSelect = document.getElementById('preset') as HTMLSelectElement;

let state: AppState = stateFromUrl() ?? loadSaved() ?? structuredClone(DEFAULT_STATE);
let est: Estimate | null = null;
let estKey = '';
let shape: BodyShape | null = null;
let shapeKey = '';
let summary: Summary | null = null;
let scheduled = false;

const panel = new Panel(document.getElementById('panel')!, {
  onBasic(patch) {
    state = { ...state, ...patch };
    // 換性別時，手動指定的數值和罩杯大多不再適用
    if (patch.sex) {
      state.overrides = {};
      state.cup = null;
    }
    presetSelect.value = '';
    update();
  },
  onMeasure(id, value) {
    const overrides = { ...state.overrides };
    if (value === null) delete overrides[id];
    else overrides[id] = value;
    state = { ...state, overrides };
    presetSelect.value = '';
    update();
  },
  onView(patch) {
    state = { ...state, view: { ...state.view, ...patch } };
    update();
  },
  onFocusMeasure(id: MeasureId | null) {
    viewer.setActiveMeasure(id);
  },
});

function update(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(apply);
}

function apply(): void {
  scheduled = false;
  const { view, ...data } = state;
  const key = JSON.stringify(data);
  if (key !== estKey || !est) {
    est = estimate(state);
    estKey = key;
  }
  const nextShapeKey = `${key}|${view.armAngle}`;
  if (nextShapeKey !== shapeKey || !shape) {
    shape = generateBody(est.measurements, { quality: FINE, armAngle: view.armAngle });
    shapeKey = nextShapeKey;
    summary = summarize(est, state.weight, shape);
    viewer.setShape(shape, est.measurements);
  }
  viewer.setDisplay({ grid: view.showGrid, outline: view.showOutline, measures: view.showMeasures });
  panel.render(state, est, summary!);
  renderSummary(summaryEl, state, summary!);
  save(state);
}

// 範例體型
presetSelect.append(new Option('自訂', ''));
for (const p of PRESETS) presetSelect.append(new Option(p.label, p.id));
presetSelect.addEventListener('change', () => {
  const p = PRESETS.find((x) => x.id === presetSelect.value);
  if (!p) return;
  state = presetState(p, state.view);
  update();
});

document.getElementById('reset')!.addEventListener('click', () => {
  state = presetState(PRESETS.find((p) => p.state.sex === state.sex) ?? PRESETS[0], state.view);
  presetSelect.value = '';
  update();
  viewer.setView('front');
});

// 視角
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
  btn.addEventListener('click', () => viewer.setView(btn.dataset.view as ViewName));
}

// 匯出與分享
const exportDialog = new ExportDialog();
const stamp = () => new Date().toISOString().slice(0, 10);
document.getElementById('shot')!.addEventListener('click', () => {
  exportDialog.show('目前視角截圖', viewer.captureCurrent(2), `bodyref-${stamp()}.png`);
});
document.getElementById('three-view')!.addEventListener('click', () => {
  if (!est || !summary) return;
  exportDialog.show('三視圖', composeThreeView(viewer, state, est, summary), `bodyref-三視圖-${stamp()}.png`);
});
const shareDialog = new ShareDialog((s) => {
  state = { ...s, view: state.view };
  presetSelect.value = '';
  update();
});
document.getElementById('share')!.addEventListener('click', () => shareDialog.show(state));

onThemeChange(() => viewer.refreshColors());

// 寬螢幕時摘要卡浮在 3D 畫面左上角，模型改成置中在右側沒被遮住的區域
function syncInset(): void {
  const floating = getComputedStyle(summaryEl).position === 'absolute';
  viewer.setLeftInset(floating ? summaryEl.offsetLeft + summaryEl.offsetWidth : 0);
}
new ResizeObserver(syncInset).observe(summaryEl);
syncInset();

// 從分享連結開啟時，清掉網址參數，之後的修改不會和連結混淆
if (new URLSearchParams(window.location.search).has('b')) {
  history.replaceState(null, '', window.location.pathname);
}

presetSelect.value = PRESETS.find((p) => JSON.stringify(presetState(p, state.view)) === JSON.stringify(state))?.id ?? '';
apply();
