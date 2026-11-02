import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  root: 'web',
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4318' } },
  build: { outDir: '../dist', emptyOutDir: true },
});
