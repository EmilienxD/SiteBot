import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

/**
 * Two outputs from one source (docs/01-architecture.md §2, docs/07-widget.md §1):
 *
 *   dist/sitebot.js    IIFE — the <script> tag, auto-boots from data-* attrs
 *   dist/sitebot.mjs   ESM  — bundler import, `defineSiteBot({ ... })`
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
      formats: ['iife', 'es'],
      fileName: (format) => (format === 'iife' ? 'sitebot.js' : 'sitebot.mjs'),
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
    // Preact is bundled rather than externalised — the script tag has to be
    // self-contained. It costs ~6 kB of the 25 kB budget. Code splitting stays
    // on so the panel can be a lazy chunk (docs/07-widget.md §1).
  },
  esbuild: {
    legalComments: 'none',
  },
})
