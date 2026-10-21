// 產物包含 CC0 網格衍生的權重與截面；只寫到明確指定的倉庫外目錄。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';

const output = process.argv[2];
if (!output) throw new Error('用法：npm run test:shape-report -- <倉庫外輸出.json>');
const dest = path.resolve(output), rel = path.relative(process.cwd(), dest);
if (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) throw new Error('形狀報告必須放在倉庫外');
// realpath 防止以倉庫外的符號連結寫回倉庫內。
fs.mkdirSync(path.dirname(dest), { recursive: true });
const realDest = path.join(fs.realpathSync(path.dirname(dest)), path.basename(dest));
const realRel = path.relative(fs.realpathSync(process.cwd()), realDest);
if ((!realRel.startsWith('..' + path.sep) && realRel !== '..' && !path.isAbsolute(realRel)) || fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) throw new Error('輸出路徑不能連回倉庫');
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { parseBodyAsset } = await server.ssrLoadModule('/src/body/mh/asset.ts');
  const { makeShapeBaseline, SHAPE_BASELINES } = await server.ssrLoadModule('/src/lab/shapeBaseline.ts');
  const bin = fs.readFileSync('public/body.bin');
  const asset = parseBodyAsset(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const snapshot = (r) => ({ values: r.measured.values, volume: r.volume, marks: r.measured.marks,
    sections: Object.fromEntries(['waist', 'hip', 'thigh'].map((k) => [k, r.measured.tapes[k]])) });
  const report = { schema: 1, baselineApplication: 'f4e2aff', assetSHA256: createHash('sha256').update(bin).digest('hex'),
    units: { positions: 'cm', volume: 'cm³', amplitude: 'cm' },
    // 與驗收頁一致的固定正交視角；基準與變形共用鏡頭，不能各自縮放。
    camera: { azimuthDegrees: [0, 45, 90, 135, 180], heightAt160: 60, centerAboveCrotchAt160: 15 }, cases: [] };
  for (const c of SHAPE_BASELINES) {
    const rig = makeShapeBaseline(asset, c);
    const baseline = snapshot(rig.baselineResult);
    const singles = rig.controls.map((control) => {
      const probes = [-0.5, 1].map((amount) => {
        const r = rig.apply({ [control.id]: amount * rig.scale });
        return { amount: amount * rig.scale, ...snapshot(r), volumeDelta: r.volume - baseline.volume };
      });
      const { weights, ...spec } = control;
      return { ...spec, weights: Array.from(weights), probes };
    });
    const linked = [];
    for (const mode of ['muscle', 'fat']) for (const increment of [0, 2, 5, 10, 20]) for (const fixedThigh of [false, true]) {
      const target = baseline.values.hip + increment;
      const { result, ...fit } = rig.fitHip(mode, target, fixedThigh);
      linked.push({ mode, target, fixedThigh, ...fit, ...snapshot(result), volumeDelta: result.volume - baseline.volume });
    }
    report.cases.push({ ...c, baseline, references: rig.references, controls: singles, linked });
    console.log(`${c.id}: ${rig.controls.length} controls; hip ${baseline.values.hip.toFixed(2)} cm; fixed-thigh +2 cm: ${linked.filter((r) => r.fixedThigh && r.target === baseline.values.hip + 2).map((r) => `${r.mode} ${r.reached ? 'pass' : 'residual ' + r.error.toFixed(2)}`).join(', ')}`);
  }
  fs.writeFileSync(dest, JSON.stringify(report));
} finally { await server.close(); }
