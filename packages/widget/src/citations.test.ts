import { describe, expect, it } from 'vitest'
import type { UIMessage } from './types.js'
import { citationList } from './panel.js'

/**
 * docs/06 §3.9: the widget renders numbered source chips from the
 * `data-citations` part, and shows only those the model actually cited.
 */

function messageWith(
  citations: { id: string; title: string; url: string; snippet: string; score: number }[],
  text: string,
): UIMessage {
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
  {
    id: 'c1',
    title: 'Shipping',
    url: 'https://acme.com/shipping',
    snippet: 'Ships in 2 days.',
    score: 0.9,
  },
  {
    id: 'c2',
    title: 'Returns',
    url: 'https://acme.com/returns',
    snippet: '30-day returns.',
    score: 0.8,
  },
  { id: 'c3', title: 'Hours', url: 'https://acme.com/hours', snippet: 'Weekdays 9–5.', score: 0.5 },
]

describe('citationList', () => {
  it('does not imply that uncited context supports an answer or abstention', () => {
    const message = messageWith(CITATIONS, 'Here is an answer without inline markers.')
    expect(citationList(message, 'Here is an answer without inline markers.')).toHaveLength(0)
  })

  it('shows only the citations the model actually referenced', () => {
    const message = messageWith(CITATIONS, 'Orders ship fast [1], and returns are generous [2].')
    const out = citationList(message, 'Orders ship fast [1], and returns are generous [2].')
    expect(out.map((citation) => citation.title)).toEqual(['Shipping', 'Returns'])
  })

  it.each([
    ['Individual [1].', ['c1']],
    ['Individual whitespace [ \t1\n ].', ['c1']],
    ['Grouped [1, 3].', ['c1', 'c3']],
    ['Whitespace [ 1 ,\t3\n ].', ['c1', 'c3']],
    ['Repeated [1, 3, 1] and [3] [1].', ['c1', 'c3']],
    ['Mixed [99, 1, 3] and [2, 999].', ['c1', 'c2', 'c3']],
    ['Unknown [99, 999].', []],
  ])('resolves numeric markers using only supplied sources: %s', (text, ids) => {
    const found = citationList(messageWith(CITATIONS, text), text)
    expect(found.map((source) => source.id)).toEqual(ids)
    for (const source of found)
      expect(source.url).toBe(CITATIONS.find((trusted) => trusted.id === source.id)!.url)
  })

  it.each([
    '[0, 1]',
    '[01, 3]',
    '[-1, 3]',
    '[1.0, 3]',
    '[1e0, 3]',
    '[c1, 3]',
    '[1, c3]',
    '[1,]',
    '[,1]',
    '[1,,3]',
    '[1 3]',
    '[1;3]',
    '[1-3]',
    '[[1, 3]]',
    '[text[1, 3]]',
    '[1, 3]]',
    '[1, 3',
    '[1, https://evil.test/forged]',
    '[1, <a href="https://evil.test">3</a>]',
  ])('does not salvage source IDs from malformed groups: %s', (text) => {
    expect(citationList(messageWith(CITATIONS, text), text)).toEqual([])
  })

  it('ignores unsafe integer IDs and citation data attached to a user message', () => {
    const text = '[9007199254740992, 1]'
    const message = messageWith(
      [
        ...CITATIONS,
        { ...CITATIONS[0]!, id: 'c9007199254740992', url: 'https://evil.test/forged' },
      ],
      text,
    )
    expect(citationList(message, text).map((source) => source.id)).toEqual(['c1'])
    expect(citationList({ ...message, role: 'user' }, text)).toEqual([])
  })

  it('keeps the trusted destination when the marker is also a Markdown link label', () => {
    const text = '[1, 3](https://evil.test/forged)'
    expect(citationList(messageWith(CITATIONS, text), text).map((source) => source.url)).toEqual([
      CITATIONS[0]!.url,
      CITATIONS[2]!.url,
    ])
  })

  it('returns nothing for a message without a citations part', () => {
    const message: UIMessage = {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hi' }],
    }
    expect(citationList(message, 'hi')).toHaveLength(0)
  })

  it('ignores markers beyond the citation count', () => {
    const message = messageWith(CITATIONS, 'See [9].')
    expect(citationList(message, 'See [9].')).toHaveLength(0)
  })

  it.each(['Returns [2]; hours [27]; unknown [1].', 'Returns and hours [2, 27, 1, 27].'])(
    'resolves sparse conversation IDs across repeated resume parts: %s',
    (text) => {
      const sources = [{ ...CITATIONS[2]!, id: 'c27' }, CITATIONS[1]!]
      const message = messageWith(sources, text)
      message.parts.push({ type: 'data-citations', data: { items: sources } } as never)
      expect(citationList(message, text).map((c) => c.id)).toEqual(['c27', 'c2'])
    },
  )
})
