import { describe, expect, it, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { MemorySessionStore } from '@sitebot/core'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { createSiteBotHandler } from './handler.js'
import { testConfig, SESSION } from '../test/helpers.js'

describe('terminal tool-only outcomes over HTTP', () => {
  it('bounds a stalled provider after HTTP streaming begins and retains a localized timeout outcome', async () => {
    vi.useFakeTimers()
    const requestController = new AbortController()
    let started!: () => void
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let providerSignal: AbortSignal | undefined
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        providerSignal = options.abortSignal
        started()
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'text-start', id: 't' })
              controller.enqueue({ type: 'text-delta', id: 't', delta: 'Début de réponse.' })
            },
          }),
        }
      },
    })
    const store = new MemorySessionStore()
    const handler = createSiteBotHandler(
      testConfig({
        backend: { provider: 'anthropic', model: 'offline', timeoutMs: 20, maxRetries: 0 },
      }),
      {
        deps: { sessionStore: store, adapters: { anthropic: async () => model } },
      },
    )
    try {
      const completed = handler(
        new Request('http://localhost/api/chat', {
          method: 'POST',
          signal: requestController.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: SESSION,
            locale: 'fr',
            messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Question' }] }],
          }),
        }),
      ).then(async (response) => ({ status: response.status, wire: await response.text() }))
      await providerStarted
      await vi.advanceTimersByTimeAsync(25)
      const { status, wire } = await completed
      expect(status).toBe(200)
      const chunks = wire
        .split('\n')
        .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
        .map((line) => JSON.parse(line.slice(6)))
      expect(chunks.filter((chunk) => chunk.type === 'data-error')).toMatchObject([
        {
          data: {
            code: 'provider_error',
            messageKey: 'provider_error',
            retryable: true,
            message: 'L’assistant rencontre un problème pour répondre. Veuillez réessayer.',
          },
        },
      ])
      expect(chunks.find((chunk) => chunk.type === 'finish')).toMatchObject({
        finishReason: 'error',
      })
      expect(providerSignal?.aborted).toBe(true)
      expect(requestController.signal.aborted).toBe(false)
      expect(model.doStreamCalls).toHaveLength(1)
      expect((await store.get(SESSION))?.messages.at(-1)?.parts).toContainEqual(
        expect.objectContaining({ type: 'data-error' }),
      )
    } finally {
      await handler.dispose()
      vi.useRealTimers()
    }
  })

  it.each([
    ['en', 'The assistant has reached its usage limit for now.'],
    ['fr', 'L’assistant a atteint sa limite d’utilisation.'],
  ])(
    'persists a localized %s error and permits a fresh follow-up without another finalization call',
    async (locale, message) => {
      const model: MockLanguageModelV3 = new MockLanguageModelV3({
        doStream: async () => {
          const first = model.doStreamCalls.length === 1
          const chunks: LanguageModelV3StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            ...(first
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'c',
                    toolName: 'search_public',
                    input: '{}',
                  },
                ]
              : [
                  { type: 'text-start' as const, id: 't' },
                  { type: 'text-delta' as const, id: 't', delta: 'A new answer.' },
                  { type: 'text-end' as const, id: 't' },
                ]),
            {
              type: 'finish',
              finishReason: { unified: first ? 'tool-calls' : 'stop', raw: 'scripted' },
              usage: {
                inputTokens: {
                  total: first ? 11_999 : 10,
                  noCache: first ? 11_999 : 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: first ? 0 : 1, reasoning: 0 },
              },
            },
          ]
          return {
            stream: simulateReadableStream({
              chunks,
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          }
        },
      })
      const store = new MemorySessionStore()
      const handler = createSiteBotHandler(
        testConfig({
          backend: { provider: 'anthropic', model: 'offline', maxRetries: 0 },
          agent: {
            maxSteps: 4,
            onMaxSteps: 'summarize',
            stopWhen: { tokens: 12_000, seconds: 45 },
          },
          tools: [
            {
              name: 'search_public',
              description: 'Search public application content.',
              readOnly: true,
              parameters: { type: 'object' },
              outputSchema: { type: 'object' },
              execute: () => ({ matches: [], protocol: 'INTERNAL_SEARCH_RESULT' }),
            },
          ],
        }),
        { deps: { sessionStore: store, adapters: { anthropic: async () => model } } },
      )
      const ask = (id: string) =>
        handler(
          new Request('http://localhost/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: SESSION,
              locale,
              messages: [{ id, role: 'user', parts: [{ type: 'text', text: 'Question' }] }],
            }),
          }),
        )
      try {
        const response = await ask('u1')
        expect(response.status).toBe(200)
        const wire = await response.text()
        expect(model.doStreamCalls).toHaveLength(1)
        const chunks = wire
          .split('\n')
          .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
          .map((line) => JSON.parse(line.slice(6)))
        expect(chunks.filter((chunk) => chunk.type === 'data-error')).toMatchObject([
          {
            data: {
              code: 'budget_exceeded',
              messageKey: 'budget_exceeded',
              message,
              retryable: false,
            },
          },
        ])
        expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'error' })
        expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false)
        const session = await store.get(SESSION)
        expect(session?.messages.at(-1)?.parts).toContainEqual(
          expect.objectContaining({ type: 'data-error' }),
        )
        expect(session?.state?.pendingRun).toBeUndefined()
        const followup = await ask('u2')
        expect(await followup.text()).toContain('A new answer.')
        expect(model.doStreamCalls).toHaveLength(2)
      } finally {
        await handler.dispose()
      }
    },
  )
})
