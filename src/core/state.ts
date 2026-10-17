import type { BasicInputs } from './estimate';
import { MEASURES, type MeasureValues } from './measurements';

// 網站狀態：基本輸入、手動指定的量測、顯示設定。
// 會存在瀏覽器（下次打開時還原），也能編碼成網址分享。

export interface ViewSettings {
  armAngle: number;
  showGrid: boolean;
  showOutline: boolean;
  showMeasures: boolean;
}

export interface AppState extends BasicInputs {
  overrides: Partial<MeasureValues>;
  view: ViewSettings;
}

export const DEFAULT_VIEW: ViewSettings = { armAngle: 12, showGrid: true, showOutline: true, showMeasures: true };

export interface Preset {
  id: string;
  label: string;
  state: Omit<AppState, 'view' | 'overrides'> & { overrides?: Partial<MeasureValues> };
}

// 範例體型，用來快速比較；不是任何真人的數據
export const PRESETS: readonly Preset[] = [
  { id: 'f-avg', label: '女性・平均（160 cm／52 kg）', state: { sex: 'female', height: 160, weight: 52, bodyFat: null, cup: null } },
  { id: 'f-slim', label: '女性・纖細（165 cm／46 kg）', state: { sex: 'female', height: 165, weight: 46, bodyFat: null, cup: 'A' } },
  { id: 'f-curvy', label: '女性・豐滿（162 cm／60 kg・E）', state: { sex: 'female', height: 162, weight: 60, bodyFat: 0.3, cup: 'E' } },
  { id: 'f-fit', label: '女性・運動（167 cm／57 kg・體脂 20%）', state: { sex: 'female', height: 167, weight: 57, bodyFat: 0.2, cup: 'B' } },
  { id: 'm-avg', label: '男性・平均（172 cm／68 kg）', state: { sex: 'male', height: 172, weight: 68, bodyFat: null, cup: null } },
  { id: 'm-lean', label: '男性・精實（178 cm／74 kg・體脂 12%）', state: { sex: 'male', height: 178, weight: 74, bodyFat: 0.12, cup: null } },
  { id: 'm-big', label: '男性・壯碩（176 cm／92 kg・體脂 24%）', state: { sex: 'male', height: 176, weight: 92, bodyFat: 0.24, cup: null } },
];

export function presetState(p: Preset, view: ViewSettings = DEFAULT_VIEW): AppState {
  return { ...p.state, overrides: { ...(p.state.overrides ?? {}) }, view: { ...view } };
}

export const DEFAULT_STATE: AppState = presetState(PRESETS[0]);

const STORAGE_KEY = 'bodyref:v1';

function sanitize(raw: unknown): AppState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  const sex = r.sex === 'male' ? 'male' : r.sex === 'female' ? 'female' : null;
  const height = num(r.height, 100, 250);
  const weight = num(r.weight, 20, 250);
  if (!sex || height === null || weight === null) return null;
  const overrides: Partial<MeasureValues> = {};
  const ov = (r.overrides ?? {}) as Record<string, unknown>;
  for (const d of MEASURES) {
    const v = num(ov[d.id], d.min * 0.5, d.max * 1.5);
    if (v !== null) overrides[d.id] = v;
  }
  const view = (r.view ?? {}) as Record<string, unknown>;
  return {
    sex,
    height,
    weight,
    bodyFat: num(r.bodyFat, 0.02, 0.7),
    cup: typeof r.cup === 'string' && /^[A-K]{1,2}$/.test(r.cup) ? r.cup : null,
    overrides,
    view: {
      armAngle: num(view.armAngle, 0, 80) ?? DEFAULT_VIEW.armAngle,
      showGrid: typeof view.showGrid === 'boolean' ? view.showGrid : DEFAULT_VIEW.showGrid,
      showOutline: typeof view.showOutline === 'boolean' ? view.showOutline : DEFAULT_VIEW.showOutline,
      showMeasures: typeof view.showMeasures === 'boolean' ? view.showMeasures : DEFAULT_VIEW.showMeasures,
    },
  };
}

export function loadSaved(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function save(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 無法存取瀏覽器儲存空間時（例如無痕模式）就不保存
  }
}

/** 分享網址只帶數據，不帶顯示設定 */
export function encodeShare(state: AppState): string {
  const { view: _view, ...data } = state;
  const json = JSON.stringify(data);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShare(code: string): AppState | null {
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    return sanitize({ ...data, view: DEFAULT_VIEW });
  } catch {
    return null;
  }
}

export function shareUrl(state: AppState): string {
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = `?b=${encodeShare(state)}`;
  return url.toString();
}

export function stateFromUrl(): AppState | null {
  const code = new URLSearchParams(window.location.search).get('b');
  return code ? decodeShare(code) : null;
}
