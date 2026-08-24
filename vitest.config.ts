import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const packageSource = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepsync/contracts': packageSource('./packages/contracts/src/index.ts'),
      '@deepsync/core': packageSource('./packages/core/src/index.ts'),
      '@deepsync/doctor': packageSource('./packages/doctor/src/index.ts'),
      '@deepsync/source-github': packageSource('./packages/source-github/src/index.ts'),
      '@deepsync/target-dsh': packageSource('./packages/target-dsh/src/index.ts'),
    },
  },
  test: {
    include: ['{apps,packages,fixtures}/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: ['**/dist/**'],
      thresholds: { lines: 70, functions: 65, statements: 65, branches: 60 },
    },
  },
})
