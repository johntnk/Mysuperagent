import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/contract/**/*.test.ts', 'tests/acceptance/**/*.test.ts'],
    setupFiles: ['./tests/offline.ts'],
    testTimeout: 10000,
  },
});
