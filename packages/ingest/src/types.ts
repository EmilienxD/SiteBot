import type { KnowledgeSource } from '@sitebot/config'

/**
 * One fetched source document, before extraction and chunking.
 *
 * A `null` body means "unchanged, skip the body work": sources that can check
 * freshness without downloading (`{text}`, `files` mtime, `sitemap`
 * conditional requests) use it; unconditional sources always carry a body.
 */
export interface SourceDocument {
  url: string
  title?: string
  /** Raw HTML or text. `null` signals "known unchanged from the manifest". */
  body: string | null
  contentHash: string
  lang?: string
}

export interface SourceResult {
  id: string
  type: KnowledgeSource['type']
  label: string
  documents: SourceDocument[]
  /** URLs the source was checked against but skipped as unchanged. */
  unchanged: number
  removed: number
}

export interface FetchOptions {
  fetchImpl?: typeof fetch
  /** Documents already in the manifest for this source, for conditionalGet. */
  previous?: Map<string, { contentHash: string; etag?: string; lastModified?: string }>
  concurrency?: number
  onProgress?: (message: string) => void
}

export function sourceId(source: KnowledgeSource): string {
  return 'id' in source && source.id !== undefined ? source.id : source.type
}
