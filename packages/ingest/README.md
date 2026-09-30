# @sitebot/ingest

Builds the knowledge index for [SiteBot](https://github.com/EmilienxD/SiteBot): crawls sitemaps,
sites, Markdown files and OpenAPI specs, extracts and chunks the content, embeds it, and writes it to the
configured vector store. Unchanged pages are skipped by content hash, so re-runs are cheap.

You usually run it through the CLI:

```bash
npx sitebot ingest --dry-run   # what would be fetched, and the estimated embedding cost
npx sitebot ingest
```

- **`@sitebot/ingest`**: the pipeline. Node only.
- **`@sitebot/ingest/query`**: `createQueryEmbedder`, the one piece a request path needs. Edge-safe.

The embedding provider SDK is an optional peer, e.g. `@ai-sdk/openai` for `text-embedding-3-small`.

Crawl sources respect robots rules by default; sitemap pages also honor them.
`respectRobots: false` explicitly disables this for a crawl source. Rules are
cached per origin for each source, and redirect targets are checked before
fetching. Requests are spaced by 200 ms per host; 429/503 responses retry twice,
honoring `Retry-After`. Unavailable robots rules or persistent server errors
stop ingestion before it changes the index.

For JavaScript sites, install the optional renderer and enable
`knowledge.extract.renderJs: true`:

```bash
npm install playwright
npx playwright install chromium
```

Both crawl and sitemap pages render in isolated Chromium contexts, waiting for
network idle (30-second timeout). JavaScript-created links are discoverable by
the crawler. Browser resource requests also obey robots and retry rules.
Rendered pages are re-executed on every ingest; HTML-shell ETags cannot prove
that API-loaded content is unchanged. Content hashes still avoid unnecessary
embedding calls. Missing Playwright/Chromium or rendering failures produce
explicit errors. `sitebot doctor` samples web extraction and suggests this
switch for empty SPA shells; `--offline` skips that probe.

See [`docs/06-knowledge.md`](https://github.com/EmilienxD/SiteBot/blob/main/docs/06-knowledge.md).
