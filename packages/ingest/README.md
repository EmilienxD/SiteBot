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
See [`docs/06-knowledge.md`](https://github.com/EmilienxD/SiteBot/blob/main/docs/06-knowledge.md).
