# Edge (Cloudflare Workers)

The chat API runs on Workers, Deno, Bun and Vercel Edge through the fetch adapter, a plain
`(Request) => Promise<Response>`. The edge has no filesystem and can't load packages by name at runtime,
so a Worker wires a few things by hand that a Node server loads by itself.

Runnable example:
[`examples/cloudflare-worker`](https://github.com/EmilienxD/SiteBot/tree/main/examples/cloudflare-worker),
with KV sessions, Upstash Vector for knowledge, and no `nodejs_compat` flag.

## What changes on the edge

| Piece          | On Node                                | On the edge                                          |
| -------------- | -------------------------------------- | ---------------------------------------------------- |
| Config         | read from `chatbot.config.yaml`        | a `chatbot.config.ts` object, bundled                |
| Chat model     | SDK loaded from `backend.provider`     | SDK imported by you, passed as `deps.adapters`       |
| Session store  | `storage.type`                         | one you pass as `deps.sessionStore` (KV, Durable Objects, Upstash Redis) |
| Knowledge      | store and embedder built from config   | `deps.knowledge`: `createUpstashVectorStore({ client })` and your embedder |

The part that matters:

```ts
import { createOpenAI } from '@ai-sdk/openai'
import { validateConfig } from '@sitebot/config'
import { createUpstashVectorStore } from '@sitebot/core'
import { createFetchHandler } from '@sitebot/server/fetch'
import { Index } from '@upstash/vector'
import config from '../chatbot.config'

let handler: Promise<(request: Request) => Promise<Response>> | undefined

export default {
  async fetch(request: Request, env: Env) {
    handler ??= (async () => {
      const result = validateConfig(config, { env })   // ${env.X} from Worker bindings
      if (!result.ok) throw new Error(JSON.stringify(result.errors))
      const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY })
      return createFetchHandler(result.value, {
        deps: {
          adapters: { openai: async (entry) => openai(entry.model) },
          sessionStore: createKvSessionStore(env.SESSIONS),
          knowledge: {
            store: await createUpstashVectorStore({
              url: env.UPSTASH_VECTOR_REST_URL,
              token: env.UPSTASH_VECTOR_REST_TOKEN,
              client: new Index({ url: env.UPSTASH_VECTOR_REST_URL, token: env.UPSTASH_VECTOR_REST_TOKEN }),
            }),
            embedder, // see the example: openai.embedding(…) wrapped with ai's embed()
          },
        },
      })
    })()
    return (await handler)(request)
  },
}
```

The example's `src/worker.ts` is the complete version, including the KV session store and the query
embedder.

## Knowledge: ingest locally, query on the edge

Ingest crawls and embeds pages, which needs Node, so it runs on your machine or in CI:

```bash
npx sitebot ingest       # reads chatbot.config.ts, writes vectors to Upstash
```

The Worker only queries. Use the same embedding model on both sides; the config file is shared, so they
can't drift.

## Nothing Node-only in the bundle

The packages keep Node-only code (SQLite, DNS pinning, stdio MCP) behind the Node adapters, and the
repo's CI bundles the edge entry points and fails on any `node:*` import. In your own Worker, leave
`nodejs_compat` off: if something Node-only slips in, the build fails instead of the first request.

## Limits

- **Sessions.** KV is eventually consistent. That's fine for `mode: chat`. For `mode: agent`, where an
  approval must be read back, use Durable Objects or Upstash Redis.
- **Rate limits.** The in-memory limiter is per isolate. Put Cloudflare's rate-limiting rules in front of
  `/api/chat`.
- **Tools.** `http`, `mcp` over HTTP and `client` tools work on the edge. `stdio` MCP servers and
  `module` tools loaded from a path don't.
