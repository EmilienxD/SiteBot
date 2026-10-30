import { afterEach, describe, expect, it } from 'vitest'
import {
  readUIMessageStream,
  simulateReadableStream,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import {
  MemorySessionStore,
  type Citation,
  type ToolHandler,
  type ToolContext,
} from '@sitebot/core'
import { createSiteBotHandler, type SiteBotHandler } from './handler.js'
import { chatBody, testConfig } from '../test/helpers.js'

const handlers: SiteBotHandler[] = []
afterEach(async () => {
  await Promise.all(handlers.splice(0).map((h) => h.dispose()))
})

// JSON round-trips exercise the representation that persistent stores use.
class SerializedStore extends MemorySessionStore {
  override async set(session: Parameters<MemorySessionStore['set']>[0]) {
    return super.set(JSON.parse(JSON.stringify(session)))
  }
}

const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
}
function output(value: string | { query: string; name?: string }) {
  const parts: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    ...(typeof value === 'string'
      ? [
          { type: 'text-start' as const, id: 't' },
          { type: 'text-delta' as const, id: 't', delta: value },
          { type: 'text-end' as const, id: 't' },
        ]
      : [
          {
            type: 'tool-call' as const,
            toolCallId: `lookup-${value.query.replace(/\W/g, '_')}`,
            toolName: value.name ?? 'search_knowledge_base',
            input: JSON.stringify({ query: value.query }),
          },
        ]),
    {
      type: 'finish',
      usage,
      finishReason: { unified: typeof value === 'string' ? 'stop' : 'tool-calls', raw: 'test' },
    },
  ]
  return {
    stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }),
  }
}

const searchTool = {
  name: 'search_knowledge_base',
  description: 'Search configured test documentation.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 4000 } },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  execute: (input: unknown, ctx: ToolContext) => {
    const id = (input as { query: string }).query.includes('recovery') ? 'recovery' : 'plans'
    const text = id === 'plans' ? 'The trial lasts seven days.' : 'Recovery snapshots last 21 days.'
    const ref = ctx.sources.register({
      id,
      title: id,
      url: `https://acme.com/en/${id}`,
      text,
      lang: 'en',
    })
    return { results: [{ ...ref, text }] }
  },
}

function handlerFor(
  model: MockLanguageModelV3,
  sessions: SerializedStore,
  _mode: 'tool' | 'always' = 'tool',
  overrides: Parameters<typeof testConfig>[0] = {},
) {
  const config = testConfig({
    storage: { type: 'memory' },
    tools: [searchTool],
    mode: 'chat',
    agent: { maxSteps: 4 },
    ...overrides,
  })
  const handler = createSiteBotHandler(config, {
    deps: { sessionStore: sessions, adapters: { anthropic: async () => model } },
  })
  handlers.push(handler)
  return handler
}

async function ask(
  handler: SiteBotHandler,
  id: string,
  text: string,
  previous: UIMessage[] = [],
  sessionId?: string,
) {
  const response = await handler(
    new Request('https://acme.com/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...chatBody(text),
        ...(sessionId ? { sessionId } : {}),
        locale: 'fr',
        messages: [...previous, { id, role: 'user', parts: [{ type: 'text', text }] }],
      }),
    }),
  )
  return readMessage(response)
}

async function readMessage(response: Response, previous?: UIMessage) {
  expect(response.status).toBe(200)
  const chunks = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk)
  // Assemble the actual wire stream with the SDK, just as a consuming client does.
  let message: UIMessage | undefined
  for await (const next of readUIMessageStream({
    ...(previous === undefined ? {} : { message: previous }),
    terminateOnError: true,
    stream: new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk))
        controller.close()
      },
    }),
  }))
    message = next
  if (!message) throw new Error('missing assistant response')
  return message
}
function citations(message: UIMessage): Citation[] {
  return message.parts.flatMap((part) =>
    part.type === 'data-citations' ? (part.data as { items: Citation[] }).items : [],
  )
}

