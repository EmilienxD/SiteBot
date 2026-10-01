# @sitebot/ingest

## 0.1.0

### Minor Changes

- c431d39: First public release.

  - **Config**: one `chatbot.config` file, validated with errors that name the key and the fix, a JSON
    Schema for editor autocomplete, and `extends` for splitting a config between YAML and TypeScript.
  - **Engine**: chat and agent modes, approval-gated tools (HTTP, MCP, module, builtin and client),
    provider fallback, retrieval with citations, budgets, rate limits, PII redaction and guardrails.
  - **Server**: adapters for Next.js, Express, Fastify, Hono, Node and any fetch runtime, including
    Cloudflare Workers.
  - **Widget**: a `<site-chat>` element in a closed shadow root, about 13 KB gzipped before first open,
    accessible, light and dark, with SRI hashes in `@sitebot/widget/sri.json`.
  - **CLI**: `init`, `validate`, `doctor`, `ingest`, `dev` and `serve`.

### Patch Changes

- cacb12b: Fix SQLite knowledge indexes to load sqlite-vec on Node 22.13+ and use native cosine search with
  metadata filtering. Migrate existing indexes, synchronize vector writes and deletions transactionally,
  and support forced model/dimension changes. Ingestion now closes database connections on success and failure.
- Updated dependencies [c431d39]
- Updated dependencies [cacb12b]
  - @sitebot/config@0.1.0
  - @sitebot/core@0.1.0
