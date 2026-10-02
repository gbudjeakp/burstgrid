import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Floci-backed integration tests pull a Docker image and start a container —
    // excluded from the default fast run; use `pnpm test:integration` instead.
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
  },
});
