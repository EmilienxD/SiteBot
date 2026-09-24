import type { UIMessage, UIPart } from './types.js'

/**
 * A reader for the AI SDK UI Message Stream — docs/03-protocol.md §2–§4.
 *
 * The widget used to depend on `ai` for this (`AbstractChat` +
 * `DefaultChatTransport`), which pulled zod and the JSON-schema machinery into
 * the browser: ~55 kB gzip for what is, on the wire, a line-oriented SSE feed
 * of small JSON objects. This module is the in-house replacement docs/07 §1
 * describes. It owns the protocol, so it is held to it by a conformance test
 * (`ui-stream.test.ts`) that replays streams produced by the real server-side
 * SDK and compares the resulting message with the SDK's own reader.
 *
 * It is deliberately lenient where the SDK is strict: a delta for a part that
 * never started opens one rather than failing the whole response, because a
 * half-rendered answer is better than an error bubble.
 */

export type Chunk = { type: string } & Record<string, unknown>

export interface StreamingMessage {
  message: UIMessage
  finishReason?: string
  /** Open text/reasoning parts by stream id, closed on `*-end` or step end. */
  open: Map<string, UIPart>
}

type ToolPart = UIPart & {
  toolCallId: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
  toolName?: string
}

/** Continue `last` if it is the assistant turn being resumed, else start fresh. */
export function startMessage(last: UIMessage | undefined, id: string): StreamingMessage {
  const message =
    last?.role === 'assistant'
      ? (structuredClone(last) as UIMessage)
      : { id, role: 'assistant' as const, parts: [] }
  return { message, open: new Map() }
}

/**
 * Apply one chunk. Returns true when the message changed, and reports data
 * parts (transient included) through `onData`. An `error` chunk throws — the
 * server has given up on this response.
 */
export function applyChunk(
  state: StreamingMessage,
  chunk: Chunk,
  onData?: (part: { type: string; id?: string; data: unknown; transient?: boolean }) => void,
): boolean {
  const parts = state.message.parts
  const str = (key: string) => (typeof chunk[key] === 'string' ? (chunk[key] as string) : '')
  switch (chunk.type) {
    case 'start':
      if (chunk.messageId) state.message.id = str('messageId')
      return mergeMetadata(state, chunk.messageMetadata) || Boolean(chunk.messageId)
    case 'finish':
      if (chunk.finishReason) state.finishReason = str('finishReason')
      return mergeMetadata(state, chunk.messageMetadata)
    case 'message-metadata':
      return mergeMetadata(state, chunk.messageMetadata)
    case 'start-step':
      parts.push({ type: 'step-start' })
      return false
    case 'finish-step':
      state.open.clear()
      return false
    case 'text-start':
    case 'reasoning-start': {
      const part = { type: chunk.type.slice(0, -6), text: '', state: 'streaming' }
      state.open.set(`${part.type}:${str('id')}`, part)
      parts.push(part)
      return true
    }
    case 'text-delta':
    case 'reasoning-delta': {
      const type = chunk.type.slice(0, -6)
      const key = `${type}:${str('id')}`
      let part = state.open.get(key)
      if (!part) {
        part = { type, text: '', state: 'streaming' }
        state.open.set(key, part)
        parts.push(part)
      }
      part.text = `${part.text as string}${str('delta')}`
      return true
    }
    case 'text-end':
    case 'reasoning-end': {
      const key = `${chunk.type.slice(0, -4)}:${str('id')}`
      const part = state.open.get(key)
      if (part) part.state = 'done'
      state.open.delete(key)
      return part !== undefined
    }
    case 'file':
      parts.push({ type: 'file', mediaType: chunk.mediaType, url: chunk.url })
      return true
    case 'source-url':
      parts.push({
        type: 'source-url',
        sourceId: chunk.sourceId,
        url: chunk.url,
        title: chunk.title,
      })
      return true
    case 'source-document':
      parts.push({
        type: 'source-document',
        sourceId: chunk.sourceId,
        mediaType: chunk.mediaType,
        title: chunk.title,
        filename: chunk.filename,
      })
      return true
    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-input-available':
    case 'tool-input-error': {
      if (chunk.type === 'tool-input-delta' && !findTool(state, str('toolCallId'))) return false
      const part = upsertTool(state, chunk)
      if (chunk.type === 'tool-input-start') part.state = 'input-streaming'
      else if (chunk.type === 'tool-input-available') {
        part.state = 'input-available'
        part.input = chunk.input
      } else if (chunk.type === 'tool-input-error') {
        part.state = 'output-error'
        part.errorText = str('errorText')
        part.input = chunk.input
      }
      return chunk.type !== 'tool-input-delta'
    }
    case 'tool-approval-request': {
      const part = findTool(state, str('toolCallId'))
      if (!part) return false
      part.state = 'approval-requested'
      part.approval = { id: str('approvalId') }
      return true
    }
    case 'tool-output-denied':
    case 'tool-output-available':
    case 'tool-output-error': {
      const part = findTool(state, str('toolCallId'))
      if (!part) return false
      if (chunk.type === 'tool-output-denied') part.state = 'output-denied'
      else if (chunk.type === 'tool-output-error') {
        part.state = 'output-error'
        part.errorText = str('errorText')
      } else {
        part.state = 'output-available'
        part.output = chunk.output
        if (chunk.preliminary !== undefined) part.preliminary = chunk.preliminary
      }
      return true
    }
    case 'error':
      throw new StreamError(str('errorText') || 'The response failed.')
    default: {
      if (!chunk.type.startsWith('data-')) return false
      const data = {
        type: chunk.type,
        ...(chunk.id === undefined ? {} : { id: str('id') }),
        data: chunk.data,
      }
      if (chunk.transient === true) {
        onData?.({ ...data, transient: true })
        return false
      }
      const existing =
        data.id === undefined
          ? undefined
          : parts.find((part) => part.type === data.type && part.id === data.id)
      if (existing) existing.data = data.data
      else parts.push(data)
      onData?.(data)
      return true
    }
  }
}

