import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // tsup strips `node:` by default, which breaks the built-ins that exist
  // only under the prefix — `node:sqlite` has no bare `sqlite` alias.
  removeNodeProtocol: false,
  platform: 'node',
  // No `banner` here: it applies to every entry, which would put a shebang on
  // the library entry too. src/cli.ts carries its own, and esbuild preserves it.
})
