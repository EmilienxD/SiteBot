# 09 — Implementation Plan

Ordered phases with explicit acceptance criteria. Each phase is a coherent unit of work sized for one or two coding sessions and leaves the repo in a working state.

**Governing rule:** every phase ends with a demo you can run. No phase is "plumbing only".

---

## Phase 0 — Foundations

**Goal:** an empty monorepo that builds, tests, lints, and publishes.

| Deliverable                | Files                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| pnpm workspace + Turborepo | `package.json`, `pnpm-workspace.yaml`, `turbo.json`                                              |
| Shared TS config           | `tsconfig.base.json`                                                                             |
| Lint / format              | `eslint.config.js`, `.prettierrc`, dependency-boundary rule from [`01`](./01-architecture.md) §3 |
| Test harness               | `vitest.workspace.ts`                                                                            |
| CI                         | `.github/workflows/ci.yml` — typecheck, lint, test, build, size-limit                            |
| Release                    | `.changeset/config.json`                                                                         |
| Package skeletons          | 7 packages under `packages/*`, each with `package.json`, `src/index.ts`, `tsup.config.ts`        |

**Acceptance:** `pnpm build && pnpm test && pnpm lint` green on a clean clone. Importing `@sitebot/core` from `@sitebot/config` fails lint.

---

## Phase 1 — `@sitebot/config`

**Goal:** the config file is real, validated, and typed.

| Deliverable              | Notes                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Full Zod schema          | Every section of [`02`](./02-configuration.md). Split one file per section under `src/schema/`. |
| Loader                   | yaml / json / toml / ts / package.json, in the documented precedence order                      |
| `${env.*}` interpolation | Including `:-` defaults, missing-var fatal, env-sourced tracking for `toPublicConfig`           |
| `extends` merge          | Array/tool/object merge semantics per §1                                                        |
| Cross-field validation   | All 10 rules from §14                                                                           |
| `toPublicConfig`         | Explicit allowlist + mechanical env exclusion                                                   |
| `emitJsonSchema`         | Build step writing `schema/chatbot.schema.json`                                                 |
| Error formatting         | Path, value, expectation, fix, did-you-mean                                                     |

**Acceptance:**

- A 200-line kitchen-sink YAML validates and resolves.
- Each of the 10 cross-field rules has a test asserting the exact error message.
- Property test: no env-sourced value survives `toPublicConfig`.
- The emitted JSON Schema gives working autocomplete in VS Code (manually verified once, then snapshot-tested).

---

## Phase 2 — `@sitebot/core`, chat mode only

**Goal:** a working single-turn chatbot, no tools, no knowledge.

| Deliverable                                  | Notes                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Provider registry                            | Lazy import, install-hint errors, adapters for anthropic / openai / google / openai-compatible / ollama |
| Fallback chain                               | Retry classification, backoff, pre-first-token-only hopping, `provider_fallback` events                 |
| Prompt composer                              | The six ordered blocks, `{{variables}}`, untrusted framing                                              |
| Session store interface + `memory`, `sqlite` |                                                                                                         |
| History truncation                           | Token-budget based, never splits tool pairs                                                             |
| Guards                                       | Origin, key, rate limit (memory + interface), request size, message length                              |
| Engine `handleChat`                          | `streamText` → `toUIMessageStreamResponse`                                                              |
| `mapError`                                   | Fixed code table, no internal leakage                                                                   |
| Telemetry scaffolding                        | Logger, OTel spans, event dispatch                                                                      |

**Acceptance:**

- `createEngine(config).handleChat(req, ctx)` returns a valid SSE stream against `MockLanguageModelV2`.
- Prompt composition snapshot tests pass for all six-block permutations.
- Fallback tests cover: retry-then-succeed, retry-exhausted-then-hop, non-retryable-no-retry, mid-stream-no-hop.
- Guard ordering test: rate limit rejects before any model call is made.
- Zero real network calls in CI.

---

## Phase 3 — `@sitebot/server` + playground

**Goal:** the first end-to-end demo. Browser → server → model → browser.

