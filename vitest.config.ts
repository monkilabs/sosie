import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@sosie/core': src('core'),
      '@sosie/postgres': src('postgres'),
      '@sosie/mysql': src('mysql'),
      '@sosie/rest': src('rest'),
      '@sosie/graphql': src('graphql'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'test/memory-source/**/*.test.ts', 'test/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          exclude: ['test/e2e/mysql/**'],
          globalSetup: ['test/e2e/database.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'mysql',
          include: ['test/e2e/mysql/**/*.test.ts'],
          globalSetup: ['test/e2e/mysql/database.ts'],
          testTimeout: 30_000,
          // A first run downloads MySQL's binaries.
          hookTimeout: 600_000,
        },
      },
    ],
  },
})
