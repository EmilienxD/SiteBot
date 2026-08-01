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
  external: [/^@ai-sdk\//],
})
