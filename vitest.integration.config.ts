import { defineConfig } from 'vitest/config';

// Separate from vitest.config.ts: these tests start a real Floci container per
// suite (Docker + image pull), so they're opt-in via `pnpm test:integration`
// rather than part of the default fast `pnpm test` run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
