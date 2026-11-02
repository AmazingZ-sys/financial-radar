import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts', 'src/admin.ts'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  format: ['esm'],
  target: 'node24',
  sourcemap: true,
  clean: true,
  noExternal: [/^@radar\//],
});
