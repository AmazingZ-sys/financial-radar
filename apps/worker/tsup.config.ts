import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/health.ts'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  format: ['esm'],
  target: 'node24',
  clean: true,
  sourcemap: true,
  noExternal: [/^@radar\//],
});
