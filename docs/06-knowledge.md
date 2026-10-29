# 06 — Knowledge

How the assistant learns the website it lives on. Four layers, ordered cheapest-first. Layers 1 and 2 alone produce a genuinely useful assistant with zero infrastructure — that property is a hard requirement, because it determines whether `npx sitebot init` is impressive or disappointing.

| Layer                 | Source                       | Cost                        | Freshness  | Configured by               |
| --------------------- | ---------------------------- | --------------------------- | ---------- | --------------------------- |
| **L1 Site context**   | Hand-written facts in config | ~200 tokens/request         | Manual     | `siteContext`               |
| **L2 Page context**   | Live DOM of the current page | ~800 tokens/request         | Real-time  | `prompt.includePageContext` |
| **L3 Knowledge base** | Crawled + embedded corpus    | ~1500 tokens when retrieved | Build-time | `knowledge`                 |
| **L4 Live tools**     | The developer's APIs         | Per call                    | Real-time  | `tools`                     |

---

## 1. L1 — Site context

Covered in [`02`](./02-configuration.md) §6. Nothing to build beyond prompt composition. Worth restating why it earns its place: for a marketing site, ten hand-written facts plus a route list outperforms a badly-tuned RAG pipeline, and it costs nothing to run and nothing to maintain.

`sitebot init` bootstraps it: given a URL, it fetches the homepage, extracts the title, description, and nav structure, and writes a draft `siteContext` block for the developer to edit.

---

## 2. L2 — Page context

The highest value-per-token feature in the whole system. The assistant knows what the user is looking at right now.

Extraction algorithm is normative and specified in [`03`](./03-protocol.md) §10. Additional rules:

- **Never sent when `prompt.includePageContext: false`.** Some sites have pages the assistant must not see.
- `ui.pageContext.excludePaths` (glob list) suppresses extraction entirely on matching routes — checkout, account settings, anything with PII on screen.
- `ui.pageContext.redactSelectors` removes matching elements before extraction (default includes `input`, `[data-private]`, `.pii`).
- The extract is hashed; unchanged extracts are sent as `extractHash` and rehydrated server-side, which is a meaningful token saving during a multi-turn conversation on one page.
- Page context is **untrusted input**. A page can contain user-generated content, and a hostile comment saying "ignore your instructions" would otherwise be a live injection vector. Framing is normative — see [`08`](./08-security.md) §4.

---

## 3. L3 — The knowledge base

### 3.1 Pipeline

```
sources ──▶ fetch ──▶ extract ──▶ chunk ──▶ embed ──▶ store
                                                        │
                                          query ◀───────┘
```

Run by `sitebot ingest`, importable as `@sitebot/ingest` for CI.

### 3.2 Sources

| `type`    | Fields                                                                   | Notes                                                                                                                            |
| --------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `sitemap` | `url`, `include[]`, `exclude[]`, `maxPages`                              | Preferred. Fast, complete, respects the site's own view of itself.                                                               |
| `crawl`   | `url`, `maxDepth`, `maxPages`, `respectRobots`, `include[]`, `exclude[]` | Fallback when no sitemap. `respectRobots: true` by default.                                                                      |
| `files`   | `glob`, `baseUrl`                                                        | Local `.md`/`.mdx`/`.txt`/`.html`. `baseUrl` maps file paths to public URLs for citations.                                       |
| `openapi` | `url` or `path`                                                          | Each operation becomes a chunk: method, path, summary, parameters, example. Makes the assistant genuinely good at API questions. |
| `text`    | `id`, `content`                                                          | Inline blob for policies, FAQs, anything without a URL.                                                                          |
| `json`    | `path`, `jsonPath`, `template`                                           | Structured records (product catalog) rendered into text via a template.                                                          |

Crawl politeness: 2 concurrent requests per host by default, 200 ms delay, `User-Agent: sitebot-ingest/1.0 (+<primaryUrl>)`, honours `robots.txt` and `Retry-After`. These are defaults a developer _can_ raise for their own site, but the shipped values are conservative.

Robots checks apply to sitemap pages as well as crawl pages, and to redirect
targets and renderer resources before they are requested. Crawl sources can
explicitly opt out with `respectRobots: false`. Rules are cached per origin for
each source; user-agent groups, longest matching allow/disallow rules, wildcard
paths, query strings and encoded paths are supported. Missing robots files
(4xx except 429) allow access. Network errors, unavailable robots files and
persistent server errors stop ingestion before index writes. HTTP 429/503
responses retry twice, using `Retry-After` seconds or HTTP dates, otherwise
exponential backoff.

### 3.3 Extraction

