// 檢視頁的瀏覽器測試：把 CDN 的 three.js 換成倉庫 node_modules 裡的版本（容器連不到 CDN），載入頁面、截圖、按「隱藏大腿」再截圖。
// NODE_PATH=<全域 node_modules> node tools/blender/viewer_test.cjs <index.html> <截圖前綴>；輸出 status 與錯誤訊息
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [html, out] = process.argv.slice(2);
  const nm = require('path').resolve(__dirname, '../../node_modules/three');
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 400, height: 820 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await p.route('https://cdn.jsdelivr.net/**', r => {
    const u = r.request().url();
    const f = u.includes('/examples/jsm/') ? nm + '/examples/jsm/' + u.split('/examples/jsm/')[1] : nm + '/build/' + u.split('/build/')[1];
    r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f, 'utf8') });
  });
  await p.route('http://page/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' + fs.readFileSync(html, 'utf8') }));
  await p.goto('http://page/index.html');
  await p.waitForTimeout(5000);
  const status = await p.evaluate(() => { const s = document.getElementById('status'); return s.hidden ? 'hidden' : s.textContent; });
  await p.screenshot({ path: out + '-a.png' });
  await p.click('#thighs'); await p.waitForTimeout(1500);
  await p.screenshot({ path: out + '-b.png' });
  console.log(JSON.stringify({ status, errs: errs.filter(e => !e.includes('three.module.js')) }));
  await b.close();
})();
