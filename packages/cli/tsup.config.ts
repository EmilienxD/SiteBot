import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  // No `banner` here: it applies to every entry, which would put a shebang on
  // the library entry too. src/cli.ts carries its own, and esbuild preserves it.
})
