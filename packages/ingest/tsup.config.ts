import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/query.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  // tsup strips `node:` by default, which breaks the built-ins that exist
  // only under the prefix — `node:sqlite` has no bare `sqlite` alias.
  removeNodeProtocol: false,
  platform: 'node',
})
