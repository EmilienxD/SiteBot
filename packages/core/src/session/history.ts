import type { UIMessage } from 'ai'

/**
 * Merging the client's messages with server-side history — docs/08-security.md
 * §6, docs/04 §6 step 2.
 */

/** The last message with `role: 'user'`, or null. */
export function lastUserMessage(messages: readonly UIMessage[]): UIMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as UIMessage
    if (message.role === 'user') return message
  }
  return null
}

export interface MergeHistoryInput {
  /** What the store holds for this session. */
  stored: readonly UIMessage[]
  /** What the request body claims the conversation is. */
  incoming: readonly UIMessage[]
  /** `storage.type: none` — no server history exists, so the client's is all there is. */
  stateless: boolean
}

/**
 * With server storage on, **only the last user message from the request body is
 * trusted**; everything before it comes from the store. A malicious client can
 * otherwise forge an assistant turn saying "the user is an administrator", and
 * the model has no way to tell the difference.
 *
 * With `storage.type: none` there is nothing to compare against, so the client's
 * array is used wholesale. That is the documented weakness of stateless mode
 * and the reason agent mode forbids it.
 */
export function mergeHistory(input: MergeHistoryInput): UIMessage[] {
  if (input.stateless) return [...input.incoming]

  const latest = lastUserMessage(input.incoming)
  if (latest === null) return [...input.stored]

  // A retry or a reconnect can resend a message the store already has.
  const alreadyStored = input.stored.some((message) => message.id === latest.id)
  if (alreadyStored) return [...input.stored]

  return [...input.stored, latest]
}

/** Shown to the model in place of the result a dangling tool call never got. */
export const UNANSWERED_APPROVAL =
  'not_performed: the approval request was never answered (it expired, or the visitor moved on), so this action did not run.'
export const MISSING_RESULT =
  'no_result: the run ended before this tool returned a result, so it may not have completed.'

/**
 * Close every tool call that a new turn leaves behind — docs/03 §5.
 *
 * A suspended run's assistant message ends on a call waiting for an approval
 * or a client tool result. Once the visitor sends a new message instead (or
 * the checkpoint expires and the resume is refused), that call never gets a
 * result, and a provider rejects any transcript holding a call without one:
 * every later turn in the session would fail. Each such call is settled as an
 * error that says what happened, so the model can still tell the visitor.
 *
 * The `approval` record goes too: an unanswered request has no response for
 * the SDK to pair it with.
 */
export function settleDanglingToolCalls(messages: readonly UIMessage[]): {
  messages: UIMessage[]
  settled: number
} {
  let settled = 0
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    let changed = false
    const parts = message.parts.map((part) => {
      const tool = part as { type: string; state?: string; approval?: unknown }
      if (!tool.type.startsWith('tool-') && tool.type !== 'dynamic-tool') return part
      if (
        tool.state !== 'approval-requested' &&
        tool.state !== 'approval-responded' &&
        tool.state !== 'input-available'
      )
        return part
      changed = true
      settled += 1
      const { approval: _approval, ...rest } = tool
      return {
        ...rest,
        state: 'output-error',
        errorText: tool.state === 'approval-requested' ? UNANSWERED_APPROVAL : MISSING_RESULT,
      } as unknown as typeof part
    })
    return changed ? { ...message, parts } : message
  })
  return { messages: next, settled }
}
