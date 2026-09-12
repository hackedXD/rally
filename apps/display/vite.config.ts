import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(__dirname);
const repo = resolve(__dirname, '../..');

/**
 * The display app. Workspace packages are aliased straight at their TypeScript
 * source: no build step between editing `@rally/protocol` and seeing the change,
 * which is the only reason a protocol edit is a two-second operation instead of a
 * two-minute one.
 */
export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@rally/protocol': resolve(repo, 'packages/protocol/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
      '/healthz': { target: 'http://localhost:8787' },
      // The phone app, proxied from its own dev server.
      //
      // The QR code encodes whatever origin the display is served from, so in
      // development that is this port. Without this proxy the code points at a
      // 404 and the phone flow cannot be tested at all until you build — which is
      // exactly the thing you most want to iterate on.
      '/c': {
        target: 'http://localhost:5174',
        // The controller dev server serves its index at the directory form.
        rewrite: (path) => (path === '/c' ? '/c/' : path),
      },
    },
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
