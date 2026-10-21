import { defineConfig, mergeConfig } from 'vite';
import main from './vite.config';

// 獨立建置，避免實驗控制進入正式人台或改變離線單檔的模組結構。
export default mergeConfig(main, defineConfig({
  build: { outDir: 'dist-shape-lab', rollupOptions: { input: 'shape-lab.html' } },
}));
