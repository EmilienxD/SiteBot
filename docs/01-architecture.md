# 01 — Architecture

---

## 1. Monorepo layout

```
website-chatbot-template/
├── package.json                 # pnpm workspace root, turbo pipeline
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .changeset/
├── docs/                        # this spec set
├── packages/
│   ├── config/                  # @sitebot/config
│   ├── core/                    # @sitebot/core
│   ├── server/                  # @sitebot/server
│   ├── widget/                  # @sitebot/widget
│   ├── react/                   # @sitebot/react
│   ├── ingest/                  # @sitebot/ingest
│   └── cli/                     # @sitebot/cli   (bin: sitebot)
├── apps/
│   ├── playground/              # Next.js demo site = living integration test
│   └── docs/                    # documentation site
└── examples/
    ├── nextjs/
    ├── express-sidecar/
    ├── cloudflare-worker/
    └── plain-html/
```

**Tooling:** pnpm workspaces, Turborepo (`build`, `test`, `lint`, `typecheck`), changesets for versioning, tsup for library builds, Vite for the widget bundle, Vitest for unit/integration, Playwright for widget-in-real-page.

---

## 2. Package boundaries

The dependency graph is strictly acyclic and layered. **A package may only import from packages below it.**

```
                     ┌──────────────┐  ┌──────────────┐
       layer 4       │  @sitebot/   │  │  @sitebot/   │
       (entry)       │     cli      │  │  playground  │
                     └──────┬───────┘  └──────┬───────┘
                            │                 │
        ┌───────────────────┼─────────────────┼──────────────────┐
        │                   │                 │                  │
   ┌────▼─────┐      ┌──────▼──────┐   ┌──────▼──────┐   ┌───────▼──────┐
   │ @sitebot │      │  @sitebot/  │   │  @sitebot/  │   │  @sitebot/   │
   │ /ingest  │      │   server    │   │   widget    │   │    react     │
   └────┬─────┘      └──────┬──────┘   └──────┬──────┘   └───────┬──────┘
   layer 3                  │          layer 3 (browser)         │
        │                   │                 │                  │
        └─────────┬─────────┘                 └────────┬─────────┘
                  │                                    │
            ┌─────▼──────┐                             │
   layer 2  │  @sitebot/ │                             │
            │    core    │                             │
            └─────┬──────┘                             │
                  │                                    │
            ┌─────▼────────────────────────────────────▼─────┐
   layer 1  │              @sitebot/config                   │
            │   (schema + types — importable from browser)   │
            └────────────────────────────────────────────────┘
```

### `@sitebot/config` — layer 1

The schema. **Zero runtime dependencies beyond Zod and the parsers.** Must be importable in a browser bundle (the widget imports the `UiConfig` _type_ and the public-config validator).

```ts
export const ConfigSchema: z.ZodType<SiteBotConfig>
export type SiteBotConfig                 // full, server-side
export type PublicConfig                  // safe subset sent to the browser
export function loadConfig(pathOrObject, opts?): Promise<ResolvedConfig>
export function validateConfig(raw): Result<ResolvedConfig, ConfigError[]>
export function defineConfig(c: SiteBotConfigInput): SiteBotConfigInput
export function toPublicConfig(c: ResolvedConfig): PublicConfig
export function emitJsonSchema(): JSONSchema7   // build step → schema/chatbot.schema.json
```

Responsibilities: parse (yaml/json/toml/ts), merge `extends`, interpolate `${env.X}`, apply defaults, validate, and split public vs. private fields.

### `@sitebot/core` — layer 2

The engine. **No HTTP framework dependency. No Node-only APIs in the main entry** (Node-specific pieces — stdio MCP, fs-backed stores — live behind `@sitebot/core/node` subpath so edge builds tree-shake them out).

```ts
export function createEngine(config: ResolvedConfig, deps?: EngineDeps): Engine

interface Engine {
  handleChat(req: ChatRequest, ctx: RequestContext): Promise<Response> // SSE
  getPublicConfig(): PublicConfig
  health(): Promise<HealthReport>
  dispose(): Promise<void>
}
```

