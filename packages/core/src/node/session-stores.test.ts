import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UIMessage } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { validateConfig } from '@sitebot/config'
import type * as OptionalImport from '../providers/optional-import.js'
import { MemorySessionStore } from '../session/store.js'
import { runSessionStoreConformance } from '../../test/session-store-conformance.js'
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
 * sends is asserted to be the SQL the fake understands. `pnpm test:live` runs
 * the same cases against real servers (`stores.live.test.ts`).
 */

// pg is a dev dependency for the live suite; a consumer without it must still
// get the install command, so its absence is simulated here.
vi.mock('../providers/optional-import.js', async (importOriginal) => {
  const actual = await importOriginal<typeof OptionalImport>()
  return {
    ...actual,
    importOptional: async (specifier: string, options?: { from?: string[] }) => {
      if (specifier === 'pg') {
        throw Object.assign(new Error("Cannot find package 'pg'"), { code: 'ERR_MODULE_NOT_FOUND' })
      }
      return actual.importOptional(specifier, options)
    },
  }
})

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

describe('Redis session connection recovery', () => {
  it('retries a failed connection and leaves an injected client owned by its caller', async () => {
    const client = { ...fakeRedis(), isOpen: false, quit: vi.fn(async () => {}) }
    client.connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic unavailable connection'))
      .mockImplementation(async () => {
        client.isOpen = true
      })
    const store = createRedisSessionStore({ url: 'redis://unused', client })
    await expect(store.get('synthetic')).rejects.toThrow('synthetic unavailable connection')
    await store.append('synthetic', [message('recovered')])
    expect((await store.get('synthetic'))?.messages[0]?.id).toBe('recovered')
    await store.dispose?.()
    expect(client.quit).not.toHaveBeenCalled()
  })
})

runSessionStoreConformance(
  'memory',
  async (o) =>
    new MemorySessionStore({ now: o.now, ttlSeconds: o.ttlSeconds, maxMessagesPerSession: o.max }),
)
runSessionStoreConformance('sqlite', (o) =>
  createSqliteSessionStore({
    path: ':memory:',
    now: o.now,
    ttlSeconds: o.ttlSeconds,
    maxMessagesPerSession: o.max,
  }),
)
runSessionStoreConformance('redis', async (o) =>
  createRedisSessionStore({
    url: 'redis://unused',
    client: fakeRedis(),
    now: o.now,
    ttlSeconds: o.ttlSeconds,
    maxMessagesPerSession: o.max,
  }),
)
runSessionStoreConformance('postgres', (o) =>
  createPostgresSessionStore({
    url: 'postgres://unused',
    pool: fakePg(),
    now: o.now,
    ttlSeconds: o.ttlSeconds,
    maxMessagesPerSession: o.max,
  }),
)

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