```yaml
knowledge:
  extract:
    selector: main, article, [role="main"]
    strip: [nav, footer, aside, .cookie-banner, .sidebar]
    format: markdown
    minChars: 200
    renderJs: false
```

- Server-side HTML → Markdown via a readability-style main-content heuristic, with `selector` as an explicit override.
- Headings are preserved — they drive the chunker and make citations meaningful.
- Pages under `minChars` after extraction are skipped (nav-only shells, redirects).
- `renderJs: true` opts into a headless-browser fetch for SPA-rendered sites. Off by default because it is slow and adds a Playwright dependency; `sitebot doctor` detects "sitemap present but every page extracts to < 200 chars" and suggests it.

Install the optional peer with `npm install playwright` and install Chromium
with `npx playwright install chromium` (pnpm equivalents are supported).
Crawl and sitemap pages render in fresh contexts and wait for network idle,
with a 30-second timeout. JavaScript-created links are followed by crawl
sources. Browser/API requests obey robots and retry rules. Missing setup and
rendering errors fail explicitly. Rendered pages bypass conditional GETs:
an unchanged HTML-shell ETag says nothing about API-loaded content. Extracted
content hashes still make unchanged re-ingestion free of embedding calls.
The online doctor probes at most three sitemap pages or one crawl seed per
source; `--offline` never starts a browser or fetches sources.

### 3.4 Chunking

```yaml
chunk:
  strategy: semantic # semantic | heading | fixed
  maxTokens: 512
  overlapTokens: 64
  minTokens: 64
```

| Strategy             | Behaviour                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `heading`            | Split at `h1`–`h3` boundaries; oversized sections fall back to `fixed`. Best for documentation.                                          |
| `semantic` (default) | Heading-aware, then merges adjacent paragraphs until `maxTokens`, breaking at the largest embedding-distance gap when a split is needed. |
| `fixed`              | Token windows with overlap. Predictable, dumb, always works.                                                                             |

Semantic ingestion embeds paragraph units only for changed, oversized heading
sections, then splits recursively at the largest adjacent cosine-distance gap.
Final chunks are embedded separately with their heading prefix. This can roughly
double embedding input for oversized sections; the run summary includes both
passes. Unchanged documents make no embedding calls. `minTokens` prefers viable
boundaries, while the hard `maxTokens` ceiling and preserving all prose take
priority. Giant paragraphs use bounded units. Overlap adds a trailing excerpt
only when it fits the next chunk and stays within the same heading section.
The exported `chunkSemanticDocument(document, options, embedder)` performs this
asynchronous pass; synchronous `chunkDocument` requires it for oversized semantic
sections. `heading` remains a cheaper alternative for well-structured docs.
Rebuild an existing index with `sitebot ingest --force` to apply the new semantic
boundaries; unchanged documents deliberately retain their stored chunks.

Every chunk carries metadata that matters at query time:

```ts
interface Chunk {
  id: string // stable for unchanged text and heading within a document
  text: string
  embedding: number[]
  metadata: {
    url: string // for citations
    title: string
    headingPath: string[] // ["Docs", "API", "Authentication"]
    sourceId: string
    sourceType: string
    contentHash: string
    updatedAt: string
    tokens: number
    lang?: string
  }
}
```

`headingPath` is prepended to the chunk text before embedding (`Docs > API > Authentication\n\n<text>`). Cheap, and materially improves retrieval on documentation where a chunk's own text lacks context.

### 3.5 Embedding

```yaml
embedding:
  provider: openai
  model: text-embedding-3-small
  dimensions: 1536
  batchSize: 96
  apiKey: ${env.OPENAI_API_KEY}
```

Supported: `openai`, `google`, `mistral`, `cohere`, `voyage`, `ollama` (local, zero-cost), `openai-compatible`. Same lazy-registry pattern as language-model providers.

- Batched with concurrency 4 and retry/backoff.
- **The embedding model and document prefix are recorded in the index manifest.** Changing model, dimensions or `documentPrefix` invalidates the whole index; `ingest` detects the mismatch and requires `--force` for all sources. Silently mixing embedding spaces produces garbage retrieval that is very hard to debug.
- **Input conventions are model-specific.** Optional `documentPrefix` and `queryPrefix` prepend text only for embedding, preserving the original excerpts and metadata. Configure them from the model's official documentation; they default to no prefix. Cohere and Voyage adapters select query/document `input_type` automatically. Rebuild older Voyage indexes with `--force` to apply the document input type consistently. See the [multilingual guide](../apps/docs/guide/multilingual.md#documentation-languages) for Nomic's documented prefixes and the limits of its English model card.

