import type { VarId } from './linkage';
import { VARS } from './linkage';
import type { Sex } from './measurements';
import { RATIOS, type Ratios } from './proportions';
import { ABDOMEN_SHAPES, BREAST_SHAPES, DEFAULT_MORPHOLOGY, HIP_SHAPES, type Morphology } from './morphology';
import { CUP_TABLE } from './reference';

// 網站狀態：哪些數值是使用者鎖定（手動）的、罩杯、顯示設定。
// 沒鎖定的數值由連動模型給建議值，所以狀態裡只存鎖定的部分。
// 狀態會存在瀏覽器（下次打開時還原），也能編碼成分享代碼。

/** 人台表面的線條：結構線（白模）、密集網格、不畫 */
export type LineStyle = 'guide' | 'grid' | 'none';
export const LINE_STYLES: readonly { id: LineStyle; label: string }[] = [
  { id: 'guide', label: '結構線' },
  { id: 'grid', label: '網格' },
  { id: 'none', label: '無' },
];

export interface ViewSettings {
  armAngle: number;
  lineStyle: LineStyle;
  showOutline: boolean;
  showMeasures: boolean;
}

export type Locked = Partial<Record<VarId, number>>;

export interface AppState {
  sex: Sex;
  /** 鎖定的數值；身高一定鎖定 */
  locked: Locked & { height: number };
  /** 指定的罩杯（只對女性有效） */
  cup: string | null;
  /** 指定的身體比例（和對應的長度互斥，見 proportions.ts） */
  ratios: Ratios;
  view: ViewSettings;
  muscleMass: number | null;
  morphology: Morphology;
}

export const DEFAULT_VIEW: ViewSettings = { armAngle: 16, lineStyle: 'none', showOutline: false, showMeasures: false };

export interface Preset {
  id: string;
  label: string;
  state: Omit<AppState, 'view' | 'muscleMass' | 'morphology'>;
}

// 範例體型，用來快速比較；不是任何真人的數據。
// 預設只填身高：體重由體型推算，改圍度時體重會跟著變。
export const PRESETS: readonly Preset[] = [
  { id: 'f-avg', label: '女性・平均（160 cm）', state: { sex: 'female', locked: { height: 160 }, cup: null, ratios: {} } },
  { id: 'f-slim', label: '女性・纖細（165 cm／46 kg・A）', state: { sex: 'female', locked: { height: 165, weight: 46 }, cup: 'A', ratios: {} } },
  { id: 'f-curvy', label: '女性・豐滿（162 cm・體脂 30%・E）', state: { sex: 'female', locked: { height: 162, bodyFat: 0.3 }, cup: 'E', ratios: {} } },
  { id: 'f-fit', label: '女性・運動（167 cm／57 kg・體脂 20%）', state: { sex: 'female', locked: { height: 167, weight: 57, bodyFat: 0.2 }, cup: 'B', ratios: {} } },
  { id: 'f-long', label: '女性・長腿（168 cm・腿長比 49%）', state: { sex: 'female', locked: { height: 168 }, cup: null, ratios: { legRatio: 0.49 } } },
  {
    id: 'f-hourglass',
    label: '女性・誇張沙漏（插畫常見比例）',
    state: { sex: 'female', locked: { height: 160, bust: 94, underbust: 66, waist: 56, hip: 94 }, cup: null, ratios: {} },
  },
  { id: 'm-avg', label: '男性・平均（172 cm）', state: { sex: 'male', locked: { height: 172 }, cup: null, ratios: {} } },
  { id: 'm-lean', label: '男性・精實（178 cm／74 kg・體脂 12%）', state: { sex: 'male', locked: { height: 178, weight: 74, bodyFat: 0.12 }, cup: null, ratios: {} } },
  { id: 'm-big', label: '男性・壯碩（176 cm／92 kg・體脂 24%）', state: { sex: 'male', locked: { height: 176, weight: 92, bodyFat: 0.24 }, cup: null, ratios: {} } },
];

export function presetState(p: Preset, view: ViewSettings = DEFAULT_VIEW): AppState {
  return { sex: p.state.sex, locked: { ...p.state.locked }, cup: p.state.cup, ratios: { ...p.state.ratios }, view: { ...view }, muscleMass: null, morphology: { ...DEFAULT_MORPHOLOGY } };
}

export const DEFAULT_STATE: AppState = presetState(PRESETS[0]);

const STORAGE_KEY = 'bodyref:v3';

function sanitize(raw: unknown): AppState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  const sex = r.sex === 'male' ? 'male' : r.sex === 'female' ? 'female' : null;
  if (!sex) return null;
  const src = (r.locked ?? {}) as Record<string, unknown>;
  const locked: Locked = {};
  for (const id of VARS) {
    const v = id === 'bodyFat' ? num(src[id], 0.03, 0.7) : num(src[id], 5, 260);
    if (v !== null) locked[id] = v;
  }
  if (locked.height === undefined) return null;
  const srcRatios = (r.ratios ?? {}) as Record<string, unknown>;
  const ratios: Ratios = {};
  for (const d of RATIOS) {
    const v = num(srcRatios[d.id], d.min / d.scale, d.max / d.scale);
    if (v !== null) ratios[d.id] = v;
  }
  const morph = (r.morphology ?? {}) as Record<string, unknown>;
  const view = (r.view ?? {}) as Record<string, unknown>;
  return {
    sex,
    locked: locked as AppState['locked'],
    cup: typeof r.cup === 'string' && CUP_TABLE.some((c) => c.cup === r.cup) ? r.cup : null,
    ratios,
    muscleMass: num(r.muscleMass, 5, 100),
    morphology: {
      breast: BREAST_SHAPES.find(x => x.id === morph.breast)?.id ?? DEFAULT_MORPHOLOGY.breast,
      hip: HIP_SHAPES.find(x => x.id === morph.hip)?.id ?? DEFAULT_MORPHOLOGY.hip,
      abdomen: ABDOMEN_SHAPES.find(x => x.id === morph.abdomen)?.id ?? DEFAULT_MORPHOLOGY.abdomen,
    },
    view: {
      armAngle: num(view.armAngle, 0, 60) ?? DEFAULT_VIEW.armAngle,
      lineStyle: LINE_STYLES.find((s) => s.id === view.lineStyle)?.id ?? DEFAULT_VIEW.lineStyle,
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

/** 分享代碼只帶數據，不帶顯示設定 */
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
