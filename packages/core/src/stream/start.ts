import type { UIMessageChunk } from 'ai'

/**
 * The pre-first-token boundary — docs/04-providers-and-engine.md §3 rule 5.
 *
 * Fallback is only legal *before* output reaches the user; once a token has
 * been sent, switching models mid-answer produces incoherent text. So the
 * engine cannot simply hand the model's stream to the response — it has to know
 * whether the stream got as far as producing something before it commits.
 *
 * `awaitFirstOutput` buffers the stream's opening chunks until one of three
 * things happens:
 *
 *   • a real output chunk appears  → the stream is healthy, commit to it
 *   • an `error` chunk appears     → reject, so `runChain` can retry or hop
 *   • the stream ends             → reject, an empty answer is a failed attempt
 *
 * The buffered chunks are replayed into the returned stream, so nothing is
 * lost. After this point errors are the stream's problem, not the chain's:
 * they flow through as terminal `error` parts, exactly as §3 rule 7 requires.
 */

/** Chunk types that mean the model has actually started answering. */
const OUTPUT_CHUNK_TYPES = new Set([
  'text-start',
  'text-delta',
  'reasoning-start',
  'reasoning-delta',
  'tool-input-start',
  'tool-input-available',
  'tool-approval-request',
  'source-url',
  'source-document',
  'file',
  'finish',
])

export class EmptyStreamError extends Error {
  override readonly name = 'EmptyStreamError'
  constructor() {
    super('the model produced no output')
  }
}

export class StreamStartError extends Error {
  override readonly name = 'StreamStartError'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export interface FirstOutputOptions {
  /**
   * The raw provider error, captured by `streamText`'s `onError`. The `error`
   * chunk only carries a redacted string, and `classifyError` needs the status
   * code — so the caller passes a getter for the object it saw.
   */
  rawError?: () => unknown
}

/**
 * Wait until the stream has committed to producing output, then return a stream
 * that replays what was buffered and continues.
 */
export async function awaitFirstOutput(
  source: ReadableStream<UIMessageChunk>,
  options: FirstOutputOptions = {},
): Promise<ReadableStream<UIMessageChunk>> {
  const reader = source.getReader()
  const buffered: UIMessageChunk[] = []

  for (;;) {
    let result: Awaited<ReturnType<typeof reader.read>>
    try {
      result = await reader.read()
    } catch (error) {
      reader.releaseLock()
      throw error
    }

    if (result.done) {
      reader.releaseLock()
      throw new EmptyStreamError()
    }

    const chunk = result.value

    if (chunk.type === 'error') {
      const raw = options.rawError?.()
      // Prefer the raw error: it carries the status code that decides retry vs
      // hop. The chunk's text is the redacted, browser-safe version.
      if (raw !== undefined && raw !== null) throw raw
      throw new StreamStartError(chunk.errorText)
    }

    buffered.push(chunk)
    if (OUTPUT_CHUNK_TYPES.has(chunk.type)) break
  }

  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk)
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        reader.releaseLock()
        return
      }
      controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
