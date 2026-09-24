import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  dynamicTool,
  jsonSchema,
  readUIMessageStream,
  simulateReadableStream,
  stepCountIs,
  streamText,
  tool,
  type UIMessageChunk,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from './types.js'
import { applyChunk, readEvents, startMessage, StreamError, type Chunk } from './ui-stream.js'

/**
 * Protocol conformance for the in-house stream reader — docs/07 §1.
 *
 * The widget stopped depending on `ai` in the browser, which means it now owns
 * the client side of the UI Message Stream. These tests hold it to the server:
 * each stream below is produced by the real AI SDK (the same code path the
 * engine uses), then read twice — once by `ui-stream.ts`, once by the SDK's own
 * `readUIMessageStream` — and the two resulting messages must agree.
 */

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number }
const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as never as Usage

/** A model whose successive calls stream the given step parts. */
function model(steps: Array<Array<Record<string, unknown>>>): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const parts = steps[Math.min(call, steps.length - 1)] ?? []
      call += 1
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...parts,
            {
              type: 'finish',
              finishReason: {
                unified: parts.some((part) => part.type === 'tool-call') ? 'tool-calls' : 'stop',
                raw: undefined,
              },
              usage,
            },
          ] as never,
        }),
      }
    },
  })
}

const text = (id: string, ...deltas: string[]) => [
  { type: 'text-start', id },
  ...deltas.map((delta) => ({ type: 'text-delta', id, delta })),
  { type: 'text-end', id },
]

/** Read `response` with the widget's reader. */
async function widgetRead(
  response: Response,
  last?: UIMessage,
): Promise<{ message: UIMessage; data: unknown[] }> {
  const state = startMessage(last, 'fallback-id')
  const data: unknown[] = []
  for await (const chunk of readEvents(response.body!))
    applyChunk(state, chunk, (part) => data.push(part))
  return { message: state.message, data }
}

/** Read `response` with the AI SDK's reader — the reference. */
async function sdkRead(response: Response, last?: UIMessage): Promise<UIMessage> {
  const chunks = (await readSseChunks(response)) as UIMessageChunk[]
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  let final: UIMessage | undefined
  for await (const message of readUIMessageStream({
    stream,
    ...(last ? { message: structuredClone(last) as never } : {}),
  }))
    final = message as unknown as UIMessage
  return final!
}

async function readSseChunks(response: Response): Promise<unknown[]> {
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as unknown)
}

/** Drop `undefined` and provider bookkeeping the widget never reads. */
function normalise(message: UIMessage): unknown {
  return JSON.parse(
    JSON.stringify(message, (key, value: unknown) =>
      ['providerMetadata', 'callProviderMetadata', 'resultProviderMetadata'].includes(key)
        ? undefined
        : value,
    ),
  )
}

async function both(make: () => Response, last?: UIMessage) {
  // One generation, read twice: ids minted by the SDK must match.
  const response = make()
  const [ours, reference] = await Promise.all([
    widgetRead(response.clone(), last),
    sdkRead(response, last),
  ])
  // Without a `messageId` on `start` the SDK leaves the id empty and the
  // widget mints one; either way the server's id wins when it sends one.
  if (reference.id === '') reference.id = ours.message.id
  return { ours: normalise(ours.message), reference: normalise(reference), data: ours.data }
}

