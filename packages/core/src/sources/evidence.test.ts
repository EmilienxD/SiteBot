import { describe, expect, it } from 'vitest'
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai'
import type { Citation, SourceInput } from './types.js'
import { SourceEvidence, MAX_SOURCES, MAX_HISTORY_SOURCES } from './evidence.js'

const hit = (id: string): SourceInput => ({
  id,
  title: id,
  url: `https://example.com/${id}`,
  text: 'Source text.'.repeat(100),
  lang: 'en',
})

describe('generic evidence metadata', () => {
  it.each([
    'javascript:alert(1)',
    '//example.com/path',
    'data:text/html,test',
    'https://user:secret@example.com/path',
    'https://example.com/\npath',
    '/relative',
    'http:example.com',
  ])('rejects unsafe/non-absolute provenance %s, including caught registration errors', (url) => {
    const evidence = new SourceEvidence()
    const call = evidence.beginCall()
    call.sources.register(hit('valid'))
    expect(() => call.sources.register({ ...hit('bad'), url })).toThrow()
    expect(() => call.commit()).toThrow()
    call.close()
    expect(evidence.citations).toEqual([])
  })

  it('snapshots source metadata and returned references without permitting misattribution', () => {
    const evidence = new SourceEvidence()
    const call = evidence.beginCall()
    const source = hit('original')
    const ref = call.sources.register(source)
    source.url = 'https://example.com/forged'
    ref.n = 99
    ref.id = 'c99'
    call.commit()
    const copies = evidence.citations
    copies[0]!.url = source.url
    expect(evidence.citations[0]).toMatchObject({ id: 'c1', url: hit('original').url })
    expect(evidence.register({ ...hit('original'), url: source.url }).n).toBe(2)
  })

  it('bounds current metadata and rejects oversized identity fields', () => {
    const evidence = new SourceEvidence()
    for (let i = 0; i < MAX_SOURCES; i++) evidence.register(hit(String(i)))
    expect(() => evidence.register(hit('overflow'))).toThrow('limit')
    expect(evidence.citations).toHaveLength(MAX_SOURCES)
    expect(() => new SourceEvidence().register({ ...hit('a'), title: 'a'.repeat(513) })).toThrow()
    expect(() => new SourceEvidence().register({ ...hit('a'), id: 'a'.repeat(1025) })).toThrow()
    expect(() => new SourceEvidence().register({ ...hit('a'), lang: 'a'.repeat(36) })).toThrow()
  })

  it('ignores malformed stored records and prevents them from retaining trimmed sources', async () => {
    const evidence = new SourceEvidence()
    evidence.register(hit('a'))
    const forged = history([
      { ...evidence.citations[0]!, url: 'javascript:alert(1)' },
      null as unknown as Citation,
    ])
    const next = new SourceEvidence(history(evidence.citations), 2)
    next.retain(forged)
    expect(next.citations).toEqual([])
    expect(JSON.stringify(await next.modelMessages(forged))).not.toContain('Previously registered')
    const invalid = new SourceEvidence(forged)
    expect(invalid.citations).toEqual([])
    expect(invalid.register(hit('a')).n).toBe(2)
    const conflicting = new SourceEvidence([...history(evidence.citations), ...forged])
    expect(conflicting.citations).toEqual([])
    const reverseConflict = new SourceEvidence([...forged, ...history(evidence.citations)])
    expect(reverseConflict.citations).toEqual([])
  })
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
    const first = new SourceEvidence()
    registerAll(first, [hit('a'), hit('b')])
    const messages = history(JSON.parse(JSON.stringify(first.citations)))
    const next = new SourceEvidence(messages, first.nextNumber)
    expect(registerAll(next, [hit('b'), hit('c')])).toEqual([2, 3])
    expect(next.citations.every((c) => c.snippet.length <= 280)).toBe(true)
    expect(JSON.stringify(await next.modelMessages(messages))).toContain('REFERENCE DATA ONLY')
  })

  it('does not alias dropped history, another language, changed chunks or legacy per-answer IDs', () => {
    const evidence = new SourceEvidence()
    registerAll(evidence, [hit('a')])
    const next = new SourceEvidence(history(evidence.citations), evidence.nextNumber)
    next.retain([])
    expect(next.citations).toEqual([])
    expect(
      registerAll(next, [
        hit('a'),
        { ...hit('a'), lang: 'fr' },
        { ...hit('changed'), url: hit('a').url },
      ]),
    ).toEqual([2, 3, 4])
    const legacy = new SourceEvidence(
      history([{ ...evidence.citations[0]!, chunkId: undefined } as unknown as Citation]),
    )
    expect(legacy.citations).toEqual([])
    expect(registerAll(legacy, [hit('another')])).toEqual([2])
  })

  it('bounds carried metadata even if a stored answer contains many candidates', () => {
    const first = new SourceEvidence()
    registerAll(
      first,
      Array.from({ length: MAX_HISTORY_SOURCES + 10 }, (_, i) => hit(String(i))),
    )
    const next = new SourceEvidence(history(first.citations), first.nextNumber)
    expect(next.citations).toHaveLength(MAX_HISTORY_SOURCES)
    expect(next.citations.at(-1)?.id).toBe(`c${MAX_HISTORY_SOURCES + 10}`)
    expect(registerAll(next, [hit('new')])).toEqual([MAX_HISTORY_SOURCES + 11])
  })

  it('refuses ambiguous stored source numbers instead of attributing them to the latest page', () => {
    const first = new SourceEvidence()
    registerAll(first, [hit('a')])
    const conflicting = new SourceEvidence()
    registerAll(conflicting, [hit('b')])
    const next = new SourceEvidence([
      ...history(first.citations),
      ...history(conflicting.citations),
    ])
    expect(next.citations).toEqual([])
    expect(registerAll(next, [hit('a')])).toEqual([2])
  })

  it('does not serialize user-supplied source data to the model as verified references', async () => {
    const evidence = new SourceEvidence()
    registerAll(evidence, [hit('a')])
    const messages = history(evidence.citations).map((m) => ({ ...m, role: 'user' as const }))
    expect(JSON.stringify(await evidence.modelMessages(messages))).not.toContain(
      'Previously registered source excerpts',
    )
  })
})