/** The server gave up mid-stream (an `error` chunk). */
export class StreamError extends Error {
  override name = 'StreamError'
}

function mergeMetadata(state: StreamingMessage, metadata: unknown): boolean {
  if (metadata == null || typeof metadata !== 'object') return false
  const current = state.message.metadata
  state.message.metadata =
    current && typeof current === 'object' ? { ...current, ...metadata } : { ...metadata }
  return true
}

function findTool(state: StreamingMessage, toolCallId: string): ToolPart | undefined {
  const parts = state.message.parts
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] as ToolPart
    if (isTool(part) && part.toolCallId === toolCallId) return part
  }
  return undefined
}

function upsertTool(state: StreamingMessage, chunk: Chunk): ToolPart {
  const toolCallId = String(chunk.toolCallId)
  const existing = findTool(state, toolCallId)
  if (existing) {
    if (chunk.providerExecuted !== undefined) existing.providerExecuted = chunk.providerExecuted
    return existing
  }
  const toolName = String(chunk.toolName ?? '')
  const part: ToolPart = chunk.dynamic
    ? { type: 'dynamic-tool', toolName, toolCallId, state: 'input-streaming' }
    : { type: `tool-${toolName}`, toolCallId, state: 'input-streaming' }
  if (chunk.providerExecuted !== undefined) part.providerExecuted = chunk.providerExecuted
  if (typeof chunk.title === 'string') part.title = chunk.title
  state.message.parts.push(part)
  return part
}

export function isTool(part: UIPart): boolean {
  return part.type.startsWith('tool-') || part.type === 'dynamic-tool'
}

/**
 * Split an SSE body into its `data:` payloads — docs/03 §2: "Each event is
 * `data: <json>\n\n`, terminated by `data: [DONE]`". Comments and other fields
 * are ignored; multi-line data is joined per the SSE spec.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  const flush = function* (): Generator<Chunk> {
    if (data.length === 0) return
    const payload = data.join('\n')
    data = []
    if (payload === '[DONE]') return
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) yield parsed as Chunk
    } catch {
      /* a malformed event is skipped, not fatal */
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1))
        if (line === '') yield* flush()
        else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5))
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(buffer[5] === ' ' ? 6 : 5))
        yield* flush()
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
