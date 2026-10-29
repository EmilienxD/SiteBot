import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'SiteBot',
  description: 'A drop-in, fully configurable AI assistant for any website.',
  cleanUrls: true,
  lastUpdated: false,
  // The spec pages are included from ../../docs, which links to its own
  // sibling files by relative path; those resolve in the repo, not here.
  ignoreDeadLinks: [/^\.\/\d\d-/, /^\.\.\//],
  markdown: {
    // Pages compile as Vue templates, and VitePress only protects fenced code:
    // inline `{{identity.sub}}` would be interpolated (and crash the render).
    // Config placeholders are literal text everywhere in these docs.
    config(md) {
      const render = md.renderer.rules.code_inline!
      md.renderer.rules.code_inline = (...args) =>
        render(...args).replace(/^<code/, '<code v-pre')
    },
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Recipes', link: '/recipes/' },
      { text: 'Reference', link: '/reference/configuration' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Multilingual assistants', link: '/guide/multilingual' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' },
        ],
      },
      {
        text: 'Deploy',
        items: [
          { text: 'In your app (Next.js)', link: '/deploy/in-app' },
          { text: 'Separate server (sidecar)', link: '/deploy/sidecar' },
          { text: 'Edge (Cloudflare Workers)', link: '/deploy/edge' },
          { text: 'Production checklist', link: '/deploy/checklist' },
        ],
      },
      {
        text: 'Recipes',
        items: [
          { text: 'Overview', link: '/recipes/' },
          { text: 'Ecommerce assistant', link: '/recipes/ecommerce' },
          { text: 'Docs assistant', link: '/recipes/docs-assistant' },
          { text: 'Lead-capture bot', link: '/recipes/lead-capture' },
          { text: 'Support triage', link: '/recipes/support-triage' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'Protocol', link: '/reference/protocol' },
          { text: 'Security', link: '/reference/security' },
        ],
      },
    ],
    search: { provider: 'local' },
    outline: [2, 3],
  },
})
