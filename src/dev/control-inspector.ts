import '../styles.css';
import * as THREE from 'three';
import { loadBodyAsset } from '../body/mh/asset';
import { BodyEngine } from '../body/mh/engine';
import { bodyInputFor } from '../body/goals';
import { suggest } from '../core/linkage';
import { DEFAULT_MORPHOLOGY } from '../core/morphology';
import { Viewer } from '../view/viewer';
import { SOFT_KEYS, type SoftKey } from '../body/mh/rings';

// 獨立維護頁；不載入一般產品流程、不儲存使用者數據。
const host = document.getElementById('inspection')!;
host.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) 340px;height:100vh';
host.innerHTML = `<div id="inspection-stage" style="position:relative"></div><aside style="padding:20px;overflow:auto">
<h1>形狀控制檢查</h1><p>單控制／權重檢查與實際輸入分開。單控制位移不重新對準尺寸。</p>
<label>性別 <select id="inspect-sex"><option value="female">女性</option><option value="male">男性</option></select></label>
<p><label>臀圍 <input id="inspect-hip" type="number" min="70" max="150" value="104"></label></p>
<p><label>體脂 % <input id="inspect-fat" type="number" min="5" max="55" value="26"></label></p>
<button id="inspect-solve">實際數值求解</button>
<p><label>控制 <select id="inspect-control"></select></label></p>
<p><label>隔離：停用 <select id="inspect-disable"><option value="">無</option></select></label></p>
<p><label>單控制 cm <input id="inspect-amount" type="range" min="-1" max="3" value="0" step="0.1"></label></p>
<p><label><input id="inspect-heat" type="checkbox" checked>權重熱圖</label></p>
<p><label>光向 <input id="inspect-light" type="range" min="-3.14" max="3.14" value="0" step="0.2"></label></p>
<div id="inspect-views"><button data-view="front">正</button><button data-view="quarter">斜</button><button data-view="side">側</button><button data-view="back">後</button></div>
<pre id="inspect-data" style="white-space:pre-wrap"></pre></aside>`;
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewer = new Viewer(get('inspection-stage'));
const asset = await loadBodyAsset('/body.bin');
const engine = new BodyEngine(asset);
viewer.setTopology(asset);
viewer.setDisplay({ lineStyle: 'none', outline: false, measures: false });
const control = get<HTMLSelectElement>('inspect-control');
const disable = get<HTMLSelectElement>('inspect-disable');
for (const key of SOFT_KEYS) disable.append(new Option(key, key));
let current: ReturnType<BodyEngine['run']>;
let bindings: ReturnType<BodyEngine['rings']['inspectControls']>;
const condition = { morphology: { ...DEFAULT_MORPHOLOGY }, bodyFat: 0.26, muscle: 0 };

function solve() {
  const sex = get<HTMLSelectElement>('inspect-sex').value === 'male' ? 'male' : 'female';
  const hip = Number(get<HTMLInputElement>('inspect-hip').value);
  const bodyFat = Number(get<HTMLInputElement>('inspect-fat').value) / 100;
  const input = bodyInputFor({ sex, sug: suggest({ sex, locked: { height: 165, hip, bodyFat } }), bustDiff: null });
  current = engine.run({ ...input, condition: { ...condition, bodyFat }, armAngle: 16 });
  bindings = engine.rings.inspectControls(input);
  control.replaceChildren(...bindings.surface.map(c => new Option(c.id, c.id)));
  get<HTMLInputElement>('inspect-amount').value = '0';
  draw();
}
function draw() {
  const c = bindings.surface.find(c => c.id === control.value)!;
  const amount = Number(get<HTMLInputElement>('inspect-amount').value);
  const inspected = engine.rings.inspectControl(c.id, amount, disable.value ? [disable.value as SoftKey] : []);
  const positions = engine.model.display(inspected.P, 16, false).P.slice(0, asset.nBody * 3);
  viewer.setShape({ ...current, positions }, inspected.values);
  if (get<HTMLInputElement>('inspect-heat').checked) viewer.body.group.traverse(obj => {
    if (!(obj instanceof THREE.Mesh) || !(obj.material instanceof THREE.MeshStandardMaterial)) return;
    const count = obj.geometry.getAttribute('position').count;
    if (count !== asset.nBody) return;
    const rgb = new Float32Array(count * 3);
    const max = Math.max(...c.weights, 1e-6);
    for (let i = 0; i < count; i++) {
      const t = c.weights[i] / max;
      rgb[i * 3] = t; rgb[i * 3 + 1] = 0.15 + 0.7 * Math.sin(Math.PI * t); rgb[i * 3 + 2] = 1 - t;
    }
    obj.geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  });
  get('inspect-data').textContent = JSON.stringify({ id: c.id, parent: c.parent, origin: c.origin,
    axes: c.axes, tissue: c.tissue, range: c.range, boundary: c.boundary,
    affectedVertices: c.weights.filter(w => w > 0).length,
    response: { volumeCm3: inspected.volume - current.volume,
      girthCm: Object.fromEntries(Object.entries(inspected.values).map(([k, v]) => [k, v - current.values[k as keyof typeof current.values]])) },
    actualInput: { values: current.values, tissues: current.tissues, residual: current.residual } }, null, 2);
}
get('inspect-solve').addEventListener('click', solve);
control.addEventListener('change', draw);
disable.addEventListener('change', draw);
get('inspect-amount').addEventListener('input', draw);
get('inspect-heat').addEventListener('change', draw);
get('inspect-light').addEventListener('input', () => viewer.setLightOffset(Number(get<HTMLInputElement>('inspect-light').value)));
get('inspect-views').querySelectorAll<HTMLButtonElement>('button').forEach(b => b.addEventListener('click', () => viewer.setView(b.dataset.view as 'front' | 'quarter' | 'side' | 'back')));
solve();