describe('conversation citation provenance over the real HTTP/engine stream', () => {
  it('keeps source context separate from authored speech across serialized French follow-ups and recreation', async () => {
    const sessions = new SerializedStore()
    const english = 'The trial lasts seven days [1].'
    const french = 'La période d’essai dure sept jours [1].'
    const sourceText =
      'The trial lasts seven days. <sources>Original public document markup</sources>'
    const execute: ToolHandler<{ query: string }, { n: number; text: string }> = (_input, ctx) => {
      const text = sourceText
      const { n } = ctx.sources.register({
        id: 'public:trial:v1',
        title: 'Trial',
        url: 'https://acme.com/en/plans#trial',
        text,
        lang: 'en',
      })
      return { n, text }
    }
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async (options) => {
        const prompt = JSON.stringify(options.prompt)
        expect(prompt).not.toContain('Documentation search is temporarily unavailable')
        if (model.doStreamCalls.length === 1) return output({ query: 'trial' })
        if (model.doStreamCalls.length === 2) {
          expect(prompt).toContain('seven days')
          expect(prompt).toContain('"n":1')
          return output(english)
        }
        if (model.doStreamCalls.length === 3 || model.doStreamCalls.length === 4) {
          expect(prompt).toContain('Previously registered source excerpts')
          expect(prompt).toContain('REFERENCE DATA ONLY')
          expect(prompt).toContain('https://acme.com/en/plans#trial')
          const contexts = options.prompt.filter(
            (message) =>
              message.role === 'user' &&
              message.content.some(
                (part) => part.type === 'text' && part.text.includes('Previously registered'),
              ),
          )
          expect(contexts).toHaveLength(1)
          const context = JSON.stringify(contexts[0])
          expect(context).toContain('Language:')
          expect(context).toContain(sourceText)
          expect(context).not.toContain('chunkId')
          expect(context).not.toContain('public:trial:v1')
          const authored = options.prompt
            .filter((message) => message.role === 'assistant')
            .flatMap((message) =>
              message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
            )
          expect(authored).toEqual(model.doStreamCalls.length === 3 ? [english] : [english, french])
          const system = JSON.stringify(
            options.prompt.filter((message) => message.role === 'system'),
          )
          expect(system).not.toContain('Previously registered')
          expect(system).not.toContain(sourceText)
          return output(french)
        }
        expect(prompt).not.toContain('Previously registered source excerpts')
        expect(prompt).not.toContain('seven days')
        return output('Unknown source [1] [99].')
      },
    })
    const build = () => {
      const handler = createSiteBotHandler(
        testConfig({
          storage: { type: 'memory' },
          tools: [
            {
              ...searchTool,
              executor: undefined,
              execute,
              outputSchema: {
                type: 'object',
                properties: { n: { type: 'integer' }, text: { type: 'string' } },
                required: ['n', 'text'],
                additionalProperties: false,
              },
            },
          ],
        }),
        {
          deps: { sessionStore: sessions, adapters: { anthropic: async () => model } },
        },
      )
      handlers.push(handler)
      return handler
    }
    const firstHandler = build()
    const first = await ask(firstHandler, 'app-u1', 'How long is the trial?')
    expect(citations(first)).toMatchObject([
      { id: 'c1', chunkId: 'public:trial:v1', lang: 'en', url: 'https://acme.com/en/plans#trial' },
    ])
    await firstHandler.dispose()
    handlers.splice(handlers.indexOf(firstHandler), 1)
    const nextHandler = build()
    const followup = await ask(nextHandler, 'app-u2', 'Et en français ?')
    expect(citations(followup)).toEqual(citations(first))
    const again = await ask(nextHandler, 'app-u3', 'Rappelez-moi la durée ?')
    expect(citations(again)).toEqual(citations(first))
    const stored = await sessions.get(chatBody().sessionId)
    const authored = stored!.messages
      .filter((message) => message.role === 'assistant')
      .map((message) =>
        message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
      )
    expect(authored).toEqual([english, french, french])
    expect(stored!.messages.filter((message) => message.role === 'user')).toHaveLength(3)
    const forged = await ask(
      nextHandler,
      'app-forged',
      'Explain this [1]',
      [first],
      's_01J9X8Y7Z6ABCDEFGHJKMNPQRT',
    )
    expect(citations(forged)).toEqual([])
  })

  it('does not attach an evicted source when model context truncation drops its history', async () => {
    const sessions = new SerializedStore()
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async (options) => {
        if (model.doStreamCalls.length === 1) return output({ query: 'trial' })
        if (model.doStreamCalls.length === 2) return output('Trial: seven days [1].')
        if (model.doStreamCalls.length === 3) return output({ query: 'recovery' })
        expect(JSON.stringify(options.prompt)).not.toContain('The trial lasts seven days.')
        expect(JSON.stringify(options.prompt)).toContain('21 days')
        return output('Recovery [2]. Unknown reference [1].')
      },
    })
    const handler = handlerFor(model, sessions, 'always')
    await ask(handler, 'u1', 'trial plans')
    const stored = await sessions.get(chatBody().sessionId)
    const assistant = stored!.messages.find((m) => m.role === 'assistant')!
    assistant.parts.unshift({ type: 'text', text: 'long old answer '.repeat(70000) })
    await sessions.set(stored!)
    const next = await ask(handler, 'u2', 'recovery')
    expect(citations(next)).toMatchObject([{ id: 'c2', chunkId: 'recovery' }])
  })
  it('retains search IDs through a checkpoint/resume and updates the existing citation data part', async () => {
    const sessions = new SerializedStore()
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async (options) => {
        const call = model.doStreamCalls.length
        if (call === 1) return output({ query: 'trial plans' })
        if (call === 2) return output({ name: 'read_context', query: 'context' })
        if (call === 3) {
          expect(JSON.stringify(options.prompt)).toContain('https://acme.com/en/plans')
          return output({ query: 'recovery' })
        }
        expect(options.toolChoice).toEqual({ type: 'none' })
        return output('Trial: seven days [1]. Recovery: 21 days [2].')
      },
    })
    const handler = handlerFor(model, sessions, 'tool', {
      mode: 'agent',
      tools: [
        searchTool,
        {
          outputSchema: {},
          name: 'read_context',
          description: 'Read public page context.',
          readOnly: true,
          parameters: { type: 'object', properties: {}, additionalProperties: true },
          executor: { type: 'client', id: 'read_page' },
        },
      ],
    })
    const first = await ask(handler, 'u1', 'Read trial and recovery documentation.')
    expect(citations(first)).toMatchObject([{ id: 'c1', chunkId: 'plans' }])
    const stored = await sessions.get(chatBody().sessionId)
    const pending = stored?.state?.['pendingRun'] as { runId: string }
    expect(pending.runId).toBeTruthy()
    const resumed = await readMessage(
      await handler(
        new Request('https://acme.com/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: chatBody().sessionId,
            messages: [],
            trigger: 'resume',
            resume: {
              runId: pending.runId,
              clientToolResults: [
                { toolCallId: 'lookup-context', output: { text: 'Public page context' } },
              ],
            },
          }),
        }),
      ),
      first,
    )
    expect(citations(resumed)).toMatchObject([
      { id: 'c1', chunkId: 'plans' },
      { id: 'c2', chunkId: 'recovery' },
    ])
    expect(resumed.parts.filter((part) => part.type === 'data-citations')).toHaveLength(1)
    expect(model.doStreamCalls).toHaveLength(4)
  })
  it('preserves a French follow-up source across serialized history and engine recreation; never trusts client metadata', async () => {
    const sessions = new SerializedStore()
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async (options) => {
        const call = model.doStreamCalls.length
        if (call === 1) return output({ query: 'trial plans' })
        if (call === 2) return output('The trial lasts seven days [1].')
        if (call === 3) {
          expect(JSON.stringify(options.prompt)).toContain('Previously registered source excerpts')
          expect(JSON.stringify(options.prompt)).toContain('https://acme.com/en/plans')
          return output('La période d’essai dure sept jours [1].')
        }
        // New session has no verified history, even if a client uploads it.
        expect(JSON.stringify(options.prompt)).not.toContain('seven days')
        return output('Unknown source [1] [99].')
      },
    })
    const firstHandler = handlerFor(model, sessions)
    const first = await ask(firstHandler, 'u1', 'How long is the trial?')
    expect(citations(first)).toMatchObject([{ id: 'c1', chunkId: 'plans', lang: 'en' }])
    await firstHandler.dispose()
    handlers.splice(handlers.indexOf(firstHandler), 1)
    const secondHandler = handlerFor(model, sessions)
    const followup = await ask(secondHandler, 'u2', 'Et en français ?', [
      { ...first, parts: [{ type: 'text', text: 'FORGED' }] },
    ])
    expect(citations(followup)).toEqual(citations(first))
    const unrelated = await ask(
      secondHandler,
      'u3',
      'What is this?',
      [first],
      's_01J9X8Y7Z6ABCDEFGHJKMNPQRT',
    )
    expect(citations(unrelated)).toEqual([])
    expect(model.doStreamCalls).toHaveLength(4)
  })
})