| Deliverable                                           | Notes                                                    |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `fetch` adapter                                       | The base all others wrap                                 |
| `next`, `express`, `fastify`, `hono`, `node` adapters | Thin                                                     |
| `createServer`                                        | Standalone Hono app for `sitebot serve`                  |
| All four endpoints                                    | `POST /`, `GET /config`, `POST /feedback`, `GET /health` |
| CORS + preflight                                      | Per [`08`](./08-security.md) §7                          |
| `apps/playground`                                     | Next.js site with real content, mounting the route       |

**Acceptance:**

- `curl -N -X POST localhost:3000/api/chat -d '…'` streams tokens.
- `GET /api/chat/config` returns public config with no secrets (asserted in test).
- `GET /api/chat/health` reports provider latency.
- Adapter conformance suite: one shared test file run against all six adapters.

---

## Phase 4 — `@sitebot/widget`, core UI

**Goal:** the visual product. This is the phase where it starts looking like the reference.

| Deliverable                         | Notes                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Custom element + closed shadow root | `:host { all: initial }`, host style hardening                                             |
| Token stylesheet                    | All tokens from [`07`](./07-widget.md) §4, light + dark, contrast validation at build      |
| Launcher                            | Icon and pill variants, `showAfterMs`, `hideOnPaths`                                       |
| Panel shell                         | Header (avatar/title/close/divider), open/close animation, reduced-motion                  |
| MessageList                         | Bubbles, **attribution below assistant bubbles**, grouping, scroll-follow + jump-to-latest |
| Markdown renderer                   | ~3 KB whitelist renderer, XSS-safe                                                         |
| SuggestionRow                       | **Right-aligned pills**, all four action types                                             |
| Composer                            | Auto-grow, filled field, circular send/stop, key handling                                  |
| Footer                              | Legal text + link                                                                          |
| Streaming client                    | AI SDK framework-agnostic `Chat` + signals binding                                         |
| State machine                       | Including a visible `submitted` state                                                      |
| Page context extraction             | The 6-step algorithm from [`03`](./03-protocol.md) §10, with hashing                       |
| `window.SiteBot` API                | Queued before boot                                                                         |
| Persistence                         | sessionStorage/localStorage, namespaced keys, private-mode fallback                        |
| Responsive                          | Mobile full-screen sheet, dvh, visualViewport, safe areas                                  |
| A11y                                | Full §8 of [`07`](./07-widget.md)                                                          |

**Acceptance:**

- Playwright screenshots at 4 viewports × 2 themes match baselines, and a manual side-by-side against `example-from-ramp-website.png` is signed off.
- Hostile-CSS fixture pages (Tailwind preflight, Bootstrap, `* { color: red !important }`) leave the widget unaffected.
- axe-core clean in every state.
- `size-limit`: launcher (initial) ≤ 14 KB, panel (lazy) ≤ 24 KB, total ≤ 38 KB gzip — see [`07`](./07-widget.md) §1 for what sets those numbers.
- The widget never throws into the host page (error-injection test).

**Milestone: v0.1 — a configurable, good-looking, streaming chatbot.** Shippable on its own.

---

## Phase 5 — Tools and agent mode

**Goal:** the assistant can act.

| Deliverable                    | Notes                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Tool registry + wrapper        | Timeout, call caps, scope check, argument re-validation, structured errors             |
| Policy resolution              | The `resolvePolicy` function — the only `mode` branch                                  |
| Stop conditions                | `stepCountIs`, `tokenBudgetIs`, `wallClockIs`, `onMaxSteps: summarize`                 |
| `http` executor                | **All of [`08`](./08-security.md) §5 in this phase, not later**                        |
| `module` executor              | Path resolution, hot reload in dev                                                     |
| `builtin` executors            | `list_site_sections`, `get_page_context`, `get_time`, `submit_feedback`                |
| Approval gates                 | Checkpoint, `data-approval-request`, resume, binding, expiry, argument-hash caching    |
| Client tools                   | Suspend/resume, server-declared allowlist, the 7 built-in client tools, `registerTool` |
| Widget: ToolChip, ApprovalCard | Including focus behaviour and non-default Enter                                        |
| Tool description linting       | The 5 lint rules                                                                       |

