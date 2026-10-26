// 造型工作室：組出基礎形狀並算多視圖。產物只寫到倉庫外。
// node tools/studio/render.mjs <輸出資料夾> [名稱]
// 目前算 MakeHuman 亞洲年輕女性的基礎形狀；之後各部位的造型模組接在這裡。
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const [output, name = 'base'] = process.argv.slice(2);
if (!output) throw new Error('請指定倉庫外的輸出資料夾');
const root = process.cwd(), dest = path.resolve(output);
if (!path.relative(root, dest).startsWith('..')) throw new Error('產物必須在倉庫外');
fs.mkdirSync(dest, { recursive: true });

const bundle = await build({
  entryPoints: [path.join(root, 'tools/studio/entry.ts')], bundle: true, format: 'iife', platform: 'browser', write: false,
  define: { BODY_BASE64: JSON.stringify(fs.readFileSync(path.join(root, 'public/body.bin')).toString('base64')) },
});
const html = '<!doctype html><html><body style="margin:0"><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>';
// 環境變數或常見位置的 Chromium；都沒有時用 Playwright 自帶的版本
const executablePath = process.env.BODYREF_CHROMIUM ?? ['/opt/pw-browsers/chromium', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.setContent(html);
  const shots = await page.evaluate(() => {
    const s = window.studio;
    const P = s.compose({ 'asian-female-young': 1 });
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 1; i < P.length; i += 3) { yMin = Math.min(yMin, P[i]); yMax = Math.max(yMax, P[i]); }
    const H = yMax - yMin;
    const out = {};
    for (const v of ['front', 'side', 'back', 'rearQuarter']) out[`full-${v}`] = s.render(P, v, [500, 1000]);
    // 下半身：腰上方到膝下
    const focus = { y0: yMin + H * 0.22, y1: yMin + H * 0.68 };
    for (const v of ['front', 'side', 'back', 'rearQuarter', 'quarter']) out[`lower-${v}`] = s.render(P, v, [700, 800], focus);
    return { out, positions: Array.from(P), H, yMin };
  });
  for (const [k, png] of Object.entries(shots.out)) fs.writeFileSync(path.join(dest, `${name}-${k}.png`), Buffer.from(png.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(dest, `${name}-positions.bin`), Buffer.from(Float32Array.from(shots.positions).buffer));
  console.log(`${name}: 身高 ${shots.H.toFixed(1)} cm，${Object.keys(shots.out).length} 張圖`);
} finally {
  await browser.close();
}
