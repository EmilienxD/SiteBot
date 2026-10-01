# Example: Next.js (widget and API in one app)

Lumen Bikes is a made-up e-bike shop built with the Next.js App Router. The chat API is one route file
and the widget is one client component, so it all deploys as a single app. It shows:

- **The Next adapter.** `app/api/chat/[[...route]]/route.ts` serves `/api/chat` and its `/config`,
  `/feedback` and `/health` sub-routes.
- **`@sitebot/react`.** `app/sitebot.tsx` renders `<ChatWidget endpoint="/api/chat" />` from the root
  layout.
- **A server tool.** `find_service_slots` is an HTTP tool the engine calls on the server. It hits a mock
  booking API in the same app (`app/api/mock/service-slots`); the browser never sees that URL.
- **Knowledge from the site's own pages.** `pnpm ingest` reads `app/sitemap.ts`, embeds the pages and
  answers cite them.

## Run it

From the repo root, run `pnpm install && pnpm build` once. Then:

```bash
cd examples/nextjs
cp .env.example .env.local        # set OPENAI_API_KEY — one key covers chat and embeddings
pnpm dev                          # http://localhost:3000
```

In a second terminal, while `pnpm dev` is running, build the knowledge index:

```bash
pnpm ingest --dry-run             # pages found and estimated embedding cost
pnpm ingest                       # writes .sitebot/index.json
```

The chat works before you ingest. It answers from `siteContext` and the page the visitor is on, then
starts citing pages once the index exists.

To use Anthropic for chat, set `backend.provider: anthropic` and a Claude model in
`chatbot.config.yaml`, add `@ai-sdk/anthropic`, and set `ANTHROPIC_API_KEY`. Embeddings stay on
OpenAI because Anthropic has no embedding API.

## What to try

| Ask                                               | What it exercises                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| "Which bike fits on the train?" (after ingest)    | Retrieval with a citation chip linking to `/bikes`                |
| "When can I bring my bike in on Monday?"          | `find_service_slots`: server-side HTTP tool, result in the answer |
| "Is the workshop open on Saturday for a service?" | Same tool, closed-day answer from the mock API                    |
| "Take me to the service page"                     | Built-in `navigate`, restricted to `siteContext.routes`           |

## Files

| File                                  | Purpose                                                             |
| ------------------------------------- | ------------------------------------------------------------------- |
| `chatbot.config.yaml`                 | Provider, prompt, site facts, knowledge sources, tools, theme       |
| `lib/sitebot.ts`                      | Loads the config and builds the route handlers on the first request |
| `app/api/chat/[[...route]]/route.ts`  | The chat API, via `@sitebot/server/next`                            |
| `app/api/mock/service-slots/route.ts` | The mock booking API the server tool calls                          |
| `app/sitebot.tsx`                     | The widget                                                          |
| `app/sitemap.ts`                      | What `pnpm ingest` crawls                                           |

The handlers are built lazily because `next build` imports every route module. Loading the config at
import time would make the build need an API key.

## In your own app

Copy `lib/sitebot.ts`, the `app/api/chat` route and `app/sitebot.tsx`, then write a
`chatbot.config.yaml` (`npx sitebot init` will draft one). Remove the `outputFileTracingRoot` line in
`next.config.ts`, which exists only because this example lives in a monorepo. Keep
`outputFileTracingIncludes`: the config file is read at runtime, so the tracer can't find it by following
imports.

Prebuilt knowledge indexes also need an explicit tracing include. This example
includes `.sitebot/index.json` when it exists at build time; run ingestion before
the production build to ship an index. Session databases are runtime state and
are not included. If your config extends other files, loads a custom module, or
uses a prompt file, include those runtime inputs explicitly too.

## Deploying

Any Node host that runs Next.js works. The route uses `runtime = 'nodejs'` because it reads the config
file and stores sessions in SQLite. On a serverless host where the filesystem doesn't persist, switch
`storage` to `redis` or `postgres` and the knowledge store to `pgvector` or `upstash`. Before going live,
run `pnpm doctor --production` and read [`docs/deployment-checklist.md`](../../docs/deployment-checklist.md).

`pnpm build` produces standalone output and prepares its dependency links for
copying out of the monorepo (including pnpm's absolute Windows links). Copy
`.next/standalone` as the deployment root, preserving relative links, then copy
`.next/static` into `examples/nextjs/.next/static` beneath that root. If you add a
`public` directory, copy it to `examples/nextjs/public` there as well. Start with:

```bash
node examples/nextjs/server.js
```

Set `PORT`, `HOSTNAME`, provider secrets and production storage configuration on
the host. On Windows, enable Developer Mode or grant symbolic-link permissions
to produce portable dependency links. Use a copy/archive tool that preserves
directory symlinks, or build on Linux for a Linux deployment.

From the repository root, `pnpm check:nextjs-artifact` checks the actual traced
files and dependency links and reports uncompressed artifact sizes. Run
`node test/smoke/nextjs-standalone.mjs` to copy the bundle into a temporary directory
and verify pages, static assets, config, streamed chat and a server tool against
the offline model. CI runs both checks.
