import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { readSse, testConfig, testContext, userMessage } from '../test/helpers.js'
import { createEngine } from './engine.js'
import type { ToolContext } from './types.js'

const SESSION = 's_01J9X8Y7Z6ABCDEFGHJKMNPQRS'
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}
function stream(textOrTool: string | { name?: string; query: unknown }, call: number) {
  const isText = typeof textOrTool === 'string'
  const chunks: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    ...(isText
      ? [
          { type: 'text-start' as const, id: 't' },
          { type: 'text-delta' as const, id: 't', delta: textOrTool },
          { type: 'text-end' as const, id: 't' },
        ]
      : [
          {
            type: 'tool-call' as const,
            toolCallId: `search-${call}`,
            toolName: textOrTool.name ?? 'search_knowledge_base',
            input: JSON.stringify({ query: textOrTool.query }),
          },
        ]),
    {
      type: 'finish',
      finishReason: { unified: isText ? 'stop' : 'tool-calls', raw: 'test' },
      usage,
    },
  ]
  return {
    stream: simulateReadableStream({ chunks, chunkDelayInMs: null, initialDelayInMs: null }),
  }
}

const definition = {
  name: 'search_knowledge_base',
  description: 'Read application records selected by a query.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
}
function fixture(locale = 'en') {
  const execute = vi.fn((_input: unknown, ctx: ToolContext) => {
    const text =
      locale === 'fr' ? 'Le forfait comprend 12 espaces.' : 'The plan includes 12 spaces.'
    return {
      ...ctx.sources.register({
        id: `plan-${locale}`,
        title: 'Plan',
        url: `https://example.test/${locale}/plan`,
        text,
        lang: locale,
      }),
      text,
    }
  })
  return { execute, tool: { ...definition, execute } }
}
async function eventsFor(engine: ReturnType<typeof createEngine>, locale = 'en') {
  const response = await engine.handleChat(
    { sessionId: SESSION, messages: [userMessage('plan')] },
    testContext({ locale }),
  )
  return (await readSse(response)).filter((x) => x !== '[DONE]').map((x) => JSON.parse(x))
}
describe('application tools through the bounded engine (offline)', () => {
  it.each(['en', 'fr'])(
    'keeps %s application evidence and citations across model steps',
    async (locale) => {
      const app = fixture(locale)
      const model: MockLanguageModelV3 = new MockLanguageModelV3({
        doStream: async (options) => {
          if (model.doStreamCalls.length === 1) return stream({ query: 'plan' }, 1)
          expect(JSON.stringify(options.prompt)).toContain('12')
          return stream('12 [1].', 2)
        },
      })
      const engine = createEngine(testConfig({ tools: [app.tool] }), {
        adapters: { anthropic: async () => model },
      })
      try {
        const events = await eventsFor(engine, locale)
        expect(app.execute).toHaveBeenCalledTimes(1)
        expect(events.find((e) => e.type === 'data-citations')?.data.items).toMatchObject([
          { id: 'c1', lang: locale, url: `https://example.test/${locale}/plan` },
        ])
      } finally {
        await engine.dispose()
      }
    },
  )
  it.each(['none', 'final', 'disabled', 'unknown'])(
    'never executes a forged %s call',
    async (reason) => {
      const app = fixture()
      const hook = vi.fn()
      const model = new MockLanguageModelV3({
        doStream: async () =>
          stream({ name: reason === 'unknown' ? 'forged' : definition.name, query: 'plan' }, 1),
      })
      const engine = createEngine(
        testConfig({
          tools: [{ ...app.tool, enabled: reason !== 'disabled' }],
          agent: {
            maxSteps: reason === 'final' ? 1 : 2,
            toolChoice: reason === 'none' ? 'none' : 'auto',
          },
          hooks: { onToolCall: hook },
        }),
        { adapters: { anthropic: async () => model } },
      )
      try {
        await eventsFor(engine)
        expect(app.execute).not.toHaveBeenCalled()
        expect(hook).not.toHaveBeenCalled()
      } finally {
        await engine.dispose()
      }
    },
  )
  it('honors required tools and reserves its final step for an answer', async () => {
    const app = fixture()
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async (options) => {
        const call = model.doStreamCalls.length
        expect(options.toolChoice).toEqual({ type: call < 4 ? 'required' : 'none' })
        expect(options.tools?.length ?? 0).toBe(call < 4 ? 1 : 0)
        return stream(call < 4 ? { query: 'plan' } : '12 [1].', call)
      },
    })
    const engine = createEngine(
      testConfig({ tools: [app.tool], agent: { maxSteps: 4, toolChoice: 'required' } }),
      { adapters: { anthropic: async () => model } },
    )
    try {
      await eventsFor(engine)
      expect(model.doStreamCalls).toHaveLength(4)
      expect(app.execute).toHaveBeenCalledTimes(3)
    } finally {
      await engine.dispose()
    }
  })
  it('stops at the token ceiling without an additional summary call', async () => {
    const app = fixture()
    const model = new MockLanguageModelV3({ doStream: async () => stream({ query: 'plan' }, 1) })
    const engine = createEngine(
      testConfig({ tools: [app.tool], agent: { stopWhen: { tokens: 1 } } }),
      { adapters: { anthropic: async () => model } },
    )
    try {
      const events = await eventsFor(engine)
      expect(model.doStreamCalls).toHaveLength(1)
      expect(events.some((e) => e.type === 'data-error' && e.data.code === 'budget_exceeded')).toBe(
        true,
      )
    } finally {
      await engine.dispose()
    }
  })
})
