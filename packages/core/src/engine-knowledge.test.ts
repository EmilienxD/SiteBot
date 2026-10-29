import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { readSse, streamedText, testConfig, testContext, userMessage } from '../test/helpers.js'
import { createEngine } from './engine.js'
import { MemoryVectorStore } from './knowledge/memory-store.js'
import type { Chunk } from './knowledge/store.js'
import type { QueryEmbedder } from './knowledge/types.js'
import type { ProviderFactory } from './providers/adapters.js'
import type { ChatRequest } from './types.js'

/**
 * The engine-side of Phase 6 — docs/06 §3.8/§3.9 and the degraded rule of
 * docs/08 §1: knowledge failures never take chat down, retrieval injects a
 * `<knowledge>` block, and the stream ends with a `data-citations` part.
 */

const SESSION = 's_01J9X8Y7Z6ABCDEFGHJKMNPQRS'

function textModel(chunks: string[]): MockLanguageModelV3 {
  const parts: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...chunks.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
    },
  ]
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: parts,
        chunkDelayInMs: null,
        initialDelayInMs: null,
      }),
    }),
  })
}

const adapterFor = (model: MockLanguageModelV3): Record<string, ProviderFactory> => ({
  anthropic: async () => model,
})

function testChunk(id: string, url: string, text: string, embedding: number[]): Chunk {
  return {
    id,
    text,
    embedding,
    metadata: {
      url,
      title: `Doc ${id}`,
      headingPath: [],
      sourceId: 'test',
      sourceType: 'text',
      contentHash: id,
      updatedAt: '2026-08-03T00:00:00Z',
      tokens: 10,
    },
  }
}

/** An embedder whose embedding is a lexical needle: word hits on axis i. */
function needleEmbedder(map: Record<string, number>): QueryEmbedder {
  return {
    modelId: 'test-embed',
    embed: async (text: string) => {
      const vector = [0, 0, 0]
      for (const [word, axis] of Object.entries(map)) {
        if (text.toLowerCase().includes(word)) vector[axis] = 1
      }
      return { embedding: vector, tokens: 4 }
    },
  }
}

function knowledgeConfig(): ReturnType<typeof testConfig> {
  return testConfig({
    knowledge: {
      sources: [{ type: 'text', id: 'docs', content: 'body' }],
      embedding: { provider: 'openai', model: 'text-embedding-3-small', apiKey: 'x' },
      retrieval: { mode: 'always', includeCitations: true, minScore: 0.3 },
    },
  })
}

/** Buffer the SSE body once and expose both views of it. */
async function readAll(response: Response): Promise<{
  text: string
  citations: { id: string; url: string }[]
}> {
  const events = await readSse(response)
  let text = ''
  let citations: { id: string; url: string }[] = []
  for (const event of events) {
    if (event === '[DONE]') continue
    const parsed = JSON.parse(event) as {
      type: string
      delta?: string
      data?: { items?: { id: string; url: string }[] }
    }
    if (parsed.type === 'text-delta' && typeof parsed.delta === 'string') text += parsed.delta
    if (parsed.type === 'data-citations') citations = parsed.data?.items ?? []
  }
  return { text, citations }
}