**Acceptance:**

- A multi-step agent run with two tool calls completes end-to-end in the playground.
- The SSRF table-driven suite passes in full.
- Approval: approve, deny, replay-across-sessions (403), expiry (410), page-reload-then-resume.
- Client tool allowlist rejection tested in a real browser.
- `mode: chat` with a non-`readOnly` tool fails validation.

---

## Phase 6 — Knowledge

**Goal:** the assistant knows the website.

| Deliverable                     | Notes                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@sitebot/ingest`               | sitemap / crawl / files / openapi / text / json sources                                                   |
| Extraction                      | Readability-style + selector override, markdown output                                                    |
| Chunking                        | `heading`, `semantic`, `fixed`; `headingPath` prefixing                                                   |
| Embedding registry              | openai / google / mistral / cohere / voyage / ollama                                                      |
| Incremental indexing            | Manifest, content hashing, chunk-level diffing, model-mismatch guard                                      |
| Vector stores                   | `memory`, `sqlite` (sqlite-vec), `pgvector`, `upstash`, `custom` — one conformance suite                  |
| Retrieval                       | `always` / `tool` / `hybrid`, `expandNeighbours`, `dedupeByUrl`, `minScore` with explicit no-results note |
| `search_knowledge_base` builtin |                                                                                                           |
| Citations                       | `data-citations` part + widget source chips + `citation-click` event                                      |
| Degraded operation              | Store unreachable → `/health: degraded`, tools unregistered, chat still works                             |

**Acceptance:**

- Ingest the playground site; a golden set of 20 query→doc pairs holds recall@6 above threshold.
- Re-running ingest with no changes makes **zero** embedding calls.
- The conformance suite passes against all five stores.
- Changing the embedding model without `--force` fails with a clear message.
- Citations render and link correctly in the browser.

Crawler acceptance (2026-10-01): robots enforcement, redirect checks and
Retry-After behavior have fixture tests. `renderJs` now uses optional Playwright
and Chromium for crawl and sitemap pages; setup failures are explicit and
doctor diagnoses short extraction. `e2e/crawling.spec.ts` verifies asynchronous
API content, JavaScript-created links, robots-blocked documents/resources,
503 recovery, changed API content behind an unchanged shell, and real widget
retrieval with offline model/embeddings.

**Milestone: v0.5 — feature-complete agent.**

---

## Phase 7 — MCP

**Goal:** the tool ecosystem, and a clean path for developers to expose their own backend.

| Deliverable                    | Notes                                                                       |
| ------------------------------ | --------------------------------------------------------------------------- |
| MCP client pool                | http / sse / stdio transports, lazy connect, health, reconnect-with-backoff |
| Bulk `from: mcp` import        | `allow` / `deny` / `prefix`, missing-`allow` warning                        |
| Untrusted description handling | Length cap, injection framing                                               |
| Health integration             | Dead server degrades rather than fails                                      |
| Example MCP server             | In `examples/`, so developers have a starting point                         |

**Acceptance:** an in-process mock MCP server over both http and stdio; allow-filtering, prefixing, reconnect, and degraded-health all tested.

---

## Phase 8 — Security hardening and production controls

Much of this landed with its feature. This phase closes the gaps and proves the whole.

| Deliverable              | Notes                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| JWT verification         | HS256 + JWKS, all 7 rules from [`08`](./08-security.md) §3               |
| Rate limit `redis` store | Sliding window, multi-replica correct                                    |
| Budgets                  | Session/day token + USD, `pricing.json`, `degrade` / `message` / `error` |
| PII redaction            | Stable replacement tokens                                                |
| `blockedPatterns`        |                                                                          |
| `trustProxy`             | Configurable hop count                                                   |
| Full injection framing   | Randomised delimiters, stripping                                         |
| `pnpm test:security`     | Every suite from [`08`](./08-security.md) §13                            |
| Deployment checklist     | `docs/deployment-checklist.md` + `sitebot doctor --production`           |

**Acceptance:** `pnpm test:security` is a required CI check and passes. An external review pass against the [`08`](./08-security.md) checklist finds no gaps.

---

## Phase 9 — CLI and developer experience

**Goal:** `npx sitebot init` produces a working assistant in under five minutes.

| Command    | Behaviour                                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`     | Detects the framework (Next/Nuxt/SvelteKit/Astro/static); prompts for provider, model, site URL; fetches the homepage to draft `siteContext`; writes config with the `$schema` line, the route file, the script tag, and `.env.example` |
| `validate` | Resolved config with secrets masked, defaults explicit, lint warnings                                                                                                                                                                   |
| `ingest`   | Per [`06`](./06-knowledge.md) §5, with `--dry-run` cost estimate                                                                                                                                                                        |
| `dev`      | Local server + playground page, config hot-reload, request/stream inspector                                                                                                                                                             |
| `serve`    | Production sidecar                                                                                                                                                                                                                      |
| `doctor`   | Env vars, provider reachability, store health, CORS, index freshness, retrieval smoke test, inline-secret scan, `--production` checklist                                                                                                |

