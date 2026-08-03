import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { citationList } from './panel.js'

/**
 * docs/06 §3.9: the widget renders numbered source chips from the
 * `data-citations` part, and shows only those the model actually cited.
 */

function messageWith(citations: { id: string; title: string; url: string; snippet: string; score: number }[], text: string): UIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [
      { type: 'text', text },
      { type: 'data-citations', data: { items: citations } } as never,
    ],
  }
}

const CITATIONS = [
  { id: 'c1', title: 'Shipping', url: 'https://acme.com/shipping', snippet: 'Ships in 2 days.', score: 0.9 },
  { id: 'c2', title: 'Returns', url: 'https://acme.com/returns', snippet: '30-day returns.', score: 0.8 },
  { id: 'c3', title: 'Hours', url: 'https://acme.com/hours', snippet: 'Weekdays 9–5.', score: 0.5 },
]

describe('citationList', () => {
  it('returns every item when the text cites nothing (opaque context)', () => {
    const message = messageWith(CITATIONS, 'Here is an answer without inline markers.')
    expect(citationList(message, 'Here is an answer without inline markers.')).toHaveLength(3)
  })

  it('shows only the citations the model actually referenced', () => {
    const message = messageWith(CITATIONS, 'Orders ship fast [1], and returns are generous [2].')
    const out = citationList(message, 'Orders ship fast [1], and returns are generous [2].')
    expect(out.map((citation) => citation.title)).toEqual(['Shipping', 'Returns'])
  })

  it('returns nothing for a message without a citations part', () => {
    const message: UIMessage = { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }
    expect(citationList(message, 'hi')).toHaveLength(0)
  })

  it('ignores markers beyond the citation count', () => {
    const message = messageWith(CITATIONS, 'See [9].')
    expect(citationList(message, 'See [9].')).toHaveLength(0)
  })
})
