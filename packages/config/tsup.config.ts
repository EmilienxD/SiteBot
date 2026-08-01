import { defineConfig } from 'tsup'

/**
 * Two entries, mirroring @sitebot/core:
 *
 *   src/index.ts       schema, validation, toPublicConfig — browser-safe
 *   src/node/index.ts  the filesystem loader — Node only
 *
 * Keeping them separate is what lets a bundler drop `node:fs` from a browser
 * build instead of failing on it (docs/01-architecture.md §2).
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/node/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
})
