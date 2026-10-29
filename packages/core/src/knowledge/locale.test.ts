import { describe, expect, it } from 'vitest'
import { testConfig } from '../../test/helpers.js'
import { MemoryVectorStore } from './memory-store.js'
import { retrieve } from './retrieve.js'
import type { Chunk } from './store.js'
import { composePrompt } from '../prompt/compose.js'
import { cachedSystem } from '../prompt/cache.js'

function chunk(id: string, lang: string | undefined, score = 1, sourceId = 'docs'): Chunk {
  return {
    id,
    text: `Document ${id}`,
    embedding: [score, Math.sqrt(1 - score * score)],
    metadata: {
      url: `https://example.com/original/${id}`,
      title: id,
      headingPath: [],
      sourceId,
      sourceType: 'text',
      contentHash: id,
      updatedAt: '2026-01-01',
      tokens: 5,
      ...(lang ? { lang, language: lang.split('-')[0] } : {}),
    },
  }
}
function fixture(chunks: Chunk[]) {
  const store = new MemoryVectorStore({ chunks })
  const embedder = { modelId: 'offline', embed: async () => ({ embedding: [1, 0], tokens: 2 }) }
  const config = testConfig({
    knowledge: {
      retrieval: { topK: 1, minScore: 0.5, dedupeByUrl: false, languagePreference: 'locale-first' },
    },
  })
  return { deps: { store, embedder }, config }
}
describe('documentation language preference (offline vectors)', () => {
  it('does not let weak same-language evidence suppress stronger cross-language evidence by default', async () => {
    const { deps, config } = fixture([
      chunk('strong-english', 'en', 0.9),
      chunk('weak-french', 'fr', 0.55),
    ])
    config.knowledge.retrieval.languagePreference = 'relevance'
    expect((await retrieve(deps, 'semantic question', config, 'fr')).hits[0]?.id).toBe(
      'strong-english',
    )
    // The original locale-first behavior remains an explicit deployment choice.
    config.knowledge.retrieval.languagePreference = 'locale-first'
    expect((await retrieve(deps, 'semantic question', config, 'fr')).hits[0]?.id).toBe(
      'weak-french',
    )
  })

  it('uses exact locale and language family as relevance tie-breakers', async () => {
    const { deps, config } = fixture([
      chunk('english', 'en'),
      chunk('french', 'fr'),
      chunk('canadian', 'fr-CA'),
    ])
    config.knowledge.retrieval.languagePreference = 'relevance'
    expect((await retrieve(deps, 'q', config, 'fr-CA')).hits[0]?.id).toBe('canadian')
    expect((await retrieve(deps, 'q', config, 'fr-BE')).hits[0]?.lang).not.toBe('en')
  })

  it('reranks the combined language pool once before thresholding and language selection', async () => {
    const { deps, config } = fixture([chunk('english', 'en', 0.6), chunk('french', 'fr', 0.95)])
    config.knowledge.retrieval.languagePreference = 'relevance'
    config.knowledge.retrieval.rerank = { provider: 'custom', module: 'unused' }
    const pools: string[][] = []
    const reranker = {
      rerank: async (_query: string, docs: string[]) => {
        pools.push(docs)
        return docs.map((text, index) => ({ index, score: text.includes('english') ? 0.9 : 0.2 }))
      },
    }
    expect((await retrieve({ ...deps, reranker }, 'q', config, 'fr')).hits[0]?.id).toBe('english')
    expect(pools).toHaveLength(1)
    expect(pools[0]).toHaveLength(2)
  })
  it('finds French documents even when English would fill the global topK, preserving URLs and language', async () => {
    const { deps, config } = fixture([chunk('english', 'en'), chunk('french', 'fr', 0.8)])
    const result = await retrieve(deps, 'question', config, 'fr-CA')
    expect(result.hits).toMatchObject([
      { id: 'french', lang: 'fr', url: 'https://example.com/original/french' },
    ])
    const prompt = composePrompt({ config, ctx: { locale: 'fr' }, documents: result.hits })
    expect(prompt.text).toContain('[language: fr]')
    expect(prompt.text).toContain('https://example.com/original/french')
    expect(prompt.text).not.toContain('Document english')
  })
  it('prefers exact regional language, then the language family', async () => {
    const { deps, config } = fixture([chunk('base', 'fr'), chunk('canada', 'fr-CA', 0.8)])
    expect((await retrieve(deps, 'q', config, 'fr-CA')).hits[0]?.id).toBe('canada')
    expect((await retrieve(deps, 'q', config, 'fr-BE')).hits[0]?.lang).toBe('fr')
    const onlyRegional = fixture([chunk('canada', 'fr-CA')])
    expect((await retrieve(onlyRegional.deps, 'q', onlyRegional.config, 'fr')).hits[0]?.lang).toBe(
      'fr-CA',
    )
  })
  it.each([{ other: [] }, { other: [chunk('irrelevant-french', 'fr', 0.1)] }])(
    'falls back only when no suitable French result exists',
    async ({ other }) => {
      const { deps, config } = fixture([chunk('real-en-url', 'en'), ...other])
      expect((await retrieve(deps, 'q', config, 'fr')).hits).toMatchObject([
        { id: 'real-en-url', lang: 'en', url: 'https://example.com/original/real-en-url' },
      ])
    },
  )
  it('retains unknown-language content as fallback and never widens deployment metadata filters', async () => {
    const { deps, config } = fixture([
      chunk('unknown', undefined),
      chunk('restricted', 'fr', 1, 'private'),
    ])
    config.knowledge.retrieval.filter = { sourceId: 'docs' }
    expect((await retrieve(deps, 'q', config, 'fr')).hits[0]?.id).toBe('unknown')
    config.knowledge.retrieval.filter = { lang: 'en' }
    expect((await retrieve(deps, 'q', config, 'fr')).hits).toEqual([])
  })
  it('supports a third language without language-specific retrieval branches', async () => {
    const { deps, config } = fixture([chunk('english', 'en'), chunk('german', 'de', 0.8)])
    expect((await retrieve(deps, 'q', config, 'de-CH')).hits[0]?.id).toBe('german')
  })
  it('does not expand into a different-language document sharing the same URL', async () => {
    const french = chunk('fr', 'fr', 0.8)
    const english = chunk('en', 'en')
    english.metadata.url = french.metadata.url
    const { deps, config } = fixture([french, english])
    config.knowledge.retrieval.expandNeighbours = 2
    expect((await retrieve(deps, 'q', config, 'fr')).hits.map((hit) => hit.lang)).toEqual(['fr'])
  })
  it('varies cached policy by canonical selected language while keeping the deployment prefix stable', () => {
    const config = testConfig()
    const english = composePrompt({ config, ctx: { locale: 'en' }, delimiterId: 'test' })
    const french = composePrompt({ config, ctx: { locale: 'fr-CA' }, delimiterId: 'test' })
    const enSystem = cachedSystem('anthropic', english.text, english)
    const frSystem = cachedSystem('anthropic', french.text, french)
    if (!Array.isArray(enSystem) || !Array.isArray(frSystem))
      throw new Error('expected segmented cache')
    expect(enSystem[0]).toEqual(frSystem[0])
    expect(enSystem[1]?.content).not.toBe(frSystem[1]?.content)
    expect(frSystem[1]?.content).toContain('Respond in language fr by default')
  })
})
