import { importOptional } from '../providers/optional-import.js'
import type { Chunk, QueryOptions, ScoredChunk, VectorStore, VectorStoreStats } from './store.js'

/**
 * `knowledge.store.type: upstash` — the serverless / edge store (docs/06 §3.7).
 *
 * Zero-ops and paid, which is exactly the trade a Cloudflare Worker or a
 * hobby deployment wants. `@upstash/vector` is an optional peer; the error
 * names the install command rather than failing inside the SDK.
 */

export interface UpstashVectorStoreOptions {
  url: string
  token: string
  /** Recorded into stats; the manifest carries the authoritative copy. */
  model?: string
  /** Injected by tests. */
  client?: UpstashIndexLike
}

interface UpstashIndexLike {
  upsert(
    vectors: Array<{
      id: string
      vector: number[]
      metadata?: Record<string, unknown>
    }>,
  ): Promise<unknown>
  query(options: {
    vector: number[]
    topK: number
    filter?: string
    includeMetadata?: boolean
    includeVectors?: boolean
  }): Promise<Array<{ id: string | number; score: number; metadata?: Record<string, unknown> }>>
  delete(ids: string[] | { filter: string }): Promise<unknown>
  info(): Promise<{
    vectorCount: number
    pendingVectorCount?: number
    indexSize?: number
  }>
}

export async function createUpstashVectorStore(
  options: UpstashVectorStoreOptions,
): Promise<VectorStore> {
  let client = options.client
  if (client === undefined) {
    let sdk: { Index?: new (config: { url: string; token: string }) => UpstashIndexLike }
    try {
      sdk = (await importOptional('@upstash/vector')) as typeof sdk
    } catch (cause) {
      throw new Error(
        'knowledge.store "upstash" requires the optional dependency @upstash/vector.\n' +
          '  Install it:  pnpm add @upstash/vector',
        { cause },
      )
    }
    if (sdk.Index === undefined) throw new Error('@upstash/vector did not expose Index')
    client = new sdk.Index({ url: options.url, token: options.token })
  }
  return new UpstashVectorStore(client, options.model ?? '')
}

const TEXT_FIELD = 'sitebot_text'

class UpstashVectorStore implements VectorStore {
  #index: UpstashIndexLike
  #model: string

  constructor(index: UpstashIndexLike, model: string) {
    this.#index = index
    this.#model = model
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return
    await this.#index.upsert(
      chunks.map((chunk) => ({
        id: chunk.id,
        vector: chunk.embedding,
        metadata: {
          ...chunk.metadata,
          [TEXT_FIELD]: chunk.text,
          embeddingModel: this.#model,
        },
      })),
    )
  }

  async query(embedding: number[], opts: QueryOptions): Promise<ScoredChunk[]> {
    const filter = upstashFilter(opts.filter)
    const results = await this.#index.query({
      vector: embedding,
      topK: opts.topK,
      ...(filter === undefined ? {} : { filter }),
      includeMetadata: true,
    })
    const scored: ScoredChunk[] = []
    for (const result of results) {
      const metadata = result.metadata ?? {}
      const text = typeof metadata[TEXT_FIELD] === 'string' ? metadata[TEXT_FIELD] : ''
      delete metadata[TEXT_FIELD]
      // Upstash returns cosine *distance-adjusted* similarity for cosine
      // indexes; normalise into the [0,1] convention the rest of the system
      // uses.
      const score = result.score < 0 ? 0 : result.score > 1 ? 1 : result.score
      if (opts.minScore !== undefined && score < opts.minScore) continue
      scored.push({
        chunk: {
          id: String(result.id),
          text,
          metadata: metadata as unknown as Chunk['metadata'],
          embedding: [],
        },
        score,
      })
    }
    scored.sort((a, b) => b.score - a.score)
    // Upstash's server-side filter syntax differs from a local equality
    // check only in expressiveness: the client-side re-application guards
    // against filter clauses the service dialect understood differently.
    const final = scored.filter((entry) =>
      upstashMatches(entry.chunk.metadata as unknown as Record<string, unknown>, opts.filter),
    )
    return final
  }

  async deleteBySource(sourceId: string): Promise<void> {
    await this.#index.delete({ filter: `sourceId = '${sourceId.replaceAll("'", "''")}'` })
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.#index.delete(ids)
  }

  /** Neighbour expansion is infra-bound on Upstash: not expressible. */
  // No documentChunks — the optional method is deliberately omitted.

  async stats(): Promise<VectorStoreStats> {
    const info = await this.#index.info().catch(() => undefined)
    return {
      documents: 0, // Upstash has no distinct-count; known limit, documented.
      chunks: info?.vectorCount ?? 0,
      lastIndexed: new Date(0).toISOString(),
      model: this.#model,
    }
  }

  async close(): Promise<void> {}
}

function upstashMatches(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (filter === undefined) return true
  for (const [key, value] of Object.entries(filter)) {
    if (metadata[key] !== value) return false
  }
  return true
}

function upstashFilter(filter: Record<string, unknown> | undefined): string | undefined {
  if (filter === undefined) return undefined
  const clauses = Object.entries(filter).map(
    ([key, value]) => `${key} = '${String(value).replaceAll("'", "''")}'`,
  )
  return clauses.length === 0 ? undefined : clauses.join(' AND ')
}
