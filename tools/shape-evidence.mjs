// 同快照的數值、多視角與渲染證據；所有產物只寫入倉庫外。
// node tools/shape-evidence.mjs /absolute/output [案例 ID ...]
// BODYREF_RENDERER_ROOT 可讓舊引擎使用同版渲染器作基準對照。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const [output, ...selected] = process.argv.slice(2);
if (!output) throw new Error('請指定倉庫外輸出目錄及可選的案例 ID');
const root = process.cwd(), dest = path.resolve(output), rendererRoot = process.env.BODYREF_RENDERER_ROOT ?? root;
const relative = path.relative(root, dest);
if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('產物必須在倉庫外');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fingerprint = () => {
  const hash = crypto.createHash('sha256');
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort();
  for (const file of files) { if (!fs.existsSync(file)) continue; hash.update(file); hash.update(fs.readFileSync(file)); }
  return hash.digest('hex');
};
const snapshot = { commit: git('rev-parse', 'HEAD'), treeSha256: fingerprint(),
  assetSha256: crypto.createHash('sha256').update(fs.readFileSync('public/body.bin')).digest('hex'), rendererRoot,
  measurement: '中性最終曲面、放鬆上臂中點、胸壁下胸參照 v2；基準使用其原量法' };
const server = await createServer({ root, server: { port: 0, host: '127.0.0.1', hmr: false, fs: { allow: [root, rendererRoot] } },
  plugins: [{ name: 'evidence-frame', configureServer(s) {
    s.middlewares.use('/__shape_evidence', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="evidence-stage" style="position:fixed;inset:0"></div></body></html>'); });
  } }],
});
let browser;
try {
  const { BODY_CASES } = await server.ssrLoadModule('/tests/fixtures/bodyCases.ts');
  const cases = BODY_CASES.filter(c => !selected.length || selected.includes(c.id));
  if (selected.some(id => !cases.some(c => c.id === id))) throw new Error('有未知的案例 ID');
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ executablePath: process.env.BODYREF_CHROMIUM || undefined, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => { throw error; });
  await page.goto(`http://127.0.0.1:${address.port}/__shape_evidence`);
  await page.evaluate(async ({ rendererRoot }) => {
    await import(`/@fs${rendererRoot}/src/styles.css`);
    const { Viewer } = await import(`/@fs${rendererRoot}/src/view/viewer.ts`);
    const { loadBodyAsset } = await import('/src/body/mh/asset.ts');
    const { BodyEngine } = await import('/src/body/mh/engine.ts');
    const { bodyInputFor } = await import('/src/body/goals.ts');
    const { suggest } = await import('/src/core/linkage.ts');
    const { cupDiff } = await import('/src/core/reference.ts');
    const { measureContext } = await import('/src/body/mh/measure.ts');
    const geometry = await import('/src/body/mh/geometry.ts');
    document.documentElement.dataset.theme = 'light';
    const viewer = new Viewer(document.getElementById('evidence-stage'));
    const asset = await loadBodyAsset('/body.bin');
    viewer.setTopology(asset); viewer.setDisplay({ lineStyle: 'none', outline: false, measures: false });
    window.__shapeEvidence = { viewer, engine: new BodyEngine(asset), bodyInputFor, suggest, cupDiff, geometry, ctx: measureContext(asset), asset };
  }, { rendererRoot });
  const results = [];
  fs.mkdirSync(dest, { recursive: true });
  for (const c of cases) {
    const result = await page.evaluate(c => {
      const e = window.__shapeEvidence;
      const bustDiff = c.cup ? e.cupDiff(c.cup) : null;
      const sug = e.suggest({ sex: c.sex, locked: c.locked, bustDiff });
      const input = { ...e.bodyInputFor({ sex: c.sex, sug, bustDiff, morphology: c.morphology, muscleMass: c.muscleMass }), armAngle: 16 };
      const start = performance.now(), out = e.engine.run(input), ms = performance.now() - start;
      e.viewer.setShape(out, out.values);
      e.out = out;
      const neutral = e.engine.rings.inspectSolved ? e.engine.rings.inspectSolved() : null;
      const sections = [];
      if (neutral) for (let y = out.marks.crotchY - 4; y <= out.values.height * 0.79; y += 2) {
        const points = e.geometry.slice(neutral, e.asset.quads, e.ctx.faces.trunk, e.geometry.horizontal(y)).flat();
        if (points.length > 2) sections.push({ y, perimeter: e.geometry.tape(points, e.geometry.horizontal(y)).length,
          width: Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0])),
          depth: Math.max(...points.map(p => p[2])) - Math.min(...points.map(p => p[2])), points });
      }
      return { values: out.values, residual: out.residual, tissues: out.tissues, accounting: out.accounting, measurement: out.measurement, weight: out.weight, bodyFat: out.bodyFat, volume: out.volume, ms, diagnostics: out.diagnostics, sections };
    }, c);
    for (const view of ['front', 'quarter', 'side', 'rearQuarter', 'back']) {
      const png = await page.evaluate(view => {
        const e = window.__shapeEvidence; e.viewer.setView(view, false);
        return e.viewer.captureCurrent(1, true);
      }, view);
      fs.writeFileSync(path.join(dest, `${c.id}-${view}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    for (const view of ['quarter', 'rearQuarter']) {
      const png = await page.evaluate(view => {
        const v = window.__shapeEvidence.viewer; v.setView(view, false); v.setLightOffset(2.4);
        const png = v.captureCurrent(1, true); v.setLightOffset(0); return png;
      }, view);
      fs.writeFileSync(path.join(dest, `${c.id}-${view}-light.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    for (const region of ['chest', 'hip']) {
      const png = await page.evaluate(region => {
        const e = window.__shapeEvidence, v = e.viewer;
        v.setView(region === 'chest' ? 'quarter' : 'rearQuarter', false);
        const offset = v.camera.position.clone().sub(v.controls.target).multiplyScalar(0.45);
        const tape = e.out.tapes[region === 'chest' ? 'bust' : 'hip'];
        v.controls.target.set(0, tape ? tape.anchor[1] : e.out.values.height * 0.55, 0);
        v.camera.position.copy(v.controls.target).add(offset); v.controls.update();
        return v.captureCurrent(1, true);
      }, region);
      fs.writeFileSync(path.join(dest, `${c.id}-${region}-detail.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    results.push({ ...c, ...result });
    fs.writeFileSync(path.join(dest, 'report.json'), JSON.stringify({ snapshot, results }, null, 2));
    console.log(`${c.id}: ${result.ms.toFixed(0)} ms; ${result.diagnostics?.length ?? 0} 診斷`);
  }
  const views = ['front', 'quarter', 'side', 'rearQuarter', 'back', 'quarter-light', 'rearQuarter-light', 'chest-detail', 'hip-detail'];
  fs.writeFileSync(path.join(dest, 'index.html'), `<!doctype html><meta charset="utf-8"><title>BodyRef 形狀證據</title><style>body{font-family:system-ui;margin:24px;background:#eee}img{width:220px;max-width:100%}figure{margin:0}section{margin:30px 0}.views{display:flex;flex-wrap:wrap;gap:8px}pre{white-space:pre-wrap}</style><h1>BodyRef 形狀證據</h1><pre>${JSON.stringify(snapshot, null, 2)}</pre>${results.map(r => `<section><h2>${r.id}</h2><p>${r.weight.toFixed(2)} kg・${(r.bodyFat * 100).toFixed(1)}%・診斷 ${r.diagnostics?.length ?? 0}</p><div class="views">${views.map(v => `<figure><a href="${r.id}-${v}.png"><img loading="lazy" src="${r.id}-${v}.png"></a><figcaption>${v}</figcaption></figure>`).join('')}</div></section>`).join('')}<p>完整殘差、組成與每 2 cm 中性截面見 report.json。</p>`);
  if (snapshot.treeSha256 !== fingerprint()) throw new Error('產出途中來源有變動；這份證據不可作同版本驗收');
} finally { await browser?.close(); await server.close(); }
