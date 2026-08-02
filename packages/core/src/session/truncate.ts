import type { UIMessage } from 'ai'

/**
 * History management — docs/04-providers-and-engine.md §6.
 *
 * Truncation is token-budget based, not message-count based, because one pasted
 * stack trace is worth fifty short turns.
 */

/**
 * Per-model context windows. Conservative default of 128k for anything not
 * listed, so a model we have never heard of degrades to "assume a normal
 * window" rather than "assume infinite and get a 400 from the provider".
 *
 * Matched by prefix: `claude-sonnet-5-20260101` hits the `claude-sonnet-5` row.
 */
export const MODEL_CONTEXT_WINDOWS: readonly [string, number][] = [
  ['claude-opus-5', 200_000],
  ['claude-sonnet-5', 200_000],
  ['claude-haiku-4-5', 200_000],
  ['claude-', 200_000],
  ['gpt-5', 400_000],
  ['gpt-4.1', 1_047_576],
  ['gpt-4o', 128_000],
  ['o3', 200_000],
  ['gemini-2.5', 1_048_576],
  ['gemini-', 1_000_000],
  ['mistral-large', 128_000],
  ['llama', 128_000],
]

export const DEFAULT_CONTEXT_WINDOW = 128_000

export function maxContextTokens(modelId: string): number {
  const bare = modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId
  for (const [prefix, window] of MODEL_CONTEXT_WINDOWS) {
    if (bare.startsWith(prefix)) return window
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * ~4 characters per token, plus a small per-message envelope.
 *
 * A real tokenizer would cost a dependency per provider family and still be
 * approximate across providers, and the number is only used to decide what to
 * drop — the 20% headroom below absorbs the error.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const MESSAGE_OVERHEAD_TOKENS = 4

export function estimateMessageTokens(message: UIMessage): number {
  let total = MESSAGE_OVERHEAD_TOKENS
  for (const part of message.parts as { type: string; [key: string]: unknown }[]) {
    if (part.type === 'text' && typeof part.text === 'string') {
      total += estimateTokens(part.text)
      continue
    }
    if (part.type === 'reasoning' && typeof part.text === 'string') {
      total += estimateTokens(part.text)
      continue
    }
    // Tool parts and data parts: measure the serialised payload, which is what
    // the provider actually charges for.
    try {
      total += estimateTokens(JSON.stringify(part) ?? '')
    } catch {
      total += MESSAGE_OVERHEAD_TOKENS
    }
  }
  return total
}

export interface ContextBudgetInput {
  modelId: string
  systemTokens: number
  maxOutputTokens: number
  /** Overrides the lookup table when a developer knows better. */
  contextWindow?: number
}

/** `contextWindow − system − maxOutput − 20% headroom` (§6 step 3). */
export function contextBudget(input: ContextBudgetInput): number {
  const window = input.contextWindow ?? maxContextTokens(input.modelId)
  const usable = window - input.systemTokens - input.maxOutputTokens
  return Math.max(0, Math.floor(usable * 0.8))
}

/** More than this many dropped messages warrants a synthetic summary (§6 step 5). */
export const SUMMARY_THRESHOLD = 4

export interface TruncateOptions {
  budgetTokens: number
  /**
   * Prepended as a synthetic user turn when more than {@link SUMMARY_THRESHOLD}
   * messages were dropped. The engine supplies it; producing it (a cheap model
   * call, cached per session) is the caller's job, so this stays pure.
   */
  summary?: string
}

export interface TruncateResult {
  messages: UIMessage[]
  dropped: number
  /** Estimated tokens of the kept window, summary included. */
  tokens: number
  /** True when a summary was requested by the drop count but none was supplied. */
  summaryNeeded: boolean
}

const isUser = (message: UIMessage): boolean => message.role === 'user'

/**
 * Keep the newest messages that fit in `budgetTokens`, cutting at a clean
 * boundary.
 *
 * "Clean" means the window starts with a user message. In the v6 UIMessage
 * model a tool call and its result live in the *same* assistant message, so a
 * pair cannot be split across messages (§6 step 4); what can go wrong is
 * keeping an assistant reply whose question was dropped, which reads to the
 * model as an unprompted assertion. Advancing to the next user message costs a
 * message or two and removes that whole class of confusion.
 */
export function truncateHistory(
  messages: readonly UIMessage[],
  options: TruncateOptions,
): TruncateResult {
  const budget = Math.max(0, options.budgetTokens)
  const sizes = messages.map((message) => estimateMessageTokens(message))

  let start = messages.length
  let total = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const size = sizes[index] as number
    if (total + size > budget) break
    total += size
    start = index
  }

  // Always keep the last message even if it alone blows the budget: dropping
  // the message the user just sent would be worse than an over-long request,
  // which the provider will at least report clearly.
  if (start === messages.length && messages.length > 0) {
    start = messages.length - 1
    total = sizes[start] as number
  }

  // Advance to a clean boundary.
  while (start < messages.length && !isUser(messages[start] as UIMessage)) {
    total -= sizes[start] as number
    start += 1
  }

  const kept = messages.slice(start)
  const dropped = start
  const summaryNeeded = dropped > SUMMARY_THRESHOLD

  if (summaryNeeded && options.summary !== undefined) {
    const summaryMessage: UIMessage = {
      id: 'summary',
      role: 'user',
      parts: [{ type: 'text', text: options.summary }],
    }
    return {
      messages: [summaryMessage, ...kept],
      dropped,
      tokens: total + estimateMessageTokens(summaryMessage),
      summaryNeeded: false,
    }
  }

  return { messages: kept, dropped, tokens: Math.max(0, total), summaryNeeded }
}
