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