**Acceptance:** on a fresh Next.js app, `npx sitebot init && npx sitebot dev` yields a working, site-aware chatbot with one API key and no manual file editing. Timed and recorded.

**Recorded (2026-09-25):** a fresh `node:22` container, a `create-next-app --yes` app (not timed), and the seven packages installed from `pnpm pack` tarballs to stand in for npm. `npm i` took 6 s, `sitebot init -y --provider anthropic` 1 s, and `next dev` took 3 s to a healthy `/api/chat/health` (model resolved, `/config` served, `doctor` green). That's 10 s of tooling; the rest of the five minutes is choosing a provider and pasting a key. One deviation from "no manual file editing": `init` writes the config, the route and `.env.example`, but only *prints* the script tag for `app/layout.tsx` rather than editing it, because it never modifies an existing file. That's one paste, and the getting-started guide says so. The homepage-fetch step (`--site-url`) wasn't exercised, since the container had no site to fetch.

---

## Phase 10 — Examples, docs, release

| Deliverable                  | Notes                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `examples/nextjs`            | Topology T1                                                                      |
| `examples/express-sidecar`   | Topology T2, with a Django host page                                             |
| `examples/cloudflare-worker` | Topology T3, upstash store                                                       |
| `examples/plain-html`        | No build step at all                                                             |
| `apps/docs`                  | Getting started, config reference (generated from Zod), recipes, troubleshooting |
| Recipes                      | Ecommerce assistant, docs assistant, lead-capture bot, support triage            |
| Release                      | Changesets, provenance, SRI hashes published                                     |

**Acceptance:** every example runs from a clean clone with only an API key set. Docs config reference is generated, so it cannot drift from the schema.

**Status:** the four examples are done, each with a README and `.env.example`. CI runs `doctor` on each, smoke-tests the Next.js and Express servers against a scripted offline model, and dry-run bundles the Worker, failing on any `node:*` import. The browser suite (`e2e/`) covers plain-html and the cross-origin sidecar. `cloudflare-worker` chats with only an OpenAI key; its Upstash retrieval additionally needs an Upstash index. The VitePress docs site, generated config reference, four recipes, changeset, provenance release workflow, and SRI manifest are implemented. Publishing has not happened yet.

---

## Dependency graph between phases

```
0 ──▶ 1 ──▶ 2 ──▶ 3 ──▶ 4 ──▶ 5 ──▶ 6 ──▶ 7
                         │      │      │
                         └──────┴──────┴──▶ 8 ──▶ 9 ──▶ 10
```

Phases 5, 6 and 7 are independently parallelisable once 4 lands, if more than one session works at a time. Phase 8 must follow all of them.

---

## Testing strategy summary

