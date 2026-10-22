// 真正產品頁的操作回歸；結果與截圖放在倉庫外。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

if (!process.argv[2]) throw new Error('請指定倉庫外輸出目錄');
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
const fingerprint = () => {
  const hash = crypto.createHash('sha256');
  for (const file of tracked) { hash.update(file); hash.update(fs.readFileSync(file)); }
  return hash.digest('hex');
};
const snapshot = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), treeSha256: fingerprint() };
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
  for (const [key, options] of [['breast', ['teardrop', 'long', 'round']], ['hip', ['balanced', 'projected']], ['abdomen', ['soft', 'smooth']]]) {
    for (const value of options) {
      await change(() => page.locator(`#shape-${key}`).selectOption(value));
      shared = await readShare(); assert.equal(shared.morphology[key], value);
      assert.equal(shared.muscleMass, 24); assert.deepEqual(shared.locked, state.locked);
    }
  }
  const saved = await readShare(); await page.goto(root);
  await page.waitForFunction(() => Boolean(document.getElementById('stage')?.dataset.shapeKey), null, { timeout: 60000 });
  assert.deepEqual(await readShare(), saved, '重載由儲存狀態還原全部型態與肌肉輸入');
  await page.locator('details').filter({ hasText: 'PROPORTION' }).locator('summary').click();
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
  for (const [id, value] of [['legRatio', '0.4'], ['thighCalf', '2'], ['armRatio', '0.38'], ['upperFore', '0.625']]) {
    await change(() => page.locator(`#n-${id}`).fill(value));
  }
  shared = await readShare();
  assert.equal(shared.ratios.legRatio, 0.4); assert.equal(shared.ratios.thighCalf, 0.5);
  assert.equal(shared.ratios.armRatio, 0.38); assert.equal(shared.ratios.upperFore, 1.6);
  await change(() => page.locator('#reset').click());
  await change(() => page.locator('#sex-male').check());
  assert.equal((await readShare()).sex, 'male');
  assert.equal(await page.locator('#shape-breast').isVisible(), false);
  for (const [key, options] of [['hip', ['projected', 'balanced']], ['abdomen', ['smooth', 'soft']]]) {
    for (const value of options) {
      await change(() => page.locator(`#shape-${key}`).selectOption(value));
      assert.equal((await readShare()).morphology[key], value);
    }
  }
  await change(() => page.locator('#n-muscleMass').fill('30'));
  assert.equal((await readShare()).muscleMass, 30);
  await change(() => page.locator('#reset').click());
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '手機版無水平溢出');
  assert.deepEqual(errors, []);
  fs.mkdirSync(dest, { recursive: true }); await page.screenshot({ path: path.join(dest, 'mobile.png'), fullPage: true });
  const checks = ['男女肌肉獨立', '三胸型及男女兩臀型／兩腹型逐項切換', '比例互斥與舊碼', '極端比值與倒數', '分享與儲存重載', '乾淨輸出與恢復', '三視圖', '重設', '手機排版'];
  let offlineMethod;
  if (process.env.BODYREF_SINGLE_HTML) {
    const offline = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
    try {
      const filePage = await offline.newPage();
      filePage.on('pageerror', e => errors.push(e.message));
      const html = fs.readFileSync(path.resolve(process.env.BODYREF_SINGLE_HTML));
      snapshot.singleHtmlSha256 = crypto.createHash('sha256').update(html).digest('hex');
      if (process.env.BODYREF_OFFLINE_INLINE === '1') {
        // 部分執行環境禁止 file:// 導航；此模式只證明單檔內容離線可用，
        // 報告明列載入方式，不能冒充原生檔案開啟驗證。
        await filePage.setContent(html.toString()); offlineMethod = 'inline-content';
      } else {
        await filePage.goto(pathToFileURL(path.resolve(process.env.BODYREF_SINGLE_HTML)).href); offlineMethod = 'file-navigation';
      }
      await filePage.waitForFunction(() => Boolean(document.getElementById('stage')?.dataset.shapeKey), null, { timeout: 60000 });
      const old = await filePage.locator('#stage').getAttribute('data-shape-key');
      await filePage.locator('#shape-breast').selectOption('long');
      await filePage.waitForFunction(old => document.getElementById('stage').dataset.shapeKey !== old, old, { timeout: 60000 });
      await filePage.locator('#shot').click();
      await filePage.locator('#export-image').evaluate(img => img.decode());
      assert.ok(await filePage.locator('#export-image').evaluate(img => img.naturalWidth > 0 && img.naturalHeight > 0));
      assert.deepEqual(errors, []);
      await filePage.screenshot({ path: path.join(dest, 'offline.png') });
      checks.push('單檔離線載入、Worker 求解與圖片輸出');
    } finally { await offline.close(); }
  }
  assert.equal(fingerprint(), snapshot.treeSha256, '驗證期間不得更動來源');
  fs.writeFileSync(path.join(dest, 'result.json'), JSON.stringify({ snapshot, passed: true, checks, errors, offlineMethod }, null, 2));
  console.log('產品操作回歸通過');
} finally { await browser?.close(); await server.close(); }
