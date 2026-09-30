import { describe, expect, it, vi } from 'vitest'
import { testConfig } from '../../test/helpers.js'
import { MemoryVectorStore } from './memory-store.js'
import { retrieve } from './retrieve.js'
import { createReranker, rerankCandidates, type Reranker } from './rerank.js'
import type { Chunk } from './store.js'

const chunk = (id: string, embedding: number[]): Chunk => ({
  id,
  embedding,
  text: id,
  metadata: {
    url: `https://acme.com/${id}`,
    title: id,
    headingPath: ['Policies'],
    sourceId: 'docs',
    sourceType: 'text',
    contentHash: id,
    updatedAt: '',
    tokens: 1,
  },
})

describe('cross-encoder reranking', () => {
  it('loads a local reranker factory relative to the config directory', async () => {
    const reranker = await createReranker(
      { provider: 'custom', module: './packages/core/test/fixtures/local-reranker.mjs' },
      { baseDir: process.cwd() },
    )
    expect(await reranker?.rerank('q', ['one', 'two'])).toEqual([
      { index: 0, score: 1 },
      { index: 1, score: 0.5 },
    ])
  })
  it('overfetches before topK, rescues low vector scores and applies relevance threshold after reranking', async () => {
    const store = new MemoryVectorStore()
    await store.upsert([chunk('wrong', [1, 0]), chunk('answer', [0, 1])])
    const spy = vi.spyOn(store, 'query')
    const reranker: Reranker = {
      rerank: vi.fn(async (_query: string, documents: string[]) =>
        documents.map((text, index) => ({ index, score: text.includes('answer') ? 0.95 : 0.1 })),
      ),
    }
    const config = testConfig({
      knowledge: {
        retrieval: {
          rerank: true,
          topK: 1,
          minScore: 0.8,
          expandNeighbours: 0,
          dedupeByUrl: false,
        },
      },
    })
    const result = await retrieve(
      {
        store,
        reranker,
        embedder: {
          modelId: 'test',
          embed: async () => ({ embedding: [1, 0], tokens: 2 }),
        },
      },
      'which policy applies?',
      config,
    )
    expect(spy.mock.calls[0]?.[1].topK).toBe(4)
    expect(result.hits.map((hit) => [hit.id, hit.score])).toEqual([['answer', 0.95]])
    expect(reranker.rerank).toHaveBeenCalledWith('which policy applies?', [
      'Policies\n\nwrong',
      'Policies\n\nanswer',
    ])
    expect(result.belowThreshold).toBe(false)
  })

  it('does not call an injected reranker when disabled', async () => {
    const store = new MemoryVectorStore()
    await store.upsert([chunk('answer', [1, 0])])
    const reranker = { rerank: vi.fn() }
    await retrieve(
      {
        store,
        reranker,
        embedder: { modelId: 'test', embed: async () => ({ embedding: [1, 0], tokens: 1 }) },
      },
      'query',
      testConfig(),
    )
    expect(reranker.rerank).not.toHaveBeenCalled()
  })

  it('sends the Cohere HTTP contract and maps relevance_score', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [{ index: 0, relevance_score: 0.9 }] }),
    )
    const reranker = await createReranker(
      {
        provider: 'cohere',
        model: 'rerank-v3.5',
        apiKey: 'secret',
        baseUrl: 'http://localhost:4320',
        timeoutMs: 1000,
      },
      { fetchImpl },
    )
    expect(await reranker?.rerank('query', ['doc'])).toEqual([{ index: 0, score: 0.9 }])
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:4320/v2/rerank')
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'rerank-v3.5',
      query: 'query',
      documents: ['doc'],
      top_n: 1,
    })
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret' })
  })

  it('reports provider errors without response bodies or credentials', async () => {
    const reranker = await createReranker(
      {
        provider: 'cohere',
        model: 'm',
        apiKey: 'secret',
        baseUrl: 'http://localhost',
        timeoutMs: 1000,
      },
      {
        fetchImpl: async () => new Response('private provider body', { status: 429 }),
      },
    )
    await expect(reranker?.rerank('q', ['d'])).rejects.toThrow(
      'Cohere rerank request failed (429).',
    )
  })

  it.each([
    [{ index: 0, score: NaN }],
    [{ index: 1, score: 0.5 }],
    [
      { index: 0, score: 0.5 },
      { index: 0, score: 0.4 },
    ],
    [],
  ])('rejects malformed scores %j', async (...scores) => {
    await expect(
      rerankCandidates({ rerank: async () => scores.flat() }, 'q', [
        { chunk: chunk('d', [1]), score: 1 },
      ]),
    ).rejects.toThrow()
  })
})
