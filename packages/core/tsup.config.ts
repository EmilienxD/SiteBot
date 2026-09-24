import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries, deliberately. The root entry must stay edge-compatible;
  // everything that touches node:* lives behind the ./node subpath so edge
  // builds tree-shake it out. docs/01-architecture.md §3 rule 6.
  entry: ['src/index.ts', 'src/node/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  // tsup strips `node:` by default, which breaks the built-ins that exist
  // only under the prefix — `node:sqlite` has no bare `sqlite` alias.
  removeNodeProtocol: false,
  external: [/^@ai-sdk\//, /^@modelcontextprotocol\//, 'undici'],
})
