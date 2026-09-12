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
    /**
     * The suite never spends money or needs the network.
     *
     * `config.ts` loads `.env`, so on any machine that has real keys in it the
     * commentary tests quietly stopped exercising the shipped default and
     * started driving Gemini and ElevenLabs for real — a hundred written and
     * synthesised lines per director test, on every run, against a concurrency
     * limit that then turns half of them into retries. Nothing failed, which is
     * why it went unnoticed; it just billed somebody.
     *
     * Set RALLY_TEST_LIVE_AI=1 to deliberately test against the real providers.
     */
    env: process.env.RALLY_TEST_LIVE_AI === '1' ? {} : { RALLY_FORCE_OFFLINE_AI: '1' },
  },
});
