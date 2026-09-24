import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import { MemorySessionStore, type SessionStore } from '../session/store.js'
import { createNodeSessionStore } from './index.js'
import {
  createPostgresSessionStore,
  createRedisSessionStore,
  type PgLike,
  type RedisLike,
} from './session-stores.js'
import { createSqliteSessionStore } from './sqlite-store.js'

/**
 * One conformance suite for every `storage.type` — docs/02 §10, docs/01 §6.
 * Redis and Postgres run against in-memory fakes of exactly the client surface
 * the stores use, so the suite needs no server; the SQL the Postgres store
 * sends is asserted to be the SQL the fake understands.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures')

function fakeRedis(): RedisLike & { keys: Map<string, string> } {
  const keys = new Map<string, string>()
  return {
    keys,
    isOpen: true,
    connect: async () => undefined,
    get: async (key) => keys.get(key) ?? null,
    set: async (key, value) => void keys.set(key, value),
    del: async (key) => void keys.delete(key),
  }
}

function fakePg(): PgLike & { statements: string[] } {
  const rows = new Map<string, { data: string; updated_at: number }>()
  const statements: string[] = []
  return {
    statements,
    async query(text, values = []) {
      const sql = text.replace(/\s+/g, ' ').trim()
      statements.push(sql.split(' ').slice(0, 2).join(' '))
      if (sql.startsWith('CREATE')) return { rows: [] }
      if (sql.startsWith('SELECT')) {
        const row = rows.get(String(values[0]))
        return { rows: row ? [{ data: JSON.parse(row.data), updated_at: row.updated_at }] : [] }
      }
      if (sql.startsWith('INSERT')) {
        rows.set(String(values[0]), { data: String(values[1]), updated_at: Number(values[2]) })
        return { rows: [] }
      }
      if (sql.startsWith('DELETE') && sql.includes('WHERE id =')) {
        rows.delete(String(values[0]))
        return { rows: [] }
      }
      if (sql.startsWith('DELETE') && sql.includes('updated_at <')) {
        for (const [id, row] of rows) if (row.updated_at < Number(values[0])) rows.delete(id)
        return { rows: [] }
      }
      throw new Error(`fake pg does not understand: ${sql}`)
    },
  }
}

const message = (id: string, text = id): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})

type Factory = (options: {
  now: () => number
  ttlSeconds: number
  max: number
}) => Promise<SessionStore>

const STORES: Array<[string, Factory]> = [
  [
    'memory',
    async (o) =>
      new MemorySessionStore({
        now: o.now,
        ttlSeconds: o.ttlSeconds,
        maxMessagesPerSession: o.max,
      }),
  ],
  [
    'sqlite',
    (o) =>
      createSqliteSessionStore({
        path: ':memory:',
        now: o.now,
        ttlSeconds: o.ttlSeconds,
        maxMessagesPerSession: o.max,
      }),
  ],
  [
    'redis',
    async (o) =>
      createRedisSessionStore({
        url: 'redis://unused',
        client: fakeRedis(),
        now: o.now,
        ttlSeconds: o.ttlSeconds,
        maxMessagesPerSession: o.max,
      }),
  ],
  [
    'postgres',
    (o) =>
      createPostgresSessionStore({
        url: 'postgres://unused',
        pool: fakePg(),
        now: o.now,
        ttlSeconds: o.ttlSeconds,
        maxMessagesPerSession: o.max,
      }),
  ],
]

describe.each(STORES)('%s session store conformance', (_name, make) => {
  const setup = async (max = 100) => {
    let time = 1_000_000
    const store = await make({ now: () => time, ttlSeconds: 60, max })
    return { store, advance: (ms: number) => (time += ms) }
  }

  it('returns null for an unknown session', async () => {
    const { store } = await setup()
    expect(await store.get('missing')).toBeNull()
  })

  it('round-trips a session, including checkpoint state and fingerprint', async () => {
    const { store } = await setup()
    await store.set({
      id: 's1',
      messages: [message('m1')],
      createdAt: 1,
      updatedAt: 1,
      fingerprint: '203.0.113|https://acme.com|abcd',
      state: { pending: { runId: 'r1' } },
    })
    const session = await store.get('s1')
    expect(session).toMatchObject({
      id: 's1',
      messages: [message('m1')],
      createdAt: 1,
      fingerprint: '203.0.113|https://acme.com|abcd',
      state: { pending: { runId: 'r1' } },
    })
  })

  it('append creates the session, then extends it in order', async () => {
    const { store } = await setup()
    await store.append('s1', [message('m1')])
    const after = await store.append('s1', [message('m2'), message('m3')])
    expect(after.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect((await store.get('s1'))?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('keeps only the newest maxMessagesPerSession messages', async () => {
    const { store } = await setup(3)
    await store.append(
      's1',
      ['a', 'b', 'c', 'd', 'e'].map((id) => message(id)),
    )
    expect((await store.get('s1'))?.messages.map((m) => m.id)).toEqual(['c', 'd', 'e'])
  })

  it('expires a session after ttlSeconds of inactivity, and activity renews it', async () => {
    const { store, advance } = await setup()
    await store.append('s1', [message('m1')])
    advance(50_000)
    await store.append('s1', [message('m2')])
    advance(50_000)
    expect(await store.get('s1')).not.toBeNull()
    advance(61_000)
    expect(await store.get('s1')).toBeNull()
  })

  it('isolates sessions and deletes one without touching another', async () => {
    const { store } = await setup()
    await store.append('s1', [message('one')])
    await store.append('s2', [message('two')])
    await store.delete('s1')
    expect(await store.get('s1')).toBeNull()
    expect((await store.get('s2'))?.messages[0]?.id).toBe('two')
  })

  it('does not share mutable state with the caller', async () => {
    const { store } = await setup()
    await store.append('s1', [message('m1')])
    const read = await store.get('s1')
    read!.messages.push(message('injected'))
    expect((await store.get('s1'))?.messages).toHaveLength(1)
  })
})

describe('createNodeSessionStore (every storage.type)', () => {
  const storage = (value: Record<string, unknown>) => {
    const result = validateConfig(
      {
        version: 1,
        name: 'x',
        backend: { provider: 'anthropic', model: 'm', apiKey: 'k' },
        prompt: { system: 's' },
        storage: value,
      },
      { env: {} },
    )
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    return result.value.storage
  }

  it('builds memory and none through the edge-safe factory', async () => {
    expect(await createNodeSessionStore(storage({ type: 'memory' }))).toBeInstanceOf(
      MemorySessionStore,
    )
    expect(await (await createNodeSessionStore(storage({ type: 'none' }))).get('x')).toBeNull()
  })

  it('opens sqlite relative to the config directory', async () => {
    const store = await createNodeSessionStore(storage({ type: 'sqlite', path: ':memory:' }), {
      baseDir: FIXTURES,
    })
    await store.append('s', [message('m')])
    expect((await store.get('s'))?.messages).toHaveLength(1)
    await store.dispose?.()
  })

  it('loads a custom store module (factory export) relative to the config', async () => {
    const store = await createNodeSessionStore(
      storage({ type: 'custom', module: './custom-session-store.mjs#createStore' }),
      { baseDir: FIXTURES },
    )
    await store.append('s', [message('m')])
    expect((await store.get('s'))?.messages.map((m) => m.id)).toEqual(['m'])
  })

  it('rejects a custom module that does not implement the interface', async () => {
    await expect(
      createNodeSessionStore(
        storage({ type: 'custom', module: './custom-session-store.mjs#broken' }),
        {
          baseDir: FIXTURES,
        },
      ),
    ).rejects.toThrow(/does not implement append\(\)/)
  })

  it('names the missing driver for postgres instead of a stack trace', async () => {
    await expect(
      createNodeSessionStore(storage({ type: 'postgres', url: 'postgres://localhost/x' })),
    ).rejects.toThrow(/pnpm add pg/)
  })
})
