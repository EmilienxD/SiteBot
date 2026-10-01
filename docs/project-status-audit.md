# Project status audit — 2026-09-30

The main chat/widget/agent implementation works, but the project is not ready to call fully done. The audit found knowledge-ingestion gaps, a native SQLite setup defect, missing live validation, and unfinished release work. **SQLite, robots enforcement, JavaScript rendering, the advertised retrieval refinements and live provider/infrastructure validation have since been completed**, as recorded below. The other gaps remain.

## Verified locally during the initial audit

Windows, Node 24.12.0, pnpm 10.26.1, current checkout.

| Check | Result |
| --- | --- |
| `pnpm build --force` | Pass: 10 tasks, no cache; Next.js example warns that file tracing includes too much of the project |
| `pnpm test` | 901 passed, 1 skipped, 67 files |
| `pnpm test:security` | 56 passed |
| `pnpm e2e` | 45 passed: Chromium, accessibility, desktop/mobile, visual baselines, iframe, client tools, cross-origin sidecar |
| `pnpm lint` | Pass on standalone rerun; the first run overlapped Playwright cleaning `test-results` and encountered an ENOENT race |
| `pnpm typecheck` | Pass; Turbo reused cached package results and the root e2e TypeScript check ran |
| `pnpm format:check` | Pass before adding this report |
| `pnpm check:packages` | Pass: publint and are-the-types-wrong for all seven packages |
| `pnpm size` | Pass: launcher 13.51 kB / 14, panel 22.36 kB / 24, total 35.86 kB / 38 gzip |
| `pnpm test:live` | Initially failed: “No test files found”. Now populated; see §5 |

Interactive Chrome checks used the shipped plain-HTML example on `http://localhost:4317`, the real CLI/server/widget, and the repository's **scripted offline model**. Verified launcher/greeting, message/response, tool navigation to `/shop`, conversation persistence across pages, approval focus on Deny, Enter denying the action, pending approval surviving reload, and Approve filling the wholesale form without submitting it. At 375 × 812 the panel fills the viewport and the composer remains visible. No real model response or retrieval quality was assessed by these interactions.

Local screenshots and logs are in the ignored `.sitebot/status-audit/` directory. The only tracked addition from this audit is this report.

## Remaining work, in priority order

### 1. SQLite knowledge store — resolved

[`vector-sqlite.ts`](../packages/core/src/node/vector-sqlite.ts) now enables extension loading during initialization, verifies sqlite-vec, then disables further extension loading. The runtime requirement is Node **22.13+**, when Node added the extension API. Load/initialization failures close the database and preserve the underlying cause.

Search uses a real `vec0` cosine index. Metadata filters apply before nearest-neighbor selection; chunks and vector entries stay synchronized in transactions. Existing JSON-only SQLite corpora migrate automatically, and clearing the corpus allows a forced rebuild with a new model/dimension. Original embeddings and citation metadata remain available. Zero vectors, finite-value validation and the extension's KNN request limit are handled explicitly.

The SQLite conformance suite now uses the actual extension instead of fake SQL, and required initialization errors fail rather than skip. Dedicated native tests cover persistence, migration, filtered ranking, updates/deletes, rollback, invalid embeddings and model/dimension changes. Real ingestion verifies first indexing, zero embedding calls on an unchanged rerun, forced model/dimension changes, and connection cleanup after success/failure. Windows x64 prebuilt loading is verified locally on Node 22.13 and 24. CI now includes Linux, Windows and macOS native runs on both Node versions; those remote jobs still need to execute after pushing. `sqlite-vec@^0.1.9` remains optional for consumers and is installed as a development dependency for required native tests.

Validation after these changes: build, lint, formatting, typecheck and package checks pass; **920 unit/integration tests and 56 security tests pass**. The Node 22.13 native/ingestion selection passes 54 tests, with one unrelated optional Upstash neighbour-expansion test skipped.

### 2. Crawler robots and retry behavior — resolved 2026-10-01

