import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { createQueryEmbedder } from '@sitebot/ingest/query'
import {
  createEngine,
  MemoryVectorStore,
  type QueryEmbedder,
  type VectorStore,
} from '@sitebot/core'
import { createSiteBotHandler, type SiteBotHandler } from './handler.js'
import { chatBody, mockDeps, streamedText, testConfig, textModel } from '../test/helpers.js'

vi.mock('@sitebot/ingest/query', () => ({ createQueryEmbedder: vi.fn() }))

const embedder: QueryEmbedder = {
  modelId: 'offline-embedding',
  embed: async () => ({ embedding: [1, 0], tokens: 3 }),
}
const handlers: SiteBotHandler[] = []

beforeEach(() => {
  vi.mocked(createQueryEmbedder).mockReset().mockResolvedValue(embedder)
})
afterEach(async () => {
  await Promise.all(handlers.splice(0).map((handler) => handler.dispose()))
})

function config() {
  return testConfig({
    mode: 'chat',
    storage: { type: 'none' },
    tools: [],
    telemetry: { logLevel: 'silent' },
    knowledge: {
      sources: [{ type: 'text', id: 'docs', content: 'Shipping documentation' }],
      embedding: { provider: 'openai', model: 'offline-embedding', apiKey: 'unused' },
      store: { type: 'sqlite', path: 'unused.db' },
      retrieval: { mode: 'always', includeCitations: true, minScore: 0.1 },
    },
  })
}

async function indexedStore() {
  const store = new MemoryVectorStore({ model: 'offline-embedding' })
  await store.upsert([
    {
      id: 'shipping',
      text: 'Ships within two days.',
      embedding: [1, 0],
      metadata: {
        url: 'https://acme.com/shipping',
        title: 'Shipping',
        headingPath: [],
        sourceId: 'docs',
        sourceType: 'text',
        contentHash: 'shipping',
        updatedAt: '2026-01-01T00:00:00Z',
        tokens: 5,
      },
    },
  ])
  return store
}

function managed(options: Parameters<typeof createSiteBotHandler>[1]) {
  const handler = createSiteBotHandler(config(), { deps: mockDeps(['Answer.']), ...options })
  handlers.push(handler)
  return handler
}

async function chat(handler: SiteBotHandler) {
  const response = await handler(
    new Request('https://acme.com/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody('When will it ship?')),
    }),
  )
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(await streamedText(body)).toBe('Answer.')
  return body
}

const health = (handler: SiteBotHandler) => handler(new Request('https://acme.com/api/chat/health'))

