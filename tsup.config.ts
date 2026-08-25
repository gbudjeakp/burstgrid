import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    scheduler: 'bin/scheduler.ts',
    'worker-agent': 'bin/worker-agent.ts',
  },
  format: ['cjs'],
  target: 'node24',
  clean: true,
  splitting: false,
});
