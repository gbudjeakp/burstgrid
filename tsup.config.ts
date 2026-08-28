import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    scheduler: 'bin/scheduler.ts',
    'worker-agent': 'bin/worker-agent.ts',
  },
  format: ['esm'],
  target: 'node20',
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  splitting: false,
});
