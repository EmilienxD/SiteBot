import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

/**
 * Two chunks from one source (docs/01-architecture.md §2, docs/07-widget.md §1):
 *
 *   dist/sitebot.js         entry — custom element, styles, launcher
 *   dist/sitebot-panel.js   lazy  — panel tree, chat controller, `ai` transport
 *
 * The output is an ES module (`<script type="module">`), not an IIFE: a lazy
 * panel chunk and a single-file IIFE are mutually exclusive — Rollup cannot
 * code-split into an IIFE — and docs/07 §1 makes the lazy panel the
 * requirement ("First paint cost is a button"). Chunk loading is relative to
 * the module URL, so self-hosting and the CDN both work unconfigured.
 *
 * CSS is inlined into the bundle and injected into the shadow root at runtime;
 * we deliberately ship no separate stylesheet.
 */
export default defineConfig({
  plugins: [preact()],
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      name: 'SiteBot',
      formats: ['es'],
      fileName: () => 'sitebot.js',
    },
    // Stable, unhashed chunk names — the size-limit budgets in package.json
    // point at them by path and `sitebot dev` serves them by name, so a name
    // that moved with the module graph would make CI flap. `panel-chunk` is
    // the lazy half; anything else Rollup factors out is shared between the
    // entry and the panel and therefore loads eagerly with the launcher.
    rollupOptions: {
      output: {
        // Vite's ES-library preset leaves codegen unminified. This artifact is
        // also a drop-in script, so minify whitespace while retaining annotations.
        minify: { compress: true, mangle: true, codegen: true },
        chunkFileNames: (chunk) =>
          chunk.name === 'panel-chunk' ? 'sitebot-panel.js' : 'sitebot-shared.js',
      },
    },
    // Preact is bundled rather than externalised — the script tag has to be
    // self-contained. It costs ~6 kB of the initial budget.
  },
  esbuild: {
    legalComments: 'none',
  },
})
