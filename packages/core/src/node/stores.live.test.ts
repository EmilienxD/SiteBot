import { randomUUID } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import pg from 'pg'
import { createClient } from 'redis'
import { afterAll, describe, expect, it } from 'vitest'
import { runSessionStoreConformance } from '../../test/session-store-conformance.js'
import { createRedisRateLimitStore } from './redis-rate-limit.js'
import { createPostgresSessionStore, createRedisSessionStore } from './session-stores.js'
import { createBudgetTracker } from '../guards/budget.js'

/**
 * Real-infrastructure checks — `pnpm test:live` only (docs/04 §10).
 *
 * The offline conformance suites run every store against driver stand-ins.
 * These run the same suites against real servers, so a stand-in that
 * understands SQL or commands the server does not fails here. Each backend
 * is gated on its own variable and skips without it:
 *
 *   SITEBOT_LIVE_PG_URL        Postgres sessions
 *   SITEBOT_LIVE_REDIS_URL     Redis 6.2+
 *
 * Tables and keys carry a random run id and are dropped afterwards.
 */

const PG_URL = process.env['SITEBOT_LIVE_PG_URL']
const REDIS_URL = process.env['SITEBOT_LIVE_REDIS_URL']

const RUN = randomUUID().slice(0, 8)
let tableCounter = 0
const nextTable = (kind: string) => `sitebot_live_${RUN}_${kind}_${tableCounter++}`

/** A unit vector along `axis` in `dimensions` dimensions. */

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

  runSessionStoreConformance('postgres (real server)', (o) =>
    createPostgresSessionStore({
      url: PG_URL!,
      table: table('sessions'),
      now: o.now,
      ttlSeconds: o.ttlSeconds,
      maxMessagesPerSession: o.max,
    }),
  )

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

  it('releases owned pools when session initialization fails', async () => {
    const marker = `sitebot_failure_${RUN}`
    const url = new URL(PG_URL!)
    url.searchParams.set('application_name', marker)
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
