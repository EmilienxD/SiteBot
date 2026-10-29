import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmbeddingModel, embedChunks, embeddingTokens } from './embedding.js'
import { createQueryEmbedder } from './query-embedder.js'

afterEach(() => vi.unstubAllGlobals())

describe('embedding usage without provider token counts', () => {
  it.each(['cohere', 'voyage'] as const)(
    'uses documented %s query/document input types through the SDK',
    async (provider) => {
      const requests: Array<Record<string, unknown>> = []
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as Record<string, unknown>
        requests.push(body)
        return Response.json(
          provider === 'cohere'
            ? { embeddings: { float: [[1, 0]] } }
            : { data: [{ embedding: [1, 0] }] },
        )
      })
      const config = { provider, model: 'offline', batchSize: 1, apiKey: 'test-only' }
      const { model } = await createEmbeddingModel(config)
      await embedChunks(model, ['document'])
      await (await createQueryEmbedder(config)).embed('question')
      expect(requests.map((body) => body['input_type'])).toEqual(
        provider === 'cohere' ? ['search_document', 'search_query'] : ['document', 'query'],
      )
    },
  )

  it('applies the configured query prefix only to embedding input', async () => {
    const requests: string[][] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] }
      requests.push(body.input)
      return Response.json({ embeddings: [[1, 0]] })
    })
    const config = {
      provider: 'ollama',
      model: 'offline',
      batchSize: 1,
      queryPrefix: 'search_query: ',
    } as const
    const result = await (await createQueryEmbedder(config)).embed('question')
    expect(requests).toEqual([['search_query: question']])
    expect(result.tokens).toBe(6)
  })
  it('keeps ingest and query usage finite through the actual SDK when HTTP usage is absent', async () => {
    // Ollama's adapter returns vectors without SDK usage. ai@6 represents the
    // missing count as NaN, which a nullish fallback does not handle.
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { input } = JSON.parse(init.body as string) as { input: string[] }
      return Response.json({ embeddings: input.map(() => [1, 0, 0]) })
    })
    const config = { provider: 'ollama', model: 'fixture', batchSize: 2 } as const
    const { model } = await createEmbeddingModel(config)
    const texts = ['A short document.', 'Another document.']
    const batch = await embedChunks(model, texts)
    expect(batch.embeddings).toHaveLength(2)
    expect(batch.tokens).toBe(10)
    const embedder = await createQueryEmbedder(config)
    const query = await embedder.embed('A question?')
    expect(query.embedding).toEqual([1, 0, 0])
    expect(query.tokens).toBe(3)
  })

  it('preserves supplied counts, including zero, and estimates invalid counts', () => {
    for (const tokens of [0, 17]) expect(embeddingTokens(tokens, ['hello'])).toBe(tokens)
    for (const tokens of [undefined, NaN, Infinity, -1]) {
      expect(embeddingTokens(tokens, ['hello'])).toBe(2)
    }
  })
})
