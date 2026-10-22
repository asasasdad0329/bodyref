import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

// 網頁直接標示來源版本，讓部署、截圖與驗證紀錄可互相核對。
const revision = (() => {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    return sha + (dirty ? '+' : '');
  } catch { return 'local'; }
})();

// 相對路徑讓建置結果可以直接放在 GitHub Pages 的子路徑（/<repo>/）下運作
export default defineConfig({
  base: './',
  // 授權全文與第三方授權聲明跟著網站一起發佈（three.js 的 MIT 授權要求散布時附上聲明）
  plugins: [
    { name: 'source-version', transformIndexHtml: html => html.replace('<!-- build-version -->', `版本 ${revision}`) },
    {
      name: 'license-files',
      generateBundle() {
        for (const fileName of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
          this.emitFile({ type: 'asset', fileName, source: readFileSync(fileName) });
        }
      },
    },
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
