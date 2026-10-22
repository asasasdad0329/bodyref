// 基準／候選用相同案例、同一台機器串行量測；兩版各用獨立程序，避免共用 JIT 狀態。
// node tools/performance-regression.mjs <基準工作樹> <倉庫外輸出目錄>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'vite';
import { transform } from 'esbuild';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
if (args[0] !== '--run') {
  const [baseline, output] = args;
  if (!baseline || !output) throw new Error('請指定基準工作樹和倉庫外輸出目錄');
  const candidate = process.cwd(), dest = path.resolve(output), relative = path.relative(candidate, dest);
  if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('產物必須在倉庫外');
  fs.mkdirSync(dest, { recursive: true });
  const code = await transform(fs.readFileSync('tests/fixtures/bodyCases.ts', 'utf8'), { loader: 'ts', format: 'esm' });
  const { BODY_CASES } = await import('data:text/javascript;base64,' + Buffer.from(code.code).toString('base64'));
  const cases = BODY_CASES.filter(c => /^(T\d|H\d|UA-|BF\d|W\d|CUP-)/.test(c.id));
  const caseFile = path.join(dest, 'cases.json'); fs.writeFileSync(caseFile, JSON.stringify(cases));
  const script = fileURLToPath(import.meta.url);
  for (const [name, root] of [['baseline', path.resolve(baseline)], ['candidate', candidate]]) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--run', root, caseFile, path.join(dest, `${name}.json`)], { stdio: 'inherit' });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${name} 效能量測失敗：${code}`)));
    });
  }
  const base = JSON.parse(fs.readFileSync(path.join(dest, 'baseline.json'))), current = JSON.parse(fs.readFileSync(path.join(dest, 'candidate.json')));
  const ratios = Object.fromEntries(['coldMs', 'warmMs'].map(k => [k,
    Object.fromEntries(['median', 'p95'].map(s => [s, current.stats[k][s] / base.stats[k][s]]))]));
  const passed = Object.values(ratios).every(row => Object.values(row).every(v => v <= 1.2));
  fs.writeFileSync(path.join(dest, 'comparison.json'), JSON.stringify({ passed, budget: 1.2, ratios }, null, 2));
  console.log(JSON.stringify({ passed, ratios }));
  if (!passed) process.exitCode = 1;
} else {
  const [, root, caseFile, output] = args;
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
    .filter(f => f.startsWith('src/') || f === 'public/body.bin').sort();
  const fingerprint = () => {
    const h = crypto.createHash('sha256');
    for (const f of files) { h.update(f); h.update(fs.readFileSync(path.join(root, f))); }
    return h.digest('hex');
  };
  const snapshot = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    modelSha256: fingerprint(), casesSha256: hash(fs.readFileSync(caseFile)), node: process.version,
    cpu: os.cpus()[0].model, platform: `${os.platform()} ${os.arch()}`,
    coldDefinition: '每例新引擎，包含建構；同一程序依序執行案例，非每例重啟程序',
    warmDefinition: '先改上臂硬條件，再回原輸入；相同輸入快取另記' };
  const server = await createServer({ root, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { BodyEngine } = await server.ssrLoadModule('/src/body/mh/engine.ts');
    const { parseBodyAsset } = await server.ssrLoadModule('/src/body/mh/asset.ts');
    const { bodyInputFor } = await server.ssrLoadModule('/src/body/goals.ts');
    const { suggest } = await server.ssrLoadModule('/src/core/linkage.ts');
    const { cupDiff } = await server.ssrLoadModule('/src/core/reference.ts');
    const buf = fs.readFileSync(path.join(root, 'public/body.bin'));
    const asset = parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), results = [];
    for (const c of JSON.parse(fs.readFileSync(caseFile))) {
      const bustDiff = c.cup ? cupDiff(c.cup) : null;
      const input = { ...bodyInputFor({ sex: c.sex, sug: suggest({ sex: c.sex, locked: c.locked, bustDiff }), bustDiff }), armAngle: 16 };
      const start = performance.now(), engine = new BodyEngine(asset), initMs = performance.now() - start;
      const out = engine.run(input), coldMs = performance.now() - start;
      let t = performance.now(); engine.run(input); const cachedMs = performance.now() - t;
      const preferred = { ...input.preferred }; delete preferred.upperArm;
      const changed = engine.run({ ...input, locked: { ...input.locked, upperArm: out.values.upperArm + 0.3 }, preferred, estimateReference: false });
      if (Math.abs(changed.values.upperArm - out.values.upperArm) < 0.01) throw new Error(`${c.id} 中間操作未改變實際尺寸`);
      t = performance.now(); const again = engine.run(input); const warmMs = performance.now() - t;
      if (Math.abs(again.weight - out.weight) > 0.01) throw new Error(`${c.id} 重算結果不一致`);
      results.push({ id: c.id, initMs, coldMs, warmMs, cachedMs, weight: out.weight, diagnostics: out.diagnostics });
      fs.writeFileSync(output, JSON.stringify({ snapshot, results }, null, 2));
      console.log(`${path.basename(root)} ${c.id}: ${Math.round(coldMs)} / ${Math.round(warmMs)} ms`);
    }
    if (snapshot.modelSha256 !== fingerprint()) throw new Error('量測期間來源改變');
    const stats = Object.fromEntries(['initMs', 'coldMs', 'warmMs', 'cachedMs'].map(k => {
      const v = results.map(r => r[k]).sort((a, b) => a - b);
      return [k, { median: (v[Math.floor((v.length - 1) / 2)] + v[Math.ceil((v.length - 1) / 2)]) / 2, p95: v[Math.ceil(v.length * 0.95) - 1] }];
    }));
    fs.writeFileSync(output, JSON.stringify({ snapshot, stats, results }, null, 2));
  } finally { await server.close(); }
}
