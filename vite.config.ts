import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { darkTheme } from './build/dark-theme';
export default defineConfig({
  plugins: [react()],
  root: 'web',
  css: { postcss: { plugins: [darkTheme({ vendor: /swagger-ui/ })] } },
  server: { host: '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:4318', ws: true } } },
  build: { outDir: '../dist', emptyOutDir: true },
});
