import { describe, expect, it } from 'vitest'
import { PLAYGROUND_CORPUS } from '../../test/fixtures/playground-corpus.js'
import { testConfig } from '../../test/helpers.js'
import { lexicalEmbedder } from '../../test/lexical-embedder.js'
import { MemoryVectorStore } from './memory-store.js'
import { retrieve } from './retrieve.js'
import type { ResolvedConfig } from '@sitebot/config'
import type { Chunk } from './store.js'

/**
 * docs/09 Phase 6 acceptance: "Ingest the playground site; a golden set of 20
 * query → doc pairs holds recall@6 above threshold."
 *
 * No infrastructure and no provider: the corpus is the playground's own prose
 * (test/fixtures/playground-corpus.ts) and the embedder is the deterministic
 * TF-IDF stub (test/lexical-embedder.ts). docs/09's hard rule — no test in the
 * default pipeline makes a real network call to a provider — is what rules out
 * the obvious alternative of embedding for real and snapshotting the vectors.
 */

/**
 * The committed floor for recall@6.
 *
 * **What it guards.** Every query below is answerable from exactly one section,
 * and `topK` is 6 out of a 24-section corpus — so a healthy pipeline puts the
 * right section in the window nearly every time. The regressions this catches
 * are the quiet ones: a chunker that merges or splits sections so the answer
 * lands in a chunk the query no longer matches, a `dedupeByUrl` change that
 * evicts a second good section from the same page, an `expandNeighbours` change
 * that fills the window with padding, or a `minScore` raised past the point
 * where real hits survive. None of those fail an existing test; all of them
 * degrade answer quality in production.
 *
 * Measured recall at the time of writing is 1.0. The floor is set below that so
 * a single borderline query does not break the build, and deliberately not much
 * below: if this number has to be lowered to make a change pass, that is the
 * conversation the constant exists to force.
 */
const RECALL_AT_6_THRESHOLD = 0.9

/** 20 query → expected-section pairs. */
const GOLDEN_SET: readonly { query: string; expect: string }[] = [
  // /
  { query: 'which ocean lanes do you sail and how often do they depart', expect: 'home#services' },
  { query: 'what happens after I accept a quote request', expect: 'home#how-it-works' },

  // /docs
  { query: 'what token do I send to authenticate a request', expect: 'docs#authentication' },
  { query: 'how do I create a shipment from an accepted quote', expect: 'docs#creating-a-shipment' },
  { query: 'which webhook events do you deliver', expect: 'docs#webhooks' },
  { query: 'how do I verify the signature header on a delivery', expect: 'docs#verifying-a-webhook' },
  { query: 'what happens if I exceed the requests per minute limit', expect: 'docs#rate-limits' },
  { query: 'what does a 422 response mean', expect: 'docs#errors' },

  // /pricing
  { query: 'how much does the Growth plan cost per month', expect: 'pricing#plans' },
  { query: 'is entry filing charged separately from the platform fee', expect: 'pricing#intro' },
  { query: 'is duty and VAT included or passed through', expect: 'pricing#not-included' },
  { query: 'what are the payment terms and is annual prepayment cheaper', expect: 'pricing#billing' },
  {
    query: 'is a consolidated LCL booking with four suppliers counted as four shipments',
    expect: 'pricing#what-counts',
  },
  { query: 'can I upgrade my plan mid month and is the fee prorated', expect: 'pricing#changing-plans' },

  // /support
  { query: 'what are your support hours', expect: 'support#intro' },
  { query: 'which email address should I write to for something not time critical', expect: 'support#how-to-reach-us' },
  { query: 'my shipment is stuck, how do I escalate it', expect: 'support#escalating' },
  { query: 'why was my customs entry held', expect: 'support#why-held' },
  { query: 'who pays demurrage charges', expect: 'support#demurrage' },
  { query: 'do you handle dangerous goods classes', expect: 'support#dangerous-goods' },
]

const TOP_K = 6

const embedder = lexicalEmbedder(
  PLAYGROUND_CORPUS.map((section) => `${section.headingPath.join(' ')} ${section.text}`),
)

/**
 * The store as ingest would leave it: heading path prepended before embedding,
 * ordinal ids, one `sourceId` for the whole crawl (docs/06 §3.4).
 */
