import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  contextBudget,
  estimateMessageTokens,
  SUMMARY_THRESHOLD,
  truncateHistory,
} from './truncate.js'

/** docs/04 §6 steps 3–5. */

const text = (id: string, role: UIMessage['role'], words: number): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text: `${id} ${'word '.repeat(words)}` }],
})

/** user/assistant pairs, oldest first: u0 a0 u1 a1 … */
function conversation(turns: number, words = 40): UIMessage[] {
  return Array.from({ length: turns }, (_, index) => [
    text(`u${index}`, 'user', words),
    text(`a${index}`, 'assistant', words),
  ]).flat()
}

describe('contextBudget', () => {
  it('is the window minus system and output, less 20% headroom', () => {
    expect(
      contextBudget({
        modelId: 'x:y',
        contextWindow: 10_000,
        systemTokens: 1_000,
        maxOutputTokens: 1_000,
      }),
    ).toBe(6_400)
  })

  it('never goes negative', () => {
    expect(
      contextBudget({
        modelId: 'x:y',
        contextWindow: 100,
        systemTokens: 500,
        maxOutputTokens: 500,
      }),
    ).toBe(0)
  })
})

describe('truncateHistory', () => {
  it('keeps everything that fits', () => {
    const messages = conversation(3)
    const result = truncateHistory(messages, { budgetTokens: 100_000 })
    expect(result.messages).toEqual(messages)
    expect(result.dropped).toBe(0)
  })

  it('keeps the newest messages within the budget', () => {
    const messages = conversation(10)
    const perMessage = estimateMessageTokens(messages[0]!)
    const result = truncateHistory(messages, { budgetTokens: perMessage * 4 + 1 })
    expect(result.messages.map((message) => message.id)).toEqual(['u8', 'a8', 'u9', 'a9'])
    expect(result.tokens).toBeLessThanOrEqual(perMessage * 4 + 1)
  })

  it('starts the window on a user turn, never on an orphaned reply', () => {
    // Room for three messages would keep a8 u9 a9: a8 answers a question that
    // is gone, so the window advances to u9.
    const messages = conversation(10)
    const perMessage = estimateMessageTokens(messages[0]!)
    const result = truncateHistory(messages, { budgetTokens: perMessage * 3 + 1 })
    expect(result.messages[0]?.role).toBe('user')
    expect(result.messages.map((message) => message.id)).toEqual(['u9', 'a9'])
  })

  it('keeps a tool call and its result together — they share one message', () => {
    const toolTurn: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-lookup',
          toolCallId: 'tc1',
          state: 'output-available',
          input: { q: 'x' },
          output: { found: true },
        },
        { type: 'text', text: 'Found it.' },
      ],
    } as UIMessage
    const messages = [...conversation(6), text('u1', 'user', 5), toolTurn]
    const result = truncateHistory(messages, {
      budgetTokens: estimateMessageTokens(toolTurn) + estimateMessageTokens(messages[12]!) + 1,
    })
    const kept = result.messages.at(-1)!
    expect(kept.parts.map((part) => part.type)).toEqual(['tool-lookup', 'text'])
  })

  it('always keeps the message just sent, even over budget', () => {
    const messages = [...conversation(2), text('huge', 'user', 5_000)]
    const result = truncateHistory(messages, { budgetTokens: 10 })
    expect(result.messages.map((message) => message.id)).toEqual(['huge'])
  })

  it(`asks for a summary when more than ${SUMMARY_THRESHOLD} messages are dropped`, () => {
    const messages = conversation(10)
    const perMessage = estimateMessageTokens(messages[0]!)
    const without = truncateHistory(messages, { budgetTokens: perMessage * 2 + 1 })
    expect(without.dropped).toBeGreaterThan(SUMMARY_THRESHOLD)
    expect(without.summaryNeeded).toBe(true)

    const withSummary = truncateHistory(messages, {
      budgetTokens: perMessage * 2 + 1,
      summary: 'Earlier: the visitor asked about returns.',
    })
    expect(withSummary.summaryNeeded).toBe(false)
    expect(withSummary.messages[0]).toMatchObject({ id: 'summary', role: 'user' })
    expect(withSummary.messages.slice(1).map((message) => message.id)).toEqual(['u9', 'a9'])
  })

  it('does not ask for a summary for a small drop', () => {
    const messages = conversation(3)
    const perMessage = estimateMessageTokens(messages[0]!)
    expect(truncateHistory(messages, { budgetTokens: perMessage * 4 + 1 }).summaryNeeded).toBe(
      false,
    )
  })
})
