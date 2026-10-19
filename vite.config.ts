import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// 相對路徑讓建置結果可以直接放在 GitHub Pages 的子路徑（/<repo>/）下運作
export default defineConfig({
  base: './',
  // 授權全文與第三方授權聲明跟著網站一起發佈（three.js 的 MIT 授權要求散布時附上聲明）
  plugins: [
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
