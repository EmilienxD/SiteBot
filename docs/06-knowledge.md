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
- **The embedding model is recorded in the index manifest.** Changing model or dimensions invalidates the whole index; `ingest` detects the mismatch and refuses to run incrementally, telling the developer to `--force` a rebuild. Silently mixing embedding spaces produces garbage retrieval that is very hard to debug.

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
| `hybrid` | Inject top-3 always **and** expose the tool for follow-ups.                                                                             | opt-in        |

Query-time refinements:

- **`expandNeighbours: 1`** — after scoring, pull the adjacent chunks of each hit from the same document. Cheap fix for the classic "the answer was in the next paragraph" failure.
- **`dedupeByUrl`** — at most one chunk per URL in the final set unless fewer than `topK` documents match; prevents one long page monopolising the context.
- **`minScore`** — below-threshold results are dropped. If _everything_ is below threshold, the engine injects an explicit "no relevant documentation found" note rather than silently supplying nothing, which is what stops the model confabulating.
- **`rerank`** — optional cross-encoder pass (Cohere Rerank or a local model). Off by default; measurable gain on large corpora, extra latency and cost.
- **`filter`** — metadata filters (`sourceType`, `lang`, custom tags) supported per query and settable per tool.

### 3.9 Citations

When `includeCitations: true`:

1. Retrieved chunks are numbered `[1]…[n]` in the prompt with their titles and URLs.
2. `<tool_policy>` instructs the model to cite with `[n]` when it uses a result.
3. The engine emits a `data-citations` part with the full list.
4. The widget renders numbered source chips below the message; clicking one opens the URL and fires a `citation-click` event.
5. Citations referencing chunks the model did not actually cite are still sent — the widget shows only those referenced in the text, keeping the UI honest.

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

`--dry-run` reports what would change and the estimated embedding cost without writing or spending. `sitebot doctor` runs a retrieval smoke test: three sample queries derived from `siteContext`, showing top hits and scores, so a developer can tell at a glance whether the index is any good.

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