Internal modules:

| Module       | Responsibility                                                           |
| ------------ | ------------------------------------------------------------------------ |
| `providers/` | Resolve `backend` config → an AI SDK `LanguageModel`. Fallback chain.    |
| `prompt/`    | Compose system prompt from base + siteContext + pageContext + retrieval. |
| `tools/`     | Registry; the five executors; MCP client pool; approval bookkeeping.     |
| `agent/`     | The single loop. Step control, stop conditions, mode policy.             |
| `knowledge/` | Retrieval at request time. Vector store client interface.                |
| `session/`   | Session identity, history storage adapters, truncation.                  |
| `guards/`    | Rate limits, budgets, origin checks, PII redaction, injection wrapping.  |
| `stream/`    | UI Message Stream construction, custom data parts, error mapping.        |
| `telemetry/` | OTel spans, structured events, hook dispatch.                            |

### `@sitebot/server` — layer 3

Adapters only. Each is thin — normalise the framework's request into a Web `Request`, call `engine.handleChat`, translate the `Response` back.

```
@sitebot/server/next      → { GET, POST } route handlers
@sitebot/server/express   → RequestHandler middleware
@sitebot/server/fastify   → FastifyPluginAsync
@sitebot/server/hono      → Hono app / middleware
@sitebot/server/fetch     → (req: Request) => Promise<Response>   // Workers, Deno, Bun
@sitebot/server/node      → (req: IncomingMessage, res: ServerResponse) => void
```

Also exports `createServer(config)` — the standalone Hono app used by `sitebot serve` for topology T2.

### `@sitebot/widget` — layer 3, browser

The custom element. Preact + signals, Shadow DOM. Builds:

| Output                   | Use                                                                   |
| ------------------------ | --------------------------------------------------------------------- |
| `dist/sitebot.js` (IIFE) | `<script>` tag, auto-boots from `data-*` attributes                   |
| `dist/sitebot.mjs` (ESM) | bundler import                                                        |
| `dist/sitebot.css`       | _not shipped_ — styles are inlined into the shadow root by the bundle |

Budget: **≤ 25 KB gzip** for the IIFE bundle including Preact. Enforced by a CI size check.

### `@sitebot/react` — layer 3, browser

Optional `<ChatWidget config={...} />` for React sites that want the widget in their tree rather than as a global. Wraps the same custom element; does not fork the UI.

### `@sitebot/ingest` — layer 3, Node-only

Crawler → extractor → chunker → embedder → store writer. Used by the CLI and importable for CI pipelines.

### `@sitebot/cli` — layer 4

```
sitebot init            scaffold config + route + script tag, interactive
sitebot validate        validate config, print resolved view with secrets masked
sitebot ingest          build/refresh the knowledge index
sitebot dev             local dev server + playground page, config hot-reload
sitebot serve           production sidecar server (topology T2)
sitebot doctor          diagnose env vars, provider reachability, store health, CORS
```

---

## 3. Dependency rules (enforced by lint)

1. `config` imports nothing from the workspace.
2. `core` imports only `config`.
3. `server`, `ingest` import `core` and `config`.
4. `widget`, `react` import **types only** from `config` — never `core`.
5. Nothing imports `cli`.
6. `core`'s root entry must not import `node:*`. Node-specific code goes in `core/node`.
7. No package may import from another package's internal path — only its declared exports.

---

## 4. Request lifecycle

The complete path of one user message in agent mode with a knowledge lookup and an approval-gated tool.

