// 自身案例的四視圖驗收；只使用 Node、系統 Chrome 與既有 Vite，不新增套件。
// 輸出必須在倉庫外；CI 將 PNG／量測結果保存為 artifact，圖片不進 Git。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'vite';

const [output, ...selected] = process.argv.slice(2);
if (!output) throw new Error('用法：node tools/body-visual.mjs <倉庫外目錄> [案例 ID ... 或 all]');
const root = process.cwd(), dest = path.resolve(output), relative = path.relative(root, dest);
if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('驗收產物必須放在倉庫外');
const chromes = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter((name) => {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; } catch { return false; }
});
if (!chromes.length) throw new Error('需要系統 Chromium 或 Google Chrome');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, message, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await pause(150); }
  throw new Error(message);
};
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bodyref-visual-'));
const server = await createServer({ cacheDir: path.join(temp, 'vite'), server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser, socket;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const { BODY_CASES } = await server.ssrLoadModule('/tests/fixtures/bodyCases.ts');
  const representative = ['CUP-E-90', 'CUP-E-95', 'CUP-E-100', 'CUP-E-W50', 'PRESET-f-avg', 'PRESET-m-avg', 'PRESET-f-long', 'T2', 'T4', 'T7-weight120', 'H114', 'H130', 'T5-125', 'CUP-S', 'F-SHAPE-BF18', 'F-SHAPE-BF35', 'M-CHEST-M30', 'M-CHEST-M45', 'M-H115', 'LOCK-W80', 'F-M43-AUTO-W'];
  const ids = selected[0] === 'all' ? [...new Set([...representative, ...BODY_CASES.map((c) => c.id)])]
    : selected.length ? selected : representative;
  const cases = ids.map((id) => {
    const c = BODY_CASES.find((c) => c.id === id); if (!c) throw new Error(`未知案例：${id}`); return c;
  });
  let debugPort; const startupErrors = [];
  // Ubuntu 的 chromium 可能只是無法在 runner 執行的 snap 啟動器；優先完整 Chrome，失敗再試其他候選。
  for (const [index, chrome] of chromes.entries()) {
    const profile = path.join(temp, `profile-${index}`);
    let stderr = '', launchError;
    browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-3000); });
    browser.on('error', (error) => { launchError = error.message; });
    try {
      debugPort = await until(async () => {
        if (launchError || browser.exitCode !== null) throw new Error(launchError ?? `程序結束 ${browser.exitCode}`);
        try { return (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return null; }
      }, `${chrome} 啟動逾時`, 30000);
      break;
    } catch (error) {
      startupErrors.push(`${chrome}: ${error.message}\n${stderr}`);
      if (browser.exitCode === null) browser.kill();
    }
  }
  if (!debugPort) throw new Error(`Chrome 無法啟動：${startupErrors.join('\n')}`);
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let serial = 0; const pending = new Map(), errors = [];
  socket.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const promise = pending.get(m.id); pending.delete(m.id); if (m.error) promise?.reject(new Error(m.error.message)); else promise?.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 逾時`)); }, 30000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__bodySearch=location.search;window.__bodyResults=[];const W=window.Worker;window.Worker=class extends W{constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data?.type==='result'){const o=e.data.output;window.__bodyResults.push({values:o.values,weight:o.weight,bodyFat:o.bodyFat,muscleRate:o.muscleRate,tissueMass:o.tissueMass,residual:o.residual,finite:o.positions.every(Number.isFinite)})}})}};` });
  await fs.mkdir(dest, { recursive: true }); const report = [];
  for (const c of cases) {
    errors.length = 0;
    const code = Buffer.from(JSON.stringify({ sex: c.sex, locked: c.locked, cup: c.cup ?? null, ratios: c.ratios ?? {} })).toString('base64url');
    await evaluate('window.__bodySearch=null;window.__bodyResults=[]');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?b=${code}` });
    await until(async () => {
      try { return await evaluate(`window.__bodySearch === ${JSON.stringify('?b=' + code)} && window.__bodyResults?.length > 0 && document.querySelector("#stage-status")?.hidden`); }
      catch (e) { if (/context|navigat/i.test(e.message)) return false; throw e; }
    }, `${c.id} 求解逾時`);
    const out = await evaluate('window.__bodyResults.at(-1)');
    if (errors.length || !out.finite || out.residual.some(({ goal, error }) => Math.abs(error) >= (['bodyFat', 'muscleRate'].includes(goal.kind) ? 0.01 : 0.5))) throw new Error(`${c.id} UI 驗收失敗：${JSON.stringify({ errors, out })}`);
    if (await evaluate('document.querySelectorAll(".ratio-prefix").length') !== 4) throw new Error('比例欄位缺少 1 : 前綴');
    for (const view of ['front', 'side', 'back', 'rear-quarter']) {
      await evaluate(`document.querySelector('[data-view="${view === 'rear-quarter' ? 'back' : view}"]').click()`);
      if (view === 'rear-quarter') {
        const box = await evaluate('(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
        const x = box.x + box.width * 0.6, y = box.y + box.height * 0.42;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - box.height / 8, y, buttons: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - box.height / 8, y, button: 'left', buttons: 0, clickCount: 1 });
      }
      await pause(view === 'rear-quarter' ? 600 : 200);
      const clip = await evaluate('(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()');
      const shot = await send('Page.captureScreenshot', { format: 'png', clip });
      await fs.writeFile(path.join(dest, `${c.id}_${view}.png`), Buffer.from(shot.data, 'base64'));
    }
    // 另存無結構線、無皮尺的斜前視角，避免橫向疊線遮住胸部與臀下曲線。
    await evaluate(`document.querySelector('#display-bar [data-value="none"]').click();const measure=[...document.querySelectorAll('#display-bar button')].find(b=>b.textContent==='量測線');if(measure.getAttribute('aria-pressed')==='true')measure.click();document.querySelector('[data-view="quarter"]').click();`);
    await pause(250);
    const cleanClip = await evaluate('(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()');
    const clean = await send('Page.captureScreenshot', { format: 'png', clip: cleanClip });
    await fs.writeFile(path.join(dest, `${c.id}_quarter-clean.png`), Buffer.from(clean.data, 'base64'));
    await evaluate(`document.querySelector('[data-view="back"]').click()`);
    const cleanX = cleanClip.x + cleanClip.width * 0.6, cleanY = cleanClip.y + cleanClip.height * 0.42;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cleanX, y: cleanY });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cleanX, y: cleanY, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cleanX - cleanClip.height / 8, y: cleanY, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cleanX - cleanClip.height / 8, y: cleanY, button: 'left', buttons: 0, clickCount: 1 });
    await pause(500);
    const cleanRear = await send('Page.captureScreenshot', { format: 'png', clip: cleanClip });
    await fs.writeFile(path.join(dest, `${c.id}_rear-quarter-clean.png`), Buffer.from(cleanRear.data, 'base64'));
    if (c.id === 'PRESET-f-long') {
      const change = async (id, value) => {
        const count = await evaluate('window.__bodyResults.length');
        await evaluate(`(()=>{const n=document.getElementById(${JSON.stringify('n-' + id)});n.value=${JSON.stringify(String(value))};n.dispatchEvent(new Event('input',{bubbles:true}));n.blur()})()`);
        await until(() => evaluate(`window.__bodyResults.length>${count}&&document.querySelector('#stage-status').hidden`), `${id} 比例操作逾時`);
        return evaluate('window.__bodyResults.at(-1)');
      };
      const legs = await change('legRatio', 0.47);
      if (Math.abs((legs.values.thighLen + legs.values.calfLen) / legs.values.height + 0.042 - 0.47) > 0.005) throw new Error('腿長比未驅動實際長度');
      const count = await evaluate('window.__bodyResults.length');
      await evaluate(`document.querySelector('[data-var="legRatio"] .field-reset').click()`);
      await until(() => evaluate(`window.__bodyResults.length>${count}&&document.querySelector('#stage-status').hidden`), '比例解除逾時');
      if (await evaluate(`document.querySelector('[data-var="legRatio"] .tag').textContent`) !== '推算') throw new Error('比例未恢復推算');
      const arms = await change('armRatio', 0.36), split = await change('upperFore', 0.8);
      if (Math.abs((arms.values.upperArmLen + arms.values.forearmLen) / arms.values.height - 0.36) > 0.005
        || Math.abs(split.values.forearmLen / split.values.upperArmLen - 0.8) > 0.03) throw new Error('手臂比值方向錯誤');
      const manual = await change('forearmLen', 27);
      if (Math.abs(manual.values.forearmLen - 27) > 0.5 || await evaluate(`['armRatio','upperFore'].some(id=>document.querySelector('[data-var="'+id+'"] .tag').textContent!=='推算')`)) throw new Error('手動長度未解除比例');
      await fs.writeFile(path.join(dest, 'ratio-interaction.json'), JSON.stringify({ status: 'PASS', legs: legs.values, arms: arms.values, split: split.values, manual: manual.values }, null, 2));
    }
    if (errors.length) throw new Error(`${c.id} 瀏覽器錯誤：${errors.join(', ')}`);
    report.push({ id: c.id, ...out });
    await fs.writeFile(path.join(dest, 'checks.json'), JSON.stringify(report, null, 2));
    console.log(`${c.id}: 已保存四視圖與無疊線前後斜視，手動條件符合；外型需另行檢視`);
  }
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); browser.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  await server.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
