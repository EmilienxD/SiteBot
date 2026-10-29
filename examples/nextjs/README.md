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

The default `gpt-5-mini` model has no shipped price entry. Before enabling
`security.budget.maxUsdPerDay`, configure `backend.pricing["openai:gpt-5-mini"]`
with your applicable `inputUsdPerMillion` and `outputUsdPerMillion` rates (and
prices for any fallback or `budget.degradeTo` models). `sitebot validate` and
doctor check pricing; engine creation rejects dollar caps with missing prices.
Without a dollar cap, token-only budgets work with any model ID.

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

The loader shares an in-flight initialization and clears a failed attempt so a repaired configuration
can recover in the same process. `server-only` keeps this module out of client components. The explicit
`@ai-sdk/openai` import and matching `serverExternalPackages` entry declare the chosen runtime SDK;
update both when choosing another chat/embedding provider. They do not construct a model or require a
build-time key. The standalone preparation script preserves the SDK's ordinary name as well as Next's
hashed external alias, so SiteBot's lazy factories resolve it after relocation.

## In your own app

This example intentionally exposes a booking-slot lookup and browser `navigate` tool. For a
documentation-only integration, replace `tools` with `[]`, set `mode: chat` and
`knowledge.retrieval.mode: tool`, and use the prompt and limits in the
[generic docs Q&A recipe](../../apps/docs/recipes/docs-assistant.md). Automatic search then returns
bounded indexed excerpts and citations without exposing browser actions, mutations or account APIs.
The same Next.js route works for either configuration; keep provider keys in its server environment.

Copy `lib/sitebot.ts`, the `app/api/chat` route and `app/sitebot.tsx`, then write a
`chatbot.config.yaml` (`npx sitebot init` will draft one). Remove the `outputFileTracingRoot` line in
`next.config.ts`, which exists only because this example lives in a monorepo. Keep
`outputFileTracingIncludes`: the config file is read at runtime, so the tracer can't find it by following
imports.

Prebuilt knowledge indexes also need an explicit tracing include. This example
includes `.sitebot/index.json` when it exists at build time; run ingestion before
the production build to ship an index. The example's Turbo inputs include that snapshot and the
standalone preparation script, so changing them invalidates a cached build. Session databases are runtime state and
are not included. If your config extends other files, loads a custom module, or
uses a prompt file, include those runtime inputs explicitly too.

## Deploying

The example uses `runtime = 'nodejs'` because it reads the config and stores sessions in SQLite.
SQLite needs a durable writable volume on a persistent single-node host. For serverless/multiple
instances, use `storage: redis` or `postgres` for conversations/citations and independently configure
`security.rateLimit.store: redis` for shared rate and token/USD counters. An immutable prebuilt JSON
knowledge snapshot can be bundled and read into each instance's memory; ingestion/redeployment updates
it. Query-only load/disposal does not rewrite it. Use `pgvector` or `upstash` for externally managed
knowledge instead. External stores, proxy IP trust, function duration, streaming and disconnect behavior
still require actual hosted validation; local standalone success does not verify them. See the
[deployment guide](../../apps/docs/deploy/in-app.md) for requirements and official framework/hosting references.
Before going live,
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

For the complete local production boundary check, run:

```bash
node test/smoke/nextjs-build.mjs
```

This creates an isolated copy under the ignored `.sitebot/` directory, builds the real example without
provider credentials or dotenv files, and traces a small synthetic public snapshot present before
build. It relocates the artifact into a fresh temporary directory, checks every dependency link, and
runs the actual Next server with file reads confined to the deployment and writes confined to the
fixture's SQLite state directory. No source-checkout fallback is permitted. Requires Node 24+ for the
permission checks and an already installed Playwright Chromium; it never installs a browser or model.

The Q&A fixture has `tools: []`, bounded indexed search, a four-step ceiling, 180 output tokens and
English/French controls. Synthetic loopback OpenAI Responses/embedding endpoints replace inference,
while the provider SDK, Next route, SQLite, SSE, widget and browser assets are real. Checks include
keyless build, lazy-config recovery, source IDs across process restart, language/session isolation,
incremental text timing, cancellation, corrupt-index and provider/store recovery, rate/budget errors,
and synthetic credential canaries in HTTP responses and browser assets/maps. No public source maps are
enabled by this example; the harness probes them and scans any it finds. Processes and temporary files
belonging to the run are removed. Counter reset across a process restart is expected for this fixture's
memory counters and demonstrates why they are insufficient for serverless deployment.

This verifies a local production artifact only. It does not qualify real generation/embedding quality,
validate a cloud deployment, or integrate another website. The existing live model-quality gate remains
separate and failed for the tested local Qwen/Nomic pair.
