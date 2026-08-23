import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSse, testConfig, testContext, userMessage } from '../../test/helpers.js'
import { createEngine } from '../engine.js'
import { resolvePolicy, tokenBudgetIs, wallClockIs } from './policy.js'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { StepResult, StopCondition, ToolSet } from 'ai'

/**
 * docs/04 §4 — `resolvePolicy` is the only place that branches on `mode`, and
 * docs/09 lists it plus the three stop conditions as Phase 5 deliverables.
 *
 * The stop conditions are tested *at* their boundary and on both sides of it:
 * an off-by-one in `tokenBudgetIs` either burns the whole budget or refuses to
 * run at all, and neither shows up in a "does it stop eventually" test.
 */

const SESSION = 's_01J9X8Y7Z6ABCDEFGHJKMNPQRS'

/** A step carrying only the usage the stop conditions read. */
function step(totalTokens: number | undefined): StepResult<ToolSet> {
  return { usage: { totalTokens } } as unknown as StepResult<ToolSet>
}

const stops = async (
  condition: StopCondition<ToolSet>,
  steps: StepResult<ToolSet>[],
): Promise<boolean> => Boolean(await condition({ steps }))

const readOnlyTool = (name: string) => ({
  name,
  parameters: { type: 'object' as const, properties: {} },
  executor: { type: 'builtin' as const, id: 'submit_feedback' as const },
  readOnly: true,
})

describe('resolvePolicy — chat mode (docs/04 §4)', () => {
  it('stops after a single step and never approves', () => {
    const policy = resolvePolicy(testConfig())
    expect(policy.approvals).toBe(false)
    expect(policy.summarizeAtStep).toBeUndefined()
    expect(policy.stopWhen).toHaveLength(1)
  })

  it('its single stop condition is stepCountIs(1)', async () => {
    const [condition] = resolvePolicy(testConfig()).stopWhen
    expect(await stops(condition!, [])).toBe(false)
    expect(await stops(condition!, [step(0)])).toBe(true)
  })

  it('admits only read-only tools', () => {
    const { toolFilter } = resolvePolicy(testConfig())
    expect(toolFilter({ readOnly: true })).toBe(true)
    expect(toolFilter({ readOnly: false })).toBe(false)
    // Unmarked is not read-only: docs/02 makes the safe reading the explicit one.
    expect(toolFilter({})).toBe(false)
  })

  it('sets toolChoice to none when there is no enabled tool', () => {
    expect(resolvePolicy(testConfig()).toolChoice).toBe('none')
    expect(
      resolvePolicy(testConfig({ tools: [{ ...readOnlyTool('lookup'), enabled: false }] }))
        .toolChoice,
    ).toBe('none')
  })

  it('sets toolChoice to auto once a tool is enabled', () => {
    expect(resolvePolicy(testConfig({ tools: [readOnlyTool('lookup')] })).toolChoice).toBe('auto')
  })

  it('ignores agent.toolChoice — chat mode never forces a tool call', () => {
    const policy = resolvePolicy(
      testConfig({ tools: [readOnlyTool('lookup')], agent: { toolChoice: 'required' } }),
    )
    expect(policy.toolChoice).toBe('auto')
  })

  it('does not count an MCP import as an enabled tool', () => {
    // `from` entries are imports, not tools: their contents are not known
    // until the server is reached, so they cannot flip toolChoice on their own.
    const policy = resolvePolicy(
      testConfig({
        tools: [
          {
            from: 'mcp',
            id: 'acme',
            server: { transport: 'http', url: 'https://mcp.acme.test' },
            readOnly: true,
          },
        ],
      }),
    )
    expect(policy.toolChoice).toBe('none')
  })

  it('defaults retrieval to always, and honours an explicit mode', () => {
    expect(resolvePolicy(testConfig()).retrieval).toBe('always')
    expect(
      resolvePolicy(testConfig({ knowledge: { retrieval: { mode: 'tool' } } })).retrieval,
    ).toBe('tool')
  })
})

