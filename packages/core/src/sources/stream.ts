import type { UIMessageChunk } from 'ai'
import type { Citation } from './types.js'

/**
 * Attaches the `data-citations` message part once the assistant text finishes
 * (docs/06-sources.md). The part carries every registered source; the widget filters
 * to the `[n]` markers actually used in the text, so the UI stays honest.
 */
export function appendCitations(
  stream: ReadableStream<UIMessageChunk>,
  options: { items: () => Citation[]; include: boolean },
): ReadableStream<UIMessageChunk> {
  if (!options.include) return stream
  let emitted = false
  const emit = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    const items = options.items()
    if (items.length > 0)
      controller.enqueue({
        type: 'data-citations',
        id: 'source-citations',
        data: { items },
      } as UIMessageChunk)
    emitted = true
  }
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        // Tool calls can run after an introductory text-end. Read the
        // current list only when the entire assistant run is finishing.
        if (chunk.type === 'finish' && !emitted) emit(controller)
        controller.enqueue(chunk)
      },
      flush(controller) {
        // Tool-only responses still carry committed source metadata.
        if (!emitted) emit(controller)
      },
    }),
  )
}
