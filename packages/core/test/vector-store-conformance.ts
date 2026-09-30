import { describe, expect, it } from 'vitest'
import type { Chunk, VectorStore } from '../src/knowledge/store.js'
/**
 * The vector-store conformance suite — docs/06 §7, docs/09 Phase 6.
 *
 * One file, every implementation. A store that needs an absent optional peer
 * or live infrastructure returns `undefined` from its factory here and the
 * affected assertions skip via `softSkip` rather than failing a developer who
 * has never configured that store — the suite is only meaningful against an
 * implementation it can actually build.
 *
 * The corpus is small and the ground truth is explicit: queries with a known
 * nearest chunk by keyword content, so recall is verified without a fuzzy
 * threshold argument.
 */

export interface StoreFactory {
  name: string
  /** Fresh, empty store, or undefined (`skipReason` must say why). */
  create(model?: string): Promise<VectorStore | undefined>
  skipReason?: string
}

function chunk(
  id: string,
  text: string,
  embedding: number[],
  overrides: Partial<Chunk['metadata']> = {},
): Chunk {
  return {
    id,
    text,
    embedding,
    metadata: {
      url: overrides.url ?? `https://example.com/${id}`,
      title: overrides.title ?? `Page ${id}`,
      headingPath: overrides.headingPath ?? [],
      sourceId: overrides.sourceId ?? 'test',
      sourceType: overrides.sourceType ?? 'text',
      contentHash: overrides.contentHash ?? `hash-${id}`,
      updatedAt: overrides.updatedAt ?? '2026-08-03T00:00:00Z',
      tokens: overrides.tokens ?? 10,
      ...(overrides.ordinal === undefined ? {} : { ordinal: overrides.ordinal }),
      ...(overrides.lang === undefined ? {} : { lang: overrides.lang }),
    },
  }
}

/** A tiny but non-degenerate embedding space: three axes, three clusters. */
const CORPUS: Chunk[] = [
  chunk('shipping-1', 'How long does shipping take? Orders ship in 2 business days.', [1, 0, 0], {
    url: 'https://example.com/shipping',
    title: 'Shipping',
    ordinal: 0,
  }),
  chunk('shipping-2', 'Express shipping is overnight for most addresses.', [0.95, 0.05, 0], {
    url: 'https://example.com/shipping',
    title: 'Shipping',
    ordinal: 1,
  }),
  chunk('returns-1', 'Return any item within 30 days for a full refund.', [0, 1, 0], {
    url: 'https://example.com/returns',
    title: 'Returns',
  }),
  chunk('hours-1', 'Support hours are weekdays 9 to 5 Pacific.', [0, 0, 1], {
    url: 'https://example.com/hours',
    title: 'Support hours',
  }),
  chunk('billing-1', 'We bill monthly; annual plans get two months free.', [0.5, 0.5, 0.1], {
    url: 'https://example.com/billing',
    title: 'Billing',
  }),
]

async function buildStore(
  factory: StoreFactory,
  model = 'test-embed-1',
): Promise<VectorStore | undefined> {
  try {
    return await factory.create(model)
  } catch (error) {
    if (factory.skipReason === undefined) throw error
    return undefined
  }
}

