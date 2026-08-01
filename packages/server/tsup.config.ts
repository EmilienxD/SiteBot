import { defineConfig } from 'tsup'

export default defineConfig({
  // Phase 3 adds one entry per adapter (fetch, next, express, fastify, hono,
  // node) plus the matching `exports` subpaths, so importing
  // `@sitebot/server/next` never pulls in Express or Fastify.
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  external: ['express', 'fastify', 'hono', 'next'],
})
