import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/health.ts'],
  banner: {
    js: "import { createRequire as radarCreateRequire } from 'node:module'; const require = radarCreateRequire(import.meta.url);",
  },
  format: ['esm'],
  target: 'node24',
  clean: true,
  sourcemap: true,
  noExternal: [/^@radar\//],
});