describe('engine knowledge (docs/06)', () => {
  it.each(['always', 'hybrid', 'tool'] as const)(
    'uses injected reranking in %s mode and cites the rescored result',
    async (mode) => {
      const store = new MemoryVectorStore()
      await store.upsert([
        testChunk('shipping', 'https://acme.com/shipping', 'Ships within two days.', [1, 0, 0]),
        testChunk(
          'returns',
          'https://acme.com/returns',
          'Returns accepted for 30 days.',
          [0, 1, 0],
        ),
      ])
      const config = knowledgeConfig()
      config.mode = 'agent'
      config.knowledge.retrieval = {
        ...config.knowledge.retrieval,
        mode,
        rerank: true,
        topK: 1,
        minScore: 0.8,
        dedupeByUrl: false,
      }
      const answer = textModel(['Returns accepted for 30 days [1].'])
      let searches = 0
      const model = new MockLanguageModelV3({
        doStream: async (options) => {
          if (mode !== 'tool' || options.prompt.at(-1)?.role === 'tool')
            return answer.doStream(options)
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'intro' },
                { type: 'text-delta', id: 'intro', delta: 'I will check the policy. ' },
                { type: 'text-end', id: 'intro' },
                {
                  type: 'tool-call',
                  toolCallId: 'search1',
                  toolName: 'search_knowledge_base',
                  input: JSON.stringify({ query: 'returns policy' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ] as LanguageModelV3StreamPart[],
              chunkDelayInMs: null,
              initialDelayInMs: null,
            }),
          }
        },
      })
      const engine = createEngine(config, {
        adapters: adapterFor(model),
        knowledge: {
          store,
          embedder: needleEmbedder({ return: 0 }),
          reranker: {
            rerank: async (_query, documents) => {
              searches++
              return documents.map((text, index) => ({
                index,
                score: text.includes('30 days') ? 0.95 : 0.1,
              }))
            },
          },
        },
      })
      const response = await readAll(
        await engine.handleChat(
          { sessionId: SESSION, messages: [userMessage('returns policy')] },
          testContext(),
        ),
      )
      expect(searches).toBe(1)
      expect(response.text).toContain('30 days')
      expect(response.citations.map((citation) => citation.url)).toEqual([
        'https://acme.com/returns',
      ])
    },
  )

  it('tells the model search is unavailable when reranking fails and emits no misleading citations', async () => {
    const store = new MemoryVectorStore()
    await store.upsert([testChunk('shipping', 'https://acme.com/shipping', 'Shipping', [1, 0, 0])])
    const config = knowledgeConfig()
    config.knowledge.retrieval.rerank = true
    const answer = textModel(['I do not know.'])
    let prompt = ''
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompt = JSON.stringify(options.prompt)
        return answer.doStream(options)
      },
    })
    const engine = createEngine(config, {
      adapters: adapterFor(model),
      knowledge: {
        store,
        embedder: needleEmbedder({ ship: 0 }),
        reranker: {
          rerank: async () => {
            throw new Error('provider unavailable')
          },
        },
      },
    })
    const response = await readAll(
      await engine.handleChat(
        { sessionId: SESSION, messages: [userMessage('shipping')] },
        testContext(),
      ),
    )
    expect(response.text).toBe('I do not know.')
    expect(response.citations).toEqual([])
    expect(prompt).toContain('Search is temporarily unavailable')
    expect(prompt).not.toContain('provider unavailable')
  })
  it('injects a <knowledge> block when retrieval scores a hit', async () => {
    const store = new MemoryVectorStore({ model: 'test-embed' })
    await store.upsert([
      testChunk(
        'c-ship',
        'https://acme.com/shipping',
        'Orders ship in 2 business days.',
        [1, 0, 0],
      ),
      testChunk('c-hours', 'https://acme.com/hours', 'Support is weekdays 9 to 5.', [0, 1, 0]),
    ])
    let systemSeen = ''
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        systemSeen = options.prompt
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n\n')
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Two business days.' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ] as LanguageModelV3StreamPart[],
            chunkDelayInMs: null,
            initialDelayInMs: null,
          }),
        }
      },
    })
    const engine = createEngine(knowledgeConfig(), {
      adapters: adapterFor(model),
      knowledge: { store, embedder: needleEmbedder({ ship: 0 }) },
    })
    const response = await engine.handleChat(
      {
        sessionId: SESSION,
        messages: [userMessage('When will my order ship?')],
      } satisfies ChatRequest,
      testContext(),
    )
    expect(response.status).toBe(200)
    const parsed = await readAll(response)
    expect(parsed.text).toBe('Two business days.')
    expect(systemSeen).toContain('<knowledge>')
    expect(systemSeen).toContain('Orders ship in 2 business days.')
    expect(parsed.citations.map((citation) => citation.url)).toContain('https://acme.com/shipping')
  })

  it('emits data-citations with the retrieved chunks', async () => {
    const store = new MemoryVectorStore({ model: 'test-embed' })
    await store.upsert([
      testChunk('c-ret', 'https://acme.com/returns', '30-day returns, full refund.', [1, 0, 0]),
    ])
    const engine = createEngine(knowledgeConfig(), {
      adapters: adapterFor(textModel(['You can return it within 30 days [1].'])),
      knowledge: { store, embedder: needleEmbedder({ return: 0 }) },
    })
    const response = await engine.handleChat(
      { sessionId: SESSION, messages: [userMessage('Can I return this?')] } satisfies ChatRequest,
      testContext(),
    )
    const second = await readAll(response)
    expect(second.text).toContain('30 days')
    expect(second.citations).toHaveLength(1)
    expect(second.citations[0]!.url).toBe('https://acme.com/returns')
  })

  it('degrades to plain chat when the store is unreachable', async () => {
    const store = {
      upsert: async () => {},
      query: async () => {
        throw new Error('ECONNREFUSED')
      },
      deleteBySource: async () => {},
      deleteByIds: async () => {},
      stats: async () => {
        throw new Error('ECONNREFUSED')
      },
      close: async () => {},
    }
    const engine = createEngine(knowledgeConfig(), {
      adapters: adapterFor(textModel(['I do not know, sorry.'])),
      knowledge: { store, embedder: needleEmbedder({}) },
    })
    const response = await engine.handleChat(
      { sessionId: SESSION, messages: [userMessage('anything')] } satisfies ChatRequest,
      testContext(),
    )
    expect(response.status).toBe(200)
    expect(await streamedText(response)).toBe('I do not know, sorry.')

    const health = await engine.health()
    expect(health.status).toBe('degraded')
    expect(health.checks['knowledge']?.status).toBe('degraded')
  })

  it('health omits the knowledge check when knowledge is not configured', async () => {
    const engine = createEngine(testConfig(), { adapters: adapterFor(textModel(['ok'])) })
    const health = await engine.health()
    expect(health.checks['knowledge']).toBeUndefined()
  })

  it('health is degraded (200, not 503) when only the store is down', async () => {
    const store = new MemoryVectorStore({ model: 'test-embed' })
    await store.close()
    ;(store as unknown as { query: () => Promise<never> }).query = async () => {
      throw new Error('down')
    }
    ;(store as unknown as { stats: () => Promise<never> }).stats = async () => {
      throw new Error('down')
    }
    const engine = createEngine(knowledgeConfig(), {
      adapters: adapterFor(textModel(['ok'])),
      knowledge: { store, embedder: needleEmbedder({}) },
    })
    const health = await engine.health()
    expect(health.status).toBe('degraded')
    expect(health.checks['provider']?.status).toBe('ok')
  })
})

