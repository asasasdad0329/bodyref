// 維護用的數值回歸入口；產物寫到明確指定的倉庫外路徑。
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';

const [output, ...selected] = process.argv.slice(2);
if (!output) throw new Error('用法：node tools/body-regression.mjs <倉庫外輸出.json> [案例 ID ...]');
const root = process.cwd();
const dest = path.resolve(output);
const relative = path.relative(root, dest);
if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('回歸產物必須放在倉庫外');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fingerprint = () => {
  const hash = crypto.createHash('sha256');
  for (const file of git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort()) {
    if (fs.existsSync(file)) { hash.update(file); hash.update(fs.readFileSync(file)); }
  }
  return hash.digest('hex');
};
const snapshot = { commit: git('rev-parse', 'HEAD'), treeSha256: fingerprint(),
  assetSha256: crypto.createHash('sha256').update(fs.readFileSync('public/body.bin')).digest('hex'), measurementVersion: 2 };
const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { BodyEngine } = await server.ssrLoadModule('/src/body/mh/engine.ts');
  const { parseBodyAsset } = await server.ssrLoadModule('/src/body/mh/asset.ts');
  const { bodyInputFor } = await server.ssrLoadModule('/src/body/goals.ts');
  const { suggest } = await server.ssrLoadModule('/src/core/linkage.ts');
  const { cupDiff } = await server.ssrLoadModule('/src/core/reference.ts');
  const { BODY_CASES } = await server.ssrLoadModule('/tests/fixtures/bodyCases.ts');
  const buf = fs.readFileSync('public/body.bin');
  const asset = parseBodyAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const unknown = selected.filter((id) => !BODY_CASES.some((c) => c.id === id));
  if (unknown.length) throw new Error(`未知案例：${unknown.join(", ")}`);
  const results = [], failures = [];
  for (const c of BODY_CASES.filter((c) => !selected.length || selected.includes(c.id))) {
    const bustDiff = c.cup ? cupDiff(c.cup) : null;
    const sug = suggest({ sex: c.sex, locked: c.locked, bustDiff });
    const input = { ...bodyInputFor({ sex: c.sex, sug, bustDiff, morphology: c.morphology, muscleMass: c.muscleMass }), armAngle: 16 };
    const engine = new BodyEngine(asset);
    const started = performance.now();
    const out = engine.run(input);
    const coldMs = performance.now() - started;
    const cachedStarted = performance.now();
    engine.run(input);
    const cachedMs = performance.now() - cachedStarted;
    // 先改肩寬再回到原輸入，量真正沿用骨架校準的重算時間。
    engine.run({ ...input, frame: { ...input.frame, shoulder: input.frame.shoulder + 0.3 } });
    const warmStarted = performance.now();
    const again = engine.run(input);
    const warmMs = performance.now() - warmStarted;
    const row = { ...c, snapshot, suggestion: sug.values, range: sug.range, values: out.values, weight: out.weight,
      bodyFat: out.bodyFat, tissues: out.tissues, measurement: out.measurement, diagnostics: out.diagnostics, composition: out.composition, residual: out.residual, volume: out.volume,
      timing: { coldMs, warmMs, cachedMs }, repeat: { values: again.values, weight: again.weight, bodyFat: again.bodyFat } };
    const hardPass = out.residual.every(({ goal, error }) => Number.isFinite(error) && Math.abs(error) < (goal.kind === 'bodyFat' ? 0.01 : 0.5));
    const repeatPass = Object.keys(out.values).every((k) => Math.abs(out.values[k] - again.values[k]) < 0.01)
      && Math.abs(out.weight - again.weight) < 0.01 && Math.abs(out.bodyFat - again.bodyFat) < 0.0001;
    const geometryPass = out.positions.every(Number.isFinite) && out.head.positions.every(Number.isFinite);
    const ledgerPass = Object.values(out.tissues).every(x => Number.isFinite(x) && x >= 0)
      && Math.abs(Object.values(out.tissues).reduce((s, x) => s + x, 0) - out.weight) < 0.001
      && Math.abs((out.tissues.fat / 0.9 + (out.tissues.muscle + out.tissues.otherLean) / 1.06) * 1000 - out.volume) < 0.01;
    const diagnosed = !hardPass && c.allowUnconverged && out.diagnostics.some(d => d.kind === 'unconverged')
      && !out.diagnostics.some(d => d.kind === 'input-conflict')
      && out.residual.filter(r => r.goal.kind === 'measure' || r.goal.kind === 'diff').every(r => Math.abs(r.error) < 0.5);
    row.checks = { hardPass, status: hardPass ? 'valid' : diagnosed ? 'diagnosed-unconverged' : 'failed', repeatPass, geometryPass, ledgerPass };
    if ((!hardPass && !diagnosed) || !repeatPass || !geometryPass || !ledgerPass) failures.push(c.id);
    results.push(row);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(results, null, 2));
    console.log(`${c.id}: ${coldMs.toFixed(0)} / ${warmMs.toFixed(0)} ms; arm ${out.values.upperArm.toFixed(2)}, waist ${out.values.waist.toFixed(2)}, hip ${out.values.hip.toFixed(2)}`);
  }
  if (snapshot.treeSha256 !== fingerprint()) throw new Error('來源在產出途中有變動，不能作同版本證據');
  if (failures.length) throw new Error(`回歸未通過：${failures.join(", ")}`);
} finally {
  await server.close();
}
