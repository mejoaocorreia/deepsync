import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['{apps,packages,fixtures}/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 85, functions: 85, statements: 85, branches: 80 },
    },
  },
})
