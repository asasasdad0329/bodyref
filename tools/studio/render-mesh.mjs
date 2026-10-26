// 算外部網格（獨立模）的多視圖。產物只寫到倉庫外。
// node tools/studio/render-mesh.mjs <網格檔> <輸出資料夾> <名稱> [y0 y1]
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const [meshFile, output, name, y0, y1] = process.argv.slice(2);
if (!meshFile || !output || !name) throw new Error('用法：render-mesh.mjs <網格檔> <輸出資料夾> <名稱> [y0 y1]');
const root = process.cwd(), dest = path.resolve(output);
if (!path.relative(root, dest).startsWith('..')) throw new Error('產物必須在倉庫外');
fs.mkdirSync(dest, { recursive: true });
const bundle = await build({
  entryPoints: [path.join(root, 'tools/studio/entry.ts')], bundle: true, format: 'iife', platform: 'browser', write: false,
  define: { BODY_BASE64: JSON.stringify(fs.readFileSync(path.join(root, 'public/body.bin')).toString('base64')) },
});
const html = '<!doctype html><html><body style="margin:0"><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>';
const executablePath = process.env.BODYREF_CHROMIUM ?? ['/opt/pw-browsers/chromium', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.setContent(html);
  const focus = y0 !== undefined ? { y0: Number(y0), y1: Number(y1) } : undefined;
  const shots = await page.evaluate(({ b64, focus }) => {
    const out = {};
    for (const v of ['front', 'side', 'back', 'rearQuarter', 'quarter']) out[v] = window.studio.renderMesh(b64, v, [700, 800], focus);
    return out;
  }, { b64: fs.readFileSync(meshFile).toString('base64'), focus });
  for (const [k, png] of Object.entries(shots)) fs.writeFileSync(path.join(dest, `${name}-${k}.png`), Buffer.from(png.split(',')[1], 'base64'));
  console.log(`${name}: ${Object.keys(shots).length} 張圖`);
} finally {
  await browser.close();
}
