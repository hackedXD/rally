import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@rally/protocol': resolve(__dirname, 'packages/protocol/src/index.ts'),
      '@rally/sim': resolve(__dirname, 'packages/sim/src/index.ts'),
      '@rally/motion': resolve(__dirname, 'packages/motion/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
