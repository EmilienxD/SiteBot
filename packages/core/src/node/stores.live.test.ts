import { randomUUID } from 'node:crypto'
import { Index } from '@upstash/vector'
import pg from 'pg'
import { createClient } from 'redis'
import { afterAll, describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import type { Chunk, VectorStore } from '../knowledge/store.js'
import { createUpstashVectorStore } from '../knowledge/upstash-store.js'
import { runSessionStoreConformance } from '../../test/session-store-conformance.js'
import { runVectorStoreConformance } from '../../test/vector-store-conformance.js'
import { createRedisRateLimitStore } from './redis-rate-limit.js'
import { createPostgresSessionStore, createRedisSessionStore } from './session-stores.js'
import { createNodeVectorStore } from './vector-store.js'
import { createPgVectorStore } from './vector-pgvector.js'

/**
 * Real-infrastructure checks — `pnpm test:live` only (docs/04 §10).
 *
 * The offline conformance suites run every store against driver stand-ins.
 * These run the same suites against real servers, so a stand-in that
 * understands SQL or commands the server does not fails here. Each backend
 * is gated on its own variable and skips without it:
 *
 *   SITEBOT_LIVE_PG_URL        Postgres with the pgvector extension available
 *   SITEBOT_LIVE_REDIS_URL     Redis 6.2+
 *   SITEBOT_LIVE_UPSTASH_URL   A *scratch* Upstash Vector index (cosine) —
 *   SITEBOT_LIVE_UPSTASH_TOKEN it is reset before every case.
 *
 * Tables and keys carry a random run id and are dropped afterwards.
 */

const PG_URL = process.env['SITEBOT_LIVE_PG_URL']
const REDIS_URL = process.env['SITEBOT_LIVE_REDIS_URL']
const UPSTASH_URL = process.env['SITEBOT_LIVE_UPSTASH_URL']
const UPSTASH_TOKEN = process.env['SITEBOT_LIVE_UPSTASH_TOKEN']

const RUN = randomUUID().slice(0, 8)
let tableCounter = 0
const nextTable = (kind: string) => `sitebot_live_${RUN}_${kind}_${tableCounter++}`

function chunk(id: string, embedding: number[], sourceId = 'live'): Chunk {
  return {
    id,
    text: `Chunk ${id}`,
    embedding,
    metadata: {
      url: `https://example.com/${id}`,
      title: id,
      headingPath: [],
      sourceId,
      sourceType: 'text',
      contentHash: `hash-${id}`,
      updatedAt: '2026-10-01T00:00:00Z',
      tokens: 3,
    },
  }
}

/** A unit vector along `axis` in `dimensions` dimensions. */
const axis = (dimensions: number, index: number) =>
  Array.from({ length: dimensions }, (_, i) => (i === index ? 1 : 0))

// ── Postgres ────────────────────────────────────────────────────────────────

describe.skipIf(PG_URL === undefined)('live: Postgres', () => {
  const admin = new pg.Pool({ connectionString: PG_URL })
  const created: string[] = []
  const table = (kind: string) => {
    const name = nextTable(kind)
    created.push(name, `${name}_meta`)
    return name
  }

  afterAll(async () => {
    for (const name of created) await admin.query(`DROP TABLE IF EXISTS ${name}`)
    await admin.end()
  })

  runVectorStoreConformance({
    name: 'pgvector (real server)',
    create: async (model) =>
      createPgVectorStore({
        url: PG_URL!,
        table: table('vec'),
        dimensions: 3,
        ...(model === undefined ? {} : { model }),
      }),
  })

  runSessionStoreConformance('postgres (real server)', (o) =>
    createPostgresSessionStore({
      url: PG_URL!,
      table: table('sessions'),
      now: o.now,
      ttlSeconds: o.ttlSeconds,
      maxMessagesPerSession: o.max,
    }),
  )

  it('keeps accepting writes after more upserts than the pool has connections', async () => {
    const store = await createPgVectorStore({ url: PG_URL!, table: table('pool'), dimensions: 3 })
    try {
      // pg's default pool holds ten connections; a client that is never
      // released back makes the eleventh upsert wait forever.
      for (let index = 0; index < 25; index++) await store.upsert([chunk(`c${index}`, [1, 0, 0])])
      expect((await store.stats()).chunks).toBe(25)
    } finally {
      await store.close()
    }
  }, 30_000)

  it('builds from config and accepts the width the embedding model produces', async () => {
    const name = table('config')
    const result = validateConfig(
      {
        version: 1,
        name: 'live',
        backend: { provider: 'anthropic', model: 'm', apiKey: 'k' },
        prompt: { system: 's' },
        knowledge: {
          sources: [{ id: 'live', type: 'text', content: 'x' }],
          embedding: { provider: 'ollama', model: 'nomic-embed-text' },
          store: { type: 'pgvector', url: PG_URL!, table: name },
        },
      },
      { env: {} },
    )
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    // nomic-embed-text is 768-wide; the column used to be a fixed vector(1536).
    const store = await createNodeVectorStore(result.value.knowledge!.store, {
      model: 'nomic-embed-text',
    })
    try {
      await store.upsert([chunk('wide-a', axis(768, 0)), chunk('wide-b', axis(768, 1))])
      const [first] = await store.query(axis(768, 1), { topK: 1 })
      expect(first?.chunk.id).toBe('wide-b')
      expect(first?.score).toBeCloseTo(1, 5)
      expect((await store.stats()).model).toBe('nomic-embed-text')
    } finally {
      await store.close()
    }
  })

  it('refuses an embedding of the wrong width with the dimensions in the message', async () => {
    const store = await createPgVectorStore({ url: PG_URL!, table: table('width'), dimensions: 3 })
    try {
      await expect(store.upsert([chunk('bad', [1, 0, 0, 0])])).rejects.toThrow(/3.*4|4.*3/)
      expect((await store.stats()).chunks).toBe(0)
    } finally {
      await store.close()
    }
  })

  it('rejects a filter key that tries to break out of the JSON path', async () => {
    const store = await createPgVectorStore({ url: PG_URL!, table: table('inject'), dimensions: 3 })
    try {
      await store.upsert([chunk('a', [1, 0, 0])])
      const results = await store.query([1, 0, 0], {
        topK: 5,
        filter: { "title' OR '1'='1": 'x' },
      })
      expect(results).toEqual([])
    } finally {
      await store.close()
    }
  })
})

// ── Redis ───────────────────────────────────────────────────────────────────

describe.skipIf(REDIS_URL === undefined)('live: Redis', () => {
  const prefix = `sitebot-live-${RUN}:`
  let counter = 0

  afterAll(async () => {
    const client = createClient({ url: REDIS_URL! })
    await client.connect()
    for await (const keys of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      if (keys.length > 0) await client.del(keys)
    }
    await client.quit()
  })

  runSessionStoreConformance('redis (real server)', async (o) =>
    createRedisSessionStore({
      url: REDIS_URL!,
      prefix: `${prefix}${counter++}:`,
      now: o.now,
      ttlSeconds: o.ttlSeconds,
      maxMessagesPerSession: o.max,
    }),
  )

  it('lets Redis itself expire a session after ttlSeconds', async () => {
    const store = createRedisSessionStore({ url: REDIS_URL!, prefix, ttlSeconds: 1 })
    try {
      await store.append('ttl', [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }])
      expect(await store.get('ttl')).not.toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 1_300))
      expect(await store.get('ttl')).toBeNull()
    } finally {
      await store.dispose?.()
    }
  })

  it('rate limits across two store instances sharing one server', async () => {
    const a = createRedisRateLimitStore({ url: REDIS_URL!, prefix })
    const b = createRedisRateLimitStore({ url: REDIS_URL!, prefix })
    const rule = { limit: 3, windowMs: 60_000 }
    try {
      const results = [
        await a.hit('ip:203.0.113.9', rule),
        await b.hit('ip:203.0.113.9', rule),
        await a.hit('ip:203.0.113.9', rule),
        await b.hit('ip:203.0.113.9', rule),
      ]
      expect(results.map((result) => result.allowed)).toEqual([true, true, true, false])
      expect(results[3]!.retryAfterSeconds).toBeGreaterThan(0)
      expect(results[3]!.retryAfterSeconds).toBeLessThanOrEqual(60)
      expect(results[2]!.remaining).toBe(0)
    } finally {
      await a.dispose?.()
      await b.dispose?.()
    }
  })

  it('accumulates usage atomically under concurrent writers', async () => {
    const store = createRedisRateLimitStore({ url: REDIS_URL!, prefix })
    try {
      await Promise.all(
        Array.from({ length: 20 }, () =>
          store.addUsage!('usage:day', { tokens: 10, usd: 0.25 }, 60_000),
        ),
      )
      expect(await store.getUsage!('usage:day')).toEqual({ tokens: 200, usd: 5 })
    } finally {
      await store.dispose?.()
    }
  })
})