function indexedStore(): MemoryVectorStore {
  const chunks: Chunk[] = PLAYGROUND_CORPUS.map((section, ordinal) => ({
    id: section.id,
    text: section.text,
    embedding: embedder.embedSync(`${section.headingPath.join(' ')}\n\n${section.text}`),
    metadata: {
      url: section.url,
      title: section.title,
      headingPath: section.headingPath,
      sourceId: 'playground',
      sourceType: 'crawl',
      contentHash: `h${ordinal}`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      tokens: Math.ceil(section.text.length / 4),
    },
  }))
  return new MemoryVectorStore({ model: embedder.modelId, chunks })
}

function goldenConfig(overrides: Record<string, unknown> = {}): ResolvedConfig {
  return testConfig({
    knowledge: {
      sources: [{ type: 'crawl', url: 'https://northwind.example.com' }],
      embedding: { provider: 'openai', model: 'text-embedding-3-small', apiKey: 'k' },
      retrieval: { topK: TOP_K, minScore: 0.05, ...overrides },
    },
  })
}

async function recallAt6(config = goldenConfig()): Promise<{ recall: number; missed: string[] }> {
  const store = indexedStore()
  const missed: string[] = []

  for (const pair of GOLDEN_SET) {
    const result = await retrieve({ store, embedder }, pair.query, config)
    if (!result.hits.slice(0, TOP_K).some((hit) => hit.id === pair.expect)) missed.push(pair.query)
  }

  return { recall: (GOLDEN_SET.length - missed.length) / GOLDEN_SET.length, missed }
}

describe('golden retrieval set (docs/09 Phase 6)', () => {
  it('holds recall@6 above the committed threshold', async () => {
    const { recall, missed } = await recallAt6()
    // The miss list is in the failure message on purpose: "recall dropped" is
    // not actionable, "these three queries stopped finding their section" is.
    expect(recall, `missed: ${missed.join(' | ') || 'none'}`).toBeGreaterThanOrEqual(
      RECALL_AT_6_THRESHOLD,
    )
  })

  it('ranks the expected section first for most queries', async () => {
    // A weaker claim than recall@6 but a sharper one: it degrades before
    // recall does, so it is the early warning. Measured at 0.85.
    const store = indexedStore()
    let firstPlace = 0
    for (const pair of GOLDEN_SET) {
      const result = await retrieve({ store, embedder }, pair.query, goldenConfig())
      if (result.hits[0]?.id === pair.expect) firstPlace += 1
    }
    expect(firstPlace / GOLDEN_SET.length).toBeGreaterThanOrEqual(0.7)
  })

  it('covers every page of the playground site', () => {
    // A golden set that drifts onto one page stops testing retrieval breadth.
    const byId = new Map(PLAYGROUND_CORPUS.map((section) => [section.id, section]))
    const pages = new Set(GOLDEN_SET.map((pair) => byId.get(pair.expect)?.url))
    expect(pages.size).toBe(4)
    expect(GOLDEN_SET).toHaveLength(20)
  })

  it('names a section that actually exists for every query', () => {
    const ids = new Set(PLAYGROUND_CORPUS.map((section) => section.id))
    expect(GOLDEN_SET.filter((pair) => !ids.has(pair.expect))).toEqual([])
    // Distinct expectations: 20 pairs all pointing at one section would pass
    // the recall assertion while testing nothing.
    expect(new Set(GOLDEN_SET.map((pair) => pair.expect)).size).toBe(GOLDEN_SET.length)
  })

  it('returns at most topK hits', async () => {
    const store = indexedStore()
    const result = await retrieve({ store, embedder }, 'shipment', goldenConfig())
    expect(result.hits.length).toBeLessThanOrEqual(TOP_K)
  })

  it('flags a query with nothing above minScore rather than returning noise', async () => {
    // docs/06 §3.8: `belowThreshold` is what turns into the explicit "no
    // relevant documentation" note instead of six irrelevant chunks.
    const store = indexedStore()
    const result = await retrieve(
      { store, embedder },
      'quantum chromodynamics lattice gauge theory',
      goldenConfig({ minScore: 0.5 }),
    )
    expect(result.hits).toEqual([])
    expect(result.belowThreshold).toBe(true)
  })

  it('makes no embedding call per corpus chunk at query time', async () => {
    // Query-time embedding is one call for the user's message. If this number
    // ever tracks corpus size, retrieval is re-embedding the index per request.
    const store = indexedStore()
    const before = embedder.calls.length
    await retrieve({ store, embedder }, 'what are your support hours', goldenConfig())
    expect(embedder.calls.length - before).toBe(1)
  })
})