describe('targeted read-only Q&A over HTTP (offline)', () => {
  it.each(['en', 'fr'])(
    'searches and answers with real source citations in %s, without client-granted capabilities',
    async (locale) => {
      const store = await indexedStore()
      await store.upsert([
        {
          id: 'shipping-fr',
          text: 'Expédition sous deux jours.',
          embedding: [1, 0],
          metadata: {
            url: 'https://acme.com/fr/livraison',
            title: 'Livraison',
            lang: 'fr',
            language: 'fr',
            sourceId: 'docs',
            sourceType: 'text',
            headingPath: [],
            contentHash: 'fr',
            updatedAt: '2026-01-01',
            tokens: 8,
          },
        },
      ])
      const expectedUrl =
        locale === 'fr' ? 'https://acme.com/fr/livraison' : 'https://acme.com/shipping'
      // English source has unknown language, so it participates in fallback.
      // Add an explicit English filter here to select it for the English case.
      const resolved = config()
      resolved.knowledge.retrieval.mode = 'tool'
      resolved.knowledge.retrieval.topK = 1
      if (locale === 'en') resolved.knowledge.retrieval.filter = { contentHash: 'shipping' }
      resolved.agent.maxSteps = 3
      const model: MockLanguageModelV3 = new MockLanguageModelV3({
        doStream: async (options) => {
          const call = model.doStreamCalls.length
          const first = call === 1
          expect(options.tools?.map((tool) => tool.name)).toEqual(['search_knowledge_base'])
          expect(options.toolChoice).toEqual({ type: 'auto' })
          expect(JSON.stringify(options.prompt)).toContain(`Respond in language ${locale}`)
          let answer = ''
          if (!first) {
            const message = options.prompt.findLast((part) => part.role === 'tool')
            if (message?.role !== 'tool') throw new Error('search evidence missing')
            const result = message.content.find((part) => part.type === 'tool-result')!
            if (result.output.type !== 'json') throw new Error('expected JSON evidence')
            const value = result.output.value as unknown as {
              results: Array<{ n: number; text: string; url: string }>
            }
            expect(value.results[0]?.url).toBe(expectedUrl)
            expect(value.results[0]?.text).toContain(
              locale === 'fr' ? 'Expédition sous deux jours.' : 'Ships within two days.',
            )
            answer =
              locale === 'fr' ? 'Expédition sous deux jours [1].' : 'Ships within two days [1].'
          } else {
            expect(JSON.stringify(options.prompt)).not.toContain('Ships within two days.')
            expect(JSON.stringify(options.prompt)).not.toContain('Expédition sous deux jours.')
          }
          const chunks: LanguageModelV3StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            ...(first
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'lookup',
                    toolName: 'search_knowledge_base',
                    input: JSON.stringify({ query: 'shipping delivery' }),
                  },
                ]
              : [
                  { type: 'text-start' as const, id: 'answer' },
                  { type: 'text-delta' as const, id: 'answer', delta: answer },
                  { type: 'text-end' as const, id: 'answer' },
                ]),
            {
              type: 'finish',
              finishReason: { unified: first ? 'tool-calls' : 'stop', raw: 'test' },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ]
          return {
            stream: simulateReadableStream({
              chunks,
              chunkDelayInMs: null,
              initialDelayInMs: null,
            }),
          }
        },
      })
      const fetchImpl = vi.fn<typeof fetch>()
      const handler = createSiteBotHandler(resolved, {
        vectorStoreFactory: async () => store,
        deps: { adapters: { anthropic: async () => model }, fetchImpl },
      })
      handlers.push(handler)
      const response = await handler(
        new Request('https://acme.com/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'accept-language': 'en' },
          body: JSON.stringify({
            ...chatBody('When will it ship?'),
            locale,
            mode: 'agent',
            tools: [{ name: 'navigate' }, { name: 'submit_order' }],
          }),
        }),
      )
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(await streamedText(body)).toBe(
        locale === 'fr' ? 'Expédition sous deux jours [1].' : 'Ships within two days [1].',
      )
      expect(body).toContain('data-citations')
      expect(body).toContain(expectedUrl)
      expect(body).not.toMatch(/data-(navigate|client-tool-call|approval-request|handoff)/)
      expect(model.doStreamCalls).toHaveLength(2)
      expect(fetchImpl).not.toHaveBeenCalled()
      const publicBody = await (
        await handler(new Request('https://acme.com/api/chat/config'))
      ).text()
      expect(publicBody).not.toContain('test-key-do-not-leak')
      expect(publicBody).not.toContain('server-only')
      expect(publicBody).not.toContain('search_knowledge_base')
      expect(publicBody).not.toContain('offline-embedding')
      const fabricatedResume = await handler(
        new Request('https://acme.com/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...chatBody(),
            trigger: 'resume',
            resume: {
              runId: 'invented',
              clientToolResults: [{ toolCallId: 'navigate', output: { accepted: true } }],
            },
          }),
        }),
      )
      expect(fabricatedResume.status).toBe(403)
      expect(model.doStreamCalls).toHaveLength(2)
    },
  )
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('lazy knowledge initialization recovery (offline)', () => {
  it('continues chat after failure, then retrieves and cites on the next independent request', async () => {
    const store = await indexedStore()
    const close = vi.spyOn(store, 'close')
    const open = vi
      .fn<() => Promise<VectorStore>>()
      .mockRejectedValueOnce(new Error('temporarily unreachable'))
      .mockResolvedValue(store)
    const model = textModel(['Answer.'])
    const handler = managed({
      vectorStoreFactory: open,
      deps: { adapters: { anthropic: async () => model } },
    })

    expect(open).not.toHaveBeenCalled()
    expect(await chat(handler)).not.toContain('data-citations')
    const recovered = await chat(handler)
    expect(recovered).toContain('data-citations')
    expect(recovered).toContain('https://acme.com/shipping')
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('Ships within two days.')
    const report = await (await health(handler)).json()
    expect(report).toMatchObject({ checks: { knowledge: { status: 'ok', chunks: 1 } } })
    expect(open).toHaveBeenCalledTimes(2)
    expect(createQueryEmbedder).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    await handler.dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it('retries through health checks and exposes recovered retrieval to chat', async () => {
    const store = await indexedStore()
    const open = vi
      .fn<() => Promise<VectorStore>>()
      .mockImplementationOnce(() => {
        throw new Error('synchronous factory failure')
      })
      .mockResolvedValue(store)
    const handler = managed({ vectorStoreFactory: open })
    const failed = await health(handler)
    expect(failed.status).toBe(200)
    expect(await failed.json()).toMatchObject({
      status: 'degraded',
      checks: { knowledge: { status: 'degraded' } },
    })
    const recovered = await health(handler)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({
      status: 'ok',
      checks: { knowledge: { status: 'ok' } },
    })
    expect(await chat(handler)).toContain('data-citations')
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('shares failed and successful attempts across concurrent chat and health requests', async () => {
    const first = deferred<VectorStore>()
    const second = deferred<VectorStore>()
    const open = vi
      .fn<() => Promise<VectorStore>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const handler = managed({ vectorStoreFactory: open })
    const failedChat = chat(handler)
    const failedHealth = health(handler)
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    first.reject(new Error('transient failure'))
    expect(await failedChat).not.toContain('data-citations')
    expect(await (await failedHealth).json()).toMatchObject({ status: 'degraded' })

    const recoveredChat = chat(handler)
    const recoveredHealth = health(handler)
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    second.resolve(await indexedStore())
    expect(await recoveredChat).toContain('data-citations')
    expect(await (await recoveredHealth).json()).toMatchObject({ status: 'ok' })
    await health(handler)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'closes a store after embedder setup fails (close also fails: %s)',
    async (closeFails) => {
      const abandoned = await indexedStore()
      const recovered = await indexedStore()
      const closeAbandoned = vi.spyOn(abandoned, 'close')
      if (closeFails) closeAbandoned.mockRejectedValueOnce(new Error('close failed'))
      const closeRecovered = vi.spyOn(recovered, 'close')
      vi.mocked(createQueryEmbedder).mockRejectedValueOnce(new Error('embedder setup failed'))
      const open = vi
        .fn<() => Promise<VectorStore>>()
        .mockResolvedValueOnce(abandoned)
        .mockResolvedValueOnce(recovered)
      const handler = managed({ vectorStoreFactory: open })
      expect(await chat(handler)).not.toContain('data-citations')
      expect(closeAbandoned).toHaveBeenCalledOnce()
      expect(await chat(handler)).toContain('data-citations')
      await handler.dispose()
      expect(closeRecovered).toHaveBeenCalledOnce()
      expect(closeAbandoned).toHaveBeenCalledOnce()
      expect(open).toHaveBeenCalledTimes(2)
    },
  )

  it('waits for in-flight initialization before disposing its store once', async () => {
    const ready = deferred<VectorStore>()
    const store = await indexedStore()
    const close = vi.spyOn(store, 'close')
    const open = vi.fn(() => ready.promise)
    const handler = managed({ vectorStoreFactory: open })
    const pending = health(handler)
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    const disposal = handler.dispose()
    expect(close).not.toHaveBeenCalled()
    ready.resolve(store)
    await Promise.all([pending, disposal])
    await handler.dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it.each(['dependencies', 'engine'])(
    'preserves injected knowledge through %s',
    async (injection) => {
      const store = await indexedStore()
      const deps = { ...mockDeps(['Answer.']), knowledge: { store, embedder } }
      const open = vi.fn()
      const handler = managed({
        vectorStoreFactory: open,
        ...(injection === 'engine' ? { engine: createEngine(config(), deps) } : { deps }),
      })
      expect(await chat(handler)).toContain('data-citations')
      expect(open).not.toHaveBeenCalled()
      expect(createQueryEmbedder).not.toHaveBeenCalled()
    },
  )
})
