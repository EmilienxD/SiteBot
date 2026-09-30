import { describe, expect, it } from 'vitest'
import { chunkDocument, chunkSemanticDocument, type DocumentInput } from './chunk.js'
import { extract } from './extract.js'

/**
 * docs/06 §3.3–§3.4 acceptance: extraction snapshots and chunking properties.
 */

const OPTIONS = { strategy: 'semantic', maxTokens: 512, overlapTokens: 64, minTokens: 64 } as const
const FIXED = { ...OPTIONS, strategy: 'fixed' } as const

function doc(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return {
    url: 'https://acme.com/docs/auth',
    title: 'Authentication',
    text: '',
    headings: [],
    sourceId: 'files',
    sourceType: 'files',
    contentHash: 'hash',
    updatedAt: '2026-08-03T00:00:00Z',
    ...overrides,
  }
}

describe('extract()', () => {
  it('keeps the main element and strips chrome', () => {
    const html = `<html><head><title>Pricing — Acme</title></head><body>
      <nav><a href="/">Home</a></nav>
      <main><h1>Pricing</h1><p>Plans start at $10 a month for the starter tier.</p>
      <h2>Enterprise</h2><p>Contact sales for a volume discount on the annual plan.</p></main>
      <footer>© Acme</footer></body></html>`
    const page = extract(html)
    expect(page.title).toBe('Pricing — Acme')
    expect(page.text).toContain('Plans start at $10')
    expect(page.text).not.toContain('Home')
    expect(page.text).toContain('## Enterprise')
  })

  it('honours the selector override over the heuristic', () => {
    const html = `<html><body><article><p>Wrong section.</p></article>
      <div class="docs"><h1>API</h1><p>The real documentation lives here.</p></div></body></html>`
    const page = extract(html, { selector: '.docs' })
    expect(page.text).toContain('real documentation')
    expect(page.text).not.toContain('Wrong section')
  })

  it('marks pages under minChars as skipped', () => {
    const html = `<html><body><main><p>Hi.</p></main></body></html>`
    expect(extract(html, { minChars: 200 }).skipped).toBe(true)
    expect(extract(html, { minChars: 3 }).skipped).toBe(false)
  })
})

describe('embedding-distance semantic splits', () => {
  const paragraphs = [
    'shipping '.repeat(12),
    'delivery '.repeat(12),
    'refunds '.repeat(12),
    'returns '.repeat(12),
  ].map((text) => text.trim())
  const document = doc({ text: paragraphs.join('\n\n') })
  const options = { ...OPTIONS, maxTokens: 80, minTokens: 15, overlapTokens: 0 }
  it('breaks at the largest topic gap even when a third paragraph would fit', async () => {
    const chunks = await chunkSemanticDocument(document, options, {
      embedBatch: async (texts) => ({
        embeddings: texts.map((text) => (/shipping|delivery/.test(text) ? [1, 0] : [0, 1])),
        tokens: 100,
      }),
    })
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      paragraphs.slice(0, 2).join('\n\n'),
      paragraphs.slice(2).join('\n\n'),
    ])
    expect(chunks.every((chunk) => chunk.tokens <= options.maxTokens)).toBe(true)
    expect(chunks.flatMap((chunk) => chunk.text.split('\n\n'))).toEqual(paragraphs)
  })
  it('retains short sections and handles giant paragraphs within the ceiling', async () => {
    const chunks = await chunkSemanticDocument(
      doc({ text: 'tiny\n\n' + 'word '.repeat(1000) }),
      options,
      {
        embedBatch: async (texts) => ({ embeddings: texts.map(() => [1, 0]), tokens: 100 }),
      },
    )
    expect(chunks[0]?.text).toContain('tiny')
    expect(chunks.every((chunk) => chunk.tokens <= options.maxTokens)).toBe(true)
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index))
  })
  it('rejects missing paragraph vectors before emitting corrupt boundaries', async () => {
    await expect(
      chunkSemanticDocument(document, options, {
        embedBatch: async () => ({ embeddings: [], tokens: 0 }),
      }),
    ).rejects.toThrow('invalid paragraph embeddings')
  })
  it('adds configured overlap while keeping the final token ceiling', async () => {
    const chunks = await chunkSemanticDocument(
      document,
      { ...options, overlapTokens: 8 },
      {
        embedBatch: async (texts) => ({
          embeddings: texts.map((text) => (/shipping|delivery/.test(text) ? [1, 0] : [0, 1])),
          tokens: 100,
        }),
      },
    )
    expect(chunks[1]?.text.startsWith(chunks[0]!.text.slice(-32).trim())).toBe(true)
    expect(chunks.every((chunk) => chunk.tokens <= options.maxTokens)).toBe(true)
  })
})

describe('chunkDocument()', () => {
  const longText = Array.from({ length: 40 }, (_, index) =>
    `Paragraph ${index} has enough words in it to be a real paragraph and chunk reliably.`.repeat(
      4,
    ),
  ).join('\n\n')

  it('never emits a chunk over maxTokens (fixed)', () => {
    const chunks = chunkDocument(doc({ text: longText }), FIXED)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(FIXED.maxTokens)
  })

  it('reassembles to the source with fixed strategy', () => {
    const chunks = chunkDocument(doc({ text: longText }), FIXED)
    const words = longText.split(/\s+/)
    const chunked = new Set(chunks.flatMap((chunk) => chunk.text.split(/\s+/)))
    for (const word of words) expect(chunked.has(word)).toBe(true)
  })

  it('heading strategy splits at h2 boundaries and tracks headingPath', () => {
    const text = [
      '# Guide',
      '',
      'Intro paragraph about the guide.',
      '',
      '## Install',
      '',
      'Run pnpm add to install the package today.',
      '',
      '## Configure',
      '',
      'Set the key in the config file before you start.',
    ].join('\n')
    const chunks = chunkDocument(
      doc({
        text,
        headings: [
          { level: 1, text: 'Guide', offset: 0 },
          { level: 2, text: 'Install', offset: text.indexOf('## Install') },
          { level: 2, text: 'Configure', offset: text.indexOf('## Configure') },
        ],
      }),
      { ...OPTIONS, strategy: 'heading', minTokens: 0 },
    )
    const paths = chunks.map((chunk) => chunk.headingPath.join(' > '))
    expect(paths.some((path) => path.includes('Install'))).toBe(true)
    expect(paths.some((path) => path.includes('Configure'))).toBe(true)
    const installChunk = chunks.find((chunk) => chunk.headingPath.includes('Install'))
    expect(installChunk?.text).toContain('pnpm add')
  })

  it('ids remain unset until the pipeline stamps them', () => {
    const chunks = chunkDocument(doc({ text: longText }), FIXED)
    expect(chunks.every((chunk) => chunk.id === '')).toBe(true)
    expect(new Set(chunks.map((chunk) => chunk.ordinal)).size).toBe(chunks.length)
  })
})
