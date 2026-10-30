import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { testConfig, testContext } from '../test/helpers.js'
import { createToolRegistry } from './tools/registry.js'
import { MemorySessionStore } from './session/store.js'
import { createEngine } from './engine.js'
import { McpClientPool } from './tools/mcp.js'
import * as modules from './modules.js'
import { SourceEvidence } from './sources/evidence.js'
import type { SourceRegistrar, ToolHandler } from './index.js'

const definition = {
  name: 'calculate',
  description: 'Calculate the application result.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: { count: { type: 'integer', minimum: 1, maximum: 3 } },
    required: ['count'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { total: { type: 'integer', minimum: 1, maximum: 9 } },
    required: ['total'],
    additionalProperties: false,
  },
  execute: () => ({ total: 2 }),
}
const callOptions = { toolCallId: 'call', messages: [] }

async function registry(
  overrides: Omit<Partial<typeof definition>, 'execute'> & {
    execute?: ToolHandler
    timeoutMs?: number
  } = {},
  options: Partial<Parameters<typeof createToolRegistry>[0]> = {},
) {
  const tools = await createToolRegistry({
    config: testConfig({ tools: [{ ...definition, ...overrides }] }),
    ctx: testContext(),
    filter: () => true,
    approvals: true,
    ...options,
  }).build()
  return tools.calculate!
}

