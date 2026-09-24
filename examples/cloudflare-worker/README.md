# Example: Cloudflare Workers (edge)

Tidepool Tours is a made-up kayak tour company. One Worker serves its page (from Workers static assets)
and the chat API. It shows the edge setup:

- **The fetch adapter.** `@sitebot/server/fetch` is a plain `(Request) => Response` handler.
- **Sessions in Workers KV.** `src/kv-session-store.ts` implements the four-method `SessionStore`
  over a KV binding.
- **Knowledge in Upstash Vector.** You run the ingest locally with the CLI, which writes to Upstash;
  the Worker only queries.
- **No Node.js in the bundle.** `wrangler.jsonc` doesn't enable `nodejs_compat`, so if anything
  Node-only were bundled, the build would fail.

## Run it

From the repo root, run `pnpm install && pnpm build` once. Then:

```bash
cd examples/cloudflare-worker
cp .dev.vars.example .dev.vars    # set OPENAI_API_KEY
pnpm dev                          # wrangler dev — http://localhost:8787
```

That's enough to chat, because `OPENAI_API_KEY` is the only required variable. Retrieval switches on
once Upstash is configured:

1. In the [Upstash console](https://console.upstash.com), create a Vector index with **1536 dimensions**
   (the size of `text-embedding-3-small`) and cosine similarity.
2. Put its REST URL and token in `.dev.vars` for the Worker, and in `.env.local` for the CLI (see
   `.env.example`).
3. With `pnpm dev` running, index the Worker's own page:

   ```bash
   pnpm ingest --dry-run             # what it would fetch, and the estimated cost
   pnpm ingest                       # embeds locally and writes to Upstash
   ```

4. Restart `pnpm dev` and ask "Which tour is best for a beginner?". The answer cites the page.

## Why the Worker wires things by hand

On Node, SiteBot loads provider SDKs by package name when it needs them. A Worker is a single bundle
and can't do that, so `src/worker.ts` imports the SDKs itself and passes them to the engine:

| Piece          | On Node                           | In this Worker                                         |
| -------------- | --------------------------------- | ------------------------------------------------------ |
| Chat model     | loaded from `backend.provider`    | `adapters: { openai: … }` with a static `createOpenAI` |
| Query embedder | loaded from `knowledge.embedding` | built from `openai.embedding(…)` and `embed()`         |
| Upstash index  | loaded from `@upstash/vector`     | `client: new Index({ url, token })`                    |
| Session store  | from `storage.type`               | `createKvSessionStore(env.SESSIONS)`                   |
| Config         | read from a file                  | `chatbot.config.ts`, imported and bundled              |

The config is TypeScript for the same reason: the bundler inlines it, and the CLI loads the same file
for `ingest` and `doctor`. `${env.X}` placeholders resolve from the Worker's bindings at runtime.

## Deploy

```bash
npx wrangler kv namespace create SESSIONS     # put the id in wrangler.jsonc
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put UPSTASH_VECTOR_REST_URL
npx wrangler secret put UPSTASH_VECTOR_REST_TOKEN
pnpm deploy
```

`pnpm build:check` runs `wrangler deploy --dry-run` and writes the bundle to `dist/` without uploading.
CI runs it on every change.

## Limits worth knowing

- **KV is eventually consistent.** That's fine for `mode: chat`. For `mode: agent`, where an approval
  must be read back reliably, use a Durable Object or Upstash Redis for sessions.
- **Rate limits are per isolate.** The default in-memory limiter isn't shared across Cloudflare's
  locations. Use Cloudflare's rate-limiting rules in front of `/api/chat`, or a shared store.
- **Bundle size.** The Worker is about 550 KB gzipped, within the free plan's 3 MB limit.