The original probe indexed `/blocked` without requesting robots.txt. Crawl and
sitemap ingestion now load cached rules per origin and check pages, redirect
targets and renderer resources before fetching. Crawl opt-out remains explicit.
Tests cover user-agent precedence, allow/disallow ties, wildcards, queries,
encoded paths, blocked seeds, redirects, missing/unavailable rules and opt-out.

HTTP and browser requests honor Retry-After seconds/dates on 429/503, with
bounded backoff retries. A per-host request gate limits concurrency to two and
spaces starts by 200 ms. Persistent server/network failures abort before index
writes; tests cover failure recovery and preserving the previous corpus.

### 3. JavaScript rendering — resolved 2026-10-01

`renderJs: true` now runs optional Playwright/Chromium for both web source
types. Isolated contexts execute scripts and API requests before extracting
the resulting DOM. Crawl discovers JavaScript-created links. Missing setup,
timeouts and network failures produce explicit errors. HTML-shell validators
are bypassed so changed API content is re-indexed; content hashes still avoid
embedding unchanged content. Doctor samples extraction and suggests rendering
for empty shells; offline mode never probes sources or starts Chromium.

`e2e/crawling.spec.ts` uses real Chromium and the real ingestion/store/server/
widget with offline embeddings and model. It verifies API-loaded content,
dynamic links, robots exclusions, 503 recovery, API changes behind an unchanged
HTML shell, and retrieval through the widget. Setup and doctor checks have
unit tests. Interactive Chrome navigation to the fixture was blocked with
ERR_BLOCKED_BY_CLIENT; automated Chromium verification succeeds.

Validation after the crawling changes: **955 unit/integration tests pass
(one unrelated optional-store test skipped), 56 security tests pass, and all
48 Chromium browser tests pass**. Build, typecheck, lint, formatting and all
seven package checks pass. The existing Next.js tracing warning remains.

### 4. Advertised retrieval refinements — completed 2026-10-01

- **Semantic splitting:** [`chunk.ts`](../packages/ingest/src/chunk.ts) embeds paragraph units and splits oversized sections at the largest cosine-distance gap. Heading metadata, bounded overlap and token ceilings are preserved. Ingest reports both embedding passes; unchanged runs skip them and dry runs estimate without spending.
- **Reranking:** [`rerank.ts`](../packages/core/src/knowledge/rerank.ts) implements Cohere HTTP and custom local cross-encoder modules. Retrieval overfetches and reranks before thresholding and final selection, including injected rerankers for host runtimes.
- **Explicit provider prompt caching:** [`cache.ts`](../packages/core/src/prompt/cache.ts) emits Anthropic cache controls and Bedrock cache points after stable prompt groups. Volatile content follows without metadata; provider fallback and final summary steps retain correct boundaries.

[`e2e/knowledge.spec.ts`](../e2e/knowledge.spec.ts) verifies real ingest, query embedding, reranking, Anthropic request serialization, streaming, source chips and citation navigation against deterministic local provider endpoints. Interactive Chrome also verifies both chat turns. These are offline contract checks; paid-provider cache hits and hosted reranker quality still belong to opt-in live validation.

Validation on Windows / Node 24.12.0: **977 unit/integration tests pass (one optional-store test skipped), 56 security tests pass, and all 49 Chromium browser tests pass**. Build, typecheck, lint, formatting and all seven package checks pass. Reranking is tested in `always`, `hybrid` and `tool` modes; tool-search citations now read the current results at stream completion, including after introductory text. The pre-existing Next.js file-tracing warning remains.

### 5. Real-provider and real-infrastructure validation — resolved 2026-10-01

`pnpm test:live` now has suites, each part gated on its own variable and
skipped without it (README → Development lists them). It exits 0 with no
credentials.

- **Providers** ([`chat.live.test.ts`](../packages/server/src/chat.live.test.ts)):
  through the real fetch handler, SSE streaming arrives over several network
  chunks; an agent-mode server tool is called and its output used; an
  approval-gated tool suspends, then runs on resume. Anthropic, OpenAI and
  Ollama.
