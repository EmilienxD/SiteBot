# In your app (Next.js)

The simplest setup: the chat API is a route in the app that serves your pages, so the widget talks to
its own origin and there's no CORS to configure. This page uses Next.js; Express, Fastify, Hono and
plain Node have adapters of the same shape (`@sitebot/server/express`, `/fastify`, `/hono`, `/node`).

Runnable example: [`examples/nextjs`](https://github.com/EmilienxD/SiteBot/tree/main/examples/nextjs).

## The route

One catch-all route file serves `/api/chat` and its `/config`, `/feedback` and `/health` sub-routes:

```ts
// lib/sitebot.ts
import 'server-only'
import '@ai-sdk/openai' // declare the chosen lazy SDK to Next's file tracer
import { loadConfig } from '@sitebot/config/node'
import { createRouteHandlers, type NextRouteHandlers } from '@sitebot/server/next'

const KEY = Symbol.for('sitebot.handlers')
type Cache = { [KEY]?: Promise<NextRouteHandlers> }

export function handlers(): Promise<NextRouteHandlers> {
  const cache = globalThis as Cache
  cache[KEY] ??= loadConfig(undefined, { dotenv: true })
    .then((config) => createRouteHandlers(config))
    .catch((error: unknown) => {
      delete cache[KEY] // retry after a runtime configuration error is repaired
      throw error
    })
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
  serverExternalPackages: ['@ai-sdk/openai'],
  outputFileTracingIncludes: { '/api/chat/**': ['./chatbot.config.yaml'] },
}
```

The server-only import and `serverExternalPackages` must name the SDKs actually selected for chat. They declare dependencies without constructing a model or requiring a build-time key.
For standalone output, use the example's `scripts/prepare-standalone.mjs`: it preserves original
package names alongside Turbopack's hashed aliases so lazy imports work after relocation. Config
extensions, prompt files and custom modules also need narrow, explicit tracing includes. See
[Next.js output tracing](https://nextjs.org/docs/app/api-reference/config/next-config-js/output).

Keep credentials in server environment variables and `${env.*}` config placeholders. Pass only the
endpoint/public UI options to `ChatWidget`; never import the private config into a client component
or place provider keys in `NEXT_PUBLIC_*` or `next.config.env`. The `server-only` guard rejects an
accidental client import. The Next adapter preserves the original Web Request URL, including numeric
loopback origins, and keeps the request's cancellation signal linked to provider calls.

The route runs on Node because it reads files and can use local SQLite. A persistent single-node
host can use SQLite on a durable writable volume. For stateless/serverless instances:

The default local standalone gate uses local state; the optional shared-store gate below adds real
services and concurrent processes. Hosted proxy behavior and cloud runtime packaging still need
verification on the host. If using edge rather than Node, see [Edge](/deploy/edge).

## Shared state and limits

All replicas of one site need the same session database and, separately, the same Redis counter
database/namespace. Separate sites and test runs need isolated databases/namespaces. Store URLs,
credentials, table names and constructor prefixes belong in server-only configuration. The Node
adapters construct the configured stores; lower-level handlers need explicitly supplied stores.
For Postgres sessions, install the optional `pg` dependency and declare `import 'pg'`
in the server-only loader and `pg` in `serverExternalPackages`, as with the selected provider SDK.
Session constructors create their table and index; the database operator authorizes those operations. Reuse connections within an instance and dispose owned handlers during graceful shutdown.
Injected pools/clients remain the caller's responsibility.
Engine shutdown attempts every resource cleanup even when one fails, and rejects with an
`AggregateError` containing the failures; graceful-shutdown handlers should report that rejection.

Redis session retention uses the server's key TTL, renewed on writes. Postgres expires sessions on
read and removes expired rows during writes; idle databases need an operator-managed retention job
if physical deletion must happen on a schedule. Expired conversation sources cannot support a
follow-up without a new search. Session retention and the independent Redis budget counters have
separate lifetimes; session counters currently retain usage for 30 days, and daily counters use the
configured UTC bucket. Do not delete counters when resetting a conversation.

Shared storage supports sequential turns moving between instances and surviving process restarts.
Serialize turns for the same session. Session documents use read/modify/write updates; there is no
distributed lock, compare-and-swap or transactional conversation merge. Overlapping turns for one
session can overwrite messages/checkpoints/citation state. Use the same visitor-facing origin on
every replica: origin, coarse client IP and user agent participate in the session fingerprint.
Changing that fingerprint intentionally resets a session. Verify proxy trust separately on the host.

Redis sliding-window rate admissions are atomic per key and bound concurrent bursts across replicas.
Token/USD increments are also atomic per counter key. Budget checks refresh completed shared usage,
and successful response completion waits for usage recording, but budgets **do not reserve spend**.
Overlapping calls can all pass the check; output, later model steps and interrupted calls can exceed
the estimate. A synthetic local check deliberately admits $40 of overlapping output through a $15
threshold, records $40, then blocks later requests. These are fixture prices, not provider rates.
This is check-before/record-after admission, not a strict dollar cap or an exactly-once billing ledger.
Session and daily usage writes are separate operations; outages or abrupt termination can leave
partial accounting. Redis errors fail the current request; owned clients use a five-second connection
timeout and retry on a subsequent request after repair. There is no fallback to process-local counters.
Configure durability, backups, access control and connection capacity for the actual Redis/Postgres
services; client-process restart tests do not establish failover or crash durability of those services.

`/config` without a session returns a shared, language-independent catalog payload. Session probes
and mapped JSON errors use `private, no-store`, because their content can vary by session and locale.
Chat responses also disable storage; SSE additionally uses `no-transform` and disables proxy buffering.
Verify that the actual hosting/CDN configuration preserves these response headers.

Then go through the [production checklist](/deploy/checklist).


Applications own context loading and every tool implementation. Use complete explicit handlers or transports; an empty registry exposes no tools. See [the tool contract](https://github.com/EmilienxD/SiteBot/blob/main/docs/05-tools.md).
