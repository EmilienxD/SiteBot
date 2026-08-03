import type { ResolvedConfig } from '@sitebot/config'
import type { VectorStore } from './store.js'

/**
 * Knowledge runtime — how the engine reaches the index at query time.
 *
 * The store is constructed elsewhere (`@sitebot/core/node` for the Node
 * backends, tests inject fakes) and handed to the engine as a dep; the
 * embedder is needed only for retrieval modes that embed the user's message
 * (`always`, `hybrid`) and for the `search_knowledge_base` builtin.
 */

export interface EmbeddedQuery {
  embedding: number[]
  tokens: number
}

/** Minimal embedder surface — `embedMany` is not needed at query time. */
export interface QueryEmbedder {
  embed(text: string): Promise<EmbeddedQuery>
  readonly modelId: string
}

export interface KnowledgeDeps {
  store?: VectorStore
  embedder?: QueryEmbedder
}

export interface Citation {
  id: string
  title: string
  url: string
  snippet: string
  score: number
}

/** The `data-citations` payload — docs/03-protocol.md. */
export interface CitationsPayload {
  items: Citation[]
}

export interface RetrievalHit {
  id: string
  url: string
  title: string
  text: string
  score: number
}

export interface RetrievalResult {
  hits: RetrievalHit[]
  /** True when every raw result was below `minScore`. */
  belowThreshold: boolean
  tokensEmbedded: number
}

export function knowledgeEnabled(config: ResolvedConfig): boolean {
  return config.knowledge.sources.length > 0 && config.knowledge.embedding !== undefined
}
