import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV2 } from '@ai-sdk/provider'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { withModelTimeout } from './timeout.js'
import { createEngine } from '../engine.js'
import { MemorySessionStore } from '../session/store.js'
import { readSse, testConfig, testContext, userMessage } from '../../test/helpers.js'
import type { ToolContext } from '../types.js'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
}
const finish: LanguageModelV3StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
}
const answer = () => ({
  stream: simulateReadableStream<LanguageModelV3StreamPart>({
    initialDelayInMs: null,
    chunkDelayInMs: null,
    chunks: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Answer.' },
      { type: 'text-end', id: 't' },
      finish,
    ],
  }),
})
const events = async (response: Response) =>
  (await readSse(response)).filter((line) => line !== '[DONE]').map((line) => JSON.parse(line))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(
  model: MockLanguageModelV3,
  options: { locale?: string; retries?: number; fallback?: MockLanguageModelV3 } = {},
) {
  const parent = new AbortController(),
    store = new MemorySessionStore()
  const engine = createEngine(
    testConfig({
      backend: {
        provider: 'anthropic',
        model: 'offline',
        timeoutMs: 50,
        maxRetries: options.retries ?? 0,
        ...(options.fallback
          ? { fallback: [{ provider: 'openai', model: 'fallback', timeoutMs: 100, maxRetries: 0 }] }
          : {}),
      },
      telemetry: { logLevel: 'debug' },
    }),
    {
      sessionStore: store,
      adapters: {
        anthropic: async () => model,
        ...(options.fallback ? { openai: async () => options.fallback! } : {}),
      },
    },
  )
  const ctx = testContext({ signal: parent.signal, locale: options.locale ?? 'en' })
  const request = () =>
    engine.handleChat({ sessionId: ctx.sessionId, messages: [userMessage('Question')] }, ctx)
  return { engine, parent, store, ctx, request }
}

