/**
 * The knowledge-base vector store — docs/06-knowledge.md §3.7.
 *
 * One interface, five implementations. `memory` ships in the edge-safe entry
 * with `@sitebot/core`; `sqlite`, `pgvector` and `upstash` need a Node runtime
 * or a hosted SDK and are constructed by `@sitebot/core/node`; `custom` is a
 * module path the developer supplies (docs/01 §6 extension point).
 *
 * The methods are deliberately cheap to express on any backing store: upsert,
 * similarity query, delete-by-source, delete-by-ids, stats, close. Anything
 * richer would make the `custom` escape hatch expensive to implement, which is
 * exactly the path a developer on Pinecone or Qdrant takes.
 */

/** docs/06 §3.4 — one indexed chunk, with the metadata citations need. */
export interface Chunk {
  /** Stable for unchanged content within a document. */
  id: string
  text: string
  embedding: number[]
  metadata: ChunkMetadata
}

export interface ChunkMetadata {
  /** Public URL, for citations. */
  url: string
  title: string
  /** ["Docs", "API", "Authentication"] — prepended to text before embedding. */
  headingPath: string[]
  sourceId: string
  sourceType: string
  contentHash: string
  updatedAt: string
  tokens: number
  /** Position within the current document, used for neighbour expansion. */
  ordinal?: number
  lang?: string
}

export interface ScoredChunk {
  chunk: Chunk
  /** Cosine similarity in [0, 1]. */
  score: number
}

export interface QueryOptions {
  topK: number
  /** Drop results below this cosine similarity. */
  minScore?: number
  /** Metadata equality filters, e.g. `{ sourceType: 'openapi' }`. */
  filter?: Record<string, unknown>
}

export interface VectorStoreStats {
  documents: number
  chunks: number
  lastIndexed: string
  model: string
}

export interface VectorStore {
  upsert(chunks: Chunk[]): Promise<void>
  query(embedding: number[], opts: QueryOptions): Promise<ScoredChunk[]>
  deleteBySource(sourceId: string): Promise<void>
  deleteByIds(ids: string[]): Promise<void>
  stats(): Promise<VectorStoreStats>
  close(): Promise<void>
  /**
   * All chunks of one document, ordered as written. Powers
   * `expandNeighbours` (docs/06 §3.8). Optional: a `custom` store that cannot
   * express it simply loses neighbour expansion, not correctness.
   */
  documentChunks?(url: string): Promise<Chunk[]>
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * A chunk matches a filter when every requested metadata key equals. Unknown
 * keys are looked up on the metadata record, so custom tags a developer set at
 * ingest time filter the same way the built-in fields do.
 */
export function matchesFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (filter === undefined) return true
  for (const [key, value] of Object.entries(filter)) {
    if (metadata[key] !== value) return false
  }
  return true
}

/** Which documents still exist — the base for `VectorStoreStats`. */
export interface StoreMeta {
  /** The embedding model the index was built with. */
  model: string
  /** ISO timestamp of the last completed write. */
  lastIndexed: string
}
