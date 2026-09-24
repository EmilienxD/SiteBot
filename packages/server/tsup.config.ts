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
  // tsup strips `node:` by default, which breaks the built-ins that exist
  // only under the prefix — `node:sqlite` has no bare `sqlite` alias.
  removeNodeProtocol: false,
  external: ['express', 'fastify', 'hono', 'next'],
})
