/**
 * `@sitebot/ingest/query` — the one piece of ingest a request path needs.
 *
 * Query-time retrieval embeds the user's question with the same model the
 * index was built with. That is edge-safe (it is an `ai` call and nothing
 * else), unlike the rest of this package, which crawls and writes files — so
 * it gets its own entry, and a Workers deployment (docs/00 T3) can import it
 * without dragging the pipeline's `node:*` imports into the bundle.
 */
export { createQueryEmbedder } from './query-embedder.js'
