import type { Knowledge } from '@sitebot/config'
import { loadModuleExport, parseModuleSpec } from '../modules.js'
import { readEnv } from '../providers/optional-import.js'
import type { ScoredChunk } from './store.js'

/** Cross-encoder scores refer to the original candidate indexes. */
export interface RerankScore {
  index: number
  score: number
}

export interface Reranker {
  rerank(query: string, documents: string[]): Promise<RerankScore[]>
}

export async function createReranker(
  settings: Knowledge['retrieval']['rerank'],
  options: { baseDir?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<Reranker | undefined> {
  if (settings === false) return undefined
  if (typeof settings === 'object' && settings.provider === 'custom') {
    const spec = parseModuleSpec(settings.module)
    const exported = await loadModuleExport(spec.path, spec.exportName, {
      baseDir: options.baseDir,
      kind: 'Reranker',
    })
    const instance = typeof exported === 'function' ? await exported() : exported
    if (
      typeof instance !== 'object' ||
      instance === null ||
      typeof instance.rerank !== 'function'
    ) {
      throw new Error('Custom reranker must export a Reranker or a factory returning one.')
    }
    return instance as Reranker
  }
  const config = settings === true ? undefined : settings
  const key = config?.apiKey ?? readEnv('COHERE_API_KEY')
  if (!key)
    throw new Error(
      'Cohere reranking requires knowledge.retrieval.rerank.apiKey or COHERE_API_KEY.',
    )
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    async rerank(query, documents) {
      const response = await fetchImpl(
        `${(config?.baseUrl ?? 'https://api.cohere.com').replace(/\/$/, '')}/v2/rerank`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: config?.model ?? 'rerank-v3.5',
            query,
            documents,
            top_n: documents.length,
          }),
          signal: AbortSignal.timeout(config?.timeoutMs ?? 10000),
        },
      )
      if (!response.ok) throw new Error(`Cohere rerank request failed (${response.status}).`)
      const body = (await response.json()) as {
        results?: { index: number; relevance_score: number }[]
      }
      if (!Array.isArray(body.results))
        throw new Error('Cohere rerank response is missing results.')
      return body.results.map((result) => ({ index: result.index, score: result.relevance_score }))
    },
  }
}

export async function rerankCandidates(
  reranker: Reranker,
  query: string,
  hits: ScoredChunk[],
): Promise<ScoredChunk[]> {
  const scores = await reranker.rerank(
    query,
    hits.map(({ chunk }) =>
      [chunk.metadata.headingPath.join(' > '), chunk.text].filter(Boolean).join('\n\n'),
    ),
  )
  const seen = new Set<number>()
  for (const { index, score } of scores) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= hits.length ||
      seen.has(index) ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      throw new Error('Reranker returned an invalid index, duplicate index or relevance score.')
    }
    seen.add(index)
  }
  if (seen.size !== hits.length) throw new Error('Reranker must score every candidate.')
  return scores
    .map(({ index, score }) => ({ chunk: hits[index]!.chunk, score }))
    .sort((a, b) => b.score - a.score)
}
