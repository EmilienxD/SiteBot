import { describe, expect, it, vi } from 'vitest'
import { simulateReadableStream, type UIMessage, type UIMessageChunk } from 'ai'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV3 } from 'ai/test'
import { createEngine } from './engine.js'
import { MemorySessionStore } from './session/store.js'
import { savePendingRun } from './agent/checkpoint.js'
import { silentLogger } from './telemetry/logger.js'
import type { ToolContext } from './types.js'
import { readSse, testConfig, testContext, userMessage } from '../test/helpers.js'

interface ScriptStep {
  tool?: boolean
  text?: string
  reasoning?: string
  tokens?: number
  elapsedMs?: number
  reason?: 'stop' | 'tool-calls' | 'length'
  cancel?: boolean
}

async function run(
  script: ScriptStep[],
  options: {
    locale?: string
    maxSteps?: number
    onMaxSteps?: 'summarize' | 'silent' | 'error'
  } = {},
) {
  let clock = 0
  const cancellation = new AbortController()
  const store = new MemorySessionStore()
  const execute = vi.fn((_input: unknown, ctx: ToolContext) => {
    const source = ctx.sources.register({
      id: 'public-guide',
      url: 'https://example.test/guide',
      title: 'Public guide',
      text: 'Bounded public evidence.',
      lang: 'en',
    })
    return { matches: [{ n: source.n, excerpt: 'Bounded public evidence.' }] }
  })
  const finished = vi.fn(),
    diagnostics = vi.fn()
  const config = testConfig({
    backend: {
      provider: 'anthropic',
      model: 'offline',
      maxOutputTokens: 900,
      timeoutMs: 30_000,
      maxRetries: 0,
    },
    agent: {
      maxSteps: options.maxSteps ?? 4,
      parallelToolCalls: false,
      stopWhen: { tokens: 12_000, seconds: 45 },
      onMaxSteps: options.onMaxSteps ?? 'summarize',
    },
    hooks: { onFinish: finished },
    tools: [
      {
        name: 'search_knowledge_base',
        description: 'Search application public evidence.',
        readOnly: true,
        parameters: { type: 'object' },
        outputSchema: { type: 'object' },
        execute,
      },
    ],
  })
  const model: MockLanguageModelV3 = new MockLanguageModelV3({
    doStream: async () => {
      const index = model.doStreamCalls.length - 1
      const step = script[index]
      if (!step) throw new Error('Unexpected extra model invocation')
      if (step.cancel) cancellation.abort(new Error('PRIVATE_CANCELLATION_DETAIL'))
      clock += step.elapsedMs ?? 0
      const chunks: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }]
      if (step.reasoning !== undefined)
        chunks.push(
          { type: 'reasoning-start', id: 'r' },
          { type: 'reasoning-delta', id: 'r', delta: step.reasoning },
          { type: 'reasoning-end', id: 'r' },
        )
      if (step.text !== undefined)
        chunks.push(
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: step.text },
          { type: 'text-end', id: 't' },
        )
      if (step.tool)
        chunks.push({
          type: 'tool-call',
          toolCallId: `call-${index}`,
          toolName: 'search_knowledge_base',
          input: '{}',
        })
      const tokens = step.tokens ?? 100
      chunks.push({
        type: 'finish',
        finishReason: {
          unified: step.reason ?? (step.tool ? 'tool-calls' : 'stop'),
          raw: 'scripted',
        },
        usage: {
          inputTokens: { total: tokens - 1, noCache: tokens - 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: step.text ? 1 : 0, reasoning: step.reasoning ? 1 : 0 },
        },
      })
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      }
    },
  })
  const engine = createEngine(config, {
    sessionStore: store,
    now: () => clock,
    adapters: { anthropic: async () => model },
  })
  const ctx = testContext({
    locale: options.locale ?? 'en',
    signal: cancellation.signal,
    logger: { ...silentLogger, debug: diagnostics },
  })
  try {
    const response = await engine.handleChat(
      { sessionId: ctx.sessionId, messages: [userMessage('Can I publish this on Facebook?')] },
      ctx,
    )
    const chunks = (await readSse(response))
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line) as UIMessageChunk)
    return {
      status: response.status,
      chunks,
      model,
      execute,
      finished,
      diagnostics,
      session: await store.get(ctx.sessionId),
    }
  } finally {
    await engine.dispose()
  }
}

const text = (chunks: UIMessageChunk[]) =>
  chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.delta] : [])).join('')
