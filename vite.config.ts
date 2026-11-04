import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// 網頁直接標示來源版本，讓部署、截圖與驗證紀錄可互相核對。
const revision = (() => {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    return sha + (dirty ? '+' : '');
  } catch { return 'local'; }
})();

// 測試站（test.bodyref.…）用 `npm run build -- --mode testsite` 建置：頁面標示「測試站・未發佈」，
// 不讓搜尋引擎收錄（頁面標記、robots.txt、回應標頭三道），私有庫有看圖頁的話一起放在 review/。
// 正式站照一般的 `npm run build`，畫面照舊（DECISIONS #91）。
function testSitePlugin(): Plugin {
  let outDir = 'dist';
  const gallery = path.resolve('tools/review/gallery.mjs');   // 只在私有庫
  const hasReview = existsSync(gallery) && existsSync('review');
  return {
    name: 'test-site',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    transformIndexHtml: html => html
      .replace(/<html(\s|>)/, '<html data-site="test"$1')
      .replace('</head>', '  <meta name="robots" content="noindex, nofollow" />\n  </head>')
      .replace(/(<span id="build-version"[^>]*>.*?<\/span>)/, hasReview ? '$1 <a class="review-link" href="review/">看圖</a>' : '$1'),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: 'User-agent: *\nDisallow: /\n' });
      this.emitFile({ type: 'asset', fileName: '_headers', source: '/*\n  X-Robots-Tag: noindex, nofollow\n' });
    },
    async closeBundle() {
      if (!hasReview) return;
      const { buildReviewGallery } = await import(pathToFileURL(gallery).href);
      const n = buildReviewGallery({ root: process.cwd(), outDir, revision });
      if (n) console.log(`看圖頁：review/ ${n} 個檔案`);
    },
  };
}

// 相對路徑讓建置結果可以直接放在 GitHub Pages 的子路徑（/<repo>/）下運作
export default defineConfig(({ mode }) => {
  const testSite = mode === 'testsite';
  return {
    base: './',
    plugins: [
      { name: 'source-version', transformIndexHtml: html => html.replace('<!-- build-version -->', `${testSite ? '測試站・未發佈・' : ''}版本 ${revision}`) },
      ...(testSite ? [testSitePlugin()] : []),
      // 第三方授權聲明跟著網站一起發佈（three.js 的 MIT 授權要求散布時附上聲明）；公開庫另有 LICENSE 時一併附上
      {
        name: 'license-files',
        generateBundle() {
          for (const fileName of ['LICENSE', 'THIRD_PARTY_NOTICES.md'].filter(name => existsSync(name))) {
            this.emitFile({ type: 'asset', fileName, source: readFileSync(fileName) });
          }
        },
      },
    ],
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 900,
    },
  };
});
