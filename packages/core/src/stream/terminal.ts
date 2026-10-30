import type { UIMessageChunk } from 'ai'
import { EngineError, mapError, type ErrorCode, type MapErrorOptions } from './errors.js'

export type LoopStopReason = 'steps' | 'tokens' | 'time'

/** A completed tool call or reasoning part is not a visitor-facing answer. */
export function ensureTerminalOutcome(
  stream: ReadableStream<UIMessageChunk>,
  options: {
    signal: AbortSignal
    stopReason: () => LoopStopReason | undefined
    onMaxSteps: 'summarize' | 'silent' | 'error'
    errors: MapErrorOptions
    priorAnswerCharacters?: number
    onComplete?: (outcome: {
      finishReason?: string
      answerCharacters: number
      suspended: boolean
      failed: boolean
      terminalCode?: string
    }) => void
  },
): ReadableStream<UIMessageChunk> {
  let answerCharacters = options.priorAnswerCharacters ?? 0
  let hasAnswer = answerCharacters > 0
  let hasError = false
  let ended = false
  const pending = new Set<string>()

  const complete = (
    controller: TransformStreamDefaultController<UIMessageChunk>,
    finishReason?: string,
    aborted = false,
  ) => {
    ended = true
    const stop = options.stopReason()
    let code: ErrorCode | undefined
    if (aborted || options.signal.aborted) code = 'aborted'
    else if (pending.size === 0) {
      if (stop === 'tokens' || stop === 'time') code = 'budget_exceeded'
      else if (stop === 'steps' && (!hasAnswer || options.onMaxSteps === 'error'))
        code = 'max_steps_exceeded'
      else if (!hasAnswer || finishReason === undefined || finishReason === 'error')
        code = 'provider_error'
    }
    if (code && !hasError) {
      const mapped = mapError(new EngineError(code), options.errors)
      controller.enqueue({
        type: 'data-error',
        data: { ...mapped, retryable: code === 'provider_error' },
      } as UIMessageChunk)
      hasError = true
    }
    options.onComplete?.({
      ...(finishReason === undefined ? {} : { finishReason }),
      answerCharacters,
      suspended: pending.size > 0,
      failed: hasError,
      ...(code === undefined ? {} : { terminalCode: code }),
    })
    return hasError ? ('error' as const) : undefined
  }

  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'text-delta') {
          answerCharacters += chunk.delta.length
          if (chunk.delta.trim() !== '') hasAnswer = true
        }
        if (chunk.type === 'file') hasAnswer = true
        if (chunk.type === 'data-error' || chunk.type === 'error') hasError = true
        // Only authorized, emitted handoffs can suspend a run. Bare tool inputs cannot.
        if (chunk.type === 'data-approval-request' || chunk.type === 'data-client-tool-call') {
          const data = chunk.data as { toolCallId?: string }
          if (data.toolCallId) pending.add(data.toolCallId)
        }
        if (
          chunk.type === 'tool-output-available' ||
          chunk.type === 'tool-output-error' ||
          chunk.type === 'tool-output-denied'
        )
          pending.delete(chunk.toolCallId)
        if (chunk.type === 'finish') {
          const reason = complete(controller, chunk.finishReason ?? 'unknown')
          controller.enqueue(reason ? { ...chunk, finishReason: reason } : chunk)
        } else if (chunk.type === 'abort') {
          complete(controller, 'abort', true)
          // Abort reasons can contain application/provider details; keep the protocol event only.
          controller.enqueue({ type: 'abort' })
        } else controller.enqueue(chunk)
      },
      flush(controller) {
        if (!ended) {
          complete(controller)
          controller.enqueue({ type: 'finish', finishReason: hasError ? 'error' : 'stop' })
        }
      },
    }),
  )
}
