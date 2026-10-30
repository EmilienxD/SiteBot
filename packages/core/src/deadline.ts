const deadlines = new WeakMap<AbortSignal, { at: number; controller: AbortController }>()

/** Check elapsed time too: synchronous application work can delay the timer callback. */
export function checkDeadline(signal: AbortSignal): void {
  const deadline = deadlines.get(signal)
  if (deadline && Date.now() >= deadline.at && !signal.aborted)
    deadline.controller.abort(new Error('Deadline exceeded.'))
  signal.throwIfAborted()
}

/** Cooperative cancellation plus a hard bound on accepting the operation's result. */
export async function withDeadline<T>(
  ms: number,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  deadlines.set(controller.signal, { at: Date.now() + ms, controller })
  const abort = () => controller.abort(parent.reason)
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Deadline exceeded.')), ms)
  let rejectAbort: (() => void) | undefined
  try {
    const result = await Promise.race([
      new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error('Operation cancelled.'))
        if (controller.signal.aborted) rejectAbort()
        else controller.signal.addEventListener('abort', rejectAbort, { once: true })
      }),
      Promise.resolve().then(() => {
        checkDeadline(controller.signal)
        return operation(controller.signal)
      }),
    ])
    checkDeadline(controller.signal)
    return result
  } finally {
    clearTimeout(timer)
    parent.removeEventListener('abort', abort)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
  }
}