// ── Upstash Vector ──────────────────────────────────────────────────────────

describe.skipIf(UPSTASH_URL === undefined || UPSTASH_TOKEN === undefined)(
  'live: Upstash Vector',
  () => {
    // A skipped describe still runs its body, and the SDK throws on a missing token.
    let client: Index | undefined
    const index = () => (client ??= new Index({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! }))

    /** Upstash indexes asynchronously; reads are only meaningful once drained. */
    async function settled(): Promise<void> {
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await index().info()).pendingVectorCount === 0) return
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      throw new Error('Upstash index did not finish indexing within 30 s')
    }

    /**
     * The conformance corpus is three-dimensional; a hosted index has a fixed
     * width. Zero-padding preserves every cosine similarity exactly.
     */
    function padded(store: VectorStore, width: number): VectorStore {
      const pad = (vector: number[]) => [...vector, ...new Array(width - vector.length).fill(0)]
      return {
        ...store,
        upsert: async (chunks) => {
          await store.upsert(chunks.map((c) => ({ ...c, embedding: pad(c.embedding) })))
          await settled()
        },
        query: (embedding, options) => store.query(pad(embedding), options),
        deleteBySource: async (sourceId) => {
          await store.deleteBySource(sourceId)
          await settled()
        },
        deleteByIds: async (ids) => {
          await store.deleteByIds(ids)
          await settled()
        },
        stats: () => store.stats(),
        close: () => store.close(),
      }
    }

    runVectorStoreConformance({
      name: 'upstash (hosted)',
      create: async (model) => {
        await index().reset()
        await settled()
        const { dimension } = await index().info()
        const store = await createUpstashVectorStore({
          url: UPSTASH_URL!,
          token: UPSTASH_TOKEN!,
          ...(model === undefined ? {} : { model }),
        })
        return padded(store, dimension)
      },
    })

    afterAll(async () => {
      await index().reset()
    })
  },
)
