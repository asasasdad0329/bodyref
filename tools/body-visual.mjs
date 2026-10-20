// 自身案例的四視圖驗收；只使用 Node、系統 Chrome 與既有 Vite，不新增套件。
// 輸出必須在倉庫外；CI 將 PNG／量測結果保存為 artifact，圖片不進 Git。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'vite';

const [output, ...selected] = process.argv.slice(2);
if (!output) throw new Error('用法：node tools/body-visual.mjs <倉庫外目錄> [案例 ID ...]');
const root = process.cwd(), dest = path.resolve(output), relative = path.relative(root, dest);
if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('驗收產物必須放在倉庫外');
const chrome = ['chromium', 'google-chrome', 'chromium-browser'].find((name) => {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; } catch { return false; }
});
if (!chrome) throw new Error('需要系統 Chromium 或 Google Chrome');
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
  const ids = selected.length ? selected : ['T2', 'T4', 'H130', 'T5-125', 'F-SHAPE-BF18', 'F-SHAPE-BF35', 'M-CHEST-M30', 'M-CHEST-M45', 'M-H115'];
  const cases = ids.map((id) => {
    const c = BODY_CASES.find((c) => c.id === id); if (!c) throw new Error(`未知案例：${id}`); return c;
  });
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${temp}/profile`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  browser.on('error', (error) => { process.exitCode = 1; console.error(error.message); });
  const debugPort = await until(async () => {
    try { return (await fs.readFile(path.join(temp, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return null; }
  }, 'Chrome 啟動逾時', 30000);
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
    const code = Buffer.from(JSON.stringify({ sex: c.sex, locked: c.locked, cup: c.cup ?? null, ratios: {} })).toString('base64url');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?b=${code}` });
    await until(async () => {
      try { return await evaluate(`window.__bodySearch === ${JSON.stringify('?b=' + code)} && window.__bodyResults?.length > 0 && document.querySelector("#stage-status")?.hidden`); }
      catch (e) { if (/context|navigat/i.test(e.message)) return false; throw e; }
    }, `${c.id} 求解逾時`);
    const out = await evaluate('window.__bodyResults.at(-1)');
    if (errors.length || !out.finite || out.residual.some(({ goal, error }) => Math.abs(error) >= (['bodyFat', 'muscleRate'].includes(goal.kind) ? 0.01 : 0.5))) throw new Error(`${c.id} UI 驗收失敗：${JSON.stringify({ errors, out })}`);
    for (const view of ['front', 'side', 'back', 'quarter']) {
      await evaluate(`document.querySelector('[data-view="${view}"]').click()`);
      await pause(200);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(dest, `${c.id}_${view}.png`), Buffer.from(shot.data, 'base64'));
    }
    report.push({ id: c.id, ...out });
    await fs.writeFile(path.join(dest, 'checks.json'), JSON.stringify(report, null, 2));
    console.log(`${c.id}: 四視圖與手動條件通過`);
  }
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); browser.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  await server.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