// Deterministic vectors and a scripted model verify routing, not embedding/model quality.
describe('engine locale propagation to knowledge', () => {
  it.each(['always', 'hybrid', 'tool'] as const)(
    'keeps French retrieval, prompts, status and citations coherent in %s mode',
    async (mode) => {
      const config = knowledgeConfig()
      config.mode = 'agent'
      config.knowledge.retrieval.mode = mode
      config.knowledge.retrieval.topK = 1
      config.knowledge.retrieval.languagePreference = 'locale-first'
      config.ui.messages.suggestions = [
        { label: 'English', action: { type: 'send', text: 'English' } },
      ]
      config.ui.translations.fr = {
        messages: {
          suggestions: [{ label: 'Français', action: { type: 'send', text: 'Question' } }],
        },
      }
      const english = testChunk(
        'english',
        'https://example.com/en/real',
        'English document',
        [1, 0, 0],
      )
      const french = testChunk(
        'french',
        'https://example.com/fr/real',
        'Document français',
        [0.8, 0.6, 0],
      )
      english.metadata.lang = 'en'
      french.metadata.lang = 'fr'
      const store = new MemoryVectorStore({ chunks: [english, french] })
      const answer = textModel(['Réponse [1].'])
      const model = new MockLanguageModelV3({
        doStream: async (options) => {
          if (mode !== 'tool' || options.prompt.at(-1)?.role === 'tool')
            return answer.doStream(options)
          return {
            stream: simulateReadableStream({
              initialDelayInMs: null,
              chunkDelayInMs: null,
              chunks: [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'locale-search',
                  toolName: 'search_knowledge_base',
                  input: JSON.stringify({ query: 'documentation' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
                },
              ] as LanguageModelV3StreamPart[],
            }),
          }
        },
      })
      const engine = createEngine(config, {
        adapters: adapterFor(model),
        knowledge: { store, embedder: needleEmbedder({ doc: 0 }) },
      })
      const response = await engine.handleChat(
        { sessionId: SESSION, locale: 'fr-CA', messages: [userMessage('documentation')] },
        testContext({ locale: 'en' }),
      )
      const events = (await readSse(response))
        .filter((event) => event !== '[DONE]')
        .map((event) => JSON.parse(event))
      expect(events.find((event) => event.type === 'data-citations')?.data.items).toMatchObject([
        { lang: 'fr', url: 'https://example.com/fr/real' },
      ])
      expect(events.find((event) => event.type === 'data-status')?.data.text).toBe(
        'Recherche dans la documentation…',
      )
      expect(events.find((event) => event.type === 'data-suggestions')?.data.items[0].label).toBe(
        'Français',
      )
      const prompt = JSON.stringify(answer.doStreamCalls[0]?.prompt)
      expect(prompt).toContain('Respond in language fr by default')
      expect(prompt).toContain('https://example.com/fr/real')
      expect(prompt).not.toContain('English document')
      await engine.dispose()
    },
  )
})
