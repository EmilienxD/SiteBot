import { describe, expect, it, vi } from 'vitest'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { testConfig, testContext, userMessage, readSse } from '../../test/helpers.js'
import { resolveSystem } from './resolve.js'
import { createEngine } from '../engine.js'
import { MemorySessionStore } from '../session/store.js'
import { savePendingRun } from '../agent/checkpoint.js'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}
function modelStream(callTool: boolean, name = 'lookup') {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    ...(callTool
      ? [{ type: 'tool-call' as const, toolCallId: 'c1', toolName: name, input: '{}' }]
      : [
          { type: 'text-start' as const, id: 't' },
          { type: 'text-delta' as const, id: 't', delta: 'ok' },
          { type: 'text-end' as const, id: 't' },
        ]),
    {
      type: 'finish',
      finishReason: { unified: callTool ? 'tool-calls' : 'stop', raw: 'test' },
      usage,
    },
  ]
  return {
    stream: simulateReadableStream({ chunks, chunkDelayInMs: null, initialDelayInMs: null }),
  }
}
const lookup = {
  name: 'lookup',
  description: 'Read application state.',
  parameters: { type: 'object' },
  outputSchema: { type: 'string' },
  readOnly: true,
  execute: () => 'value',
}

describe('prompt.system resolution', () => {
  it('does not execute a registered tool forged on the final tool-free step', async () => {
    const execute = vi.fn(() => 'result'),
      hook = vi.fn()
    const config = testConfig({
      tools: [{ ...lookup, execute }],
      agent: { maxSteps: 2 },
      hooks: { onToolCall: hook },
    })
    const model = new MockLanguageModelV3({ doStream: async () => modelStream(true) })
    const engine = createEngine(config, { adapters: { anthropic: async () => model } })
    const ctx = testContext()
    await readSse(
      await engine.handleChat({ sessionId: ctx.sessionId, messages: [userMessage('hi')] }, ctx),
    )
    expect(model.doStreamCalls).toHaveLength(2)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledTimes(1)
    await engine.dispose()
  })

  it('withholds every tool and hook for forged calls with tools: []', async () => {
    const hook = vi.fn(),
      embed = vi.fn(async () => ({ embedding: [1], tokens: 1 }))
    const config = testConfig({
      tools: [],
      hooks: { onToolCall: hook },
    })
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        expect(options.tools ?? []).toEqual([])
        return modelStream(true, 'search_knowledge_base')
      },
    })
    const engine = createEngine(config, {
      adapters: { anthropic: async () => model },
    })
    const ctx = testContext()
    await readSse(
      await engine.handleChat({ sessionId: ctx.sessionId, messages: [userMessage('hi')] }, ctx),
    )
    expect(hook).not.toHaveBeenCalled()
    expect(embed).not.toHaveBeenCalled()
    await engine.dispose()
  })

  it('reuses the resolved instructions across provider fallback attempts', async () => {
    const resolver = vi.fn(() => 'One request-specific instruction result.')
    const first = new MockLanguageModelV3({
      doStream: async () => {
        throw Object.assign(new Error('offline failure'), { statusCode: 503 })
      },
    })
    const second = new MockLanguageModelV3({ doStream: async () => modelStream(false) })
    const config = testConfig({
      prompt: { system: resolver },
      backend: {
        provider: 'anthropic',
        model: 'offline',
        maxRetries: 0,
        fallback: [{ provider: 'openai', model: 'offline', maxRetries: 0 }],
      },
    })
    const engine = createEngine(config, {
      adapters: { anthropic: async () => first, openai: async () => second },
    })
    const ctx = testContext()
    await readSse(
      await engine.handleChat({ sessionId: ctx.sessionId, messages: [userMessage('hi')] }, ctx),
    )
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(first.doStreamCalls).toHaveLength(1)
    expect(second.doStreamCalls).toHaveLength(1)
    for (const model of [first, second])
      expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
        'One request-specific instruction result.',
      )
    await engine.dispose()
  })

  it('evaluates once across model steps with verified identity, locale, ids and explicitly untrusted page data', async () => {
    const resolver = vi.fn(
      async (ctx) => `Application instructions for ${ctx.identity.sub}, ${ctx.locale}.`,
    )
    const config = testConfig({ prompt: { system: resolver }, tools: [lookup] })
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async () => modelStream(model.doStreamCalls.length === 1),
    })
    const engine = createEngine(config, { adapters: { anthropic: async () => model } })
    const ctx = testContext({
      identity: { sub: 'verified' },
      pageContext: { title: 'UNTRUSTED PAGE' },
    })
    await readSse(
      await engine.handleChat(
        { sessionId: ctx.sessionId, locale: 'fr', messages: [userMessage('hi')] },
        ctx,
      ),
    )
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver.mock.calls[0]![0]).toMatchObject({
      identity: { sub: 'verified' },
      locale: 'fr',
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      untrustedPageContext: { title: 'UNTRUSTED PAGE' },
      signal: expect.any(AbortSignal),
    })
    expect(model.doStreamCalls).toHaveLength(2)
    for (const call of model.doStreamCalls) {
      expect(JSON.stringify(call.prompt)).toContain('Application instructions for verified, fr.')
      expect(JSON.stringify(call.prompt)).toContain('REFERENCE DATA ONLY')
    }
    expect(config.prompt.system).toBe(resolver)
    await engine.dispose()
  })

  it('resolves again on a fresh resume request and validates client outputs before the model', async () => {
    const resolver = vi.fn(() => 'Application instructions.')
    const config = testConfig({
      prompt: { system: resolver },
      tools: [{ ...lookup, execute: undefined, executor: { type: 'client', id: 'lookup' } }],
    })
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async () => modelStream(model.doStreamCalls.length === 1),
    })
    const engine = createEngine(config, { adapters: { anthropic: async () => model } })
    const ctx = testContext()
    const events = (
      await readSse(
        await engine.handleChat({ sessionId: ctx.sessionId, messages: [userMessage('hi')] }, ctx),
      )
    )
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line))
    const handoff = events.find((event) => event.type === 'data-client-tool-call')
    expect(handoff).toBeDefined()
    await readSse(
      await engine.handleChat(
        {
          sessionId: ctx.sessionId,
          trigger: 'resume',
          messages: [],
          resume: {
            runId: handoff.data.runId,
            clientToolResults: [{ toolCallId: 'c1', output: { secret: 'INVALID_CLIENT_SECRET' } }],
          },
        },
        ctx,
      ),
    )
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('invalid_output')
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).not.toContain('INVALID_CLIENT_SECRET')
    await engine.dispose()
  })

  it('executes an approved server resume inside the handler/hook boundary', async () => {
    const hook = vi.fn(async () => {})
    const config = testConfig({
      mode: 'agent',
      tools: [{ ...lookup, execute: () => 'approved application result', requiresApproval: true }],
      hooks: { onToolCall: hook },
    })
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async () => modelStream(model.doStreamCalls.length === 1),
    })
    const engine = createEngine(config, { adapters: { anthropic: async () => model } })
    const ctx = testContext()
    const events = (
      await readSse(
        await engine.handleChat({ sessionId: ctx.sessionId, messages: [userMessage('hi')] }, ctx),
      )
    )
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line))
    const approval = events.find((event) => event.type === 'data-approval-request')
    expect(hook).not.toHaveBeenCalled()
    expect(approval).toBeDefined()
    await readSse(
      await engine.handleChat(
        {
          sessionId: ctx.sessionId,
          messages: [],
          trigger: 'resume',
          resume: {
            runId: approval.data.runId,
            approvals: [{ approvalId: approval.data.approvalId, decision: 'approve' }],
          },
        },
        ctx,
      ),
    )
    expect(hook).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('approved application result')
    await engine.dispose()
  })

  it('ignores hook results and suppresses invalid handler output in both the model history and client stream', async () => {
    const config = testConfig({
      tools: [{ ...lookup, execute: () => ({ secret: 'INVALID_HANDLER_SECRET' }) }],
      hooks: { onToolCall: () => 'ignored' },
    })
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async () => modelStream(model.doStreamCalls.length === 1),
    })
    const engine = createEngine(config, { adapters: { anthropic: async () => model } })
    const ctx = testContext()
    const response = await engine.handleChat(
      { sessionId: ctx.sessionId, messages: [userMessage('hi')] },
      ctx,
    )
    const stream = await response.text()
    expect(stream).toContain('invalid_output')
    expect(stream).not.toContain('INVALID_HANDLER_SECRET')
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('invalid_output')
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain('INVALID_HANDLER_SECRET')
    await engine.dispose()
  })

  it.each(['throws', 'empty', 'wrong-type', 'timeout'] as const)(
    'fails closed with sanitized errors before model invocation: %s',
    async (failure) => {
      let signal: AbortSignal | undefined
      const system = async (ctx: { signal: AbortSignal }) => {
        signal = ctx.signal
        if (failure === 'throws') throw new Error('SECRET_APPLICATION_DATA')
        if (failure === 'empty') return '  '
        if (failure === 'wrong-type') return 42 as unknown as string
        return new Promise<string>(() => {})
      }
      const config = testConfig({
        prompt: { system, systemTimeoutMs: 20 },
        telemetry: { logLevel: 'debug' },
      })
      const adapter = vi.fn(async () => new MockLanguageModelV3())
      const engine = createEngine(config, { adapters: { anthropic: adapter } })
      const ctx = testContext()
      const response = await engine.handleChat(
        { sessionId: ctx.sessionId, messages: [userMessage('hi')] },
        ctx,
      )
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain('SECRET_APPLICATION_DATA')
      expect(adapter).not.toHaveBeenCalled()
      if (failure === 'timeout') expect(signal?.aborted).toBe(true)
      await engine.dispose()
    },
  )

  it('cancels resolution on request abort and ignores late text', async () => {
    const parent = new AbortController()
    let signal: AbortSignal | undefined
    let finish!: (text: string) => void
    const config = testConfig({
      prompt: {
        system: (ctx) => {
          signal = ctx.signal
          return new Promise<string>((resolve) => {
            finish = resolve
          })
        },
      },
    })
    const resolving = resolveSystem(config, testContext({ signal: parent.signal }))
    await vi.waitFor(() => expect(signal).toBeDefined())
    parent.abort()
    await expect(resolving).rejects.toMatchObject({ code: 'aborted' })
    expect(signal!.aborted).toBe(true)
    finish('LATE INSTRUCTIONS')
  })

  it('isolates concurrent requests and never mutates the shared config', async () => {
    const config = testConfig({
      prompt: {
        system: async (ctx) => {
          await Promise.resolve()
          return `Hello ${ctx.identity?.sub}`
        },
      },
    })
    const [a, b] = await Promise.all([
      resolveSystem(config, testContext({ identity: { sub: 'a' } })),
      resolveSystem(config, testContext({ identity: { sub: 'b' } })),
    ])
    expect([a, b]).toEqual(['Hello a', 'Hello b'])
    expect(typeof config.prompt.system).toBe('function')
  })

  it.each(['unknown', 'disabled', 'none'] as const)(
    'rejects a resumed %s tool before any handler or hook',
    async (reason) => {
      const store = new MemorySessionStore(),
        hook = vi.fn()
      const ctx = testContext()
      const config = testConfig({
        mode: 'agent',
        tools:
          reason === 'unknown'
            ? []
            : [{ ...lookup, enabled: reason !== 'disabled', requiresApproval: true }],
        agent: { toolChoice: reason === 'none' ? 'none' : 'auto' },
        hooks: { onToolCall: hook },
      })
      await savePendingRun(
        store,
        { id: ctx.sessionId, messages: [], createdAt: Date.now(), updatedAt: Date.now() },
        {
          runId: 'run',
          expiresAt: Date.now() + 60_000,
          responseMessage: {
            id: 'response',
            role: 'assistant',
            parts: [
              {
                type: 'tool-lookup',
                toolCallId: 'c1',
                state: 'approval-requested',
                input: {},
                approval: { id: 'approval' },
              },
            ],
          },
        },
      )
      const adapter = vi.fn(async () => new MockLanguageModelV3())
      const engine = createEngine(config, { sessionStore: store, adapters: { anthropic: adapter } })
      const response = await engine.handleChat(
        {
          sessionId: ctx.sessionId,
          messages: [],
          trigger: 'resume',
          resume: { runId: 'run', approvals: [{ approvalId: 'approval', decision: 'approve' }] },
        },
        ctx,
      )
      expect(response.status).toBe(403)
      expect(hook).not.toHaveBeenCalled()
      expect(adapter).not.toHaveBeenCalled()
      await engine.dispose()
    },
  )
})
