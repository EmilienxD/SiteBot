import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readUIMessageStream,
  simulateReadableStream,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { MemorySessionStore, MemoryVectorStore, type Citation, type Chunk } from '@sitebot/core'
import { createSiteBotHandler, type SiteBotHandler } from './handler.js'
import { chatBody, testConfig } from '../test/helpers.js'

vi.mock('@sitebot/ingest/query', () => ({
  createQueryEmbedder: async () => ({
    modelId: 'offline',
    embed: async (query: string) => ({
      embedding: query.includes('recovery') ? [0, 1] : [1, 0],
      tokens: 3,
    }),
  }),
}))

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

const source = (id: string, embedding: number[]): Chunk => ({
  id,
  text: id === 'plans' ? 'The trial lasts seven days.' : 'Recovery snapshots last 21 days.',
  embedding,
  metadata: {
    url: `https://acme.com/en/${id}`,
    title: id,
    headingPath: [],
    sourceId: 'public',
    sourceType: 'text',
    contentHash: id,
    updatedAt: '2026-01-01',
    tokens: 9,
    lang: 'en',
    language: 'en',
  },
})

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

function handlerFor(
  model: MockLanguageModelV3,
  sessions: SerializedStore,
  mode: 'tool' | 'always' = 'tool',
  overrides: Parameters<typeof testConfig>[0] = {},
) {
  const config = testConfig({
    storage: { type: 'memory' },
    tools: [],
    mode: 'chat',
    agent: { maxSteps: 4 },
    knowledge: {
      sources: [{ type: 'text', id: 'public', content: 'Indexed documentation.' }],
      embedding: { provider: 'ollama', model: 'offline' },
      store: { type: 'sqlite', path: 'unused.db' },
      retrieval: { mode, topK: 1, minScore: 0.5 },
    },
    ...overrides,
  })
  const handler = createSiteBotHandler(config, {
    deps: { sessionStore: sessions, adapters: { anthropic: async () => model } },
    vectorStoreFactory: async () =>
      new MemoryVectorStore({ chunks: [source('plans', [1, 0]), source('recovery', [0, 1])] }),
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
  it('does not attach an evicted source when model context truncation drops its history', async () => {
    const sessions = new SerializedStore()
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async (options) => {
        if (model.doStreamCalls.length === 1) return output('Trial: seven days [1].')
        expect(JSON.stringify(options.prompt)).not.toContain('Previously retrieved source excerpts')
        expect(JSON.stringify(options.prompt)).toContain('[2] recovery')
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
        {
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
          expect(JSON.stringify(options.prompt)).toContain('Previously retrieved source excerpts')
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

  it('numbers new inline evidence consistently and does not recycle IDs after stored history is evicted', async () => {
    const sessions = new SerializedStore({ maxMessagesPerSession: 2 })
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async (options) => {
        const call = model.doStreamCalls.length
        const prompt = JSON.stringify(options.prompt)
        if (call === 1) return output('Trial: seven days [1].')
        if (call === 2) {
          expect(prompt).toContain('[2] recovery')
          expect(prompt).toContain('Previously retrieved source excerpts')
          return output('Recovery: 21 days [2].')
        }
        // Evict the earlier records entirely while preserving the session counter.
        expect(prompt).toContain('[3] plans')
        expect(prompt).not.toContain('Previously retrieved source excerpts')
        return output('Trial [3]. An unknown reference [1] [99].')
      },
    })
    const handler = handlerFor(model, sessions, 'always')
    await ask(handler, 'u1', 'trial plans')
    const second = await ask(handler, 'u2', 'recovery')
    expect(citations(second).find((c) => c.id === 'c2')?.url).toBe('https://acme.com/en/recovery')
    const session = await sessions.get(chatBody().sessionId)
    await sessions.set({ ...session!, messages: [] })
    const third = await ask(handler, 'u3', 'trial plans')
    expect(citations(third)).toMatchObject([{ id: 'c3', chunkId: 'plans' }])
  })
})
