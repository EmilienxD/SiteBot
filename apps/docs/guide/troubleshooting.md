# Troubleshooting

Start with `npx sitebot doctor`. Each line it prints has a name, and this page has an entry for every
one, in the same order. `npx sitebot doctor --production` adds a second list, further down. A test in
the repo fails if `doctor` gains a check that this page doesn't cover.

## `sitebot doctor`

### `env <VARIABLE>`

**"not set, and anthropic needs it."** The provider's key isn't in the environment and `backend.apiKey`
doesn't supply one. Add it to `.env.local` next to the config (for example `ANTHROPIC_API_KEY=…`), or set
`backend.apiKey: ${env.SOME_NAME}`. `doctor` shows the first and last characters of a key it finds, so
you can tell which key is in use without it being printed.

### `env jwt secret`

`security.auth.jwt.secret` resolved to an empty string: the environment variable behind it is unset. Set
it, or remove `auth.jwt` if you don't verify visitor identity.

### `provider <id>`

**"@ai-sdk/… is not installed."** Provider SDKs are optional dependencies, so a project only installs
the one it uses. Run the install command `doctor` prints, e.g. `npm i @ai-sdk/anthropic`. The same
message appears at runtime as `Provider "…" requires an optional dependency`, and the fix is the same.

Embedding providers and vector stores work the same way: `knowledge.store "upstash" requires the optional
dependency @upstash/vector`, or `"sqlite" requires … sqlite-vec`. Install the named package, or pick a store
that needs nothing: `memory` with a `path` saves the index as a JSON file.

### `provider health`

Skipped with `--offline`. Without it, `doctor` builds the engine and resolves the model exactly as the
server would, without sending a request or spending tokens.

### `health <check>`

The same checks `GET /api/chat/health` reports:

- **`health provider`** failed: the model couldn't be constructed. Usually a wrong `backend.provider` or
  `backend.model`, or a missing `backend.baseUrl` for `openai-compatible`.
- **`health storage`** failed: the session store couldn't be opened. For `redis` or `postgres`, check the
  URL and that the server is reachable. For `sqlite`, check that the directory is writable.
- **`health mcp:<id>`** failed: an MCP server didn't answer. For `stdio`, run the `command` yourself to see
  its error. For `http`, check the `url`.
- **`health knowledge`** degraded: the vector store isn't reachable. Chat keeps working without
  retrieval.

### `health overall`

The summary of the checks above: `ok`, `degraded` (chat works, something optional doesn't) or `error`.

### `inline secrets`

Something in the config looks like a real key: `sk-…`, a long token, a password. Move it to the
environment with `${env.NAME}`. Treat a key that has been committed as leaked and rotate it.

### `cors`

- **"allowedOrigins contains '\*'"**: wildcards are refused, because any page could then spend your
  tokens. List the exact origins that embed the widget.
- **"not valid origins"**: an origin is a scheme, a host and an optional port, with no path:
  `https://acme.com`, not `https://acme.com/`.
- **"plaintext http"** (warning): fine for `localhost`. In production the widget should talk to an
  `https://` origin.
- **"same-origin only"** is correct when the API route lives in the same app as the pages. A chat server on
  another origin must list the site's origin; see [Separate server](/deploy/sidecar).

### `knowledge`

"no sources configured" is information, not a problem: the assistant still uses `siteContext` and the
current page.

### `knowledge embedding`

`knowledge.sources` is set but `knowledge.embedding` isn't. Pick an embedding provider and model, e.g.
`{ provider: openai, model: text-embedding-3-small }`, then run `sitebot ingest`.

### `knowledge exclusions`

A crawl or sitemap source doesn't exclude `/admin`, `/account` or `/internal`. If a signed-in page is ever
linked from a public one, it ends up in the index. Add `exclude: ['/admin/**', '/account/**']` before
ingesting.

### `knowledge store`

"no index at …" for a `sqlite` store: nothing has been ingested yet. Run `sitebot ingest`.

### `knowledge extraction`

The online doctor samples up to three sitemap pages or the crawl seed, using the
same robots rules and extraction settings as ingestion. Skipped with `--offline`.
If every sampled page is shorter than `knowledge.extract.minChars`, check the
selector or enable `knowledge.extract.renderJs: true` for a JavaScript site.
Install the optional renderer with `npm install playwright` and
`npx playwright install chromium`. Missing browser setup, inaccessible sources,
and unavailable robots rules report a failure with a suggested fix.

### `knowledge index`

- **"no index has been built"**: run `sitebot ingest`, with `--dry-run` first to see the pages and the
  estimated cost.
- **"built with X but knowledge.embedding.model is Y"**: vectors from different models can't be mixed.
  Rebuild with `sitebot ingest --force`.
- **"0 documents"**: the sources matched nothing. Check the URLs, globs and `exclude` patterns;
  `--dry-run` lists what would be fetched.
- **"built N days ago"** (warning): re-run `sitebot ingest`. Unchanged pages cost no embedding calls.

### `storage`

"agent mode on memory storage": approvals and resumable runs live in memory and vanish on restart. Use
`sqlite` for one server, or `redis`/`postgres` for several.

### `storage url`

The storage URL still contains `${env.…}`, so the variable behind it is unset.

## `sitebot doctor --production`

These checks only matter in production. `ok` means the setting is in place. Two are reminders you
confirm yourself.

### `allowedOrigins`

List the site's real origins explicitly. With none, only same-origin requests work; with a wildcard, any
site could use your endpoint.

### `auth`

A tool can touch user data (`scope: authenticated`, or an `http` tool), but `security.auth.mode` isn't
`required`. Verify visitors with a JWT (`security.auth.jwt`) so one visitor can't query another's data.

### `approvals`

Every tool that isn't `readOnly` should need approval (`requiresApproval: true`, or listed in
`agent.approvalRequired`) so the visitor sees what's about to happen.

