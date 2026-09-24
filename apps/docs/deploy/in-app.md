# In your app (Next.js)

The simplest setup: the chat API is a route in the app that serves your pages, so the widget talks to
its own origin and there's no CORS to configure. This page uses Next.js; Express, Fastify, Hono and
plain Node have adapters of the same shape (`@sitebot/server/express`, `/fastify`, `/hono`, `/node`).

Runnable example: [`examples/nextjs`](https://github.com/EmilienxD/SiteBot/tree/main/examples/nextjs).

## The route

One catch-all route file serves `/api/chat` and its `/config`, `/feedback` and `/health` sub-routes:

```ts
// lib/sitebot.ts
import { loadConfig } from '@sitebot/config/node'
import { createRouteHandlers, type NextRouteHandlers } from '@sitebot/server/next'

const KEY = Symbol.for('sitebot.handlers')
type Cache = { [KEY]?: Promise<NextRouteHandlers> }

export function handlers(): Promise<NextRouteHandlers> {
  const cache = globalThis as Cache
  cache[KEY] ??= loadConfig(undefined, { dotenv: true }).then((config) => createRouteHandlers(config))
  return cache[KEY]
}
```

```ts
// app/api/chat/[[...route]]/route.ts
import { handlers } from '@/lib/sitebot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = async (request: Request) => (await handlers()).GET(request)
export const POST = async (request: Request) => (await handlers()).POST(request)
export const OPTIONS = async (request: Request) => (await handlers()).OPTIONS(request)
```

Two details matter:

- **The handlers are built on the first request, not at import.** `next build` imports every route
  module, and loading the config there would make the build need your API key.
- **They're cached on `globalThis`.** `next dev` re-evaluates modules on every edit. Without the cache,
  each edit would create a fresh engine with empty in-memory sessions and rate limits.

## The widget

```tsx
// app/sitebot.tsx
'use client'
import { ChatWidget } from '@sitebot/react'

export function SiteBot() {
  return <ChatWidget endpoint="/api/chat" />
}
```

Render `<SiteBot />` once, in the root layout.

## Deploying

The config file is read at runtime, so tell Next's file tracer about it:

```ts
// next.config.ts
const config: NextConfig = {
  outputFileTracingIncludes: { '/api/chat/**': ['./chatbot.config.yaml'] },
}
```

The route runs on the Node runtime because it reads that file and, with `storage: sqlite`, a local
database. On serverless hosts with no persistent disk, use `storage: redis` or `postgres`, and a
`pgvector` or `upstash` knowledge store. If you'd rather run on the edge runtime, see
[Edge](/deploy/edge): the same approach applies to Vercel Edge.

Then go through the [production checklist](/deploy/checklist).