describe('ui-stream conformance with the AI SDK', () => {
  it('reads a plain text answer', async () => {
    const make = () =>
      streamText({
        model: model([text('t1', 'Hello', ', ', 'world')]),
        prompt: 'hi',
      }).toUIMessageStreamResponse()
    const { ours, reference } = await both(make)
    expect(ours).toEqual(reference)
    expect(ours).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'step-start' }, { type: 'text', text: 'Hello, world', state: 'done' }],
    })
  })

  it('reads reasoning before text', async () => {
    const make = () =>
      streamText({
        model: model([
          [
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'Thinking it over.' },
            { type: 'reasoning-end', id: 'r1' },
            ...text('t1', 'Answer.'),
          ],
        ]),
        prompt: 'hi',
      }).toUIMessageStreamResponse({ sendReasoning: true })
    const { ours, reference } = await both(make)
    expect(ours).toEqual(reference)
  })

  it('reads a multi-step run with a server-executed tool', async () => {
    const make = () =>
      streamText({
        model: model([
          [
            { type: 'tool-input-start', id: 'tc1', toolName: 'get_time' },
            { type: 'tool-input-delta', id: 'tc1', delta: '{"timezone":' },
            { type: 'tool-input-delta', id: 'tc1', delta: '"Europe/Paris"}' },
            { type: 'tool-input-end', id: 'tc1' },
            {
              type: 'tool-call',
              toolCallId: 'tc1',
              toolName: 'get_time',
              input: '{"timezone":"Europe/Paris"}',
            },
          ],
          text('t2', 'It is noon in Paris.'),
        ]),
        prompt: 'time?',
        stopWhen: stepCountIs(3),
        tools: {
          get_time: tool({
            inputSchema: jsonSchema<{ timezone: string }>({
              type: 'object',
              properties: { timezone: { type: 'string' } },
            }),
            execute: async () => ({ time: '12:00' }),
          }),
        },
      }).toUIMessageStreamResponse()
    const { ours, reference } = await both(make)
    expect(ours).toEqual(reference)
    expect(JSON.stringify(ours)).toContain('"state":"output-available"')
  })

  it('reads a failing tool and a dynamic tool', async () => {
    const make = () =>
      streamText({
        model: model([
          [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: '{}' },
            { type: 'tool-call', toolCallId: 'tc2', toolName: 'mcp_search', input: '{"q":"x"}' },
          ],
          text('t2', 'Done.'),
        ]),
        prompt: 'go',
        stopWhen: stepCountIs(3),
        tools: {
          lookup: tool({
            inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object' }),
            execute: async (): Promise<unknown> => {
              throw new Error('not found')
            },
          }),
          mcp_search: dynamicTool({
            inputSchema: jsonSchema({ type: 'object' }),
            execute: async () => ({ hits: 1 }),
          }),
        },
      }).toUIMessageStreamResponse()
    const { ours, reference } = await both(make)
    expect(ours).toEqual(reference)
    expect(JSON.stringify(ours)).toContain('"state":"output-error"')
    expect(JSON.stringify(ours)).toContain('"type":"dynamic-tool"')
  })

  it('reads an approval request and continues the same message on resume', async () => {
    const first = () =>
      streamText({
        model: model([
          [
            {
              type: 'tool-call',
              toolCallId: 'tc1',
              toolName: 'create_ticket',
              input: '{"title":"Help"}',
            },
          ],
        ]),
        prompt: 'open a ticket',
        tools: {
          create_ticket: tool({
            inputSchema: jsonSchema({ type: 'object' }),
            needsApproval: true,
            execute: async () => ({ id: 'T-1' }),
          }),
        },
      }).toUIMessageStreamResponse()
    const { ours, reference } = await both(first)
    expect(ours).toEqual(reference)
    expect(JSON.stringify(ours)).toContain('"state":"approval-requested"')

    // The resumed stream appends to the suspended assistant turn.
    const suspended = ours as UIMessage
    const resumed = () =>
      createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            writer.write({ type: 'start', messageId: suspended.id })
            writer.write({ type: 'start-step' })
            writer.write({
              type: 'tool-output-available',
              toolCallId: 'tc1',
              output: { id: 'T-1' },
            })
            writer.write({ type: 'text-start', id: 'x' })
            writer.write({ type: 'text-delta', id: 'x', delta: 'Ticket T-1 created.' })
            writer.write({ type: 'text-end', id: 'x' })
            writer.write({ type: 'finish' })
          },
        }),
      })
    const after = await both(resumed, suspended)
    expect(after.ours).toEqual(after.reference)
    expect((after.ours as UIMessage).id).toBe(suspended.id)
  })

  it('reads data parts: persistent, replaced by id, and transient', async () => {
    const make = () =>
      createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            writer.write({ type: 'data-status', transient: true, data: { text: 'Searching…' } })
            writer.write({ type: 'data-citations', data: { items: [{ id: 'c1', title: 'Docs' }] } })
            writer.write({ type: 'data-progress', id: 'p', data: { n: 1 } })
            writer.write({ type: 'data-progress', id: 'p', data: { n: 2 } })
            writer.write({
              type: 'source-url',
              sourceId: 's1',
              url: 'https://acme.com/a',
              title: 'A',
            })
            writer.write({ type: 'text-start', id: 't' })
            writer.write({ type: 'text-delta', id: 't', delta: 'See [1].' })
            writer.write({ type: 'text-end', id: 't' })
          },
        }),
      })
    const { ours, reference, data } = await both(make)
    expect(ours).toEqual(reference)
    expect(JSON.stringify(ours)).not.toContain('data-status')
    expect(data).toContainEqual({
      type: 'data-status',
      data: { text: 'Searching…' },
      transient: true,
    })
    expect(JSON.stringify(ours)).toContain('{"n":2}')
    expect(JSON.stringify(ours)).not.toContain('{"n":1}')
  })

  it('merges message metadata from start and finish', async () => {
    const make = () =>
      streamText({ model: model([text('t1', 'Hi')]), prompt: 'hi' }).toUIMessageStreamResponse({
        messageMetadata: ({ part }) =>
          part.type === 'start'
            ? { createdAt: 1 }
            : part.type === 'finish'
              ? { model: 'mock' }
              : undefined,
      })
    const { ours, reference } = await both(make)
    expect(ours).toEqual(reference)
    expect(ours).toMatchObject({ metadata: { createdAt: 1, model: 'mock' } })
  })
})

