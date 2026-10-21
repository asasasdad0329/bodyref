// 真正產品頁的操作回歸；結果與截圖放在倉庫外。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

if (!process.argv[2]) throw new Error('請指定倉庫外輸出目錄');
const dest = path.resolve(process.argv[2]);
const relative = path.relative(process.cwd(), dest);
if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('產物必須在倉庫外');
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.BODYREF_CHROMIUM || undefined, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const root = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const state = { sex: 'female', locked: { height: 165, weight: 60, bodyFat: 0.25, bust: 94, underbust: 74, waist: 68, hip: 104 },
    cup: null, ratios: { thighCalf: 0.8 }, muscleMass: 22,
    morphology: { breast: 'long', hip: 'projected', abdomen: 'smooth' } };
  await page.goto(root + '?b=' + Buffer.from(JSON.stringify(state)).toString('base64url'));
  await page.waitForFunction(() => Boolean(document.getElementById('stage')?.dataset.shapeKey), null, { timeout: 60000 });
  assert.equal(await page.locator('#shape-breast').inputValue(), 'long');
  assert.equal(await page.locator('#shape-hip').inputValue(), 'projected');
  assert.equal(await page.locator('#shape-abdomen').inputValue(), 'smooth');
  assert.equal(Number(await page.locator('#n-muscleMass').inputValue()), 22);
  await page.locator('details').filter({ hasText: 'PROPORTION' }).locator('summary').click();
  assert.equal(Number(await page.locator('#n-thighCalf').inputValue()), 1.25);
  const change = async action => {
    const old = await page.locator('#stage').getAttribute('data-shape-key');
    await action(); await page.locator('#panel .group-title').first().click();
    await page.waitForFunction(old => document.getElementById('stage').dataset.shapeKey !== old, old, { timeout: 60000 });
  };
  await change(() => page.locator('#n-muscleMass').fill('24'));
  assert.equal(Number(await page.locator('#n-bodyFat').inputValue()), 25);
  await change(() => page.locator('#shape-breast').selectOption('round'));
  const readShare = async () => {
    await page.locator('#share').click(); const code = await page.locator('#share-code').inputValue();
    await page.locator('#share-close').click(); return JSON.parse(Buffer.from(code, 'base64url').toString());
  };
  let shared = await readShare();
  assert.equal(shared.ratios.thighCalf, 0.8); assert.equal(shared.muscleMass, 24); assert.equal(shared.locked.bodyFat, 0.25); assert.equal(shared.morphology.breast, 'round');
  const shot = async () => {
    await page.locator('#shot').click(); const src = await page.locator('#export-image').getAttribute('src');
    await page.locator('#export-close').click(); return src;
  };
  const clean = await shot();
  await page.getByRole('button', { name: '量測線', exact: true }).click();
  await page.getByRole('button', { name: '結構線', exact: true }).click();
  assert.equal(await shot(), clean, '乾淨輸出不受疊線開關影響');
  await page.locator('#export-measurements').check();
  assert.notEqual(await shot(), clean, '附量測保留疊線');
  await page.locator('#export-measurements').uncheck();
  await page.locator('#three-view').click();
  await page.locator('#export-image').evaluate(img => img.decode());
  assert.deepEqual(await page.locator('#export-image').evaluate(img => [img.naturalWidth, img.naturalHeight]), [1560, 1000]);
  await page.locator('#export-close').click();
  await page.locator('details').filter({ hasText: 'DETAIL' }).locator('summary').click();
  await change(() => page.locator('#n-thighLen').fill('29'));
  shared = await readShare(); assert.equal(shared.ratios.thighCalf, undefined); assert.equal(shared.ratios.legRatio, undefined);
  await change(() => page.locator('#reset').click());
  shared = await readShare(); assert.equal(shared.muscleMass, null); assert.equal(shared.morphology.breast, 'teardrop'); assert.equal(shared.morphology.hip, 'balanced');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '手機版無水平溢出');
  assert.deepEqual(errors, []);
  fs.mkdirSync(dest, { recursive: true }); await page.screenshot({ path: path.join(dest, 'mobile.png'), fullPage: true });
  fs.writeFileSync(path.join(dest, 'result.json'), JSON.stringify({ passed: true, checks: ['肌肉獨立', '型態', '比例互斥與舊碼', '分享', '乾淨輸出與恢復', '三視圖', '重設', '手機排版'], errors }, null, 2));
  console.log('產品操作回歸通過');
} finally { await browser?.close(); await server.close(); }
