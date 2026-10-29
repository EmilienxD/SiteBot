import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { KnowledgeEvidence, MAX_HISTORY_SOURCES } from './search.js'
import type { Citation, RetrievalHit } from './types.js'

const hit = (id: string): RetrievalHit => ({
  id,
  title: id,
  url: `https://example.com/${id}`,
  text: 'Source text.'.repeat(100),
  score: 0.9,
  lang: 'en',
})
const history = (sources: Citation[]): UIMessage[] => [
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Source [1].' },
      { type: 'data-citations', data: { items: sources } },
    ],
  },
]

describe('bounded conversation source identity', () => {
  it('carries short source records only, preserving identity for repeated hits', async () => {
    const first = new KnowledgeEvidence()
    first.add([hit('a'), hit('b')])
    const messages = history(JSON.parse(JSON.stringify(first.citations)))
    const next = new KnowledgeEvidence(messages, first.nextNumber)
    expect(next.add([hit('b'), hit('c')])).toEqual([2, 3])
    expect(next.citations.every((c) => c.snippet.length <= 280)).toBe(true)
    expect(JSON.stringify(await next.modelMessages(messages))).toContain('REFERENCE DATA ONLY')
  })

  it('does not alias dropped history, another language, changed chunks or legacy per-answer IDs', () => {
    const evidence = new KnowledgeEvidence()
    evidence.add([hit('a')])
    const next = new KnowledgeEvidence(history(evidence.citations), evidence.nextNumber)
    next.retain([])
    expect(next.citations).toEqual([])
    expect(
      next.add([hit('a'), { ...hit('a'), lang: 'fr' }, { ...hit('changed'), url: hit('a').url }]),
    ).toEqual([2, 3, 4])
    const legacy = new KnowledgeEvidence(
      history([{ ...evidence.citations[0]!, chunkId: undefined } as unknown as Citation]),
    )
    expect(legacy.citations).toEqual([])
    expect(legacy.add([hit('another')])).toEqual([2])
  })

  it('bounds carried metadata even if a stored answer contains many candidates', () => {
    const first = new KnowledgeEvidence()
    first.add(Array.from({ length: MAX_HISTORY_SOURCES + 10 }, (_, i) => hit(String(i))))
    const next = new KnowledgeEvidence(history(first.citations), first.nextNumber)
    expect(next.citations).toHaveLength(MAX_HISTORY_SOURCES)
    expect(next.citations.at(-1)?.id).toBe(`c${MAX_HISTORY_SOURCES + 10}`)
    expect(next.add([hit('new')])).toEqual([MAX_HISTORY_SOURCES + 11])
  })

  it('refuses ambiguous stored source numbers instead of attributing them to the latest page', () => {
    const first = new KnowledgeEvidence()
    first.add([hit('a')])
    const conflicting = new KnowledgeEvidence()
    conflicting.add([hit('b')])
    const next = new KnowledgeEvidence([
      ...history(first.citations),
      ...history(conflicting.citations),
    ])
    expect(next.citations).toEqual([])
    expect(next.add([hit('a')])).toEqual([2])
  })

  it('does not serialize user-supplied source data to the model as verified references', async () => {
    const evidence = new KnowledgeEvidence()
    evidence.add([hit('a')])
    const messages = history(evidence.citations).map((m) => ({ ...m, role: 'user' as const }))
    expect(JSON.stringify(await evidence.modelMessages(messages))).not.toContain(
      'Previously retrieved source excerpts',
    )
  })
})