describe('resolvePolicy — agent mode (docs/04 §4)', () => {
  const agentConfig = (overrides = {}) =>
    testConfig({ mode: 'agent', agent: { maxSteps: 5, ...overrides } })

  it('carries all three stop conditions', () => {
    expect(resolvePolicy(agentConfig()).stopWhen).toHaveLength(3)
  })

  it('admits every tool and enables approvals', () => {
    const policy = resolvePolicy(agentConfig())
    expect(policy.toolFilter({ readOnly: false })).toBe(true)
    expect(policy.toolFilter({})).toBe(true)
    expect(policy.approvals).toBe(true)
  })

  it('takes toolChoice from agent config', () => {
    expect(resolvePolicy(agentConfig({ toolChoice: 'required' })).toolChoice).toBe('required')
    expect(resolvePolicy(agentConfig({ toolChoice: 'none' })).toolChoice).toBe('none')
  })

  it('defaults retrieval to tool, and honours an explicit mode', () => {
    expect(resolvePolicy(agentConfig()).retrieval).toBe('tool')
    expect(
      resolvePolicy(
        testConfig({ mode: 'agent', knowledge: { retrieval: { mode: 'hybrid' } } }),
      ).retrieval,
    ).toBe('hybrid')
  })

  it('stops at the configured step count', async () => {
    const [byStep] = resolvePolicy(agentConfig({ stopWhen: { steps: 3 } })).stopWhen
    expect(await stops(byStep!, [step(0), step(0)])).toBe(false)
    expect(await stops(byStep!, [step(0), step(0), step(0)])).toBe(true)
  })

  it('defaults stopWhen.steps to maxSteps', async () => {
    const [byStep] = resolvePolicy(agentConfig({ maxSteps: 2 })).stopWhen
    expect(await stops(byStep!, [step(0)])).toBe(false)
    expect(await stops(byStep!, [step(0), step(0)])).toBe(true)
  })
})

describe('summarizeAtStep (docs/02 §7 onMaxSteps)', () => {
  it('is one step before the ceiling when onMaxSteps is summarize', () => {
    const policy = resolvePolicy(
      testConfig({ mode: 'agent', agent: { maxSteps: 8, onMaxSteps: 'summarize' } }),
    )
    // Step numbers are 0-based, so the last step is 7 — summarizing at 7 is
    // the final call, not an extra one.
    expect(policy.summarizeAtStep).toBe(7)
  })

  it('follows stopWhen.steps rather than maxSteps when they differ', () => {
    const policy = resolvePolicy(
      testConfig({ mode: 'agent', agent: { maxSteps: 8, stopWhen: { steps: 3 } } }),
    )
    expect(policy.summarizeAtStep).toBe(2)
  })

  it('never goes negative for a one-step agent', () => {
    const policy = resolvePolicy(testConfig({ mode: 'agent', agent: { maxSteps: 1 } }))
    expect(policy.summarizeAtStep).toBe(0)
  })

  it.each(['error', 'silent'] as const)('is absent when onMaxSteps is %s', (onMaxSteps) => {
    expect(
      resolvePolicy(testConfig({ mode: 'agent', agent: { onMaxSteps } })).summarizeAtStep,
    ).toBeUndefined()
  })
})

describe('tokenBudgetIs', () => {
  it('is false below the budget and true at it', async () => {
    const condition = tokenBudgetIs(100)
    expect(await stops(condition, [step(60), step(39)])).toBe(false)
    expect(await stops(condition, [step(60), step(40)])).toBe(true)
    expect(await stops(condition, [step(60), step(41)])).toBe(true)
  })

  it('is false for an empty loop', async () => {
    expect(await stops(tokenBudgetIs(1), [])).toBe(false)
  })

  it('treats a step with no usage as zero rather than stopping the loop', async () => {
    // Some providers omit usage on a tool-call step. Counting `undefined` as a
    // budget breach would end the run after one tool call.
    expect(await stops(tokenBudgetIs(10), [step(undefined), step(undefined)])).toBe(false)
    expect(await stops(tokenBudgetIs(10), [step(undefined), step(10)])).toBe(true)
  })

  it('is wired to agent.stopWhen.tokens', async () => {
    const [, byTokens] = resolvePolicy(
      testConfig({ mode: 'agent', agent: { stopWhen: { tokens: 500 } } }),
    ).stopWhen
    expect(await stops(byTokens!, [step(499)])).toBe(false)
    expect(await stops(byTokens!, [step(500)])).toBe(true)
  })
})