const errors = (chunks: UIMessageChunk[]) =>
  chunks.filter((chunk) => chunk.type === 'data-error') as Array<{
    type: 'data-error'
    data: { code: string; message: string; messageKey?: string; retryable: boolean }
  }>

describe('terminal outcomes after bounded application tool loops', () => {
  it('persists a spent resumed run as an explicit error, clears its checkpoint and retains committed citations', async () => {
    const store = new MemorySessionStore(),
      adapter = vi.fn(async () => new MockLanguageModelV3())
    const ctx = testContext()
    const responseMessage: UIMessage = {
      id: 'response',
      role: 'assistant',
      parts: [
        { type: 'tool-read_page', toolCallId: 'c', state: 'input-available', input: {} },
        {
          type: 'data-citations',
          id: 'source-citations',
          data: {
            items: [
              {
                id: 'c1',
                chunkId: 'guide',
                title: 'Guide',
                url: 'https://example.test/guide',
                snippet: 'Public evidence.',
                lang: 'en',
              },
            ],
          },
        },
      ],
    }
    await savePendingRun(
      store,
      {
        id: ctx.sessionId,
        messages: [responseMessage],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        runId: 'run',
        responseMessage,
        expiresAt: Date.now() + 60_000,
        stepsTaken: 3,
        tokensUsed: 12_000,
      },
    )
    const engine = createEngine(
      testConfig({
        agent: { maxSteps: 4, stopWhen: { tokens: 12_000 } },
        tools: [
          {
            name: 'read_page',
            description: 'Read the page in the application.',
            readOnly: true,
            parameters: { type: 'object' },
            outputSchema: { type: 'object' },
            executor: { type: 'client', id: 'read_page' },
          },
        ],
      }),
      { sessionStore: store, adapters: { anthropic: adapter } },
    )
    try {
      const chunks = (
        await readSse(
          await engine.handleChat(
            {
              sessionId: ctx.sessionId,
              trigger: 'resume',
              messages: [],
              resume: { runId: 'run', clientToolResults: [{ toolCallId: 'c', output: {} }] },
            },
            ctx,
          ),
        )
      )
        .filter((line) => line !== '[DONE]')
        .map((line) => JSON.parse(line) as UIMessageChunk)
      expect(errors(chunks)).toMatchObject([{ data: { code: 'budget_exceeded' } }])
      expect(adapter).not.toHaveBeenCalled()
      const stored = await store.get(ctx.sessionId)
      expect(stored?.state?.pendingRun).toBeUndefined()
      expect(stored?.messages[0]?.parts).toContainEqual(
        expect.objectContaining({ type: 'data-error' }),
      )
      expect(stored?.messages[0]?.parts).toContainEqual(
        expect.objectContaining({ type: 'data-citations' }),
      )
      expect(stored?.messages[0]?.parts).toContainEqual(
        expect.objectContaining({ type: 'tool-read_page', state: 'output-error' }),
      )
    } finally {
      await engine.dispose()
    }
  })

  it.each(['tokens', 'time'] as const)(
    'three completed searches reaching the %s ceiling cannot finish as successful silence',
    async (limit) => {
      const result = await run(
        Array.from({ length: 3 }, () => ({
          tool: true,
          tokens: limit === 'tokens' ? 4000 : 100,
          elapsedMs: limit === 'time' ? 15_000 : 0,
        })),
      )
      expect(result.status).toBe(200)
      expect(result.model.doStreamCalls).toHaveLength(3)
      expect(result.execute).toHaveBeenCalledTimes(3)
      expect(result.finished.mock.calls[0]?.[0]).toMatchObject({
        finishReason: 'tool-calls',
        usage: { inputTokens: limit === 'tokens' ? 11_997 : 297, outputTokens: 3 },
      })
      expect(text(result.chunks)).toBe('')
      expect(errors(result.chunks)).toMatchObject([
        { data: { code: 'budget_exceeded', messageKey: 'budget_exceeded', retryable: false } },
      ])
      expect(result.chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'error' })
      const assistant = result.session?.messages.findLast((message) => message.role === 'assistant')
      expect(assistant?.parts).toContainEqual(expect.objectContaining({ type: 'data-error' }))
      expect(result.session?.state?.pendingRun).toBeUndefined()
      expect(result.chunks).toContainEqual(
        expect.objectContaining({
          type: 'data-citations',
          data: expect.objectContaining({
            items: [expect.objectContaining({ chunkId: 'public-guide' })],
          }),
        }),
      )
      expect(result.diagnostics).toHaveBeenCalledWith(
        'model loop finalized',
        expect.objectContaining({
          stopReason: limit,
          steps: 3,
          totalTokens: limit === 'tokens' ? 12_000 : 300,
          activeMs: limit === 'time' ? 45_000 : 0,
          answerCharacters: 0,
          terminalCode: 'budget_exceeded',
        }),
      )
    },
  )

  it('runs the fourth, tool-free summary when all three hard limits still permit it', async () => {
    const result = await run([
      ...Array.from({ length: 3 }, () => ({ tool: true, tokens: 3999, elapsedMs: 14_999 })),
      { text: 'The supplied evidence does not confirm Facebook support. [1]', tokens: 2 },
    ])
    expect(result.model.doStreamCalls).toHaveLength(4)
    expect(result.execute).toHaveBeenCalledTimes(3)
    expect(result.model.doStreamCalls[3]?.toolChoice).toEqual({ type: 'none' })
    expect(result.model.doStreamCalls[3]?.tools).toEqual([])
    expect(JSON.stringify(result.model.doStreamCalls[3]?.prompt)).toContain(
      'You have reached the final step.',
    )
    expect(text(result.chunks)).toContain('does not confirm Facebook support')
    expect(errors(result.chunks)).toEqual([])
    expect(result.chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it.each(['summarize', 'silent', 'error'] as const)(
    'a call at the step ceiling is explicit even with onMaxSteps=%s',
    async (onMaxSteps) => {
      const result = await run([{ tool: true }, { tool: true }, { tool: true }, { tool: true }], {
        onMaxSteps,
      })
      expect(result.model.doStreamCalls).toHaveLength(4)
      expect(errors(result.chunks)).toMatchObject([
        {
          data:
            onMaxSteps === 'summarize'
              ? { code: 'provider_error', retryable: true }
              : { code: 'max_steps_exceeded', retryable: false },
        },
      ])
    },
  )

  it.each([
    { text: '' },
    { text: '  \n' },
    { reasoning: 'private reasoning only' },
    { reason: 'length' as const },
  ])('a provider finish without an answer is a safe terminal error: %j', async (step) => {
    const result = await run([step])
    expect(result.model.doStreamCalls).toHaveLength(1)
    expect(errors(result.chunks)).toMatchObject([{ data: { code: 'provider_error' } }])
    expect(JSON.stringify(errors(result.chunks))).not.toContain('private reasoning')
  })

  it('localizes an exhausted run through the existing French error catalog', async () => {
    const result = await run([{ tool: true, tokens: 12_000 }], { locale: 'fr' })
    expect(errors(result.chunks)).toMatchObject([
      {
        data: {
          code: 'budget_exceeded',
          messageKey: 'budget_exceeded',
          message: 'L’assistant a atteint sa limite d’utilisation.',
        },
      },
    ])
  })

  it('does not turn a normal grounded answer into a budget error just because its usage reaches the ceiling', async () => {
    const result = await run([{ text: 'A grounded answer. [1]', tokens: 12_000 }])
    expect(errors(result.chunks)).toEqual([])
    expect(text(result.chunks)).toBe('A grounded answer. [1]')
  })

  it('uses the evaluated limit rather than trusting the provider finish reason', async () => {
    const result = await run(
      Array.from({ length: 3 }, () => ({ tool: true, tokens: 4000, reason: 'stop' as const })),
    )
    expect(result.finished.mock.calls[0]?.[0]).toMatchObject({ finishReason: 'stop' })
    expect(result.model.doStreamCalls).toHaveLength(3)
    expect(errors(result.chunks)).toMatchObject([{ data: { code: 'budget_exceeded' } }])
  })

  it('keeps a post-tool cancellation explicit, without a final model retry or private abort details', async () => {
    const result = await run([{ tool: true }, { cancel: true }])
    expect(result.model.doStreamCalls).toHaveLength(2)
    expect(errors(result.chunks)).toMatchObject([{ data: { code: 'aborted', retryable: false } }])
    expect(
      result.chunks.some((chunk) => chunk.type === 'finish' && chunk.finishReason === 'stop'),
    ).toBe(false)
    expect(JSON.stringify(result.chunks)).not.toContain('PRIVATE_CANCELLATION_DETAIL')
    expect(result.session?.state?.pendingRun).toBeUndefined()
  })
})
