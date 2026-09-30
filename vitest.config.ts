import { defineConfig } from 'vitest/config';

// Root-level suites only. Package tests run through their own package (`turbo run test`).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000, // the boundary and lint suites shell out to dependency-cruiser and ESLint
  },
});
