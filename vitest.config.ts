import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/api/**/*.test.ts',
      'apps/web/**/*.test.ts',
      'apps/worker/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    testTimeout: 15000,
    restoreMocks: true,
  },
});
