import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// The server serves web/dist with a strict CSP (no inline scripts or styles, no external URLs),
// so the build must emit plain files only.
export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'chrome140',
  },
});
