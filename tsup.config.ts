import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    scheduler: 'bin/scheduler.ts',
    'worker-agent': 'bin/worker-agent.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  splitting: false,
  noExternal: [/.*/],  // bundle all deps — output is a self-contained single file
  // CJS packages inside an ESM bundle call require() — provide it via createRequire
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});
