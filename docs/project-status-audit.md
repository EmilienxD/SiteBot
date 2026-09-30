# Project status audit — 2026-09-30

The main chat/widget/agent implementation works, but the project is not ready to call fully done. The audit found knowledge-ingestion gaps, a native SQLite setup defect, missing live validation, and unfinished release work. **The SQLite work has since been completed**, as recorded below. The other gaps remain; the README's claim that only licensing and publishing remain is too narrow.

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
| `pnpm test:live` | Fails: “No test files found”; this advertised suite is empty |

Interactive Chrome checks used the shipped plain-HTML example on `http://localhost:4317`, the real CLI/server/widget, and the repository's **scripted offline model**. Verified launcher/greeting, message/response, tool navigation to `/shop`, conversation persistence across pages, approval focus on Deny, Enter denying the action, pending approval surviving reload, and Approve filling the wholesale form without submitting it. At 375 × 812 the panel fills the viewport and the composer remains visible. No real model response or retrieval quality was assessed by these interactions.

Local screenshots and logs are in the ignored `.sitebot/status-audit/` directory. The only tracked addition from this audit is this report.

## Remaining work, in priority order

### 1. SQLite knowledge store — resolved

[`vector-sqlite.ts`](../packages/core/src/node/vector-sqlite.ts) now enables extension loading during initialization, verifies sqlite-vec, then disables further extension loading. The runtime requirement is Node **22.13+**, when Node added the extension API. Load/initialization failures close the database and preserve the underlying cause.

Search uses a real `vec0` cosine index. Metadata filters apply before nearest-neighbor selection; chunks and vector entries stay synchronized in transactions. Existing JSON-only SQLite corpora migrate automatically, and clearing the corpus allows a forced rebuild with a new model/dimension. Original embeddings and citation metadata remain available. Zero vectors, finite-value validation and the extension's KNN request limit are handled explicitly.

The SQLite conformance suite now uses the actual extension instead of fake SQL, and required initialization errors fail rather than skip. Dedicated native tests cover persistence, migration, filtered ranking, updates/deletes, rollback, invalid embeddings and model/dimension changes. Real ingestion verifies first indexing, zero embedding calls on an unchanged rerun, forced model/dimension changes, and connection cleanup after success/failure. Windows x64 prebuilt loading is verified locally on Node 22.13 and 24. CI now includes Linux, Windows and macOS native runs on both Node versions; those remote jobs still need to execute after pushing. `sqlite-vec@^0.1.9` remains optional for consumers and is installed as a development dependency for required native tests.

Validation after these changes: build, lint, formatting, typecheck and package checks pass; **920 unit/integration tests and 56 security tests pass**. The Node 22.13 native/ingestion selection passes 54 tests, with one unrelated optional Upstash neighbour-expansion test skipped.

### 2. Implement crawler robots and retry behavior

[`sources.ts`](../packages/ingest/src/sources.ts) never reads `source.respectRobots`, fetches/parses `robots.txt`, or honors `Retry-After`. Sending a named User-Agent does not enforce robots rules. This contradicts [knowledge §3.2](./06-knowledge.md).

An offline probe with `respectRobots: true` and a `robots.txt` disallowing `/blocked` requested and indexed both `/` and `/blocked`, without requesting robots.txt at all. Add robots parsing/enforcement and response-aware retry/backoff, with fixture tests covering blocked URLs and 429/503 responses.

### 3. Make `knowledge.extract.renderJs` work or reject the option clearly

The schema and generated reference advertise headless-browser fetching, but no execution path reads the setting. The comment in `sources.ts` says this is unimplemented and fails fast; it actually does neither rendering nor an explicit rejection.

An offline sitemap probe with `renderJs: true` and a page containing only an application shell returned **zero documents without throwing**. The described doctor check that diagnoses SPA extraction and suggests this switch is also absent. Implement the optional renderer and diagnostics, or reject unsupported use and update the documentation.

### 4. Finish or explicitly defer the advertised retrieval refinements

- **Semantic splitting:** [`chunk.ts`](../packages/ingest/src/chunk.ts), lines 8–13 and 202, documents its fallback to fixed packing. It never computes the embedding-distance split specified in [knowledge §3.4](./06-knowledge.md). An oversized single-section probe produced five chunks identical to `fixed`. Measure/implement the refinement or revise the specification to match the accepted simpler algorithm.
- **Reranking:** `knowledge.retrieval.rerank` validates and defaults to false, but [`retrieve.ts`](../packages/core/src/knowledge/retrieve.ts) never uses it. Implement the optional cross-encoder or reject/clearly mark `true` as unsupported.
- **Explicit provider prompt caching:** [engine §5](./04-providers-and-engine.md) requires provider cache breakpoints. Stable prompt ordering exists, but the engine passes one `system` string to `streamText` with no provider cache metadata/breakpoints. Finish provider-specific handling or formally defer it in the spec.

### 5. Add real-provider and real-infrastructure validation

[`vitest.config.ts`](../vitest.config.ts) declares a `live` project, but there are no `*.live.test.ts` files. `pnpm test:live` exits 1 even before credentials would be relevant. Postgres and Upstash conformance still uses fake drivers; SQLite conformance now runs against the real native extension.

Add opt-in tests for actual provider streaming/tool calling and hosted store behavior. Native SQLite on Windows is now verified by required offline tests. Keep paid provider calls outside default CI. The passing offline suites do not establish that real provider credentials, model IDs, hosted services, or deployed Workers work.

### 6. Record the remaining manual acceptance checks

[`screen-reader-check.md`](./screen-reader-check.md) contains a test script, but no results/version matrix. Before release, record NVDA/Windows and VoiceOver/macOS/iOS outcomes, especially whole-answer streaming announcements and approval focus. axe passing does not verify speech behavior.

The implementation plan still lists semantic quality/cost and provider caching as open questions; SQLite Windows packaging is resolved. Its Phase 9 onboarding acceptance records that inserting the script tag still requires one paste and that homepage drafting was not exercised in that recording. Resolve or explicitly accept these departures when updating the completion status.

### 7. Complete licensing and release

The repository has no LICENSE file and the seven public package manifests omit `license`. Choose the license and add consistent metadata. Packages are still version `0.0.0`, with an initial changeset queued. The release workflow exists, but publication is documented as not yet performed.

Verify npm scope ownership and publishing credentials/trusted-publishing setup, version the packages, publish, and verify installed tarballs, CDN lazy chunks, and SRI release notes. Repository secrets and registry ownership were not inspected during this local audit. The queued changeset is a **minor** release, so its current configuration targets 0.1.0, while the checklist is phrased as v1.0; make the intended release milestone explicit.

### 8. Update the completion claims and remaining build warning

Update the README, implementation plan, and rule-to-test audit after fixing or accepting the gaps above. In particular, the rule audit omits robots, JS rendering, semantic refinement, reranking, and explicit cache breakpoints while claiming all normative rules are covered.

Scope the Next.js example's file tracing so production output does not unintentionally include the whole workspace. The fresh build succeeds, but emits this warning; inspect the deployment artifact size before treating it as release polish only.

## Suggested next milestone

SQLite is complete. Fix crawler compliance and the silently ignored settings next. Add provider/hosted-store smoke tests and record manual accessibility results. Then choose the license and release version, update status docs, and run the release gate.
