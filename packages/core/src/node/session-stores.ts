import { importOptional } from '../providers/optional-import.js'
import { createClient } from 'redis'
import type { UIMessage } from 'ai'
import type { SessionStore, SessionStoreOptions, StoredSession } from '../session/store.js'

/**
 * `storage.type: redis | postgres` — the multi-replica session stores
 * (docs/02 §10). Both keep a whole session as one JSON document keyed by id,
 * which is all the four-method `SessionStore` contract asks for, and trim to
 * `maxMessagesPerSession` on every write exactly as the memory and sqlite
 * stores do. The conformance suite in `session-stores.test.ts` runs all of
 * them against the same cases.
 */

/** The subset of a node-redis client the store uses; injectable for tests. */
export interface RedisLike {
  isOpen?: boolean
  connect(): Promise<unknown>
  get(key: string): Promise<string | null>
  set(key: string, value: string, options: { PX: number }): Promise<unknown>
  del(key: string): Promise<unknown>
  quit?(): Promise<unknown>
}

export interface RedisSessionStoreOptions extends SessionStoreOptions {
  url: string
  prefix?: string
  client?: RedisLike
}

export function createRedisSessionStore(options: RedisSessionStoreOptions): SessionStore {
  const client = options.client ?? (createClient({ url: options.url }) as unknown as RedisLike)
  const owns = options.client === undefined
  const prefix = options.prefix ?? 'sitebot:'
  const ttlMs = (options.ttlSeconds ?? 2_592_000) * 1000
  const maxMessages = options.maxMessagesPerSession ?? 100
  const now = options.now ?? (() => Date.now())
  const key = (id: string) => `${prefix}session:${id}`
  let connecting: Promise<unknown> | undefined
  // One connect for the store's lifetime; an injected, already-open client
  // is used as is.
  const ready = () => (connecting ??= client.isOpen ? Promise.resolve() : client.connect())

  const store: SessionStore = {
    async get(id) {
      await ready()
      const raw = await client.get(key(id))
      if (raw === null) return null
      const session = JSON.parse(raw) as StoredSession
      // Redis expires the key itself; this covers an injected clock in tests.
      return now() - session.updatedAt > ttlMs ? null : session
    },
    async set(session) {
      await ready()
      const trimmed: StoredSession = {
        ...session,
        messages: session.messages.slice(-maxMessages),
        updatedAt: now(),
      }
      await client.set(key(session.id), JSON.stringify(trimmed), { PX: ttlMs })
    },
    async append(id: string, messages: UIMessage[]) {
      const time = now()
      const existing = (await store.get(id)) ?? {
        id,
        messages: [],
        createdAt: time,
        updatedAt: time,
      }
      const next = {
        ...existing,
        messages: [...existing.messages, ...messages].slice(-maxMessages),
      }
      await store.set(next)
      return { ...next, updatedAt: now() }
    },
    async delete(id) {
      await ready()
      await client.del(key(id))
    },
    async dispose() {
      if (owns && client.isOpen !== false) await client.quit?.()
    },
  }
  return store
}

/** The subset of a `pg` pool the store uses; injectable for tests. */
export interface PgLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  end?(): Promise<void>
}

export interface PostgresSessionStoreOptions extends SessionStoreOptions {
  url: string
  /** Table name; created on first use. Default `sitebot_sessions`. */
  table?: string
  pool?: PgLike
}

export async function createPostgresSessionStore(
  options: PostgresSessionStoreOptions,
): Promise<SessionStore> {
  const table = options.table ?? 'sitebot_sessions'
  if (!/^[a-z_][a-z0-9_]*$/i.test(table))
    throw new Error(`storage table name "${table}" is not a valid SQL identifier.`)
  const pool = options.pool ?? (await openPgPool(options.url))
  const owns = options.pool === undefined
  const ttlMs = (options.ttlSeconds ?? 2_592_000) * 1000
  const maxMessages = options.maxMessagesPerSession ?? 100
  const now = options.now ?? (() => Date.now())

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at BIGINT NOT NULL)`,
  )
  await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_updated_at ON ${table} (updated_at)`)

  const read = async (id: string): Promise<StoredSession | null> => {
    const { rows } = await pool.query(`SELECT data, updated_at FROM ${table} WHERE id = $1`, [id])
    const row = rows[0]
    if (row === undefined) return null
    if (now() - Number(row.updated_at) > ttlMs) {
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id])
      return null
    }
    // `pg` parses JSONB; a string arrives only from drivers that do not.
    return (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as StoredSession
  }

  const write = async (session: StoredSession): Promise<StoredSession> => {
    const time = now()
    const trimmed: StoredSession = {
      ...session,
      messages: session.messages.slice(-maxMessages),
      updatedAt: time,
    }
    await pool.query(
      `INSERT INTO ${table} (id, data, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [trimmed.id, JSON.stringify(trimmed), time],
    )
    await pool.query(`DELETE FROM ${table} WHERE updated_at < $1`, [time - ttlMs])
    return trimmed
  }

  return {
    get: read,
    async set(session) {
      await write(session)
    },
    async append(id, messages) {
      const time = now()
      const existing = (await read(id)) ?? { id, messages: [], createdAt: time, updatedAt: time }
      return write({ ...existing, messages: [...existing.messages, ...messages] })
    },
    async delete(id) {
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id])
    },
    async dispose() {
      if (owns) await pool.end?.()
    },
  }
}

async function openPgPool(url: string): Promise<PgLike> {
  let pg: { Pool?: new (config: { connectionString: string }) => PgLike; default?: unknown }
  try {
    pg = (await importOptional('pg')) as typeof pg
  } catch (cause) {
    throw new Error(
      'storage.type "postgres" requires the optional dependency pg.\n  Install it:  pnpm add pg',
      { cause },
    )
  }
  const Pool = pg.Pool ?? (pg.default as { Pool?: typeof pg.Pool } | undefined)?.Pool
  if (Pool === undefined) throw new Error('pg did not expose Pool')
  return new Pool({ connectionString: url })
}
