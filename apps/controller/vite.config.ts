import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = resolve(__dirname);
const repo = resolve(__dirname, '../..');

/**
 * The phone app. Vanilla TypeScript and no framework: it is one screen, and the
 * bundle size is the thing a judge waits on while holding someone else's phone on
 * conference wifi.
 *
 * `base: '/c/'` because the QR code points at `/c` and the server hosts it there.
 */
export default defineConfig({
  root,
  base: '/c/',
  resolve: {
    alias: {
      '@rally/protocol': resolve(repo, 'packages/protocol/src/index.ts'),
      '@rally/motion': resolve(repo, 'packages/motion/src/index.ts'),
    },
  },
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
    },
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2020',
  },
});
