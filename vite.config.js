import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径:产物既能放在任意目录下的静态服务器,也方便打成自包含单文件
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 单文件内联时体积告警没有意义(本来就要把 three 打进同一个文件)
    chunkSizeWarningLimit: 2000,
  },
});