| Level         | Tool                                  | Scope                                                              |
| ------------- | ------------------------------------- | ------------------------------------------------------------------ |
| Unit          | Vitest                                | Schema, prompt composition, chunking, executors, policy resolution |
| Integration   | Vitest + `MockLanguageModelV2` + MSW  | Engine loops, suspend/resume, fallback, adapters                   |
| Conformance   | Vitest, one suite × N implementations | Vector stores, session stores, server adapters                     |
| Browser       | Playwright                            | Widget rendering, isolation, streaming, a11y, mobile, client tools |
| Visual        | Playwright screenshots                | 4 viewports × 2 themes                                             |
| Security      | Vitest, `test:security`               | SSRF, JWT, XSS, injection, CORS, rate limit, budget                |
| Size          | size-limit                            | Bundle budgets                                                     |
| Live (opt-in) | Vitest, `test:live`                   | Real provider smoke tests, gated on env vars, never in default CI  |

**Hard rule:** no test in the default CI pipeline makes a real network call to a provider.

---

## Definition of done for v1.0

- [ ] All ten phases complete with their acceptance criteria met
- [x] `pnpm build && pnpm test && pnpm test:security && pnpm lint` green
- [x] Widget bundle within the `size-limit` budgets of [`07`](./07-widget.md) §1 — the initial payload is the number that matters, and the panel is lazy
- [x] axe-core clean across all widget states (`e2e/a11y.spec.ts`: 6 states × 2 themes, plus the mobile sheet)
- [x] All four examples run from a clean clone (CI: `doctor` on each, smoke runs, a Worker dry-run bundle; `cloudflare-worker` retrieval also needs an Upstash index)
- [x] `npx sitebot init` to working chatbot in under five minutes, verified on a fresh machine (Phase 9, recorded above)
- [x] Config reference docs generated from the Zod schema (`apps/docs`, checked in the build and the tests)
- [x] Deployment security checklist published and enforced by `doctor --production`
- [x] Every normative rule in docs 02–08 has at least one corresponding test — see [`rule-audit.md`](./rule-audit.md); screen-reader behaviour is a manual check ([`screen-reader-check.md`](./screen-reader-check.md))

---

## Open questions to resolve during implementation

Recorded here rather than guessed at now. None blocks Phase 0–2.

1. ~~**AI SDK `Chat` class API surface.**~~ **Resolved:** the widget does not use `ai` at runtime. `AbstractChat` and its transport cost ~40 KB gzip and broke the launcher budget, so `packages/widget/src/ui-stream.ts` is a small UI Message Stream reader. `ai` stays a dev dependency, and a conformance test replays real `ai`-produced streams through the reader so it cannot drift from the wire format.
2. ~~**Exact `@ai-sdk/*` major versions**~~ **Resolved:** the `ai@6` lines are `@ai-sdk/openai-compatible@^2` (also used for `ollama`), `@ai-sdk/amazon-bedrock@^4`, `@ai-sdk/google-vertex@^4`, and `^3` for the rest. They are pinned in `PROVIDER_PACKAGE_RANGES` (`@sitebot/config`) and used by install hints and `sitebot init`. The provider registry rejects a model whose spec version is not v2/v3 and names the right release line.
3. ~~**sqlite-vec packaging on Windows.**~~ **Resolved (2026-09-30):** `sqlite-vec@^0.1.9` supplies a working Windows x64 prebuilt DLL; native tests load it and exercise real vec0 cosine queries, migration, persistence and transactions. SQLite knowledge indexes require Node 22.13+ for extension loading. CI includes Linux/Windows/macOS native coverage on Node 22.13 and 24. The extension remains an optional peer for consumers; required tests install it as a dev dependency.
4. ~~**Semantic chunking cost.**~~ **Resolved (2026-10-01):** changed oversized sections embed paragraph units before selecting cosine-distance boundaries, then embed final chunks. The offline topic-shift probe separates shipping from returns where token packing would combine them; the run counts both passes (roughly twice the input for oversized sections). Unchanged runs skip both passes; dry runs estimate without spend. `heading` is documented as the cheaper option.
5. ~~**Prompt-cache breakpoint placement.**~~ **Resolved (2026-10-01):** stable groups precede page/retrieval blocks. Anthropic ephemeral cache controls and Bedrock cache points are emitted per provider attempt, including fallback and final summary steps. Other providers retain ordered strings and their automatic caching; opaque prompt-hook rewrites have no inferred boundaries. The browser fixture verifies actual Anthropic HTTP cache controls across two turns.