export function runVectorStoreConformance(factory: StoreFactory): void {
  describe(`VectorStore conformance: ${factory.name}`, () => {
    it('reports empty stats on a fresh store', async (context) => {
      const s = await buildStore(factory)
      if (s === undefined) return context.skip(factory.skipReason ?? 'store not constructible')
      try {
        const stats = await s.stats()
        expect(stats.chunks).toBe(0)
        expect(stats.documents).toBe(0)
      } finally {
        await s.close()
      }
    })

    it('upserts, queries and returns the nearest chunk first', async (context) => {
      const s = await buildStore(factory)
      if (s === undefined) return context.skip(factory.skipReason ?? 'store not constructible')
      try {
        await s.upsert(CORPUS)
        const results = await s.query([1, 0, 0], { topK: 2 })
        expect(results.length).toBe(2)
        expect(results[0]!.chunk.id).toBe('shipping-1')
        expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
      } finally {
        await s.close()
      }
    })

    it('honours minScore by dropping weak matches', async (context) => {
      const s = await buildStore(factory)
      if (s === undefined) return context.skip(factory.skipReason ?? 'store not constructible')
      try {
        await s.upsert(CORPUS)
        const results = await s.query([0, 0, 1], { topK: 10, minScore: 0.5 })
        const ids = results.map((result) => result.chunk.id)
        expect(ids).toContain('hours-1')
        expect(ids).not.toContain('shipping-1')
      } finally {
        await s.close()
      }
    })

    it('applies metadata equality filters', async (context) => {
      const s = await buildStore(factory)
      if (s === undefined) return context.skip(factory.skipReason ?? 'store not constructible')
      try {
        await s.upsert(CORPUS)
        const results = await s.query([1, 0, 0], {
          topK: 10,
          filter: { sourceType: 'text', title: 'Returns' },
        })
        const ids = results.map((result) => result.chunk.id)
        expect(ids.every((id) => id.startsWith('returns'))).toBe(true)
      } finally {
        await s.close()
      }
    })

    it('deleteBySource removes exactly that source', async (context) => {
      const s = await buildStore(factory)
      if (s === undefined) return context.skip(factory.skipReason ?? 'store not constructible')
      try {
        await s.upsert([
          ...CORPUS,
          chunk('other-1', 'Unrelated', [1, 0, 0], { sourceId: 'other', url: 'https://o.test/1' }),
        ])
        await s.deleteBySource('test')
        const results = await s.query([1, 0, 0], { topK: 10 })
        expect(results.map((result) => result.chunk.id)).toEqual(['other-1'])
      } finally {
        await s.close()
      }
    })

    it('deleteByIds removes exactly those chunks', async (context) => {
      const s = await buildStore(factory)
      if (s === undefined) return context.skip(factory.skipReason ?? 'store not constructible')
      try {
        await s.upsert(CORPUS)
        await s.deleteByIds(['shipping-1', 'hours-1'])
        const results = await s.query([1, 0, 0], { topK: 10 })
        expect(results.map((result) => result.chunk.id)).not.toContain('shipping-1')
        expect(results.map((result) => result.chunk.id)).not.toContain('hours-1')
        expect(results.length).toBe(3)
      } finally {
        await s.close()
      }
    })

    it('upsert is idempotent on the same id', async (context) => {
      const s = await buildStore(factory)
      if (s === undefined) return context.skip(factory.skipReason ?? 'store not constructible')
      try {
        await s.upsert([CORPUS[0]!])
        await s.upsert([{ ...CORPUS[0]!, text: 'Replaced body.' }])
        const stats = await s.stats()
        expect(stats.chunks).toBe(1)
        const results = await s.query([1, 0, 0], { topK: 1 })
        expect(results[0]!.chunk.text).toBe('Replaced body.')
      } finally {
        await s.close()
      }
    })

    it('reports stats after writes', async (context) => {
      const s = await buildStore(factory, 'model-a')
      if (s === undefined) return context.skip(factory.skipReason ?? 'store not constructible')
      try {
        await s.upsert(CORPUS)
        const stats = await s.stats()
        expect(stats.chunks).toBe(5)
        if (factory.name === 'upstash') {
          // Hosted Upstash has no distinct-count: documents is a documented 0.
          expect(stats.documents).toBe(0)
        } else {
          expect(stats.documents).toBeGreaterThan(0)
        }
      } finally {
        await s.close()
      }
    })

    it('documentChunks returns a whole document when implemented', async (context) => {
      const s = await buildStore(factory)
      if (s === undefined) return context.skip(factory.skipReason ?? 'store not constructible')
      try {
        if (s.documentChunks === undefined) return context.skip('documentChunks not implemented')
        await s.upsert(CORPUS)
        const chunks = await s.documentChunks('https://example.com/shipping')
        expect(chunks.map((c) => c.id)).toEqual(['shipping-1', 'shipping-2'])
        expect(chunks.map((c) => c.embedding)).toEqual([
          [1, 0, 0],
          [0.95, 0.05, 0],
        ])
      } finally {
        await s.close()
      }
    })
  })
}