- **Embeddings** ([`ingest.live.test.ts`](../packages/ingest/src/ingest.live.test.ts)):
  real ingest into SQLite and pgvector, keyword-free paraphrases retrieve the
  right source, and an unchanged rerun embeds nothing.
- **Stores** ([`stores.live.test.ts`](../packages/core/src/node/stores.live.test.ts)):
  the vector and session-store conformance suites, previously fakes only, run
  against real Postgres/pgvector, Redis and a scratch Upstash index, plus
  pool exhaustion, column width, Redis TTL expiry, cross-instance rate limits
  and concurrent usage accounting.

`pnpm e2e:live` ([`e2e/live/`](../e2e/live/widget.live.ts)) runs the
plain-html example in Chromium with a real model: page-context answer,
navigation with conversation carry-over, highlight, approval-gated form fill
that never submits, and Enter denying.

Real infrastructure found three pgvector defects that the fake driver hid; all fixed:

1. `upsert` called `end()` on pooled clients instead of `release()`, so
   `close()` hung after any write and the eleventh upsert waited forever.
2. The column was fixed at `vector(1536)`; every other embedding width
   (nomic-embed-text, voyage-3, text-embedding-3-large) failed. It is now an
   unsized `vector` unless `dimensions` is given.
3. Queries without `minScore` bound an unreferenced parameter, which Postgres
   rejects.

The fake pool now requires released clients and referenced parameters, so the
offline suite catches all three. The real-model browser run also found that
`highlight_section` guessed selectors from heading text (`#storing-beans`
for `#storage`). The page-context extract now carries heading ids
(`## [#storage] Storing beans`, docs/03 §10).

Run on Windows / Node 24.12.0 with Ollama `qwen2.5:14b` and
`nomic-embed-text`, pgvector/pgvector:pg17 and redis:7 in Docker: **35 live
tests pass** (stores, providers and ingest, each run separately). The other
17 skip because no Anthropic, OpenAI or Upstash credentials were available.
Without any credentials, `pnpm test:live` skips all 52 and exits 0. The
real-model browser tests passed **6/6, including the screen-reader live-region
check that has since been removed**. A final combined rerun did not happen,
because Docker and Ollama had stopped by then. Not verified:
paid providers, a hosted Upstash index, Bedrock/Vertex/Azure, prompt-cache
hits and deployed Workers. Run those suites when credentials exist.

One design limit was observed. `mode: chat` is one step (docs/04 §4), so a
server tool called there executes, but the visitor gets no answer text after
it. Chat mode suits client tools; tools whose output must be answered from
need `mode: agent`.

### 6. Resolve the onboarding departures

The implementation plan's semantic cost and provider caching questions are now resolved. Its Phase 9 onboarding acceptance records that inserting the script tag still requires one paste and that homepage drafting was not exercised in that recording. Resolve or explicitly accept those onboarding departures when updating the completion status.

### 7. Complete licensing and release

The repository has no LICENSE file and the seven public package manifests omit `license`. Choose the license and add consistent metadata. Packages are still version `0.0.0`, with an initial changeset queued. The release workflow exists, but publication is documented as not yet performed.

Verify npm scope ownership and publishing credentials/trusted-publishing setup, version the packages, publish, and verify installed tarballs, CDN lazy chunks, and SRI release notes. Repository secrets and registry ownership were not inspected during this local audit. The queued changeset is a **minor** release, so its current configuration targets 0.1.0, while the checklist is phrased as v1.0; make the intended release milestone explicit.

### 8. Update the completion claims and remaining build warning

The README, implementation plan and rule-to-test audit now cover robots, JS rendering, semantic refinement, reranking and explicit cache breakpoints. Keep these completion claims current as the remaining acceptance work lands.

Scope the Next.js example's file tracing so production output does not unintentionally include the whole workspace. The fresh build succeeds, but emits this warning; inspect the deployment artifact size before treating it as release polish only.

## Suggested next milestone

SQLite, crawling, the advertised retrieval refinements and live validation are
complete. Run the credential-gated live suites against the release providers,
choose the license and release version, and run the release gate.