describe('wallClockIs', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is false before the deadline and true at it', async () => {
    vi.useFakeTimers()
    const condition = wallClockIs(10)
    vi.advanceTimersByTime(9_999)
    expect(await stops(condition, [])).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await stops(condition, [])).toBe(true)
  })

  it('captures its deadline when built, not when first checked', async () => {
    // A policy reused across requests would hand the second request an
    // already-expired deadline — hence "resolve a policy per request".
    vi.useFakeTimers()
    const condition = wallClockIs(5)
    vi.advanceTimersByTime(6_000)
    expect(await stops(condition, [])).toBe(true)
  })

  it('is wired to agent.stopWhen.seconds', async () => {
    vi.useFakeTimers()
    const [, , byClock] = resolvePolicy(
      testConfig({ mode: 'agent', agent: { stopWhen: { seconds: 30 } } }),
    ).stopWhen
    vi.advanceTimersByTime(29_000)
    expect(await stops(byClock!, [])).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(await stops(byClock!, [])).toBe(true)
  })
})

/**
 * The consumption side: engine.ts turns `summarizeAtStep` into a `prepareStep`
 * that strips the tools off the final call. Without it `onMaxSteps: summarize`
 * is a config key that resolves and then does nothing.
 */
describe('summarizeAtStep consumption in the engine', () => {
  /** A model that calls `toolName` on every step it is asked for. */
  function loopingToolModel(toolName: string): MockLanguageModelV3 {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async () => {
        call += 1
        const chunks: LanguageModelV3StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          ...(call === 1
            ? ([
                {
                  type: 'tool-call',
                  toolCallId: `tc${call}`,
                  toolName,
                  input: JSON.stringify({ path: '/pricing' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                  usage: {
                    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 2, text: 0, reasoning: 0 },
                  },
                },
              ] as LanguageModelV3StreamPart[])
            : ([
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'Here is what I found.' },
                { type: 'text-end', id: 't1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 2, text: 2, reasoning: 0 },
                  },
                },
              ] as LanguageModelV3StreamPart[])),
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
  }

  const agentWithNavigate = (onMaxSteps: 'summarize' | 'silent') =>
    testConfig({
      mode: 'agent',
      agent: { maxSteps: 2, onMaxSteps },
      siteContext: { routes: [{ path: '/pricing' }] },
      tools: [
        {
          name: 'navigate',
          parameters: { type: 'object', properties: {}, additionalProperties: true },
          executor: { type: 'builtin', id: 'navigate' },
        },
      ],
    })

  const run = async (model: MockLanguageModelV3, onMaxSteps: 'summarize' | 'silent') => {
    const engine = createEngine(agentWithNavigate(onMaxSteps), {
      adapters: { anthropic: async () => model },
    })
    await readSse(
      await engine.handleChat(
        { sessionId: SESSION, messages: [userMessage('Where are the prices?')] },
        testContext(),
      ),
    )
  }

  it('disables tools on the final step and tells the model to wrap up', async () => {
    const model = loopingToolModel('navigate')
    await run(model, 'summarize')

    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2)
    const first = model.doStreamCalls[0]
    const last = model.doStreamCalls[1]

    expect(first?.tools ?? []).not.toHaveLength(0)
    // maxSteps: 2 → summarizeAtStep 1 → the second call gets no tools at all.
    expect(last?.tools ?? []).toHaveLength(0)
    expect(last?.toolChoice).toEqual({ type: 'none' })

    const system = last?.prompt.find((message) => message.role === 'system')
    expect(JSON.stringify(system)).toContain('You have reached the final step.')
  })

  it('leaves the final step untouched when onMaxSteps is not summarize', async () => {
    const model = loopingToolModel('navigate')
    await run(model, 'silent')

    const last = model.doStreamCalls[1]
    expect(last?.tools ?? []).not.toHaveLength(0)
    const system = last?.prompt.find((message) => message.role === 'system')
    expect(JSON.stringify(system)).not.toContain('You have reached the final step.')
  })
})
