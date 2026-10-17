import './styles.css';
import { BodyClient } from './body/client';
import { goalsFor } from './body/goals';
import type { EngineOutput } from './body/mh/engine';
import { type Summary, braSize, summarize } from './core/analysis';
import { type Suggestion, type VarId, rarity, suggest } from './core/linkage';
import type { MeasureId } from './core/measurements';
import { cupDiff } from './core/reference';
import { type AppState, DEFAULT_STATE, PRESETS, loadSaved, presetState, save, stateFromUrl } from './core/state';
import { ExportDialog, ShareDialog, composeThreeView } from './ui/dialogs';
import { Panel } from './ui/panel';
import { renderSummary, renderSummaryLoading } from './ui/summary';
import { onThemeChange } from './view/theme';
import { type ViewName, Viewer } from './view/viewer';

// 資料流：狀態（你鎖定的數值）→ 連動模型給其他項目建議值 → 背景執行緒依身體組成把人體網格變形 → 顯示。
// 沒鎖定的圍度、體重、體脂率，面板上顯示的是網格上實際量到（模型算出）的數值。
// 網格算好後才換上去，拖動滑桿時畫面不會卡住。

const viewer = new Viewer(document.getElementById('stage')!);
const summaryEl = document.getElementById('summary')!;
const statusEl = document.getElementById('stage-status')!;
const presetSelect = document.getElementById('preset') as HTMLSelectElement;

let state: AppState = stateFromUrl() ?? loadSaved() ?? structuredClone(DEFAULT_STATE);
let sug: Suggestion | null = null;
let summary: Summary | null = null;
let shown: { state: AppState; sug: Suggestion } | null = null;
/** 上一次網格算出的數值：新的結果算好前，沒鎖定的欄位先顯示這些 */
let meshValues: Suggestion['values'] | null = null;
let requestedKey = '';
let topologySet = false;
let scheduled = false;

interface Tag {
  state: AppState;
  sug: Suggestion;
  bustDiff: number | null;
}

const client = new BodyClient<Tag>(
  (out: EngineOutput, tag: Tag) => {
    if (!topologySet && client.asset) {
      viewer.setTopology(client.asset);
      topologySet = true;
    }
    summary = summarize(tag.state, tag.sug, out, tag.bustDiff);
    meshValues = summary.values;
    const sugShown = { ...tag.sug, values: summary.values };
    shown = { state: tag.state, sug: sugShown };
    viewer.setShape(out, summary.values);
    renderSummary(summaryEl, tag.state, summary);
    if (tag.state === state) renderPanel(sugShown);
    statusEl.hidden = true;
  },
  (message) => {
    statusEl.hidden = false;
    statusEl.textContent = `人體模型出錯：${message}。請重新整理頁面再試一次。`;
  },
);

function bustDiff(s: AppState): number | null {
  return s.sex === 'female' && s.cup ? (cupDiff(s.cup) ?? null) : null;
}

const panel = new Panel(document.getElementById('panel')!, {
  onSex(sex) {
    // 換性別時，其他手動數值大多不再適用，只保留身高與體重
    const { height, weight } = state.locked;
    state = { ...state, sex, cup: null, locked: weight === undefined ? { height } : { height, weight } };
    presetSelect.value = '';
    update();
  },
  onLock(id: VarId, value: number | null) {
    const locked = { ...state.locked };
    if (value === null) {
      if (id !== 'height') delete locked[id];
    } else {
      locked[id] = value;
    }
    state = { ...state, locked };
    presetSelect.value = '';
    update();
  },
  onCup(cup) {
    state = { ...state, cup };
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

/** 面板：鎖定的欄位顯示輸入值，其他欄位顯示網格量到的數值 */
function renderPanel(s: Suggestion): void {
  const diff = bustDiff(state);
  const rare = Object.fromEntries(rarity({ sex: state.sex, locked: state.locked, bustDiff: diff }).map((r) => [r.id, r.percentile]));
  panel.render(state, s, rare, state.sex === 'female' ? braSize(s.values.bust, s.values.underbust) : null);
}

function apply(): void {
  scheduled = false;
  const diff = bustDiff(state);
  sug = suggest({ sex: state.sex, locked: state.locked, bustDiff: diff });
  const pending = sug;
  const values = { ...pending.values };
  if (meshValues && shown?.state.sex === state.sex) {
    for (const id of Object.keys(values) as (keyof typeof values)[]) if (!pending.locked[id]) values[id] = meshValues[id];
  }
  renderPanel({ ...pending, values });
  viewer.setDisplay({ lineStyle: state.view.lineStyle, outline: state.view.showOutline, measures: state.view.showMeasures });

  const key = JSON.stringify([state.sex, state.locked, state.cup, state.view.armAngle]);
  if (key !== requestedKey) {
    requestedKey = key;
    client.request({ ...goalsFor({ sex: state.sex, sug, bustDiff: diff }), armAngle: state.view.armAngle }, { state, sug, bustDiff: diff });
  }
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
  if (!shown || !summary) return;
  exportDialog.show('三視圖', composeThreeView(viewer, shown.state, shown.sug, summary), `bodyref-三視圖-${stamp()}.png`);
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

const matchPreset = PRESETS.find((p) => JSON.stringify(presetState(p, state.view)) === JSON.stringify(state));
presetSelect.value = matchPreset?.id ?? '';
renderSummaryLoading(summaryEl, '正在載入人體模型（約 1 MB）…');
apply();