describe('readEvents', () => {
  function body(pieces: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece))
        controller.close()
      },
    })
  }
  async function collect(pieces: string[]): Promise<Chunk[]> {
    const out: Chunk[] = []
    for await (const chunk of readEvents(body(pieces))) out.push(chunk)
    return out
  }

  it('reassembles events split across network reads, mid-line and mid-codepoint', async () => {
    const event = 'data: {"type":"text-delta","id":"t","delta":"héllo"}\n\n'
    const bytes = new TextEncoder().encode(event)
    const chunks: Chunk[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // One byte at a time: splits the two-byte "é" as well as every line.
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })
    for await (const chunk of readEvents(stream)) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'text-delta', id: 't', delta: 'héllo' }])
  })

  it('handles CRLF line endings, comments, [DONE] and a missing trailing blank line', async () => {
    expect(
      await collect([
        ': keep-alive\r\n\r\n',
        'data: {"type":"start"}\r\n\r\n',
        'event: ignored\ndata: {"type":"finish"}\n\n',
        'data: [DONE]\n\n',
        'data: {"type":"late"}',
      ]),
    ).toEqual([{ type: 'start' }, { type: 'finish' }, { type: 'late' }])
  })

  it('skips malformed JSON instead of failing the response', async () => {
    expect(await collect(['data: {not json\n\n', 'data: {"type":"start"}\n\n'])).toEqual([
      { type: 'start' },
    ])
  })
})

describe('applyChunk leniency', () => {
  it('opens a text part for a delta that never started', () => {
    const state = startMessage(undefined, 'a1')
    applyChunk(state, { type: 'text-delta', id: 'x', delta: 'orphan' })
    expect(state.message.parts).toEqual([{ type: 'text', text: 'orphan', state: 'streaming' }])
  })

  it('ignores tool results for unknown calls rather than throwing', () => {
    const state = startMessage(undefined, 'a1')
    expect(
      applyChunk(state, { type: 'tool-output-available', toolCallId: 'nope', output: 1 }),
    ).toBe(false)
  })

  it('throws on an error chunk, which ends the response', () => {
    const state = startMessage(undefined, 'a1')
    expect(() => applyChunk(state, { type: 'error', errorText: 'boom' })).toThrow(StreamError)
  })

  it('starts a fresh assistant message after a user turn', () => {
    const state = startMessage({ id: 'u1', role: 'user', parts: [] }, 'a1')
    expect(state.message).toEqual({ id: 'a1', role: 'assistant', parts: [] })
  })
})
