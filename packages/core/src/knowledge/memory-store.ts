import {
  cosineSimilarity,
  matchesFilter,
  type Chunk,
  type QueryOptions,
  type ScoredChunk,
  type VectorStore,
  type VectorStoreStats,
} from './store.js'

/**
 * `knowledge.store.type: memory` — docs/06 §3.7.
 *
 * Brute-force cosine over a Map. That is not an apology: up to a few thousand
 * chunks it is faster than the network round-trip an external store costs, and
 * it is the only store that needs zero infrastructure, which is what keeps
 * `npx sitebot init` impressive. The docs cap the recommendation at ~5k
 * chunks; beyond that `sqlite` or `pgvector` exist.
 *
 * An optional JSON file (`storage.path`) persists the index between process
 * restarts, matching the session-store dev ergonomics.
 */
export class MemoryVectorStore implements VectorStore {
  protected readonly chunks = new Map<string, Chunk>()
  #model: string
  #lastIndexed: string
  readonly #persist?: (snapshot: unknown) => Promise<void>

  constructor(
    options: {
      model?: string
      chunks?: Chunk[]
      persist?: (snapshot: unknown) => Promise<void>
    } = {},
  ) {
    this.#model = options.model ?? ''
    this.#lastIndexed = new Date(0).toISOString()
    this.#persist = options.persist
    for (const chunk of options.chunks ?? []) this.chunks.set(chunk.id, chunk)
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    for (const chunk of chunks) this.chunks.set(chunk.id, chunk)
    this.touched()
    await this.flush()
  }

  async query(embedding: number[], opts: QueryOptions): Promise<ScoredChunk[]> {
    const scored: ScoredChunk[] = []
    for (const chunk of this.chunks.values()) {
      if (!matchesFilter(chunk.metadata as unknown as Record<string, unknown>, opts.filter)) {
        continue
      }
      const score = cosineSimilarity(embedding, chunk.embedding)
      if (opts.minScore !== undefined && score < opts.minScore) continue
      scored.push({ chunk, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, opts.topK)
  }

  async deleteBySource(sourceId: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.metadata.sourceId === sourceId) this.chunks.delete(id)
    }
    this.touched()
    await this.flush()
  }

  /** Chunks of one document in stored ordinal order — for `expandNeighbours`. */
  async documentChunks(url: string): Promise<Chunk[]> {
    return [...this.chunks.values()].filter((chunk) => chunk.metadata.url === url)
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.chunks.delete(id)
    this.touched()
    await this.flush()
  }

  async stats(): Promise<VectorStoreStats> {
    const documents = new Set<string>()
    for (const chunk of this.chunks.values()) documents.add(chunk.metadata.url)
    return {
      documents: documents.size,
      chunks: this.chunks.size,
      lastIndexed: this.#lastIndexed,
      model: this.#model,
    }
  }

  async close(): Promise<void> {
    await this.flush()
  }

  /** Called by the ingest pipeline when the manifest's model becomes known. */
  setModel(model: string): void {
    this.#model = model
  }

  protected touched(): void {
    this.#lastIndexed = new Date().toISOString()
  }

  private async flush(): Promise<void> {
    if (this.#persist === undefined) return
    await this.#persist({
      model: this.#model,
      lastIndexed: this.#lastIndexed,
      chunks: [...this.chunks.values()],
    })
  }
}
