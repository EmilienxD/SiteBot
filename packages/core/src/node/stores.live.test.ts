import { randomUUID } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'
import { once } from 'node:events'
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
import { createBudgetTracker } from '../guards/budget.js'
import { retrieve } from '../knowledge/retrieve.js'

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

  it('shares sessions across connections, renews retention and expires stored citation state', async () => {
    const name = table('continuity')
    const time = Date.now()
    const open = () => createPostgresSessionStore({ url: PG_URL!, table: name, ttlSeconds: 1 })
    const a = await open()
    const b = await open()
    try {
      await a.set({
        id: 'continuity',
        messages: [],
        createdAt: time,
        updatedAt: time,
        state: { nextCitationNumber: 3, synthetic: 'retained' },
      })
      expect((await b.get('continuity'))?.state).toEqual({
        nextCitationNumber: 3,
        synthetic: 'retained',
      })
      await new Promise((resolve) => setTimeout(resolve, 600))
      await b.append('continuity', [
        { id: 'fr', role: 'user', parts: [{ type: 'text', text: 'Et en français ?' }] },
      ])
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect((await a.get('continuity'))?.messages).toHaveLength(1)
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect(await a.get('continuity')).toBeNull()
      expect((await admin.query(`SELECT id FROM ${name}`)).rows).toEqual([])
    } finally {
      await a.dispose?.()
      await b.dispose?.()
    }
  })

  it('rolls back partial vector batches, releases the connection and permits recovery', async () => {
    const store = await createPgVectorStore({
      url: PG_URL!,
      table: table('rollback'),
      dimensions: 3,
    })
    try {
      for (let n = 0; n < 12; n++) {
        await expect(
          store.upsert([chunk('valid', [1, 0, 0]), chunk('bad', [1, 0])]),
        ).rejects.toThrow()
      }
      expect((await store.stats()).chunks).toBe(0)
      await store.upsert([chunk('recovered', [1, 0, 0])])
      expect((await store.query([1, 0, 0], { topK: 1 }))[0]?.chunk.id).toBe('recovered')
    } finally {
      await store.close()
    }
  })

  it('preserves multilingual citation fields and relevance/fallback through real SQL filters', async () => {
    const store = await createPgVectorStore({
      url: PG_URL!,
      table: table('language'),
      dimensions: 3,
    })
    const localized = (id: string, vector: number[], lang?: string) => {
      const c = chunk(id, vector)
      if (lang) Object.assign(c.metadata, { lang, language: lang.split('-')[0] })
      return c
    }
    const config = validateConfig(
      {
        version: 1,
        name: 'synthetic vectors',
        backend: { provider: 'ollama', model: 'fixture' },
        prompt: { system: 'fixture' },
        knowledge: {
          retrieval: { topK: 1, minScore: 0.5, expandNeighbours: 0, dedupeByUrl: false },
        },
      },
      { env: {} },
    )
    if (!config.ok) throw new Error('Invalid fixture config')
    const deps = {
      store,
      embedder: {
        modelId: 'synthetic-vectors',
        embed: async () => ({ embedding: [1, 0, 0], tokens: 1 }),
      },
    }
    try {
      const english = localized('en', [1, 0, 0], 'en')
      await store.upsert([
        english,
        localized('fr', [0.8, 0.6, 0], 'fr'),
        localized('fr-ca', [0, 1, 0], 'fr-CA'),
        localized('unknown', [0, 0, 1]),
      ])
      expect(
        (await retrieve(deps, 'synthetic query', config.value, 'fr-CA')).hits[0],
      ).toMatchObject({ id: 'en', lang: 'en', url: english.metadata.url })
      config.value.knowledge.retrieval.languagePreference = 'locale-first'
      expect((await retrieve(deps, 'synthetic query', config.value, 'fr-CA')).hits[0]?.id).toBe(
        'fr',
      )
      await store.deleteByIds(['fr'])
      expect((await retrieve(deps, 'synthetic query', config.value, 'fr-CA')).hits[0]?.id).toBe(
        'en',
      )
      expect((await store.documentChunks!(english.metadata.url))[0]).toEqual(english)
      expect((await store.query([0, 0, 1], { topK: 1 }))[0]?.chunk.id).toBe('unknown')
    } finally {
      await store.close()
    }
  })

  it('does not close a caller-owned pool on success or initialization failure', async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 1 })
    try {
      const store = await createPgVectorStore({
        url: PG_URL!,
        table: table('ownership'),
        dimensions: 3,
        pool,
      })
      await store.close()
      expect((await pool.query('SELECT 1 AS n')).rows[0]).toEqual({ n: 1 })
      await expect(
        createPgVectorStore({ url: PG_URL!, table: table('init_failure'), dimensions: -1, pool }),
      ).rejects.toThrow()
      expect((await pool.query('SELECT 1 AS n')).rows[0]).toEqual({ n: 1 })
    } finally {
      if (!pool.ended) await pool.end()
    }
  })

  it('releases owned pools when vector or session initialization fails', async () => {
    const marker = `sitebot_failure_${RUN}`
    const url = new URL(PG_URL!)
    url.searchParams.set('application_name', marker)
    await expect(
      createPgVectorStore({ url: url.href, table: table('owned_failure'), dimensions: -1 }),
    ).rejects.toThrow()
    const invalid = table('invalid_sessions')
    await admin.query(`CREATE TABLE ${invalid} (id TEXT PRIMARY KEY)`)
    await expect(createPostgresSessionStore({ url: url.href, table: invalid })).rejects.toThrow()
    expect(
      (await admin.query('SELECT pid FROM pg_stat_activity WHERE application_name = $1', [marker]))
        .rows,
    ).toEqual([])
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

  it('bounds a concurrent burst across instances and keeps the window after client recreation', async () => {
    const a = createRedisRateLimitStore({ url: REDIS_URL!, prefix })
    const b = createRedisRateLimitStore({ url: REDIS_URL!, prefix })
    const rule = { limit: 7, windowMs: 1000 }
    const key = 'burst'
    try {
      const results = await Promise.all(
        Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).hit(key, rule)),
      )
      expect(results.filter((r) => r.allowed)).toHaveLength(7)
      await a.dispose?.()
      const restarted = createRedisRateLimitStore({ url: REDIS_URL!, prefix })
      try {
        expect((await restarted.hit(key, rule)).allowed).toBe(false)
        await new Promise((resolve) => setTimeout(resolve, 1100))
        expect((await restarted.hit(key, rule)).allowed).toBe(true)
      } finally {
        await restarted.dispose?.()
      }
    } finally {
      await a.dispose?.()
      await b.dispose?.()
    }
  })

  it('accounts concurrent multi-instance token/USD writes, survives reopening and expires usage', async () => {
    const a = createRedisRateLimitStore({ url: REDIS_URL!, prefix })
    const b = createRedisRateLimitStore({ url: REDIS_URL!, prefix })
    try {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          (i % 2 ? a : b).addUsage!('concurrent', { tokens: 11, usd: 0.003 }, 60_000),
        ),
      )
      await a.dispose?.()
      const restarted = createRedisRateLimitStore({ url: REDIS_URL!, prefix })
      try {
        const usage = await restarted.getUsage!('concurrent')
        expect(usage.tokens).toBe(1100)
        expect(usage.usd).toBeCloseTo(0.3, 10)
        await restarted.addUsage!('expiring', { tokens: 1, usd: 0.01 }, 100)
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(await b.getUsage!('expiring')).toEqual({ tokens: 0, usd: 0 })
      } finally {
        await restarted.dispose?.()
      }
    } finally {
      await a.dispose?.()
      await b.dispose?.()
    }
  })

  it('refreshes shared budget checks after another tracker records completed spend', async () => {
    const a = createRedisRateLimitStore({ url: REDIS_URL!, prefix: `${prefix}refresh:` })
    const b = createRedisRateLimitStore({ url: REDIS_URL!, prefix: `${prefix}refresh:` })
    // Fixture prices only: 1000 tokens costs $1; no provider is called.
    const options = {
      budget: {
        maxTokensPerDay: 1000,
        maxUsdPerDay: 1,
        onExceeded: 'error' as const,
        resetHourUtc: 0,
      },
      pricing: { 'fixture:model': { inputUsdPerMillion: 1000, outputUsdPerMillion: 1000 } },
    }
    const reader = createBudgetTracker({ ...options, store: a })
    const writer = createBudgetTracker({ ...options, store: b })
    try {
      expect(await reader.check(1, 'fixture:model')).toBe('ok')
      await writer.record(
        { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 },
        'fixture:model',
      )
      expect(await reader.check(1, 'fixture:model')).toBe('block')
    } finally {
      await a.dispose?.()
      await b.dispose?.()
    }
  })

  it('fails unavailable connections promptly and reopens after repair and socket loss', async () => {
    const upstream = new URL(REDIS_URL!)
    const sockets = new Set<Socket>()
    const proxy = createServer((socket) => {
      const remote = createConnection({
        host: upstream.hostname,
        port: Number(upstream.port || 6379),
      })
      for (const connection of [socket, remote]) {
        sockets.add(connection)
        connection.on('close', () => sockets.delete(connection))
        connection.on('error', () => {
          socket.destroy()
          remote.destroy()
        })
      }
      socket.pipe(remote).pipe(socket)
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const port = (proxy.address() as { port: number }).port
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    const url = new URL(REDIS_URL!)
    url.hostname = '127.0.0.1'
    url.port = String(port)
    const sessions = createRedisSessionStore({ url: url.href, prefix })
    const counters = createRedisRateLimitStore({ url: url.href, prefix })
    try {
      await expect(sessions.get('reconnect')).rejects.toThrow()
      await expect(counters.getUsage!('reconnect')).rejects.toThrow()
      proxy.listen(port, '127.0.0.1')
      await once(proxy, 'listening')
      await sessions.append('reconnect', [
        { id: 'en', role: 'user', parts: [{ type: 'text', text: 'Synthetic persistent turn' }] },
      ])
      await counters.addUsage!('reconnect', { tokens: 42, usd: 0.01 }, 60000)
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect((await sessions.get('reconnect'))?.messages[0]?.id).toBe('en')
      expect(await counters.getUsage!('reconnect')).toEqual({ tokens: 42, usd: 0.01 })
    } finally {
      await sessions.dispose?.()
      await counters.dispose?.()
      for (const socket of sockets) socket.destroy()
      if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()))
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
