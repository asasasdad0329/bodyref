import * as THREE from 'three';
import './shapeLab.css';
import { loadBodyAsset } from '../body/mh/asset';
import { BodyModel } from '../body/mh/model';
import { type HipMode, type ShapePose } from '../body/mh/shapeControls';
import { makeShapeBaseline, SHAPE_BASELINES } from './shapeBaseline';

// 獨立驗收頁，不寫入正式人台的分享資料、瀏覽器狀態或公斤分配。
const root = document.getElementById('shape-lab')!;
async function start() {
  const params = new URLSearchParams(location.search);
  const asset = await loadBodyAsset(`${import.meta.env.BASE_URL}body.bin`);
  const model = new BodyModel(asset);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0xedece8);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8c94, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2);
  scene.add(key);
  const geometry = new THREE.BufferGeometry();
  const triangles: number[] = [];
  for (let f = 0; f < asset.quads.length; f += 4) {
    const [a, b, c, d] = asset.quads.subarray(f, f + 4);
    triangles.push(a, b, c, a, c, d);
  }
  geometry.setIndex(triangles);
  const material = new THREE.MeshStandardMaterial({ color: 0xf9f6f0, roughness: 0.9, vertexColors: true });
  scene.add(new THREE.Mesh(geometry, material));
  const markers = new THREE.Group();
  scene.add(markers);
  const initialBaseline = SHAPE_BASELINES.find((b) => b.id === params.get('baseline')) ?? SHAPE_BASELINES[0];
  let rig = makeShapeBaseline(asset, initialBaseline);
  let pose: ShapePose = {};
  let amount = 0;
  let fitStatus = '';
  root.innerHTML = `<header><div><a href="./">BodyRef</a><h1>腰腹・臀腿控制原型</h1><p>上排為固定基準，下排為目前形變。五個視角使用相同比例尺；預設關閉疊線。</p></div><button id="download">下載對照圖</button><button id="report">下載控制與量測</button></header>
    <section class="controls" aria-label="造型控制">
      <label>基準體型<select id="baseline"></select></label>
      <label>控制模式<select id="mode"><option value="muscle">臀肌模式</option><option value="fat">脂肪覆蓋模式</option><option value="single">單一控制</option></select></label>
      <label>局部控制<select id="control"></select></label>
      <label>控制振幅（cm）<input id="amount" type="range" min="0" max="8" step="0.1" value="0"><output id="amount-value">0.0</output></label>
      <label>目標臀圍（cm）<input id="target" type="number" step="1"></label>
      <label class="check"><input id="fixed" type="checkbox">限制大腿圍誤差 &lt; 0.5 cm</label>
      <button id="fit">對準臀圍</button><button id="reset">回到中性</button>
      <label class="check"><input id="heat" type="checkbox">權重熱圖</label><label class="check"><input id="markers" type="checkbox">控制位置／局部軸</label>
    </section>
    <p class="note">這是待外型驗收的造型原型。肌脂模式為表面分布對照，尚未連接公斤預算；超出控制範圍會顯示殘差。中性控制重現撤銷三步後的基準，尚未新增修型基準。</p>
    <p id="metrics" role="status"></p><div class="views"><span>正面</span><span>前斜視</span><span>側面</span><span>後斜視</span><span>背面</span></div><div id="canvas"></div>
    <p class="legend">上排：固定基準　／　下排：目前形變　　熱圖：深藍 0 → 青 → 黃 → 紅 1（絕對權重）</p>
    <details><summary>控制配置、自由度與交界規格</summary><div id="spec"></div></details>`;
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const select = el<HTMLSelectElement>('control');
  const modeSelect = el<HTMLSelectElement>('mode');
  const slider = el<HTMLInputElement>('amount');
  const heat = el<HTMLInputElement>('heat');
  const showMarkers = el<HTMLInputElement>('markers');
  const baseline = el<HTMLSelectElement>('baseline');
  for (const c of SHAPE_BASELINES) baseline.add(new Option(c.label, c.id));
  baseline.value = initialBaseline.id;
  el('canvas').append(renderer.domElement);
  const refreshControls = () => {
    select.replaceChildren(...rig.controls.map((c) => new Option(c.label, c.id)));
    slider.max = String(8 * rig.scale);
    el<HTMLInputElement>('target').value = String(Math.round(rig.baselineResult.measured.values.hip + 2));
    el('spec').innerHTML = `<table><thead><tr><th>控制</th><th>父參照</th><th>位置 x,y,z（cm）</th><th>位移方向（外側／上／前）</th><th>範圍（cm）</th></tr></thead><tbody>${rig.controls.map((c) => `<tr><td>${c.label}</td><td>${c.parent}</td><td>${c.origin.map((x) => x.toFixed(1)).join(', ')}</td><td>${[c.direction[0] * c.axes[0][0], c.direction[1], c.direction[2]].join(', ')}</td><td>${c.range.map((v) => v.toFixed(1)).join('～')}</td></tr>`).join('')}</tbody></table><p>局部軸：紅＝外側、綠＝上、藍＝前。支撐依 torso／thigh 拓撲與上下邊界界定；後中線及會陰漸弱。交界共享歸一化權重，單頂點總權重 ≤ 1；控制位置依本次骨架重建，造型不移動關節輔助點。</p>`;
  };
  refreshControls();
  const views = [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4, Math.PI];
  let current = rig.apply();
  function draw() {
    current = rig.apply(pose);
    const width = Math.max(650, el('canvas').clientWidth), height = Math.round(width * 0.49);
    renderer.setSize(width, height);
    const w = width / 5, h = height / 2;
    const weights = rig.controls.find((c) => c.id === select.value)!.weights;
    const colors = new Float32Array(asset.nBody * 3).fill(1);
    if (heat.checked) for (let i = 0; i < asset.nBody; i++) {
      const c = new THREE.Color().setHSL((1 - weights[i]) * 0.68, 0.95, 0.48);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    material.color.set(heat.checked ? 0xffffff : 0xf9f6f0);
    for (const child of [...markers.children]) {
      markers.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) mat.dispose();
      }
    }
    if (showMarkers.checked) for (const c of rig.controls) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.45 * rig.scale), new THREE.MeshBasicMaterial({ color: c.id === select.value ? 0xffa500 : 0x175c66, depthTest: false }));
      dot.position.fromArray(c.origin);
      dot.renderOrder = 2;
      markers.add(dot);
      c.axes.forEach((axis, index) => {
        const end = c.origin.map((v, k) => v + axis[k] * 3 * rig.scale);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...c.origin), new THREE.Vector3(...end)]), new THREE.LineBasicMaterial({ color: [0xda4848, 0x29a36e, 0x3476e8][index], depthTest: false }));
        line.renderOrder = 2;
        markers.add(line);
      });
    }
    renderer.setScissorTest(true);
    for (let row = 0; row < 2; row++) {
      // 抬手以露出腰側與臀側，兩排使用同一姿勢；數值仍量中性網格。
      const P = model.display(row ? current.positions : rig.baseline, 60).P.subarray(0, asset.nBody * 3);
      geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const halfH = 30 * rig.scale, halfW = halfH * w / h;
      for (let col = 0; col < 5; col++) {
        const angle = views[col], cy = rig.baselineResult.measured.marks.crotchY + 15 * rig.scale;
        const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 1, 1500);
        cam.position.set(Math.sin(angle) * 500, cy, Math.cos(angle) * 500);
        cam.lookAt(0, cy, 0);
        key.position.set(Math.sin(angle + 0.6) * 200, cy + 150, Math.cos(angle + 0.6) * 200);
        renderer.setViewport(col * w, row ? 0 : h, w, h);
        renderer.setScissor(col * w, row ? 0 : h, w, h);
        renderer.render(scene, cam);
      }
    }
    renderer.setScissorTest(false);
    const a = rig.baselineResult.measured.values, b = current.measured.values;
    el('metrics').textContent = ['waist', 'hip', 'thigh'].map((k) => {
      const id = k as 'waist' | 'hip' | 'thigh';
      return `${({ waist: '腰', hip: '臀', thigh: '大腿' })[id]} ${a[id].toFixed(2)} → ${b[id].toFixed(2)} cm`;
    }).join('　') + `　體積差 ${((current.volume - rig.baselineResult.volume) / 1000).toFixed(3)} L　${fitStatus}`;
    el('amount-value').textContent = amount.toFixed(1);
    root.dataset.ready = 'true';
  }
  function updatePose() {
    fitStatus = '';
    slider.min = modeSelect.value === 'single' ? String(rig.controls.find((c) => c.id === select.value)!.range[0]) : '0';
    amount = Number(slider.value);
    pose = modeSelect.value === 'single' ? { [select.value]: amount } : rig.hipPose(modeSelect.value as HipMode, amount);
    draw();
  }
  for (const input of [modeSelect, slider]) input.addEventListener('input', updatePose);
  for (const input of [select, heat, showMarkers]) input.addEventListener('input', () => modeSelect.value === 'single' ? updatePose() : draw());
  baseline.addEventListener('change', () => {
    root.dataset.ready = 'false';
    // 先讓載入狀態畫出來；基準求解與正式介面隔離。
    requestAnimationFrame(() => {
      rig = makeShapeBaseline(asset, SHAPE_BASELINES.find((b) => b.id === baseline.value)!);
      refreshControls();
      slider.value = '0';
      updatePose();
    });
  });
  el('reset').onclick = () => { slider.value = '0'; updatePose(); };
  el('fit').onclick = () => {
    if (modeSelect.value === 'single') { fitStatus = '請選擇臀肌或脂肪聯動模式'; draw(); return; }
    const target = el<HTMLInputElement>('target').valueAsNumber;
    if (!Number.isFinite(target) || target <= 0) { fitStatus = '請輸入正數臀圍'; draw(); return; }
    const fitted = rig.fitHip(modeSelect.value as HipMode, target, el<HTMLInputElement>('fixed').checked);
    pose = fitted.pose;
    amount = Math.max(0, ...Object.values(pose));
    slider.value = String(amount);
    fitStatus = `${fitted.reached ? '尺寸在原型容許誤差內，外型待驗收' : '未達標，須調整控制模式'}（臀圍殘差 ${fitted.error.toFixed(2)} cm）`;
    draw();
  };
  const download = (url: string, name: string) => { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); };
  el('download').onclick = () => {
    // 匯出的圖本身保留視角、排次與尺寸，不必依賴驗收頁旁的文字才能閱讀。
    const canvas = document.createElement('canvas');
    canvas.width = renderer.domElement.width;
    canvas.height = renderer.domElement.height + 110;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f6f5f1'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#25333c'; ctx.font = '18px system-ui';
    ctx.fillText(`${baseline.selectedOptions[0].textContent}　上排：固定基準／下排：目前形變　${modeSelect.selectedOptions[0].textContent}`, 16, 28);
    ctx.font = '14px system-ui';
    ctx.fillText(el('metrics').textContent!, 16, 54);
    ['正面', '前斜視', '側面', '後斜視', '背面'].forEach((label, i) => ctx.fillText(label, canvas.width * (i + 0.5) / 5 - 20, 83));
    ctx.drawImage(renderer.domElement, 0, 100);
    download(canvas.toDataURL('image/png'), 'bodyref-shape-comparison.png');
  };
  el('report').onclick = () => {
    const data = { baseline: baseline.value, pose, baselineValues: rig.baselineResult.measured.values,
      values: current.measured.values, baselineVolume: rig.baselineResult.volume, volume: current.volume,
      references: rig.references, controls: rig.controls.map(({ weights, ...c }) => ({ ...c, weights: Array.from(weights) })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    download(url, 'bodyref-shape-controls.json');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  new ResizeObserver(draw).observe(el('canvas'));
  // 固定驗收連結可重現控制設定，與正式分享代碼分開。
  if (['muscle', 'fat', 'single'].includes(params.get('mode') ?? '')) modeSelect.value = params.get('mode')!;
  if (rig.controls.some((c) => c.id === params.get('control'))) select.value = params.get('control')!;
  slider.min = modeSelect.value === 'single' ? String(-rig.scale) : '0';
  const initialAmount = Number(params.get('amount') ?? 0);
  if (Number.isFinite(initialAmount)) slider.value = String(initialAmount);
  heat.checked = params.get('heat') === '1';
  showMarkers.checked = params.get('markers') === '1';
  el<HTMLInputElement>('fixed').checked = params.get('fixed') === '1';
  updatePose();
  const initialTarget = Number(params.get('target'));
  if (Number.isFinite(initialTarget) && initialTarget > 0) {
    el<HTMLInputElement>('target').value = String(initialTarget);
    el('fit').click();
  }
}
start().catch((error: unknown) => { root.textContent = `控制原型載入失敗：${error instanceof Error ? error.message : String(error)}`; });