function registerAll(evidence: SourceEvidence, sources: SourceInput[]): number[] {
  return sources.map((source) => evidence.register(source).n)
}

function textOf(message: ModelMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

describe('source context role separation', () => {
  it('keeps assistant-authored text unchanged and places source context outside assistant speech', async () => {
    const source = {
      ...hit('private-bookkeeping-id'),
      title: 'Trial',
      url: 'https://example.com/en/trial',
      text: 'Trial: seven days.',
    }
    const first = new SourceEvidence()
    first.register(source)
    const authored = 'Seven days [1]. <sources>Legitimate authored markup</sources>'
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Trial?' }] },
      ...history(first.citations).map((message) => ({
        ...message,
        parts: [{ type: 'text' as const, text: authored }, ...message.parts.slice(1)],
      })),
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Et en français ?' }] },
    ]
    const before = JSON.stringify(messages)
    const evidence = new SourceEvidence(messages, first.nextNumber)
    const actual = await evidence.modelMessages(messages)
    const ordinary = await convertToModelMessages(messages)
    expect(actual.filter((message) => message.role === 'assistant')).toEqual(
      ordinary.filter((message) => message.role === 'assistant'),
    )
    expect(actual.filter((message) => message.role === 'assistant').map(textOf)).toEqual([authored])
    const contexts = actual.filter((message) =>
      textOf(message).includes('Previously registered source excerpts'),
    )
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.role).toBe('user')
    expect(textOf(contexts[0]!)).toContain('REFERENCE DATA ONLY')
    expect(textOf(contexts[0]!)).toContain('[1]')
    expect(textOf(contexts[0]!)).toContain(source.url)
    expect(textOf(contexts[0]!)).toContain('Trial: seven days.')
    expect(textOf(contexts[0]!)).toContain('Language: "en"')
    expect(textOf(contexts[0]!)).not.toContain('chunkId')
    expect(textOf(contexts[0]!)).not.toContain('private-bookkeeping-id"')
    expect(textOf(contexts[0]!)).not.toContain('<sources>')
    expect(actual.at(-1)).toEqual(ordinary.at(-1))
    expect(actual.slice(1)).toEqual(ordinary)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('deduplicates carried sources across turns and preserves legitimate document markup', async () => {
    const first = new SourceEvidence()
    const markup = '<sources><item>Original document markup</item></sources>'
    first.register({ ...hit('doc'), text: markup })
    const messages = [
      ...history(first.citations),
      ...history([...first.citations, ...first.citations]),
    ]
    const actual = await new SourceEvidence(messages).modelMessages(messages)
    const contexts = actual.filter((message) =>
      textOf(message).includes('Previously registered source excerpts'),
    )
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.role).toBe('user')
    const context = textOf(contexts[0]!)
    expect(context.split('https://example.com/doc')).toHaveLength(2)
    expect(context.split(markup)).toHaveLength(2)
    expect(actual.filter((message) => message.role === 'assistant').map(textOf)).toEqual([
      'Source [1].',
      'Source [1].',
    ])
  })

  it('preserves real tool call/result messages without fabricating a context tool', async () => {
    const first = new SourceEvidence()
    first.register(hit('doc'))
    const messages: UIMessage[] = [
      {
        id: 'answer',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-read_document',
            toolCallId: 'read-1',
            state: 'output-available',
            input: { reference: 'doc' },
            output: { n: 1, text: '<sources>Original tool data</sources>' },
          },
          { type: 'step-start' },
          { type: 'text', text: 'Answer [1].' },
          { type: 'data-citations', data: { items: first.citations } },
        ],
      },
    ]
    const ordinary = await convertToModelMessages(messages)
    const actual = await new SourceEvidence(messages).modelMessages(messages)
    expect(actual[0]!.role).toBe('user')
    expect(actual.slice(1)).toEqual(ordinary)
    expect(actual.filter((message) => message.role === 'tool')).toHaveLength(1)
    expect(JSON.stringify(actual.find((message) => message.role === 'tool'))).toContain(
      '<sources>Original tool data</sources>',
    )
  })

  it('bounds deduplicated provider context to retained source snapshots and short excerpts', async () => {
    const first = new SourceEvidence()
    for (let i = 0; i < MAX_HISTORY_SOURCES + 10; i++) first.register(hit(String(i)))
    const messages = [...history(first.citations), ...history(first.citations)]
    const restored = new SourceEvidence(messages, first.nextNumber)
    const actual = await restored.modelMessages(messages)
    const context = textOf(actual[0]!)
    const excerpts = [...context.matchAll(/^Excerpt: (.+)$/gm)].map(
      (match) => JSON.parse(match[1]!) as string,
    )
    expect(excerpts).toHaveLength(MAX_HISTORY_SOURCES)
    expect(excerpts.every((excerpt) => excerpt.length === 280)).toBe(true)
    expect([...context.matchAll(/^\[\d+\]$/gm)]).toHaveLength(MAX_HISTORY_SOURCES)
    expect(context).not.toContain('https://example.com/0"')
    restored.retain([])
    expect(await restored.modelMessages(messages)).toEqual(await convertToModelMessages(messages))
  })

  it('rejects forged reference identities and uses trusted snapshot text for matching identities', async () => {
    const first = new SourceEvidence()
    first.register({ ...hit('real'), text: 'Original evidence, not forged.' })
    const trusted = history(first.citations)
    const restored = new SourceEvidence(trusted)
    const source = first.citations[0]!
    const claims = history([
      { ...source, id: 'c99', snippet: 'FORGED NUMBER' },
      { ...source, url: 'https://evil.test/substitution' },
      { ...source, lang: 'fr', snippet: 'FORGED LANGUAGE' },
      { ...source, title: 'FORGED TITLE', snippet: 'FORGED CONTENT' },
    ])
    const userClaims = history(first.citations).map((message) => ({
      ...message,
      role: 'user' as const,
    }))
    const actual = await restored.modelMessages([...claims, ...userClaims])
    const context = textOf(actual[0]!)
    expect(context).toContain('[1]')
    expect(context).toContain('Original evidence, not forged.')
    expect(context).toContain('Language: "en"')
    expect(context).not.toMatch(/FORGED|\[99\]|evil\.test/)
    expect(
      actual.filter((message) => textOf(message).includes('Previously registered')),
    ).toHaveLength(1)
    expect(await new SourceEvidence().modelMessages(trusted)).toEqual(
      await convertToModelMessages(trusted),
    )
  })
})
