import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['lib/**/*.test.ts', 'client/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          environment: 'node',
          // Nuxt has to build the example app before the first test runs.
          testTimeout: 180_000,
          hookTimeout: 240_000,
          // One Nuxt server per file, shared by its tests; running files in
          // parallel would mean several builds competing for the same output.
          fileParallelism: false,
        },
      },
    ],
  },
})
