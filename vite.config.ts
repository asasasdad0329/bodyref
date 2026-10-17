import { defineConfig } from 'vite';

// 相對路徑讓建置結果可以直接放在 GitHub Pages 的子路徑（/<repo>/）下運作
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