describe('application tool execution boundary', () => {
  it.each(['http', 'module', 'mcp'] as const)(
    'validates output from explicit %s transports',
    async (kind) => {
      const invalid = { total: 99, secret: 'INVALID_TRANSPORT_SECRET' }
      const moduleSpy = vi.spyOn(modules, 'loadModuleExport').mockResolvedValue(async () => invalid)
      const mcpPool = new McpClientPool({
        connect: async () => ({
          list: async () => [],
          call: async () => invalid,
          ping: async () => {},
          close: async () => {},
        }),
      })
      try {
        const executor =
          kind === 'http'
            ? { type: 'http' as const, url: 'https://example.test/data' }
            : kind === 'module'
              ? { type: 'module' as const, path: './application-tool.mjs' }
              : {
                  type: 'mcp' as const,
                  tool: 'calculate',
                  server: { transport: 'http' as const, url: 'https://example.test/mcp' },
                }
        const config = testConfig({ tools: [{ ...definition, execute: undefined, executor }] })
        const tools = await createToolRegistry({
          config,
          ctx: testContext(),
          filter: () => true,
          approvals: true,
          mcpPool,
          fetchImpl: async () => Response.json(invalid),
          resolveHost: async () => ['203.0.113.10'],
        }).build()
        expect(await tools.calculate!.execute!({ count: 1 }, callOptions)).toEqual({
          error: 'invalid_output',
        })
      } finally {
        moduleSpy.mockRestore()
        await mcpPool.dispose()
      }
    },
  )

  it.each([{ count: 0 }, { count: 4 }, { count: 1, injected: true }, {}])(
    'rejects invalid arguments before handlers or hooks: %j',
    async (input) => {
      const execute = vi.fn(definition.execute),
        hook = vi.fn()
      const built = await registry({ execute }, { onToolCall: hook })
      expect(await built.execute!(input, callOptions)).toEqual({ error: 'invalid_input' })
      expect(execute).not.toHaveBeenCalled()
      expect(hook).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'checks handler and hook outputs before returning them (hook=%s)',
    async (override) => {
      const invalid = { total: 99, secret: 'MUST_NOT_LEAK' }
      const built = await registry(
        { execute: () => invalid },
        override
          ? {
              onToolCall: async () => {
                void invalid
              },
            }
          : {},
      )
      const result = await built.execute!({ count: 2 }, callOptions)
      expect(result).toEqual({ error: 'invalid_output' })
      expect(JSON.stringify(result)).not.toContain('MUST_NOT_LEAK')
    },
  )

  it('normalizes genuine Zod input and retains native refinements and transformed input/output', async () => {
    const execute = vi.fn((input: unknown) => ({ total: (input as { count: number }).count }))
    const config = testConfig({
      tools: [
        {
          ...definition,
          execute,
          parameters: z.object({
            count: z
              .string()
              .min(1)
              .refine((value) => value !== 'bad')
              .transform(Number),
          }),
          outputSchema: z
            .object({ total: z.number() })
            .transform(({ total }) => ({ total: total * 2 })),
        },
      ],
    })
    const tools = await createToolRegistry({
      config,
      ctx: testContext(),
      filter: () => true,
      approvals: true,
    }).build()
    expect(await tools.calculate!.execute!({ count: '2' }, callOptions)).toEqual({ total: 4 })
    expect(execute).toHaveBeenCalledWith({ count: 2 }, expect.anything())
    expect(await tools.calculate!.execute!({ count: 'bad' }, callOptions)).toEqual({
      error: 'invalid_input',
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not run hooks for unapproved calls, even when execute is called directly', async () => {
    const hook = vi.fn(),
      execute = vi.fn(definition.execute)
    const config = testConfig({
      mode: 'agent',
      tools: [{ ...definition, execute, requiresApproval: true }],
    })
    const tools = await createToolRegistry({
      config,
      ctx: testContext(),
      filter: () => true,
      approvals: true,
      onToolCall: hook,
    }).build()
    expect(await tools.calculate!.execute!({ count: 1 }, callOptions)).toEqual({
      error: 'approval_required',
    })
    expect(hook).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'unauthenticated', 'filtered'] as const)(
    'omits %s registrations and cannot substitute caller-supplied identity',
    async (state) => {
      const config = testConfig({
        tools: [
          {
            ...definition,
            enabled: state !== 'disabled',
            scope: state === 'unauthenticated' ? 'authenticated' : 'public',
          },
        ],
      })
      const hook = vi.fn()
      const tools = await createToolRegistry({
        config,
        ctx: testContext(),
        filter: () => state !== 'filtered',
        approvals: true,
        onToolCall: hook,
      }).build()
      expect(Object.keys(tools)).toEqual([])
      expect(hook).not.toHaveBeenCalled()
    },
  )

  it('registers nothing for tools: []', async () => {
    const config = testConfig({ tools: [] })
    const tools = await createToolRegistry({
      config,
      ctx: testContext(),
      filter: () => true,
      approvals: true,
    }).build()
    expect(Object.keys(tools)).toEqual([])
    expect(tools.toString).toBeUndefined()
  })

  it.each(['handler', 'hook'] as const)(
    'aborts a timed-out %s and suppresses late completion',
    async (kind) => {
      let signal: AbortSignal | undefined
      let finish!: (value: unknown) => void
      const pending = new Promise<unknown>((resolve) => {
        finish = resolve
      })
      const execute = vi.fn(async (_input: unknown, ctx: { signal: AbortSignal }) => {
        signal = ctx.signal
        return pending
      })
      const hook = vi.fn(async (_call: unknown, ctx: { signal: AbortSignal }) => {
        signal = ctx.signal
        await pending
      })
      const config = testConfig({
        tools: [
          {
            ...definition,
            timeoutMs: 20,
            execute: kind === 'handler' ? execute : definition.execute,
          },
        ],
      })
      const tools = await createToolRegistry({
        config,
        ctx: testContext(),
        filter: () => true,
        approvals: true,
        ...(kind === 'hook' ? { onToolCall: hook } : {}),
      }).build()
      const result = await tools.calculate!.execute!({ count: 1 }, callOptions)
      expect(result).toMatchObject({ error: 'tool_failed' })
      expect(signal?.aborted).toBe(true)
      finish(undefined)
      await Promise.resolve()
      if (kind === 'hook') expect(execute).not.toHaveBeenCalled()
    },
  )

  it('aborts a running handler on request cancellation', async () => {
    const parent = new AbortController()
    let signal: AbortSignal | undefined
    const execute = vi.fn(async (_input: unknown, ctx: { signal: AbortSignal }) => {
      signal = ctx.signal
      return new Promise(() => {})
    })
    const config = testConfig({ tools: [{ ...definition, execute }] })
    const tools = await createToolRegistry({
      config,
      ctx: testContext({ signal: parent.signal }),
      filter: () => true,
      approvals: true,
    }).build()
    const result = tools.calculate!.execute!({ count: 1 }, callOptions)
    await vi.waitFor(() => expect(execute).toHaveBeenCalled())
    parent.abort()
    expect(await result).toMatchObject({ error: 'aborted' })
    expect(signal?.aborted).toBe(true)
  })

  it('consumes session caps across registry/request rebuilds and concurrent attempts', async () => {
    const store = new MemorySessionStore()
    const config = testConfig({ tools: [{ ...definition, maxCallsPerSession: 1 }] })
    const build = () =>
      createToolRegistry({
        config,
        ctx: testContext(),
        filter: () => true,
        approvals: true,
        claimToolCall: (name, limit) => store.claimToolCall('session', name, limit),
      }).build()
    const [first, second] = await Promise.all([build(), build()])
    const results = await Promise.all([
      first.calculate!.execute!({ count: 1 }, callOptions),
      second.calculate!.execute!({ count: 1 }, callOptions),
    ])
    expect(results).toContainEqual({ total: 2 })
    expect(results).toContainEqual({ error: 'call_limit_reached' })
    await store.delete('session')
    expect(await store.claimToolCall('session', 'calculate', 1)).toBe(true)
  })

  it('rejects capped tools when storage cannot enforce atomic session counters', () => {
    const store = {
      get: async () => null,
      set: async () => {},
      append: vi.fn(),
      delete: async () => {},
    }
    expect(() =>
      createEngine(testConfig({ tools: [{ ...definition, maxCallsPerSession: 1 }] }), {
        sessionStore: store,
      }),
    ).toThrow()
  })
})

const appSource = (id = 'plans') => ({
  id,
  title: id,
  url: `https://example.com/${id}`,
  text: 'Trial: seven days.',
  lang: 'en',
})

describe('application source registration at the tool boundary', () => {
  it.each(['unapproved', 'final-step', 'call-limit'] as const)(
    'cannot register sources for a %s call',
    async (blocked) => {
      const evidence = new SourceEvidence()
      const execute = vi.fn((_input: unknown, ctx: { sources: SourceRegistrar }) => {
        ctx.sources.register(appSource())
        return { total: 1 }
      })
      const tools = await createToolRegistry({
        config: testConfig({
          mode: 'agent',
          tools: [
            {
              ...definition,
              execute,
              requiresApproval: blocked === 'unapproved',
              ...(blocked === 'call-limit' ? { maxCallsPerSession: 1 } : {}),
            },
          ],
        }),
        ctx: testContext(),
        approvals: true,
        filter: () => true,
        canExecute: () => blocked !== 'final-step',
        claimToolCall: async () => false,
        sourceEvidence: evidence,
      }).build()
      expect(await tools.calculate!.execute!({ count: 1 }, callOptions)).toHaveProperty('error')
      expect(execute).not.toHaveBeenCalled()
      expect(evidence.citations).toEqual([])
    },
  )

  it('returns an app-owned result and publishes only after output validation', async () => {
    const evidence = new SourceEvidence()
    let saved: SourceRegistrar | undefined
    const built = await registry(
      {
        execute: (_input, ctx) => {
          saved = ctx.sources
          const ref = ctx.sources.register(appSource())
          expect(ref).toEqual({ n: 1, id: 'c1' })
          expect(evidence.citations).toEqual([])
          return { total: ref.n }
        },
      },
      { sourceEvidence: evidence },
    )
    expect(await built.execute!({ count: 1 }, callOptions)).toEqual({ total: 1 })
    expect(evidence.citations).toMatchObject([{ id: 'c1', chunkId: 'plans', url: appSource().url }])
    expect(() => saved!.register(appSource('late'))).toThrow('closed')
  })

  it.each(['invalid-output', 'throw', 'non-json', 'schema-extra'] as const)(
    'discards sources on %s from the registered handler',
    async (failure) => {
      const evidence = new SourceEvidence()
      const built = await registry(
        {
          execute: async (_input, ctx) => {
            ctx.sources.register(appSource())
            if (failure === 'throw') throw new Error('failed')
            if (failure === 'non-json') return { total: BigInt(1) }
            if (failure === 'schema-extra') return { total: 1, extra: {} }
            return { total: 99 }
          },
        },
        { sourceEvidence: evidence },
      )
      expect(await built.execute!({ count: 1 }, callOptions)).toHaveProperty('error')
      expect(evidence.citations).toEqual([])
      const valid = await registry(
        {
          execute: (_input, ctx) => ({
            total: ctx.sources.register(appSource()).n,
          }),
        },
        { sourceEvidence: evidence },
      )
      expect(await valid.execute!({ count: 1 }, callOptions)).toEqual({ total: 2 })
      expect(evidence.citations).toMatchObject([{ id: 'c2' }])
    },
  )

  it.each(['timeout', 'cancel'] as const)(
    'discards %s and rejects late registration',
    async (kind) => {
      const evidence = new SourceEvidence()
      const parent = new AbortController()
      let started!: () => void
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      let saved: SourceRegistrar | undefined
      const built = await registry(
        {
          timeoutMs: kind === 'timeout' ? 20 : 1000,
          execute: async (_input, ctx) => {
            saved = ctx.sources
            ctx.sources.register(appSource())
            started()
            await pending
            return { total: 1 }
          },
        },
        { sourceEvidence: evidence, ctx: testContext({ signal: parent.signal }) },
      )
      const result = built.execute!({ count: 1 }, callOptions)
      await entered
      if (kind === 'cancel') parent.abort()
      expect(await result).toHaveProperty('error')
      expect(() => saved!.register(appSource('late'))).toThrow()
      finish()
      await Promise.resolve()
      expect(evidence.citations).toEqual([])
    },
  )

  it('keeps parallel calls isolated and shares only stable source numbers', async () => {
    const evidence = new SourceEvidence()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let staged!: () => void
    const entered = new Promise<void>((resolve) => {
      staged = resolve
    })
    const built = await registry(
      {
        execute: async (input, ctx) => {
          const shared = ctx.sources.register(appSource('shared'))
          ctx.sources.register(appSource(input.count === 1 ? 'failed-only' : 'success-only'))
          if (input.count === 1) {
            staged()
            await pending
            return { total: 99 }
          }
          return { total: shared.n }
        },
      },
      { sourceEvidence: evidence },
    )
    const failed = built.execute!({ count: 1 }, callOptions)
    await entered
    expect(await built.execute!({ count: 2 }, { ...callOptions, toolCallId: 'parallel' })).toEqual({
      total: 1,
    })
    release()
    expect(await failed).toEqual({ error: 'invalid_output' })
    expect(evidence.citations.map((c) => c.chunkId)).toEqual(['shared', 'success-only'])
  })

  it('does not promote raw output URLs or citation-shaped data into sources', async () => {
    const evidence = new SourceEvidence()
    const forged = { ...appSource('forged'), id: 'c99', chunkId: 'forged' }
    const config = testConfig({
      tools: [
        {
          ...definition,
          outputSchema: {},
          execute: () => ({
            url: appSource().url,
            'data-citations': { items: [forged] },
          }),
        },
      ],
    })
    const tools = await createToolRegistry({
      config,
      ctx: testContext(),
      filter: () => true,
      approvals: true,
      sourceEvidence: evidence,
    }).build()
    expect(await tools.calculate!.execute!({ count: 1 }, callOptions)).toHaveProperty('url')
    expect(evidence.citations).toEqual([])
  })
})
