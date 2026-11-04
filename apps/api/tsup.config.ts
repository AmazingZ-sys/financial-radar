import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts', 'src/admin.ts'],
  banner: {
    js: "import { createRequire as radarCreateRequire } from 'node:module'; const require = radarCreateRequire(import.meta.url);",
  },
  format: ['esm'],
  target: 'node24',
  sourcemap: true,
  clean: true,
  noExternal: [/^@radar\//],
});