### 3.6 Incremental indexing

`ingest` is idempotent and cheap to re-run:

1. Fetch each source, compute `contentHash` per document.
2. Compare against the manifest (`.sitebot/manifest.json`).
3. Unchanged → skip entirely, no fetch of body where `ETag`/`Last-Modified` allows a conditional request.
4. Changed → re-extract, re-chunk, re-embed **only the changed chunks** (chunk-level hashing).
5. Missing from source → delete its chunks.
6. Write the new manifest atomically.

Typical CI usage:

```yaml
- run: npx sitebot ingest --config chatbot.config.yaml
  env: { OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }} }
```

Output is a summary the developer can read: pages fetched, skipped, chunks added/updated/removed, tokens embedded, estimated cost.

### 3.7 Vector stores

One interface, five implementations.

```ts
interface VectorStore {
  upsert(chunks: Chunk[]): Promise<void>
  query(embedding: number[], opts: QueryOptions): Promise<ScoredChunk[]>
  deleteBySource(sourceId: string): Promise<void>
  deleteByIds(ids: string[]): Promise<void>
  stats(): Promise<{
    documents: number
    chunks: number
    lastIndexed: string
    model: string
  }>
  close(): Promise<void>
}
```

| `type`                 | Backing                                       | Good for                                              | Limits                          |
| ---------------------- | --------------------------------------------- | ----------------------------------------------------- | ------------------------------- |
| `memory`               | JSON file loaded into RAM, brute-force cosine | Dev, tiny sites                                       | ~5k chunks before latency hurts |
| `sqlite` **(default)** | `sqlite-vec` extension                        | Single-node self-hosting — the default recommendation | Not edge, not multi-writer      |
| `pgvector`             | Postgres + `pgvector`                         | Production, multi-replica, existing Postgres          | Needs the extension             |
| `upstash`              | Upstash Vector                                | Edge, serverless, zero-ops                            | Hosted, paid                    |
| `custom`               | `module` path                                 | Pinecone, Qdrant, Weaviate, Turbopuffer               | Developer's problem             |

The store the config names must be reachable at boot or `/health` reports `degraded` and knowledge tools are unregistered — the assistant keeps working without RAG rather than failing every request.

Initialization is lazy and shared across concurrent chat and health requests. A failed attempt degrades only those requests; the next chat or health request retries. Once the store and query embedder are ready, retrieval and citations resume and health reports the recovered store. A store opened during an incomplete attempt is closed before retrying; the engine owns successfully initialized stores and closes them on disposal.

A file-backed memory snapshot treats only a missing file as a new empty index. Corrupt JSON and read errors degrade knowledge and remain retryable after repair. The persisted indexing timestamp survives reload. Query-only loading and disposal preserve snapshot bytes and require no write to the artifact directory; ingestion mutations still persist atomically. A bundled snapshot can therefore provide small immutable public knowledge on a read-only runtime filesystem, but sessions and shared rate/budget state require their own deployment storage.

SQLite knowledge indexes require **Node 22.13+** and `sqlite-vec@^0.1.9` (prebuilt binaries; Windows x64, Linux x64/arm64, macOS x64/arm64). `vec0` performs cosine nearest-neighbor search on float32 vectors; metadata filters are applied before selecting `topK`. Original embeddings remain in the chunk table for document expansion. Upserts and deletions update both tables transactionally, and older JSON-only corpora migrate on open. Embeddings must have 1–8192 dimensions and finite float32 values. A model/dimension change requires `ingest --force` to clear the existing corpus before rebuilding. Requests above vec0's 4096-result KNN limit use extension-calculated cosine distances ordered and limited by SQLite.

### 3.8 Retrieval

```yaml
retrieval:
  mode: tool # tool | always | hybrid
  topK: 6
  minScore: 0.35
  maxContextTokens: 3000
  includeCitations: true
  rerank: false
  dedupeByUrl: true
  expandNeighbours: 1
```

| `mode`   | Behaviour                                                                                                                               | Default for   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `always` | Embed the user's message, retrieve, inject into the system prompt before the call. One extra embedding call, no extra model round-trip. | `mode: chat`  |
| `tool`   | Register `search_knowledge_base`; the model decides when and what to search. Better precision, costs a round-trip.                      | `mode: agent` |
| `hybrid` | Inject bounded `topK` results **and** expose the tool for follow-ups.                                                                    | opt-in        |

Query-time refinements:

Both `tool` and `hybrid` work in chat mode with `tools: []`. Search returns
bounded text excerpts, titles, actual source URLs and source languages, so the
model can read evidence and refine its query without a separate page-fetching
subsystem. Runtime search reads only the configured index. Source permissions,
host/redirect checks and SSRF protections belong to ingestion; a model cannot
supply a URL to fetch at query time. Keep the index limited to public content.

Inline retrieval and every tool search share stable citation numbers across a
stored conversation. Repeated hits reuse their number; later empty results do not erase
earlier evidence. Explicit `search_knowledge_base` builtin aliases share this
behavior. Tool excerpt text is always framed as untrusted, even when short.
Unavailable search is explained to the model even in tool-only retrieval mode.
`maxContextTokens` uses the existing approximate text-token estimator and clips
an oversized first chunk; result metadata and framing add a small envelope.

- **`expandNeighbours: 1`** — after scoring, pull the adjacent chunks of each hit from the same document. Cheap fix for the classic "the answer was in the next paragraph" failure.
- **`dedupeByUrl`** — at most one chunk per URL in the final set unless fewer than `topK` documents match; prevents one long page monopolising the context.
- **`minScore`** — below-threshold results are dropped. If _everything_ is below threshold, the engine injects an explicit "no relevant documentation found" note rather than silently supplying nothing, which is what stops the model confabulating.
- **`languagePreference`** — `relevance` (default) merges bounded global, exact-locale and family candidates, ranking by score with locale breaking ties. A weak same-language hit cannot suppress stronger foreign-language evidence just by passing the threshold. `locale-first` retains the former exact-locale → family → global fallback, where any suitable preferred-language hit suppresses other languages. Both preserve metadata filters, source URLs/languages and context budgets. Reranking uses one deduplicated combined pool; scores are model-dependent, not universal cross-language relevance guarantees. See the [multilingual guide](../apps/docs/guide/multilingual.md#documentation-languages).
- **`rerank`** — optional cross-encoder pass (Cohere Rerank or a custom local model). Off by default; extra latency and cost. `true` uses Cohere `rerank-v3.5` and `COHERE_API_KEY`; an object configures `provider: cohere`, `model`, `apiKey`, `baseUrl`, and `timeoutMs` (default 10 seconds), or `provider: custom` and `module`. Each store query overfetches to `4 × topK`; with locale queries the deduplicated combined pool contains at most `16 × topK` candidates. It is reranked once before thresholding, neighbour expansion, URL deduplication and token budgeting. `minScore` uses cross-encoder relevance scores when enabled. Malformed scores or provider failures report retrieval unavailable through the existing degraded-chat path.
- **`filter`** — metadata filters (`sourceType`, `lang`, custom tags) supported per query and settable per tool.

Custom modules resolve relative to the config file and export an object or a
factory returning this interface (the factory is reused per deployment config):

```ts
interface Reranker {
  rerank(query: string, documents: string[]): Promise<{ index: number; score: number }[]>
}
```

Return one finite score in `[0, 1]` for every document, using its original index.
Documents include their heading prefix. A host can also inject a `reranker` in
the engine's `KnowledgeDeps`, including for edge-hosted local models.

### 3.9 Citations

When `includeCitations: true`:

1. Retrieved chunks receive conversation-level numbers `[1]…[n]` in the prompt/tool results, keyed by indexed chunk identity, actual URL and language.
2. `<tool_policy>` instructs the model to cite with `[n]` when it uses a result.
3. The engine emits a `data-citations` part with `id: knowledge-citations` so resumes update it. Each source has an ID such as `c27` and its indexed `chunkId`; the number comes from the ID, never array position.
4. The widget renders chips only for `[n]` references with corresponding metadata, preserving the number even when sources are sparse. Clicking one opens the original URL and fires a `citation-click` event. Answers without markers show no chips.
5. At most 32 short source records (280-character excerpts) carry forward from trusted server history, plus the current run's bounded search results. The SDK data-part converter restores their mapping and untrusted excerpts to the model. A persistent session counter prevents reassigning old numbers after history eviction. Sources outside retained model history are not silently revived by a guessed marker; a fresh search can assign a new number. Session expiry/reset removes continuity. Stateless mode and legacy per-answer records without chunk identity require new retrieval for verified provenance. Source metadata establishes identity, not factual support for an arbitrary generated claim; model qualification still checks relevance and grounding.

---

## 4. L4 — Live tools

Documented in [`05`](./05-tools.md). The division of responsibility matters and should be stated in the developer docs:

| Question                       | Answered by             |
| ------------------------------ | ----------------------- |
| "What's your refund policy?"   | L3 — stable, documented |
| "What's on this page?"         | L2 — live DOM           |
| "What are your support hours?" | L1 — a one-line fact    |
| "Where is order ORD-4821?"     | L4 — live API           |

A common failure mode is developers trying to solve L4 questions with L3 (indexing an order database into a vector store). `sitebot init`'s scaffolded comments call this out explicitly.

---

## 5. `sitebot ingest`

```
sitebot ingest [--config <path>] [--source <id>] [--force] [--dry-run] [--concurrency <n>]
```

```
$ npx sitebot ingest

  Loading chatbot.config.yaml … ok
  Store: sqlite (./.sitebot/index.db)
  Embedding: openai/text-embedding-3-small (1536d)

  ▸ sitemap  https://acme.com/sitemap.xml
      412 URLs found, 388 after include/exclude filters
      342 unchanged (skipped)  ·  41 changed  ·  5 new  ·  2 removed
  ▸ files    ./content/**/*.md
      28 files, 3 changed
  ▸ openapi  ./openapi.yaml
      64 operations, unchanged

  Chunking …  187 chunks affected
  Embedding … 187 chunks (2 batches)  ~94k tokens  ≈ $0.002
  Writing   … done

  ✓ Index: 1,204 chunks across 480 documents
    Last indexed 2026-08-01T14:22:11Z
```

`--dry-run` reports what would change and the estimated embedding cost without writing or spending. Semantic dry runs count both paragraph and final-chunk embedding inputs, using neutral distances; boundaries and chunk counts are estimates until actual paragraph vectors are available. `sitebot doctor` runs a retrieval smoke test: three sample queries derived from `siteContext`, showing top hits and scores, so a developer can tell at a glance whether the index is any good.

---

## 6. Failure modes and mitigations

| Failure                                      | Mitigation                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| SPA site extracts to nothing                 | `doctor` detects it, suggests `renderJs: true`                                  |
| Index built with a different embedding model | Manifest check, refuse incremental, require `--force`                           |
| Vector store unreachable at boot             | `/health: degraded`, knowledge tools unregistered, chat still works             |
| Retrieval returns nothing relevant           | Explicit "no relevant documentation" note injected — suppresses confabulation   |
| One long page dominates results              | `dedupeByUrl`                                                                   |
| Answer spans a chunk boundary                | `expandNeighbours`                                                              |
| Stale index after a site deploy              | CI step; `/health` reports `lastIndexed`; `doctor` warns above 30 days          |
| Embedding costs surprise the developer       | `--dry-run` cost estimate; ingest prints actual cost                            |
| Sensitive page indexed by accident           | `exclude` globs; `doctor` flags URLs matching `/admin`, `/account`, `/internal` |

---

## 7. Testing

| Area        | Approach                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sources     | Fixture HTTP server serving a synthetic site with sitemap, nested pages, robots.txt. Assert filtering, depth, politeness delays, robots compliance.        |
| Extraction  | Fixture HTML corpus (docs page, marketing page, SPA shell, blog with comments). Snapshot the markdown output.                                              |
| Chunking    | Property tests: no chunk exceeds `maxTokens`; overlap is exact; heading paths are correct; reassembled chunks cover the source.                            |
| Incremental | Ingest twice unchanged → zero embedding calls. Modify one page → only its chunks re-embedded. Delete a page → its chunks removed.                          |
| Stores      | One conformance suite run against **all** implementations, including recall on a seeded corpus with known ground truth.                                    |
| Retrieval   | Golden set of 20 query→expected-doc pairs over the fixture site; assert recall@6 stays above a threshold. Regression guard for chunking/retrieval changes. |
| Cost        | Assert `--dry-run` estimate is within 5% of actual token usage on the fixture corpus.                                                                      |


## Documentation languages

Every source accepts optional `lang` (validated BCP-47), overriding HTML `<html lang>`
detection. Non-HTML documents need explicit metadata; no language is guessed from
URLs or prose. Ingest stores original `lang` and primary `language` metadata,
retains it through conditional HTTP requests, and tracks changes in the manifest.
Rebuild older indexes with `sitebot ingest --force` to populate these fields.

Inline and tool retrieval prefer suitable exact-locale results, then their language
family; only when none pass reranking/minScore do they use the normal all-language
search. All deployment filters, topK and context budgets still apply. Explicit
`filter.lang`/`filter.language` override automatic preference. Neighbor expansion
stays within the hit's source and language. Citations and prompt snippets preserve
actual URLs and original language; no translated destinations are fabricated and
no corpus-wide translation runs. Custom stores use the existing equality filters.
See the [multilingual guide](../apps/docs/guide/multilingual.md) for source examples,
fallback semantics and offline-test limitations.
