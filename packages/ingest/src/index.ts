/**
 * `@sitebot/ingest` — the knowledge pipeline, layer 3, docs/06-knowledge.md.
 *
 * The pipeline runs from `sitebot ingest` (the CLI) or directly here from CI.
 * Query-time retrieval lives in `@sitebot/core` (`knowledge/*`), which the
 * server instantiates with the same config block; this package never serves.
 */

export const SOURCE_TYPES = ['sitemap', 'crawl', 'files', 'openapi', 'text', 'json'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]
export const CHUNK_STRATEGIES = ['semantic', 'heading', 'fixed'] as const
export type ChunkStrategy = (typeof CHUNK_STRATEGIES)[number]

export { runIngest } from './pipeline.js'
export type { IngestOptions, IngestRun } from './pipeline.js'

export { chunkDocument } from './chunk.js'
export type { DocumentInput, RawChunk } from './chunk.js'
export { extract, parseHtml, querySelectorAll } from './extract.js'
export type { ExtractedPage, ExtractOptions } from './extract.js'
export {
  createEmbeddingModel,
  dollarsPerMillionTokens,
  embedChunks,
} from './embedding.js'
export type { EmbeddingAdapter, EmbeddingConfigLike } from './embedding.js'
export { createQueryEmbedder } from './query-embedder.js'
export {
  assertModelCompatible,
  ModelMismatchError,
  readManifest,
  writeManifest,
} from './manifest.js'
export type { Manifest, ManifestDocument, ManifestSource } from './manifest.js'
export { sha256 } from './hash.js'
