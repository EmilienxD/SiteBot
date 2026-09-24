# Getting started

From an existing site to a working, site-aware assistant in about five minutes. You need Node.js 22.5 or
later (22.18 or later to write the config in TypeScript) and an API key for one model provider.

## 1. Scaffold

Run this in your site's project directory:

```bash
npx sitebot init
```

`init` detects your framework (Next.js App or Pages router, Nuxt, SvelteKit, Astro, or a plain static
site) and asks four things: the provider, the model, your site's URL and the assistant's name. It then:

- **Fetches your homepage** and drafts the `siteContext` block of the config from it: company, description,
  routes. A bot that knows the site is the difference this whole project is about, and it's the step you
  would otherwise skip.
- **Writes `chatbot.config.yaml`**, a `.env.example`, and for frameworks with API routes, the route
  file (for Next.js App Router: `app/api/chat/[[...route]]/route.ts`).
- **Never overwrites anything.** If a file already exists, it stops and tells you. `--force` overrides
  that.

Every question has a flag (`--provider`, `--model`, `--site-url`, `--name`, `--framework`), and `-y`
accepts all the defaults, so it also runs in scripts.

## 2. Install and add your key

`init` prints the exact install command for your provider. For Anthropic it's:

```bash
npm i @sitebot/config @sitebot/server @ai-sdk/anthropic
```

Then put the key in `.env.local`:

```bash
ANTHROPIC_API_KEY=sk-ant-…
```

## 3. Add the widget

`init` also prints the script tag and where to put it: the root layout, `app.html`, or your page
template. For a same-origin route it looks like this:

```html
<script
  type="module"
  src="https://cdn.jsdelivr.net/npm/@sitebot/widget@0.1/dist/sitebot.js"
  data-endpoint="/api/chat"
></script>
```

The `@0.1` range picks up patch releases of the version you installed. While SiteBot is 0.x, a minor
release may change behaviour, so the range is pinned to the minor; from 1.0 it becomes `@1`.

In React you can use the component instead:

```tsx
import { ChatWidget } from '@sitebot/react'

export function SiteBot() {
  return <ChatWidget endpoint="/api/chat" />
}
```

On a static site with no server of its own, run the chat server beside it with `npx sitebot dev` for now.
[Separate server](/deploy/sidecar) covers the production setup.

## 4. Check it

```bash
npx sitebot doctor
```

`doctor` checks your key, that the provider package is installed, that the model resolves, CORS, storage
and the knowledge index. Every failure comes with the fix. [Troubleshooting](/guide/troubleshooting)
lists them all.

Start your dev server and open the site. The launcher sits in the bottom-right corner. Ask it something
only your site could answer.

## 5. Make it yours

`siteContext` is a draft. Open `chatbot.config.yaml` and correct it. After that, the most valuable next
steps are usually:

- **Facts.** Add the handful of things visitors ask about most (`siteContext.facts`).
- **Knowledge.** Index your pages so answers can cite them: add a `knowledge` block, then run
  `npx sitebot ingest`. See the [docs assistant recipe](/recipes/docs-assistant).
- **Tools.** Let it look things up (`http` tools) or act on the page (`client` tools). See the
  [recipes](/recipes/) for complete examples.

Every key is listed in the [configuration reference](/reference/configuration).

## Before going live

```bash
npx sitebot doctor --production
```

It audits the settings that matter only in production: explicit origins, auth for tools that touch
user data, approvals on writable tools, a shared rate-limit store, a privacy footer. Then go through the
[production checklist](/deploy/checklist).