describe('backend.timeoutMs enforcement', () => {
  it('bounds provider startup even when doStream ignores cancellation, and discards its late stream', async () => {
    let signal: AbortSignal | undefined, release!: (value: ReturnType<typeof answer>) => void
    let lateCancelled = false
    const model = new MockLanguageModelV3({
      doStream: (options) => {
        signal = options.abortSignal
        return new Promise((resolve) => {
          release = resolve
        })
      },
    })
    const test = setup(model, { locale: 'fr' })
    const responsePromise = test.request()
    await vi.advanceTimersByTimeAsync(51)
    const response = await responsePromise
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body).toMatchObject({
      code: 'provider_error',
      message: 'L’assistant rencontre un problème pour répondre. Veuillez réessayer.',
    })
    expect(signal?.aborted).toBe(true)
    expect(test.parent.signal.aborted).toBe(false)
    release({
      stream: new ReadableStream({
        cancel() {
          lateCancelled = true
        },
      }),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(lateCancelled).toBe(true)
    expect(await test.store.get(test.ctx.sessionId)).toBeNull()
    await test.engine.dispose()
  })

  it.each(['en', 'fr'])(
    'bounds a stalled stream after text in %s through the terminal protocol and suppresses late chunks',
    async (locale) => {
      let source!: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        signal: AbortSignal | undefined
      const fallback = new MockLanguageModelV3({ doStream: async () => answer() })
      const model = new MockLanguageModelV3({
        doStream: async (options) => {
          signal = options.abortSignal
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                source = controller
                controller.enqueue({ type: 'stream-start', warnings: [] })
                controller.enqueue({ type: 'text-start', id: 't' })
                controller.enqueue({ type: 'text-delta', id: 't', delta: 'Partial answer.' })
              },
            }),
          }
        },
      })
      const test = setup(model, { locale, fallback })
      const completed = test.request().then(events)
      await vi.advanceTimersByTimeAsync(51)
      const chunks = await completed
      expect(chunks.filter((chunk) => chunk.type === 'data-error')).toMatchObject([
        { data: { code: 'provider_error', messageKey: 'provider_error', retryable: true } },
      ])
      expect(chunks.find((chunk) => chunk.type === 'data-error').data.message).toBe(
        locale === 'fr'
          ? 'L’assistant rencontre un problème pour répondre. Veuillez réessayer.'
          : 'The assistant is having trouble responding. Please try again.',
      )
      expect(chunks.find((chunk) => chunk.type === 'finish')).toMatchObject({
        finishReason: 'error',
      })
      expect(
        chunks
          .filter((chunk) => chunk.type === 'text-delta')
          .map((chunk) => chunk.delta)
          .join(''),
      ).toBe('Partial answer.')
      expect(signal?.aborted).toBe(true)
      expect(test.parent.signal.aborted).toBe(false)
      expect(fallback.doStreamCalls).toHaveLength(0)
      expect(() =>
        source.enqueue({ type: 'text-delta', id: 't', delta: 'LATE_PRIVATE_RESULT' }),
      ).toThrow()
      const stored = await test.store.get(test.ctx.sessionId)
      expect(stored?.messages.at(-1)?.parts).toContainEqual(
        expect.objectContaining({ type: 'data-error' }),
      )
      expect(stored?.state?.pendingRun).toBeUndefined()
      expect(JSON.stringify(stored)).not.toContain('LATE_PRIVATE_RESULT')
      await test.engine.dispose()
    },
  )

  it('honors maxRetries before commitment and gives the fallback its own deadline', async () => {
    const signals: AbortSignal[] = []
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        signals.push(options.abortSignal!)
        return new Promise(() => {})
      },
    })
    const fallback = new MockLanguageModelV3({ doStream: async () => answer() })
    const test = setup(model, { retries: 1, fallback })
    const completed = test.request().then(events)
    await vi.advanceTimersByTimeAsync(500)
    expect(
      (await completed).some((chunk) => chunk.type === 'text-delta' && chunk.delta === 'Answer.'),
    ).toBe(true)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(fallback.doStreamCalls).toHaveLength(1)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(test.parent.signal.aborted).toBe(false)
    await test.engine.dispose()
  })

  it('cancels pending startup promptly without retries/fallback or private cancellation reasons', async () => {
    let signal: AbortSignal | undefined
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        signal = options.abortSignal
        return new Promise(() => {})
      },
    })
    const fallback = new MockLanguageModelV3({ doStream: async () => answer() })
    const test = setup(model, { retries: 2, fallback })
    const responsePromise = test.request()
    await vi.advanceTimersByTimeAsync(1)
    test.parent.abort(new Error('PRIVATE_REQUEST_SECRET'))
    await vi.advanceTimersByTimeAsync(0)
    const response = await responsePromise
    const body = await response.text()
    expect(body).toContain('aborted')
    expect(body).not.toContain('PRIVATE_REQUEST_SECRET')
    expect(signal?.aborted).toBe(true)
    expect(model.doStreamCalls).toHaveLength(1)
    expect(fallback.doStreamCalls).toHaveLength(0)
    await test.engine.dispose()
  })

  it.each([true, false])(
    'provider completion releases its timer before tools; unfinished provider timeout closes source staging (finished=%s)',
    async (providerFinished) => {
      let toolSignal: AbortSignal | undefined,
        finishTool!: () => void,
        providerSignal: AbortSignal | undefined
      const model: MockLanguageModelV3 = new MockLanguageModelV3({
        doStream: async (options) => {
          providerSignal = options.abortSignal
          if (model.doStreamCalls.length > 1) return answer()
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] })
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'c',
                  toolName: 'lookup',
                  input: '{}',
                })
                if (providerFinished) {
                  controller.enqueue({
                    ...finish,
                    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                  })
                  controller.close()
                }
              },
            }),
          }
        },
      })
      const execute = async (_input: unknown, ctx: ToolContext) => {
        toolSignal = ctx.signal
        const source = ctx.sources.register({
          id: 'source',
          url: 'https://example.test/source',
          title: 'Public source',
          text: 'Evidence',
          lang: 'en',
        })
        await new Promise<void>((resolve) => {
          finishTool = resolve
        })
        return { n: source.n }
      }
      const parent = new AbortController()
      const engine = createEngine(
        testConfig({
          backend: { provider: 'anthropic', model: 'offline', timeoutMs: 50, maxRetries: 0 },
          tools: [
            {
              name: 'lookup',
              description: 'Read public application evidence.',
              readOnly: true,
              parameters: { type: 'object' },
              outputSchema: { type: 'object' },
              execute,
            },
          ],
        }),
        { adapters: { anthropic: async () => model } },
      )
      const completed = engine
        .handleChat(
          { sessionId: 'session', messages: [userMessage('Question')] },
          testContext({ signal: parent.signal }),
        )
        .then(events)
      await vi.advanceTimersByTimeAsync(60)
      if (providerFinished) {
        expect(toolSignal).toBeDefined()
        expect(toolSignal?.aborted).toBe(false)
        expect(providerSignal?.aborted).toBe(false)
        finishTool()
        await vi.advanceTimersByTimeAsync(0)
        const chunks = await completed
        expect(chunks.some((chunk) => chunk.type === 'data-citations')).toBe(true)
        expect(chunks.some((chunk) => chunk.type === 'data-error')).toBe(false)
        expect(model.doStreamCalls).toHaveLength(2)
      } else {
        const chunks = await completed
        expect(toolSignal).toBeUndefined()
        expect(providerSignal?.aborted).toBe(true)
        expect(chunks.some((chunk) => chunk.type === 'data-error')).toBe(true)
        expect(chunks.some((chunk) => chunk.type === 'data-citations')).toBe(false)
        await vi.advanceTimersByTimeAsync(0)
        expect(model.doStreamCalls).toHaveLength(1)
      }
      expect(parent.signal.aborted).toBe(false)
      await engine.dispose()
    },
  )

  it('bounds the engine history-summary call with the configured timeout and retries, then continues without a late summary', async () => {
    const store = new MemorySessionStore()
    const ctx = testContext()
    const time = Date.now()
    await store.set({
      id: ctx.sessionId,
      createdAt: time,
      updatedAt: time,
      messages: Array.from({ length: 12 }, (_, index) =>
        userMessage('x'.repeat(100_000), `old-${index}`),
      ),
    })
    let signal: AbortSignal | undefined,
      release!: (value: {
        content: Array<{ type: 'text'; text: string }>
        finishReason: { unified: 'stop'; raw: 'stop' }
        usage: typeof usage
        warnings: []
      }) => void
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        signal = options.abortSignal
        return new Promise((resolve) => {
          release = resolve
        })
      },
      doStream: async () => answer(),
    })
    const engine = createEngine(
      testConfig({
        backend: { provider: 'anthropic', model: 'offline', timeoutMs: 50, maxRetries: 0 },
      }),
      { sessionStore: store, adapters: { anthropic: async () => model } },
    )
    const completed = engine
      .handleChat({ sessionId: ctx.sessionId, messages: [userMessage('New question')] }, ctx)
      .then(events)
    await vi.advanceTimersByTimeAsync(51)
    expect(
      (await completed).some((chunk) => chunk.type === 'text-delta' && chunk.delta === 'Answer.'),
    ).toBe(true)
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(signal?.aborted).toBe(true)
    release({
      content: [{ type: 'text', text: 'LATE PRIVATE SUMMARY' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect((await store.get(ctx.sessionId))?.state?.historySummary).toBeUndefined()
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain('LATE PRIVATE SUMMARY')
    expect(ctx.signal.aborted).toBe(false)
    await engine.dispose()
  })

  it('cleans up successful provider calls without later aborting their signals or the request', async () => {
    let signal: AbortSignal | undefined
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        signal = options.abortSignal
        return answer()
      },
    })
    const test = setup(model)
    const completed = test.request().then(events)
    await vi.advanceTimersByTimeAsync(1)
    expect((await completed).some((chunk) => chunk.type === 'text-delta')).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(signal?.aborted).toBe(false)
    test.parent.abort()
    expect(signal?.aborted).toBe(false)
    await test.engine.dispose()
  })

  it('bounds a stream that opens but never supplies any provider events', async () => {
    let signal: AbortSignal | undefined
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        signal = options.abortSignal
        return { stream: new ReadableStream<LanguageModelV3StreamPart>() }
      },
    })
    const test = setup(model)
    const responsePromise = test.request()
    await vi.advanceTimersByTimeAsync(51)
    const response = await responsePromise
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: 'provider_error' })
    expect(signal?.aborted).toBe(true)
    expect(test.parent.signal.aborted).toBe(false)
    await test.engine.dispose()
  })

  it('cleans up the deadline after immediate provider failure', async () => {
    let signal: AbortSignal | undefined
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        signal = options.abortSignal
        throw Object.assign(new Error('PRIVATE_PROVIDER_CREDENTIAL'), { statusCode: 400 })
      },
    })
    const test = setup(model)
    const responsePromise = test.request()
    await vi.advanceTimersByTimeAsync(1)
    expect((await responsePromise).status).toBe(502)
    await vi.advanceTimersByTimeAsync(100)
    expect(signal?.aborted).toBe(false)
    test.parent.abort()
    expect(signal?.aborted).toBe(false)
    await test.engine.dispose()
  })

  it('preserves request cancellation during streaming as aborted, without exposing its private reason', async () => {
    let signal: AbortSignal | undefined
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        signal = options.abortSignal
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'text-start', id: 't' })
              controller.enqueue({ type: 'text-delta', id: 't', delta: 'Partial' })
            },
          }),
        }
      },
    })
    const test = setup(model)
    const completed = test.request().then(events)
    await vi.advanceTimersByTimeAsync(1)
    test.parent.abort(new Error('PRIVATE_ABORT_REASON'))
    await vi.advanceTimersByTimeAsync(0)
    const chunks = await completed
    expect(chunks.filter((chunk) => chunk.type === 'data-error')).toMatchObject([
      { data: { code: 'aborted', retryable: false } },
    ])
    expect(JSON.stringify(chunks)).not.toContain('PRIVATE_ABORT_REASON')
    expect(signal?.aborted).toBe(true)
    expect(model.doStreamCalls).toHaveLength(1)
    await test.engine.dispose()
  })

  it('bounds nonstreaming generation and ignores late results while preserving normal completion', async () => {
    const parent = new AbortController()
    let release!: (value: {
      content: Array<{ type: 'text'; text: string }>
      finishReason: { unified: 'stop'; raw: 'stop' }
      usage: typeof usage
      warnings: []
    }) => void
    let signal: AbortSignal | undefined
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        signal = options.abortSignal
        return new Promise((resolve) => {
          release = resolve
        })
      },
    })
    const result = generateText({
      model: withModelTimeout(model, 50),
      prompt: 'Summarize',
      maxRetries: 0,
      abortSignal: parent.signal,
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(51)
    expect(await result).toBeInstanceOf(Error)
    expect(signal?.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
    release({
      content: [{ type: 'text', text: 'LATE SUMMARY' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    })
    await vi.advanceTimersByTimeAsync(0)
    const normal = new MockLanguageModelV3({
      doGenerate: async (options) => {
        signal = options.abortSignal
        return {
          content: [{ type: 'text', text: 'Summary' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        }
      },
    })
    expect(
      (
        await generateText({
          model: withModelTimeout(normal, 50),
          prompt: 'Summarize',
          maxRetries: 0,
          abortSignal: parent.signal,
        })
      ).text,
    ).toBe('Summary')
    await vi.advanceTimersByTimeAsync(100)
    expect(signal?.aborted).toBe(false)
  })

  it('preserves v2 provider compatibility', async () => {
    const model: LanguageModelV2 = {
      specificationVersion: 'v2',
      provider: 'offline',
      modelId: 'v2',
      supportedUrls: {},
      doStream: async () => {
        throw new Error('Unexpected streaming call')
      },
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'v2 answer' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }),
    }
    expect(
      (
        await generateText({
          model: withModelTimeout(model, 50),
          prompt: 'Question',
          maxRetries: 0,
        })
      ).text,
    ).toBe('v2 answer')
  })
})