```
Browser (widget)                    Server (@sitebot/server → core)          External
─────────────────                   ────────────────────────────────         ────────

1. user types, hits enter
2. capture page context
   {url,title,meta,extract}
3. POST /api/chat  ──────────────▶  4. adapter → Web Request
   {sessionId, messages,               5. GUARDS
    pageContext, auth}                    ├ origin allowlist
                                          ├ rate limit (ip + session)
                                          ├ budget check
                                          ├ verify auth JWT → identity
                                          └ PII redaction (inbound)

                                       6. SESSION
                                          load/merge history, truncate

                                       7. PROMPT COMPOSE
                                          system
                                          + siteContext
                                          + pageContext  ⟨untrusted⟩
                                          + retrieval (if mode=always)

                                       8. TOOL REGISTRY
                                          resolve http/mcp/module/
                                          builtin/client → AI SDK tools

                                       9. streamText(model, messages,
                                          tools, stopWhen)          ──────▶  LLM

   ◀──── SSE: text-start/delta ─────  10. stream opens

                                      11. model emits tool call
                                          `search_knowledge_base`
   ◀──── tool-input-available ──────
                                      12. builtin executor →
                                          vector store query      ──────▶  sqlite-vec
   ◀──── tool-output-available ─────      results back
   ◀──── data-citations ────────────      (custom data part)

                                      13. loop step 2 → LLM         ──────▶  LLM
   ◀──── text-delta ────────────────

                                      14. model calls `create_ticket`
                                          which is in approvalRequired
   ◀──── data-approval-request ─────      loop SUSPENDS, stream ends
                                          state persisted to session
15. widget renders confirm card
16. user clicks Approve
17. POST /api/chat  ──────────────▶  18. resume: approval granted
    {approvalId, decision}               http executor fires       ──────▶  Acme API
   ◀──── tool-output-available ─────
                                      19. loop step 3 → LLM         ──────▶  LLM
   ◀──── text-delta ────────────────
   ◀──── finish (usage metadata) ───  20. onFinish hooks:
                                          persist, telemetry,
                                          budget decrement
```

### Notes on the lifecycle

- **Steps 5–6 are non-negotiable ordering.** Guards run before any model or storage cost is incurred.
- **Step 7 wraps untrusted content.** Page context and retrieved documents are delimited and labelled as data, never as instructions. See [`08-security.md`](./08-security.md) §4.
- **Step 14's suspension** is the approval gate. The HTTP stream terminates cleanly; the loop state is checkpointed in the session store. The resume in step 17 is a fresh request that rehydrates and continues. This survives page reloads.
- **Client tools** (not shown) resolve differently: the server streams `tool-input-available` and ends the step; the widget executes locally and posts the result back to continue the loop. Same suspend/resume machinery as approvals.

---

## 5. Cross-cutting: `RequestContext`

Threaded through every layer. This is what tool executors receive.

```ts
interface RequestContext {
  requestId: string
  sessionId: string
  identity: Identity | null // verified from the auth JWT, or null if anonymous
  pageContext: PageContext | null
  origin: string
  locale: string
  ip: string | null
  signal: AbortSignal // client disconnect → abort model + tool calls
  logger: Logger
  budget: BudgetTracker // live token/cost accounting for this session
}
```

Rule: a tool executor **never** reads ambient globals for identity. If `ctx.identity` is null, an `scope: authenticated` tool refuses to run and returns a structured error the model can explain to the user.

---

## 6. Extension points

The template is opinionated but not closed. Five documented seams:

| Seam            | Interface                                                               | Registered via                                  |
| --------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| Provider        | AI SDK `LanguageModel` factory                                          | `providers.custom` in config, or `defineConfig` |
| Tool executor   | `(input, ctx) => Promise<unknown>`                                      | `module` executor or `defineConfig().tools`     |
| Vector store    | `VectorStore` (`upsert`, `query`, `delete`, `stats`)                    | `knowledge.store.type: custom` + module path    |
| Session storage | `SessionStore` (`get`, `set`, `append`, `delete`)                       | `storage.type: custom` + module path            |
| Lifecycle hooks | `onRequest`, `onMessage`, `onToolCall`, `onStep`, `onFinish`, `onError` | `defineConfig().hooks` only (code, by nature)   |

Every seam is an interface in `@sitebot/core`, exported so implementors get types.