### `http allowHosts`

Give each `http` tool an explicit `allowHosts` list. It bounds where a templated URL can point, on top of
the private-network block.

### `mcp allow`

Each MCP import should list the tools it takes (`allow: [...]`). Without one, a new tool on the server
silently becomes available to the model.

### `budget alerting`

Set `security.budget.maxUsdPerDay` and send `budget_exceeded` events to a webhook, so a runaway day
reaches a person before the invoice does.

### `rateLimit store`

With more than one replica, each keeps its own in-memory counters. Use
`security.rateLimit.store: redis` so they share one window.

### `session storage`

`memory` and `none` don't survive a restart or span replicas. Use `redis`, `postgres` or `sqlite` (single
instance).

### `trustProxy`

Behind a load balancer, set `security.trustProxy` to its hop count. Otherwise every request appears to
come from the proxy and all visitors share one rate-limit bucket.

### `secrets`

Literal-looking secrets are in the config, or `.env`/`.env.local` aren't gitignored.

### `ingest freshness`

A reminder: run `sitebot ingest` after each site deploy (in CI) so answers match the live pages.

### `sensitive routes`

Routes like `/admin` or `/account` declared in `siteContext.routes` should also be excluded from page
context (`ui.pageContext.excludePaths`) and from web sources.

### `privacy footer`

Set `ui.footer.text` to a visible notice that conversations are processed by an AI and may be stored,
with a link to your privacy policy.

### `widget integrity`

A reminder: self-host the widget, or pin the CDN script to a version with an `integrity` hash.

## In the browser

**The launcher appears but the panel says "Assistant" and the input is disabled.** The widget couldn't
load `/config`. Open the network tab. A 404 on the page's own origin means `data-endpoint` points at the
wrong place; for a server on another origin it must be the full URL. A 403 means the origin isn't in
`security.allowedOrigins`.

**The script loads but nothing appears, and the console shows a CORS error for `sitebot.js`.** A
`<script type="module">` from another origin needs `Access-Control-Allow-Origin` on the script itself.
Serve it with the same origin allowlist as the API; the
[sidecar example](https://github.com/EmilienxD/SiteBot/tree/main/examples/express-sidecar)
shows how.

**Answers ignore the page.** Check `prompt.includePageContext` is on and the path isn't in
`ui.pageContext.excludePaths`. If the content lives outside `main`, `article` or `[role=main]`, set
`ui.extract.selector`.

**An HTTP tool always returns "The tool could not complete."** The server log line for `tool failed`
includes the cause chain, e.g. `ECONNREFUSED` or a blocked private address. Tools can't reach private
networks unless the executor sets `allowPrivateNetwork: true`.
