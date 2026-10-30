import type { LanguageModel } from 'ai'
import type { LanguageModelV2, LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { EngineError } from '../stream/errors.js'

/** Private per-invocation scope. Never abort the shared request controller. */
function callDeadline(ms: number, parent?: AbortSignal, onTimeout?: () => void) {
  const controller = new AbortController()
  const expiresAt = Date.now() + ms
  const cancel = () => controller.abort(new DOMException('Request cancelled.', 'AbortError'))
  const timeout = () => {
    if (controller.signal.aborted) return
    controller.abort(new DOMException('Model call timed out.', 'TimeoutError'))
    onTimeout?.()
  }
  const timer = setTimeout(timeout, ms)
  if (parent?.aborted) cancel()
  else parent?.addEventListener('abort', cancel, { once: true })
  const check = () => {
    if (!controller.signal.aborted && Date.now() >= expiresAt) timeout()
    controller.signal.throwIfAborted()
  }
  const dispose = () => {
    clearTimeout(timer)
    parent?.removeEventListener('abort', cancel)
  }
  async function wait<T>(operation: () => PromiseLike<T>): Promise<T> {
    check()
    let onAbort: (() => void) | undefined
    try {
      const result = await Promise.race([
        new Promise<never>((_, reject) => {
          onAbort = () => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', onAbort, { once: true })
        }),
        Promise.resolve().then(() => {
          check()
          return operation()
        }),
      ])
      check()
      return result
    } finally {
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
  }
  return { signal: controller.signal, check, wait, dispose, cancel }
}

/** Enforce the existing per-call limit even when a provider ignores its abort signal. */
export function withModelTimeout(
  model: LanguageModel,
  ms: number,
  onTimeout?: () => void,
): LanguageModel {
  if (typeof model === 'string') throw new EngineError('not_ready')
  // A proxy preserves model spec v2/v3 and optional provider metadata without mutation.
  return new Proxy(model, {
    get(target, property) {
      if (property === 'doGenerate')
        return async (params: Parameters<LanguageModelV3['doGenerate']>[0]) => {
          const deadline = callDeadline(ms, params.abortSignal, onTimeout)
          try {
            return await deadline.wait(() =>
              (target as LanguageModelV3).doGenerate({ ...params, abortSignal: deadline.signal }),
            )
          } finally {
            deadline.dispose()
          }
        }
      if (property === 'doStream')
        return async (params: Parameters<LanguageModelV3['doStream']>[0]) => {
          const deadline = callDeadline(ms, params.abortSignal, onTimeout)
          let reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart> | undefined
          let ended = false
          const close = () => {
            ended = true
            deadline.dispose()
          }
          const discard = () => {
            void reader?.cancel().catch(() => {})
          }
          try {
            const result = await deadline.wait(async () => {
              const value = await (target as LanguageModelV3).doStream({
                ...params,
                abortSignal: deadline.signal,
              })
              if (deadline.signal.aborted) {
                void value.stream.cancel().catch(() => {})
                deadline.check()
              }
              return value
            })
            reader = result.stream.getReader()
            const stream = new ReadableStream({
              async pull(controller) {
                if (ended) return
                try {
                  const next = await deadline.wait(() => reader!.read())
                  if (ended) return
                  if (next.done) {
                    close()
                    controller.close()
                    return
                  }
                  controller.enqueue(next.value)
                  if (next.value.type === 'finish' || next.value.type === 'error') {
                    close()
                    controller.close()
                    discard()
                  }
                } catch (error) {
                  if (ended) return
                  close()
                  discard()
                  // Use the provider error event so the SDK and terminal guard can
                  // finalize the UI message; a rejected read bypasses their flush.
                  controller.enqueue({
                    type: 'error',
                    error: deadline.signal.aborted ? deadline.signal.reason : error,
                  })
                  controller.close()
                }
              },
              cancel() {
                deadline.cancel()
                close()
                discard()
              },
            })
            return { ...result, stream }
          } catch (error) {
            close()
            discard()
            throw error
          }
        }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as LanguageModelV2 | LanguageModelV3
}
