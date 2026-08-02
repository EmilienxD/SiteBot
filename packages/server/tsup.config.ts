import { defineConfig } from 'tsup'

export default defineConfig({
  // One entry per adapter, matching the `exports` subpaths, so importing
  // `@sitebot/server/next` never pulls in Express, Fastify or Hono.
  entry: [
    'src/index.ts',
    'src/fetch.ts',
    'src/next.ts',
    'src/express.ts',
    'src/fastify.ts',
    'src/hono.ts',
    'src/node.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  external: ['express', 'fastify', 'hono', 'next'],
})
