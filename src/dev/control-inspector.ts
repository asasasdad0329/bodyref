import '../styles.css';
import * as THREE from 'three';
import { loadBodyAsset } from '../body/mh/asset';
import { BodyEngine } from '../body/mh/engine';
import { bodyInputFor } from '../body/goals';
import { suggest } from '../core/linkage';
import { cupDiff } from '../core/reference';
import { SOFT_KEYS, type SoftKey } from '../body/mh/rings';
import { toWorld } from '../body/mh/localControls';
import { Viewer, type ViewName } from '../view/viewer';
import { BODY_CASES } from '../../tests/fixtures/bodyCases';

// 開發伺服器專用，不加入正式產品建置或使用者儲存流程。
const host = document.getElementById('inspection')!;
host.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) 360px;height:100vh';
host.innerHTML = `<div id="inspection-stage" style="position:relative;min-width:0"></div>
<aside style="padding:16px;overflow:auto"><h1>控制檢查</h1>
<p>藍色為零權重，紅色為完整權重；箭頭是本次合成實際使用的父軸。除錯增量不重新校正尺寸。</p>
<label>實際案例 <select id="inspect-case"></select></label>
<p><label>控制 <select id="inspect-control"></select></label></p>
<p><label>控制參數增量 <input id="inspect-amount" type="number" min="-0.5" max="1" step="0.1" value="0"></label></p>
<p><label>聯動隔離：停用組織（可複選）<select id="inspect-disable" multiple size="5"></select></label></p>
<p><label><input id="inspect-heat" type="checkbox" checked> 顯示權重與父參照</label></p>
<p><button id="inspect-reset">還原實際解</button></p>
<div id="inspect-views"><button data-view="front">正面</button><button data-view="quarter">前斜</button><button data-view="side">側面</button><button data-view="rearQuarter">後斜</button><button data-view="back">背面</button></div>
<pre id="inspect-data" style="white-space:pre-wrap;font-size:11px"></pre></aside>`;
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const asset = await loadBodyAsset('/body.bin'), engine = new BodyEngine(asset);
const viewer = new Viewer(get('inspection-stage')), axes = new THREE.Group();
viewer.setTopology(asset); viewer.setDisplay({ lineStyle: 'none', outline: false, measures: false });
viewer.scene.add(axes);
const cases = get<HTMLSelectElement>('inspect-case'), controls = get<HTMLSelectElement>('inspect-control');
const disabled = get<HTMLSelectElement>('inspect-disable'), amount = get<HTMLInputElement>('inspect-amount');
cases.replaceChildren(...BODY_CASES.map(c => new Option(c.id, c.id)));
disabled.replaceChildren(...SOFT_KEYS.map(k => new Option(k, k)));
let input: ReturnType<typeof bodyInputFor>, current: ReturnType<BodyEngine['run']>;
let bindings: ReturnType<BodyEngine['rings']['inspectControls']>;
let serial = 0;

function solve() {
  const c = BODY_CASES.find(c => c.id === cases.value)!;
  const bustDiff = c.cup ? cupDiff(c.cup) ?? null : null;
  input = bodyInputFor({ sex: c.sex, sug: suggest({ sex: c.sex, locked: c.locked, bustDiff }),
    bustDiff, morphology: c.morphology, muscleMass: c.muscleMass });
  current = engine.run({ ...input, armAngle: 0 });
  engine.rings.inspectSolved();
  bindings = engine.rings.inspectControls(input);
  controls.replaceChildren(...bindings.surface.map(c => new Option(c.id, c.id)));
  if (c.sex === 'female') bindings.breast.forEach((_, i) => controls.append(new Option(`乳房附著 ${i + 1}`, `breast:${i}`)));
  reset();
}

function reset() {
  amount.value = '0'; for (const o of disabled.options) o.selected = false; draw();
}

function draw() {
  const breast = controls.value.startsWith('breast:');
  amount.disabled = breast;
  const off = [...disabled.selectedOptions].map(o => o.value as SoftKey);
  const value = breast ? 0 : Math.max(-0.5, Math.min(1, Number(amount.value) || 0));
  const c = bindings.surface.find(c => c.id === controls.value);
  // 乳房選項顯示完整附著權重；三胸型的數值驅動由實際案例選單檢查。
  const result = c ? engine.rings.inspectControl(c.id, value, off) : null;
  const P = result?.P ?? engine.rings.inspectSolved(off);
  bindings = engine.rings.inspectControls(input);
  viewer.setShape({ ...current, positions: P.slice(0, asset.nBody * 3), guides: [], tapes: {} }, result?.values ?? current.values);
  const weights = new Float32Array(asset.nBody);
  if (c) c.vertices.forEach((vertex, row) => { weights[vertex] = c.weights[row]; });
  else weights.set(bindings.breast[Number(controls.value.split(':')[1])].weights);
  const heat = get<HTMLInputElement>('inspect-heat').checked;
  if (heat) viewer.body.group.traverse(obj => {
    if (!(obj instanceof THREE.Mesh) || !(obj.material instanceof THREE.MeshStandardMaterial)
      || obj.geometry.getAttribute('position').count !== asset.nBody) return;
    const colors = new Float32Array(asset.nBody * 3);
    weights.forEach((w, i) => { colors[i * 3] = w; colors[i * 3 + 1] = 0.15 + 0.7 * Math.sin(Math.PI * w); colors[i * 3 + 2] = 1 - w; });
    obj.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  });
  for (const child of [...axes.children]) {
    child.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { o.geometry.dispose(); const materials = Array.isArray(o.material) ? o.material : [o.material]; materials.forEach(m => m.dispose()); } });
    axes.remove(child);
  }
  const frame = c ? bindings.frames[c.parent] : undefined;
  if (heat && frame && c) {
    const origin = new THREE.Vector3(...toWorld(frame, c.origin));
    frame.axes.forEach((axis, i) => {
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(...axis), origin, 12, [0xff3333, 0x33cc33, 0x3388ff][i], 2, 1);
      // 內部骨點仍須可見，方便核對父軸與支撐位置。
      arrow.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { const materials = Array.isArray(o.material) ? o.material : [o.material]; materials.forEach(m => { m.depthTest = false; }); o.renderOrder = 10; } });
      axes.add(arrow);
    });
  }
  const report = { case: cases.value, control: controls.value, amount: value, disabled: off,
    parent: c?.parent, frame, origin: c?.origin, boundary: c?.boundary,
    affectedVertices: weights.filter(w => w > 0).length, maxWeight: Math.max(...weights),
    response: result ? { volumeCm3: result.volume - current.volume,
      girthCm: Object.fromEntries(Object.entries(result.values).map(([k, v]) => [k, v - current.values[k as keyof typeof current.values]])) } : null,
    actualInput: BODY_CASES.find(c => c.id === cases.value), actualResidual: current.residual,
    tissues: current.tissues, diagnostics: current.diagnostics };
  get('inspect-data').textContent = JSON.stringify(report, null, 2);
  host.dataset.serial = String(++serial);
  viewer.setView('quarter', false);
}
cases.addEventListener('change', solve);
for (const el of [controls, disabled, amount, get('inspect-heat')]) el.addEventListener('change', draw);
get('inspect-reset').addEventListener('click', reset);
get('inspect-views').querySelectorAll<HTMLButtonElement>('button').forEach(b => b.addEventListener('click', () => viewer.setView(b.dataset.view as ViewName, false)));
solve();
