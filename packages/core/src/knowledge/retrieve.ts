import type { ResolvedConfig } from '@sitebot/config'
import { estimateTokens } from '../session/truncate.js'
import type { ScoredChunk, VectorStore } from './store.js'
import type { QueryEmbedder, RetrievalHit, RetrievalResult } from './types.js'

/**
 * Query-time retrieval — docs/06-knowledge.md §3.8.
 *
 * The store returns raw scored chunks; this module applies the query-time
 * refinements in order: `minScore` (with the all-below-threshold signal the
 * prompt block turns into an explicit "no relevant documentation" note), then
 * `expandNeighbours`, `dedupeByUrl`, and finally the context-token budget.
 */
export async function retrieve(
  deps: { store: VectorStore; embedder: QueryEmbedder },
  query: string,
  config: ResolvedConfig,
): Promise<RetrievalResult> {
  const retrieval = config.knowledge.retrieval
  const embedded = await deps.embedder.embed(query)
  const overfetch = retrieval.expandNeighbours > 0 || retrieval.dedupeByUrl
  const raw = await deps.store.query(embedded.embedding, {
    topK: overfetch ? retrieval.topK * 4 : retrieval.topK,
    minScore: 0,
    ...(retrieval.filter === undefined ? {} : { filter: retrieval.filter }),
  })

  const above = raw.filter((hit) => hit.score >= retrieval.minScore)
  const belowThreshold = raw.length > 0 && above.length === 0
  const expanded = await expandNeighbours(deps.store, above, config)
  const hits = finalize(expanded, config)
  return { hits, belowThreshold, tokensEmbedded: embedded.tokens }
}

/**
 * Pull `expandNeighbours` chunks on either side of each hit from the same
 * document — the cheap fix for "the answer was in the next paragraph". The
 * neighbours score as the hit they came with: they were not matched, but they
 * are context the model asks for implicitly by reading that paragraph.
 */
export async function expandNeighbours(
  store: VectorStore,
  hits: ScoredChunk[],
  config: ResolvedConfig,
): Promise<ScoredChunk[]> {
  const n = config.knowledge.retrieval.expandNeighbours
  if (n <= 0 || store.documentChunks === undefined || hits.length === 0) return hits

  const out: ScoredChunk[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const document = await store.documentChunks(hit.chunk.metadata.url)
    const index = document.findIndex((chunk) => chunk.id === hit.chunk.id)
    if (index < 0) {
      if (!seen.has(hit.chunk.id)) {
        seen.add(hit.chunk.id)
        out.push(hit)
      }
      continue
    }
    for (let offset = -n; offset <= n; offset++) {
      const chunk = document[index + offset]
      if (chunk === undefined || seen.has(chunk.id)) continue
      seen.add(chunk.id)
      out.push({ chunk, score: offset === 0 ? hit.score : hit.score * 0.999 })
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

export function finalize(raw: ScoredChunk[], config: ResolvedConfig): RetrievalHit[] {
  const retrieval = config.knowledge.retrieval
  const topK = retrieval.topK
  const distinctUrls = new Set(raw.map((hit) => hit.chunk.metadata.url)).size

  const seenUrls = new Set<string>()
  const seenIds = new Set<string>()
  const out: RetrievalHit[] = []
  let budget = retrieval.maxContextTokens

  for (const hit of raw) {
    if (out.length >= topK) break
    const { url } = hit.chunk.metadata
    if (seenIds.has(hit.chunk.id)) continue
    if (retrieval.dedupeByUrl && seenUrls.has(url) && distinctUrls >= topK) continue
    const headingPrefix = hit.chunk.metadata.headingPath.join(' > ')
    const text =
      headingPrefix === '' ? hit.chunk.text : `${headingPrefix}\n\n${hit.chunk.text}`
    const tokens = estimateTokens(text)
    if (budget - tokens < 0 && out.length > 0) continue
    budget -= tokens
    seenUrls.add(url)
    seenIds.add(hit.chunk.id)
    out.push({
      id: hit.chunk.id,
      url,
      title: hit.chunk.metadata.title,
      text,
      score: hit.score,
    })
  }
  return out
}
