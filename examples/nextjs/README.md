# Example: Next.js (widget and API in one app)

The opt-in real Gemini gate runs from the repository root after building the packages:

```powershell
pnpm exec turbo run build --filter=@sitebot/cli... --filter=@sitebot/react...
pnpm acceptance:gemini --prepare-only
# Set GOOGLE_GENERATIVE_AI_API_KEY in your server environment or this example's .env.local.
pnpm acceptance:gemini --live
# To keep the successfully checked real localhost server open:
pnpm acceptance:gemini --live --keep-server
```

Lumen Bikes is a made-up e-bike shop built with the Next.js App Router. The chat API is one route file
and the widget is one client component, so it all deploys as a single app. It shows:

## Run it

From the repo root, run `pnpm install && pnpm build` once. Then:

```bash
cd examples/nextjs
cp .env.example .env.local        # set OPENAI_API_KEY — one key covers chat and embeddings
pnpm dev                          # http://localhost:3000
```

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

## Files

The handlers are built lazily because `next build` imports every route module. Loading the config at
import time would make the build need an API key.

The loader shares an in-flight initialization and clears a failed attempt so a repaired configuration
can recover in the same process. `server-only` keeps this module out of client components. The explicit
`@ai-sdk/openai` import and matching `serverExternalPackages` entry declare the chosen runtime SDK;
update both when choosing another chat provider. They do not construct a model or require a
build-time key. The standalone preparation script preserves the SDK's ordinary name as well as Next's
hashed external alias, so SiteBot's lazy factories resolve it after relocation.

## In your own app

Copy `lib/sitebot.ts`, the `app/api/chat` route and `app/sitebot.tsx`, then write a
`chatbot.config.yaml` (`npx sitebot init` will draft one). Remove the `outputFileTracingRoot` line in
`next.config.ts`, which exists only because this example lives in a monorepo. Keep
`outputFileTracingIncludes`: the config file is read at runtime, so the tracer can't find it by following
imports.

## Deploying

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

Applications own context loading and every tool implementation. Use complete explicit handlers or transports; an empty registry exposes no tools. See [the tool contract](https://github.com/EmilienxD/SiteBot/blob/main/docs/05-tools.md).
