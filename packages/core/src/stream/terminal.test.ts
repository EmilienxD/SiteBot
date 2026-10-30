import { describe, expect, it, vi } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { ensureTerminalOutcome } from './terminal.js'

async function outcome(
  chunks: UIMessageChunk[],
  options: Partial<Parameters<typeof ensureTerminalOutcome>[1]> = {},
) {
  const input = new ReadableStream<UIMessageChunk>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  })
  const reader = ensureTerminalOutcome(input, {
    signal: new AbortController().signal,
    stopReason: () => undefined,
    onMaxSteps: 'summarize',
    errors: { locale: 'en' },
    ...options,
  }).getReader()
  const result: UIMessageChunk[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) return result
    result.push(next.value)
  }
}
const errorParts = (chunks: UIMessageChunk[]) =>
  chunks.filter((chunk) => chunk.type === 'data-error')

describe('stream terminal outcomes', () => {
  it('turns clean EOF after tool output into an explicit provider error and finish', async () => {
    const result = await outcome([
      { type: 'start', messageId: 'response' },
      { type: 'tool-input-available', toolCallId: 'c', toolName: 'lookup', input: {} },
      { type: 'tool-output-available', toolCallId: 'c', output: { n: 1 } },
    ])
    expect(errorParts(result)).toMatchObject([{ data: { code: 'provider_error' } }])
    expect(result.at(-1)).toEqual({ type: 'finish', finishReason: 'error' })
  })

  it('does not hide an interrupted partial answer behind a fabricated successful finish', async () => {
    expect(
      errorParts(
        await outcome([
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Partial' },
        ]),
      ),
    ).toMatchObject([{ data: { code: 'provider_error' } }])
  })

  it('makes a provider error finish explicit even if it supplied some text but no error event', async () => {
    const result = await outcome([
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Partial' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: 'error' },
    ])
    expect(errorParts(result)).toMatchObject([{ data: { code: 'provider_error' } }])
  })

  it.each(['data-approval-request', 'data-client-tool-call'] as const)(
    'preserves an authorized %s suspension without claiming an empty-answer failure',
    async (type) => {
      const result = await outcome([
        { type, data: { toolCallId: 'c' } },
        { type: 'finish', finishReason: 'tool-calls' },
      ])
      expect(errorParts(result)).toEqual([])
      expect(result.at(-1)).toMatchObject({ finishReason: 'tool-calls' })
    },
  )

  it('stops treating a handoff as pending once it has an output/error', async () => {
    const result = await outcome([
      { type: 'data-client-tool-call', data: { toolCallId: 'c' } },
      { type: 'tool-output-error', toolCallId: 'c', errorText: 'Unavailable' },
      { type: 'finish', finishReason: 'tool-calls' },
    ])
    expect(errorParts(result)).toMatchObject([{ data: { code: 'provider_error' } }])
  })

  it('reports cancellation once, suppresses private abort reasons, and never emits successful finish', async () => {
    const controller = new AbortController()
    controller.abort(new Error('PRIVATE_ABORT_DETAIL'))
    const result = await outcome([{ type: 'abort', reason: 'PRIVATE_ABORT_DETAIL' }], {
      signal: controller.signal,
    })
    expect(errorParts(result)).toMatchObject([{ data: { code: 'aborted', retryable: false } }])
    expect(result.at(-1)).toEqual({ type: 'abort' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ABORT_DETAIL')
  })

  it('does not duplicate an existing terminal error or change a normal answer', async () => {
    const error: UIMessageChunk = {
      type: 'data-error',
      data: { code: 'provider_error', message: 'Safe error', retryable: true },
    }
    expect(errorParts(await outcome([error, { type: 'finish', finishReason: 'error' }]))).toEqual([
      error,
    ])
    const normal: UIMessageChunk[] = [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Answer' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: 'stop' },
    ]
    expect(await outcome(normal)).toEqual(normal)
  })

  it('preserves the silent policy when a continued assistant answer already has text', async () => {
    const diagnostics = vi.fn()
    const result = await outcome([{ type: 'finish', finishReason: 'tool-calls' }], {
      onMaxSteps: 'silent',
      stopReason: () => 'steps',
      priorAnswerCharacters: 10,
      onComplete: diagnostics,
    })
    expect(errorParts(result)).toEqual([])
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ answerCharacters: 10, failed: false }),
    )
  })
})
