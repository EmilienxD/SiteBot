/**
 * @sitebot/ingest — layer 3, Node only.
 *
 * The build-time half of the knowledge layer: crawl → extract → chunk → embed →
 * write. Used by `sitebot ingest`, and importable directly so a CI pipeline can
 * refresh the index on deploy.
 *
 * Implemented in Phase 6 — see docs/06-knowledge.md.
 */

/** Knowledge source kinds. docs/02-configuration.md §9. */
export const SOURCE_TYPES = ['sitemap', 'crawl', 'files', 'openapi', 'text', 'json'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** Chunking strategies. docs/06-knowledge.md. */
export const CHUNK_STRATEGIES = ['semantic', 'heading', 'fixed'] as const
export type ChunkStrategy = (typeof CHUNK_STRATEGIES)[number]
