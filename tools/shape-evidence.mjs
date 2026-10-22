// 同快照的數值、多視角與渲染證據；所有產物只寫入倉庫外。
// node tools/shape-evidence.mjs /absolute/output [案例 ID ...]
// BODYREF_RENDERER_ROOT 可讓舊引擎使用同版渲染器作基準對照。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const [output, ...selected] = process.argv.slice(2);
if (!output) throw new Error('請指定倉庫外輸出目錄及可選的案例 ID');
const root = process.cwd(), dest = path.resolve(output), rendererRoot = process.env.BODYREF_RENDERER_ROOT ?? root;
const relative = path.relative(root, dest);
if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('產物必須在倉庫外');
const git = async (...args) => (await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
const files = (await git('ls-files', '--cached', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean).sort();
const fingerprint = (modelOnly = false) => {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    if (modelOnly && !file.startsWith('src/body/') && !file.startsWith('src/core/') && file !== 'public/body.bin') continue;
    if (!fs.existsSync(file)) continue; hash.update(file); hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
};
const snapshot = { commit: await git('rev-parse', 'HEAD'), treeSha256: fingerprint(), modelSha256: fingerprint(true),
  assetSha256: crypto.createHash('sha256').update(fs.readFileSync('public/body.bin')).digest('hex'), rendererRoot,
  measurement: '量法以本次引擎輸出為準；基準保留其原量法，不能混稱同量法達標' };
// 靜態離線驗證頁：不啟動監聽埠、不連外，截圖不需要額外網路權限。
fs.mkdirSync(dest, { recursive: true });
const bundle = await build({ stdin: { contents: `
  import { Viewer } from ${JSON.stringify(path.join(rendererRoot, 'src/view/viewer.ts'))};
  import { parseBodyAsset } from ${JSON.stringify(path.join(root, 'src/body/mh/asset.ts'))};
  import { BodyEngine } from ${JSON.stringify(path.join(root, 'src/body/mh/engine.ts'))};
  import { bodyInputFor } from ${JSON.stringify(path.join(root, 'src/body/goals.ts'))};
  import { suggest } from ${JSON.stringify(path.join(root, 'src/core/linkage.ts'))};
  import { cupDiff } from ${JSON.stringify(path.join(root, 'src/core/reference.ts'))};
  import { measureContext } from ${JSON.stringify(path.join(root, 'src/body/mh/measure.ts'))};
  import * as geometry from ${JSON.stringify(path.join(root, 'src/body/mh/geometry.ts'))};
  import { BODY_CASES } from ${JSON.stringify(path.join(root, 'tests/fixtures/bodyCases.ts'))};
  const raw = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync('public/body.bin').toString('base64'))}), c => c.charCodeAt(0));
  const asset = parseBodyAsset(raw.buffer);
  document.documentElement.dataset.theme = 'light';
  const viewer = new Viewer(document.getElementById('evidence-stage'));
  viewer.setTopology(asset); viewer.setDisplay({ lineStyle: 'none', outline: false, measures: false });
  window.__shapeEvidence = { viewer, engine: new BodyEngine(asset), bodyInputFor, suggest, cupDiff, geometry, ctx: measureContext(asset), asset, cases: BODY_CASES };
`, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', platform: 'browser', write: false });
const harness = path.join(dest, '__harness.html');
fs.writeFileSync(harness, '<!doctype html><html><head><meta charset="utf-8"><style>' + fs.readFileSync(path.join(rendererRoot, 'src/styles.css'), 'utf8') + '</style></head><body><div id="evidence-stage" style="position:fixed;inset:0"></div><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\/script') + '</script></body></html>');
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BODYREF_CHROMIUM || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => { throw error; });
  await page.goto(pathToFileURL(harness).href);
  const allCases = await page.evaluate(() => window.__shapeEvidence.cases);
  const cases = allCases.filter(c => !selected.length || selected.includes(c.id));
  if (selected.some(id => !cases.some(c => c.id === id))) throw new Error('有未知的案例 ID');
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
      return { modelInput: { frame: input.frame, weight: input.weight, bodyFat: input.bodyFat,
        weightLocked: input.weightLocked, bodyFatLocked: input.bodyFatLocked, preferred: input.preferred },
        values: out.values, residual: out.residual, tissues: out.tissues, accounting: out.accounting, measurement: out.measurement, weight: out.weight, bodyFat: out.bodyFat, volume: out.volume, ms, diagnostics: out.diagnostics, sections };
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
    console.log(`${c.id}: ${result.ms.toFixed(0)} ms; ${result.diagnostics?.length ?? '未提供'} 診斷`);
  }
  const views = ['front', 'quarter', 'side', 'rearQuarter', 'back', 'quarter-light', 'rearQuarter-light', 'chest-detail', 'hip-detail'];
  fs.writeFileSync(path.join(dest, 'index.html'), `<!doctype html><meta charset="utf-8"><title>BodyRef 形狀證據</title><style>body{font-family:system-ui;margin:24px;background:#eee}img{width:220px;max-width:100%}figure{margin:0}section{margin:30px 0}.views{display:flex;flex-wrap:wrap;gap:8px}pre{white-space:pre-wrap}</style><h1>BodyRef 形狀證據</h1><pre>${JSON.stringify(snapshot, null, 2)}</pre>${results.map(r => `<section><h2>${r.id}</h2><p>${r.weight.toFixed(2)} kg・${(r.bodyFat * 100).toFixed(1)}%・診斷 ${r.diagnostics?.length ?? '未提供'}</p><div class="views">${views.map(v => `<figure><a href="${r.id}-${v}.png"><img loading="lazy" src="${r.id}-${v}.png"></a><figcaption>${v}</figcaption></figure>`).join('')}</div></section>`).join('')}<p>完整殘差、組成與每 2 cm 中性截面見 report.json。</p>`);
  if (snapshot.treeSha256 !== fingerprint()) throw new Error('產出途中來源有變動；這份證據不可作同版本驗收');
} finally { await browser?.close(); fs.rmSync(harness, { force: true }); }
